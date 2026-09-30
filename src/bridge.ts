import type { Runtime } from 'webextension-polyfill';
import { browser } from './utils/browser';

/**
 * 桥接脚本：只注入到目标网站（见 src/hosts/targetSites.ts 与 manifest 的 content_scripts）。
 *
 * 网页脚本访问不到 chrome.runtime，所以这里做双向中转：
 *   - 扩展 -> 页面：background / WebPageHost 发来的 cp-task，转成 window.postMessage
 *   - 页面 -> 扩展：页面发来的 cp-ping，向 background 查扩展信息后回 cp-info
 *
 * 信封格式（与网站侧 src/composables/useCompanionBridge.js 约定一致）：
 *   扩展 -> 页面 { source: 'competitive-companion', type, ... }
 *   页面 -> 扩展 { source: 'cp-page', type, ... }
 *
 * 【跨仓契约】下面这批消息名（cp-page / cp-task / cp-ping / cp-get-info / cp-info /
 * cp-set-config / cp-config）2026-10-01 与网站一起从 `cph-` 前缀改成 `cp-`。
 * 改任何一条都必须同步改网站侧 useCompanionBridge.js 并同时发新版，否则新旧两边互相认不出、抓题直接失联。
 */

const PAGE_SOURCE = 'cp-page';
const EXTENSION_SOURCE = 'competitive-companion';

interface TaskMessage {
  action?: string;
  taskId?: string;
  payload?: string;
}

function postToPage(type: string, detail: Record<string, unknown>): void {
  window.postMessage({ source: EXTENSION_SOURCE, type, ...detail }, window.location.origin);
}

// 扩展 -> 页面
function onExtensionMessage(
  message: unknown,
  _sender: Runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true {
  const task = message as TaskMessage | undefined;

  if (task?.action === 'cp-task') {
    postToPage('cp-task', { taskId: task.taskId, payload: task.payload });
  }

  sendResponse({ ok: true });
  return true;
}

// 页面 -> 扩展（握手：网页据此判断扩展是否已安装，并取版本号与快捷键）
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) {
    return;
  }

  const data = event.data as
    | { source?: string; type?: string; requestId?: string; key?: string; value?: unknown }
    | undefined;
  if (data?.source !== PAGE_SOURCE) {
    return;
  }

  const requestId = data.requestId;

  if (data.type === 'cp-ping') {
    browser.runtime
      .sendMessage({ action: 'cp-get-info' })
      .then(info => postToPage('cp-info', { requestId, info: info ?? null }))
      .catch(() => postToPage('cp-info', { requestId, info: null }));

    return;
  }

  // 网页改投递目标开关：键与值的合法性由 background 的白名单把关
  if (data.type === 'cp-set-config') {
    browser.runtime
      .sendMessage({ action: 'cp-set-config', key: data.key, value: data.value })
      .then(result => postToPage('cp-config', { requestId, key: data.key, ...(result as object) }))
      .catch(() => postToPage('cp-config', { requestId, key: data.key, ok: false }));
  }
});

browser.runtime.onMessage.addListener(onExtensionMessage);

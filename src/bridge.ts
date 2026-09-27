import type { Runtime } from 'webextension-polyfill';
import { browser } from './utils/browser';

/**
 * 桥接脚本：只注入到目标网站（见 src/hosts/targetSites.ts 与 manifest 的 content_scripts）。
 *
 * 网页脚本访问不到 chrome.runtime，所以这里做双向中转：
 *   - 扩展 -> 页面：background / WebPageHost 发来的 cph-task，转成 window.postMessage
 *   - 页面 -> 扩展：页面发来的 cph-ping，向 background 查扩展信息后回 cph-info
 *
 * 信封格式（与网站侧 src/composables/useCompanionBridge.js 约定一致）：
 *   扩展 -> 页面 { source: 'competitive-companion', type, ... }
 *   页面 -> 扩展 { source: 'cph-page', type, ... }
 *
 * 只做转发，不解析 payload，也不假设 payload 一定是题目 JSON。
 */

const PAGE_SOURCE = 'cph-page';
const EXTENSION_SOURCE = 'competitive-companion';

interface CphTaskMessage {
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
  const task = message as CphTaskMessage | undefined;

  if (task?.action === 'cph-task') {
    postToPage('cph-task', { taskId: task.taskId, payload: task.payload });
  }

  sendResponse({ ok: true });
  return true;
}

// 页面 -> 扩展（握手：网页据此判断扩展是否已安装，并取版本号与快捷键）
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) {
    return;
  }

  const data = event.data as { source?: string; type?: string; requestId?: string } | undefined;
  if (data?.source !== PAGE_SOURCE || data.type !== 'cph-ping') {
    return;
  }

  const requestId = data.requestId;

  browser.runtime
    .sendMessage({ action: 'cph-get-info' })
    .then(info => postToPage('cph-info', { requestId, info: info ?? null }))
    .catch(() => postToPage('cph-info', { requestId, info: null }));
});

browser.runtime.onMessage.addListener(onExtensionMessage);

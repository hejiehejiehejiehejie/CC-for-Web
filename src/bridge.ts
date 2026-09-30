import type { Runtime } from 'webextension-polyfill';
import { browser } from './utils/browser';

/**
 * 桥接脚本：只注入到目标网站（见 src/hosts/targetSites.ts 与 manifest 的 content_scripts）。
 *
 * 网页脚本访问不到 chrome.runtime，所以这里做双向中转：
 *   - 扩展 -> 页面：background / WebPageHost 发来的 cp-task，转成 window.postMessage；
 *     以及 cp-query-need（问「这道题的样例是不是空的」）
 *   - 页面 -> 扩展：cp-ping（查扩展信息，回 cp-info）、cp-set-config（改投递开关）、
 *     cp-need-answer（回答上面那一问）
 *
 * 信封格式（与网站侧 src/composables/useCompanionBridge.js 约定一致）：
 *   扩展 -> 页面 { source: 'competitive-companion', type, ... }
 *   页面 -> 扩展 { source: 'cp-page', type, ... }
 *
 * 【跨仓契约】下面这批消息名（cp-page / cp-task / cp-ping / cp-get-info / cp-info /
 * cp-set-config / cp-config / cp-query-need / cp-need-answer）2026-10-01 与网站一起从 `cph-`
 * 前缀改成 `cp-`。改任何一条都必须同步改网站侧 useCompanionBridge.js 并同时发新版，
 * 否则新旧两边互相认不出、抓题直接失联。
 *
 * 【cp-query-need 这一对】「用户打开题目页时要不要自动抓样例」不再看扩展存的那份名单
 * （2026-10-01 起名单已删），改成**问网页**：工作区里按 url 认得出这道题、且它的样例为空，
 * 才值得抓。于是这里是一问一答的往返，用 queryId 配对；网页没应答（不是新版网站、
 * 或页面正忙）就按「不用抓」收场，绝不把用户的题目页卡住。
 */

const PAGE_SOURCE = 'cp-page';
const EXTENSION_SOURCE = 'competitive-companion';

/** 等网页回答「要不要抓」的上限。超时一律当「不用抓」——宁可漏抓一次，也不能让题目页等着 */
const NEED_QUERY_TIMEOUT = 2000;

interface ExtensionMessage {
  action?: string;
  taskId?: string;
  payload?: any;
}

function postToPage(type: string, detail: Record<string, unknown>): void {
  window.postMessage({ source: EXTENSION_SOURCE, type, ...detail }, window.location.origin);
}

/** 在途的询问：queryId -> 结算函数 */
const pendingNeedQueries = new Map<string, (need: boolean) => void>();

/** 问网页「这个链接的题样例是空的吗」，并等它回答（cp-need-answer） */
function askPageNeed(url: string): Promise<boolean> {
  const queryId = `need-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<boolean>(resolve => {
    const timer = window.setTimeout(() => {
      pendingNeedQueries.delete(queryId);
      resolve(false);
    }, NEED_QUERY_TIMEOUT);

    pendingNeedQueries.set(queryId, need => {
      window.clearTimeout(timer);
      resolve(need);
    });

    postToPage('cp-query-need', { queryId, url });
  });
}

// 扩展 -> 页面
function onExtensionMessage(
  message: unknown,
  _sender: Runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true {
  const task = message as ExtensionMessage | undefined;

  if (task?.action === 'cp-task') {
    postToPage('cp-task', { taskId: task.taskId, payload: task.payload });
  } else if (task?.action === 'cp-query-need') {
    // 答案在网页那边（工作区是它的数据），这里只负责把问题递过去、把答案递回来
    askPageNeed(String(task.payload?.url ?? ''))
      .then(need => sendResponse({ need }))
      .catch(() => sendResponse({ need: false }));

    return true;
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
    | {
        source?: string;
        type?: string;
        requestId?: string;
        key?: string;
        value?: unknown;
        queryId?: string;
        need?: unknown;
      }
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

    return;
  }

  // 网页回答「这道题的样例空不空」：结算上面那一问。对不上的 queryId（超时后才回来）直接丢
  if (data.type === 'cp-need-answer') {
    const settle = typeof data.queryId === 'string' ? pendingNeedQueries.get(data.queryId) : undefined;

    if (settle !== undefined && typeof data.queryId === 'string') {
      pendingNeedQueries.delete(data.queryId);
      settle(data.need === true);
    }
  }
});

browser.runtime.onMessage.addListener(onExtensionMessage);

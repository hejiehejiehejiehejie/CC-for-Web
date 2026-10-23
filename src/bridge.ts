import type { Runtime } from 'webextension-polyfill';
import { browser } from './utils/browser';

/**
 * 桥接脚本：只注入到目标网站（见 src/hosts/targetSites.ts 与 manifest 的 content_scripts）。
 *
 * 网页脚本访问不到 chrome.runtime，所以这里做双向中转：
 *   - 扩展 -> 页面：background / WebPageHost 发来的 cp-task，转成 window.postMessage；
 *     以及 cp-query-need（问「这道题的样例是不是空的」）
 *   - 页面 -> 扩展：cp-ping（查扩展信息，回 cp-info）、cp-set-config（改投递开关）、
 *     cp-need-answer（回答上面那一问）、cp-fill-code（请扩展去 Codeforces 代填验证码，
 *     回 cp-fill-code-result）、cp-cf-check（问「这个浏览器在 Codeforces 上登的是不是你填的
 *     那个 handle」，回 cp-cf-check-result）、cp-submit（请扩展把当前文件提交到 Codeforces，
 *     回 cp-submit-result）
 *
 * 信封格式（与网站侧 src/composables/useCompanionBridge.js 约定一致）：
 *   扩展 -> 页面 { source: 'competitive-companion', type, ... }
 *   页面 -> 扩展 { source: 'cp-page', type, ... }
 *
 * 【跨仓契约】下面这批消息名（cp-page / cp-task / cp-ping / cp-get-info / cp-info /
 * cp-set-config / cp-config / cp-query-need / cp-need-answer / cp-fill-code /
 * cp-fill-code-result / cp-fill-code-saved / cp-cf-check / cp-cf-check-result /
 * cp-scrape-contest / cp-scrape-contest-done / cp-submit / cp-submit-result /
 * cp-submit-status）2026-10-01 与网站一起从 `cph-` 前缀改成 `cp-`。改任何一条都必须同步改
 * 网站侧 useCompanionBridge.js 并同时发新版，否则新旧两边互相认不出、抓题直接失联。
 *
 * 【cp-submit / cp-submit-result / cp-submit-status 是 2026-10-23 新加的】网页请扩展把当前
 * 文件提交到 Codeforces（只在用户点那颗提交按钮 / 按快捷键时发生）。`cp-submit` 与
 * `cp-submit-result` 是一问一答，只说「表单交出去了没有 + 提交号」；之后后台在那个后台
 * 标签页里盯 `/my`，每变一次判定就广播一条 `cp-submit-status`（见 background.ts 的
 * submitOnCodeforces 与 src/submitCode.ts）。受 `capabilities` 里的 `submit-code` 保护。
 *
 * 【cp-scrape-contest 这一对是 2026-10-19 新加的】网页请扩展**整场**抓样例：给它一个
 * `/contest/{id}/problems` 地址，扩展在后台开一个不激活的标签页读一遍，解析结果仍走
 * 既有的 cp-task 逐题投递 —— 网页不必为「补样例」再造一条入库路径。
 * 请求只回「开跑没有」（`accepted`），真正的成败由 cp-scrape-contest-done 广播回来；
 * 受 `capabilities` 里的 `contest-batch` 保护（老扩展没有这条能力，网页就不显示那颗按钮）。
 *
 * 【cp-query-need 这一对】「用户打开题目页时要不要自动抓样例」不再看扩展存的那份名单
 * （2026-10-01 起名单已删），改成**问网页**：工作区里按 url 认得出这道题、且它的样例为空，
 * 才值得抓。于是这里是一问一答的往返，用 queryId 配对；网页没应答（不是新版网站、
 * 或页面正忙）就按「不用抓」收场，绝不把用户的题目页卡住。
 *
 * 【cp-fill-code 这一对是 2026-10-11 新加的】网页请扩展去 Codeforces 代填云同步的验证码
 * （只在用户点那颗按钮时发生，不轮询、不后台自动跑）。这一条**只有请求与结果**，中间那趟
 * 「打开 Codeforces、填 Last name、保存」全在后台与 src/fillCode.ts 里，网页看不到也拿不到
 * 任何 Codeforces 凭据 —— 详细边界见那个文件开头。
 *
 * 【cp-fill-code-saved 是 2026-10-20 加的】上面那条只回答「字填进去了没有」，可网页要接着
 * 验证，就得知道**保存到底落下去没有**（它自己猜不出来）。这条由后台在「提交那一趟跳转
 * 走完」之后广播回来（`saved` 布尔），网页拿它当「可以验了」的发令枪；扩展顺手把自己开的
 * 那个 Codeforces 标签页收掉。受 `capabilities` 里的 `fill-saved` 保护 —— 老扩展不发这条，
 * 网页就照旧让用户自己点验证。
 *
 * 【cp-cf-check 这一对同样是 2026-10-11 新加的】网页问「这个浏览器在 Codeforces 上登的是不是
 * 我填的那个 handle」，好让取码界面**提前**说清代填能不能成，而不是让用户白点一次。
 * 关键是：**只回 match / mismatch / not-logged-in / unknown 四个枚举，不回用户名** ——
 * handle 明文本来就是网页自己填的，所以这个回答里**没有任何网页原本不知道的信息**。
 * 比对在后台拿会话级缓存做，见 background.ts 的 Codeforces 登录态那一段。
 * 这一对同样受 `capabilities` 保护（老扩展没有 cf-check，网页就不问）。
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
  } else if (task?.action === 'cp-scrape-contest-done') {
    // 整场抓取收尾：原样转给网页（requestId 由它配对，这里不解释也不缓存）
    postToPage('cp-scrape-contest-done', { ...(task.payload ?? {}) });
  } else if (task?.action === 'cp-fill-code-saved') {
    // 代填收尾（保存落下去没有 + 那一页已经收掉）：同样原样转给网页，requestId 由它配对
    postToPage('cp-fill-code-saved', { ...(task.payload ?? {}) });
  } else if (task?.action === 'cp-submit-status') {
    // 一键提交之后的判定变化：原样转给网页，requestId 由它配对（见 submitCode.ts）
    postToPage('cp-submit-status', { ...(task.payload ?? {}) });
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
        handle?: string;
        code?: string;
        url?: string;
        sourceCode?: string;
        language?: string;
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

    return;
  }

  // 网页请扩展去 Codeforces 代填验证码：整趟搬运都在后台与 fillCode 脚本里，这里只递请求、递结果。
  // 后台失联时回一个不带 reason 的失败 —— 网站侧会把认不出的原因折成「请手动填写」那句兜底。
  // requestId 一并带过去：后台收尾时要用它把 cp-fill-code-saved 指回这一轮（见文件头）
  if (data.type === 'cp-fill-code') {
    browser.runtime
      .sendMessage({ action: 'cp-fill-code', requestId, handle: data.handle, code: data.code })
      .then(result => postToPage('cp-fill-code-result', { requestId, ...(result as object) }))
      .catch(() => postToPage('cp-fill-code-result', { requestId, ok: false }));

    return;
  }

  // 网页请扩展整场抓样例。只回「开跑没有」：真正的成败由后台广播
  // cp-scrape-contest-done 回来。后台拒收（没有可用档期 / 地址不合法）时也走同一条
  // 结果消息，网页侧于是只认一个结果通道、不必分辨两种回包
  if (data.type === 'cp-scrape-contest') {
    browser.runtime
      .sendMessage({ action: 'cp-scrape-contest', requestId, url: data.url })
      .then(result => {
        const reply = result as { accepted?: boolean; reason?: string } | undefined;

        if (reply?.accepted !== true) {
          postToPage('cp-scrape-contest-done', {
            requestId,
            ok: false,
            count: 0,
            reason: reply?.reason ?? 'failed',
          });
        }
      })
      .catch(() =>
        postToPage('cp-scrape-contest-done', { requestId, ok: false, count: 0, reason: 'failed' }),
      );

    return;
  }

  // 网页问「这个浏览器在 Codeforces 上登的是不是我填的那个 handle」。后台只回一个枚举，
  // 这里照原样递回去 —— 桥不解释、也不缓存，答案的新鲜度由后台的会话缓存负责。
  // 后台失联时回 unknown：网站侧会当作「不知道」，界面退回改动前的样子
  if (data.type === 'cp-cf-check') {
    browser.runtime
      .sendMessage({ action: 'cp-cf-check', handle: data.handle })
      .then(result => postToPage('cp-cf-check-result', { requestId, ...(result as object) }))
      .catch(() => postToPage('cp-cf-check-result', { requestId, status: 'unknown' }));

    return;
  }

  // 网页请扩展把当前文件提交到 Codeforces：整趟搬运都在后台与 submitCode 脚本里。
  // 这里只递请求、递「提交成没成」；之后的判定变化由后台广播 cp-submit-status 回来
  if (data.type === 'cp-submit') {
    browser.runtime
      .sendMessage({
        action: 'cp-submit',
        requestId,
        url: data.url,
        sourceCode: data.sourceCode,
        language: data.language,
      })
      .then(result => postToPage('cp-submit-result', { requestId, ...(result as object) }))
      .catch(() => postToPage('cp-submit-result', { requestId, ok: false, reason: 'no-tab' }));
  }
});

browser.runtime.onMessage.addListener(onExtensionMessage);

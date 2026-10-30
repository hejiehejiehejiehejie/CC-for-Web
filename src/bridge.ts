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
 *     回 cp-submit-result）、cp-contest-states / cp-register / cp-start-virtual /
 *     cp-unofficial-rank（比赛动作，回各自那条 *-result，2026-10-26 加）
 *
 * 信封格式（与网站侧 src/composables/useCompanionBridge.js 约定一致）：
 *   扩展 -> 页面 { source: 'competitive-companion', type, ... }
 *   页面 -> 扩展 { source: 'cp-page', type, ... }
 *
 * 【跨仓契约】下面这批消息名（cp-page / cp-task / cp-ping / cp-get-info / cp-info /
 * cp-set-config / cp-config / cp-query-need / cp-need-answer / cp-fill-code /
 * cp-fill-code-result / cp-fill-code-saved / cp-cf-check / cp-cf-check-result /
 * cp-scrape-contest / cp-scrape-contest-done / cp-submit / cp-submit-result /
 * cp-submit-status / cp-contest-states / cp-contest-states-result / cp-register /
 * cp-register-result / cp-start-virtual / cp-start-virtual-result / cp-unofficial-rank /
 * cp-unofficial-rank-result）2026-10-01 与网站一起从 `cph-` 前缀改成 `cp-`。改任何一条都必须
 * 同步改网站侧 useCompanionBridge.js 并同时发新版，否则新旧两边互相认不出、抓题直接失联。
 *
 * 【比赛动作这四对是 2026-10-26 新加的（扩展 2.68.0）】网页读赛程上每一场的报名状态、
 * 请扩展替用户报名 / 开一场 VP、问一场里自己的非正式名次。全部**只在用户显式点按时**发生，
 * 扩展侧只回枚举与数字（见 src/contestActions.ts 与 background.ts 的「比赛动作」那一段）。
 * 受 `capabilities` 里的 contest-schedule / contest-register / contest-virtual /
 * contest-unofficial 保护 —— 老扩展没有这几条，网站上的入口压根不出现。
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
function handlePageMessage(event: MessageEvent): void {
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
        contestId?: string;
        handles?: string[];
        /** cp-register 专用：要不要按「不计分」报名（2026-10-30 加，缺省 = 计分） */
        unrated?: boolean;
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
      .catch(() => postToPage('cp-scrape-contest-done', { requestId, ok: false, count: 0, reason: 'failed' }));

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

  // 网页读 /contests 列表上每一场的报名状态。后台开一页读一次就关，回的是状态枚举表
  if (data.type === 'cp-contest-states') {
    browser.runtime
      .sendMessage({ action: 'cp-contest-states', requestId })
      .then(result => postToPage('cp-contest-states-result', { requestId, ...(result as object) }))
      .catch(() => postToPage('cp-contest-states-result', { requestId, ok: false, reason: 'no-tab', states: {} }));

    return;
  }

  // 网页请扩展替用户报名 / 开一场 VP。**只在用户显式确认后**由网页发起，桥只负责递请求与答案；
  // 后台不当场重试，也不做任何自动报名
  if (data.type === 'cp-register' || data.type === 'cp-start-virtual') {
    browser.runtime
      // unrated 只在「报名」上有意义（2026-10-30 加）：缺省 false = 计分，与老行为一致
      .sendMessage({
        action: data.type,
        requestId,
        contestId: data.contestId,
        unrated: data.unrated === true,
      })
      .then(result => postToPage(`${data.type}-result`, { requestId, ...(result as object) }))
      .catch(() => postToPage(`${data.type}-result`, { requestId, ok: false, reason: 'no-tab' }));

    return;
  }

  // 网页问「这些 handle 在这场里的非正式名次是多少」：回名次数字 + 是不是非正式，不回页面内容。
  // ⚠️ 回包里的那一页叫 `rankSource`，不叫 `source` —— 信封自己的 `source` 是
  // 'competitive-companion' 这个标记，同名字段会在展开时把它盖掉，网页整条消息直接丢掉
  // （2026-10-27 实测：名次永远停在「查询中…」，直到 40 秒超时）。
  if (data.type === 'cp-unofficial-rank') {
    browser.runtime
      .sendMessage({ action: 'cp-unofficial-rank', requestId, contestId: data.contestId, handles: data.handles })
      .then(result => {
        const { source, ...rest } = result as { source?: unknown } & Record<string, unknown>;
        postToPage('cp-unofficial-rank-result', { requestId, ...rest, rankSource: source });
      })
      .catch(() =>
        postToPage('cp-unofficial-rank-result', { requestId, ok: false, reason: 'no-tab', rankSource: '', ranks: [] }),
      );
  }
}

/**
 * 两份监听器只注册一次。
 *
 * 这个脚本有**两条**注入路径：manifest 的 content_scripts（页面加载那一刻）与后台在扩展
 * 启动时给**已经打开**的标签页补注入（background.ts 的 ensureBridges —— 页面开在扩展安装 /
 * 更新 / 重载之前的那些标签页里没有桥，网站探活会一直超时，见网站仓库 HANDOFF §13.7.1）。
 * 两条路径可能落在同一个页面上：重复注册会让同一条 cp-task 转两次、一次 cp-ping 回两条。
 *
 * 标记写在 window 上、写在注册之前：两次注入都落在扩展的**同一个隔离世界**里，
 * 后一份看得见前一份留下的标记。
 */
const bridgeWindow = window as typeof window & { __cpBridgeInstalled?: boolean };

if (bridgeWindow.__cpBridgeInstalled !== true) {
  bridgeWindow.__cpBridgeInstalled = true;

  window.addEventListener('message', handlePageMessage);
  browser.runtime.onMessage.addListener(onExtensionMessage);
}

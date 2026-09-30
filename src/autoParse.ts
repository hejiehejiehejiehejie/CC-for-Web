/**
 * 自动解析脚本：声明式注入到题目**来源**站点（见 src/hosts/targetSites.ts 的
 * AUTO_PARSE_SITE_PATTERNS）。
 *
 * 【它解决的问题】从网页侧抽题面板导入的题没有样例 —— Codeforces 的 problemset 接口不返回
 * 样例，题目页面又没带 CORS 头，网页自己 fetch 不到。于是**用户一打开这道题的页面**，这里就
 * 问一句网页「这道题要不要抓」，要抓就把样例抓下来补进工作区，不必再手动按 Ctrl+Shift+U。
 *
 * 【为什么不按名单判】判断权在网页那一侧：只有它知道这道题在不在工作区里、样例是不是空的。
 * 扩展没有工作区的可见性，硬存一份「待抓名单」既要在两边同步、又会因为网页没开着而记不清账。
 * 改成每次现场问一句（走 bridge.ts 的 cp-query-need / cp-need-answer），账只有一份，就在网页里。
 *
 * 【它自己不做解析】解析逻辑连同进度条都在 js/content.js 里，平时是按需注入的
 * （见 background.ts 的 loadContentScript）。这里只负责「等样例渲染出来」，然后请后台
 * 走一遍那条既有链路 —— 既不用把解析器复制一份，也避开了 content.js 那个一次性监听器
 * （它处理完一条消息就把自己摘掉）被重复注册的麻烦。
 *
 * 【为什么必须等】CF 的题目页是服务端渲染的，document_idle 时样例通常已经在 DOM 里；
 * 但偶尔会晚于脚本出现，不等就解析会抓到空样例 —— 那比不抓更糟，用户会以为已经抓到了。
 */
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';
import { noop } from './utils/noop';

/** 等样例出现的上限。超了就放弃这次，用户重开页面还能再试一次 */
const SAMPLE_TIMEOUT = 20000;
/** 轮询间隔：判定极廉价（两个 querySelector），用轮询而不是 MutationObserver，
 *  免得 CF 成批插入节点时回调次数不可控 */
const POLL_INTERVAL = 250;

/** 样例是否就绪。选择器与 CodeforcesProblemParser 保持一致，且同样要求 input / output 成对 */
function samplesReady(): boolean {
  return document.querySelector('.input pre') !== null && document.querySelector('.output pre') !== null;
}

function waitForSamples(): Promise<boolean> {
  if (samplesReady()) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const deadline = Date.now() + SAMPLE_TIMEOUT;

    const timer = window.setInterval(() => {
      if (samplesReady()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (Date.now() >= deadline) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, POLL_INTERVAL);
  });
}

/**
 * 问后台「当前这个页面要不要抓样例」。后台会把 location.href 转给网页，由网页按
 * 「工作区里认得出这道题、且它的样例为空」来答。回 null 就是不抓。
 */
async function getNeededUrl(): Promise<string | null> {
  try {
    const response = (await browser.runtime.sendMessage({
      action: MessageAction.CheckSampleNeeded,
      payload: { url: window.location.href },
    })) as { url?: unknown } | undefined;

    return typeof response?.url === 'string' ? response.url : null;
  } catch {
    // 后台没醒（扩展刚更新过）或消息通道断了：一律当「不用抓」。
    // 这是扩展内部的问题，不该在用户的题目页上抛错
    return null;
  }
}

async function main(): Promise<void> {
  const neededUrl = await getNeededUrl();
  if (neededUrl === null) {
    return;
  }

  if (!(await waitForSamples())) {
    return;
  }

  // 与点图标 / 按快捷键走的是同一条路：后台注入 js/content.js 再发 Parse
  await browser.runtime.sendMessage({ action: MessageAction.RequestAutoParse }).catch((): null => null);

  // 「抓过没有」不归这里记账：工作区那边一旦拿到样例，下次再问就是「不要抓」，
  // 重复投递也是幂等的（按 url 认题，正文与难度都不动）
}

main().then(noop).catch(noop);

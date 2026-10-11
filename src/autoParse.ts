/**
 * 自动解析脚本：声明式注入到题目**来源**站点（清单由 parser 注册表推导，
 * 见 src/hosts/sourceSitePatterns.ts，注入点见 scripts/build/extension.ts）。
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
 * 【为什么必须等 / 怎么等】不等就解析会抓到空样例，那比不抓更糟：用户会以为已经抓到了。
 * 上游只服务 Codeforces，判据可以是写死的 `.input pre` + `.output pre`；本 fork 覆盖全部
 * 支持的站点，各站结构千差万别，没有通用选择器，于是分两层：
 *   - Codeforces 系（含镜像）：沿用精确判据，行为与改动前完全一致；
 *   - 其余站点：用通用探针 —— 等 readyState 到 complete、且 DOM 规模连续若干轮不变
 *     （说明懒加载 / 客户端渲染已经收尾）、且页面上确实有像样例的元素（pre / textarea /
 *     code / table）。这是启发式，宁可判「没好」也不能判「好了但其实是空的」。
 * 两层都受 SAMPLE_TIMEOUT 约束，超时就放弃这次，用户重开页面还能再试。
 *
 * 【捎带回报登录态】本脚本的注入面是**整个来源站点域**（Codeforces 那条是
 * `https://codeforces.com/*`，不只有题目页），所以用户只要在浏览器里开过任意一个 Codeforces
 * 页面，它就已经在场了。顺手读一次页面上公开可见的登录用户名报给后台（由后台存进会话级缓存），
 * 网站的云同步面板就能提前说清「这个浏览器登的是不是你」——不必等用户白点一次代填才报错。
 * 这一趟**不发任何请求、不开标签页、不读 cookie**，判据见 src/cfIdentity.ts；只认正牌
 * codeforces.com，镜像不认（那边是另一套会话）。
 */
import { currentHandle, hasLoginForm, isCodeforcesSite } from './cfIdentity';
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';
import { noop } from './utils/noop';

/** 等样例出现的上限。超了就放弃这次，用户重开页面还能再试一次 */
const SAMPLE_TIMEOUT = 20000;
/** 轮询间隔：判据极廉价（几个 querySelector），用轮询而不是 MutationObserver，
 *  免得页面成批插入节点时回调次数不可控 */
const POLL_INTERVAL = 250;
/** 通用探针：DOM 规模要连续这么多轮不变，才认为渲染收尾（3 × 250ms = 750ms） */
const STABLE_ROUNDS = 3;
/** 通用探针的「样例可能在这儿」信号：这些标签里至少出现一个 */
const SAMPLE_TAGS = ['pre', 'textarea', 'code', 'table'];

/** Codeforces 及其镜像 —— 这些域走精确判据，零回归 */
const CODEFORCES_HOST = /(^|\.)codeforces\.(com|ml)$/;

function isCodeforcesHost(): boolean {
  return CODEFORCES_HOST.test(window.location.hostname);
}

/** 精确判据：与 CodeforcesProblemParser 保持一致，要求 input / output 成对 */
function codeforcesSamplesReady(): boolean {
  return document.querySelector('.input pre') !== null && document.querySelector('.output pre') !== null;
}

/** 通用判据的「像样例」部分：页面上至少有一个可能承载样例的元素 */
function hasSampleLikeElement(): boolean {
  return SAMPLE_TAGS.some(tag => document.querySelector(tag) !== null);
}

/**
 * DOM 规模的廉价指纹：元素数量 + 正文长度。两者一起涨说明页面还在渲染；
 * 连续多轮不变就当作渲染结束。不做 innerHTML 序列化，避免每轮一次的额外开销。
 */
function domFingerprint(): number {
  const body = document.body;
  if (body === null) {
    return 0;
  }

  return body.getElementsByTagName('*').length * 100000 + (body.textContent ?? '').length;
}

function waitForSamples(): Promise<boolean> {
  const precise = isCodeforcesHost();

  if (precise && codeforcesSamplesReady()) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const deadline = Date.now() + SAMPLE_TIMEOUT;
    let lastFingerprint = -1;
    let stableRounds = 0;

    // 通用判据：先更新「连续几轮没变」，再综合三个条件 —— 加载已收尾、DOM 不再变、
    // 页面上有像样例的东西。计数状态就放在这个闭包里。
    const genericSettled = (): boolean => {
      const current = domFingerprint();
      stableRounds = current === lastFingerprint ? stableRounds + 1 : 0;
      lastFingerprint = current;

      return document.readyState === 'complete' && stableRounds >= STABLE_ROUNDS && hasSampleLikeElement();
    };

    const timer = window.setInterval(() => {
      if (precise ? codeforcesSamplesReady() : genericSettled()) {
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

/**
 * 捎带把「这个浏览器在 Codeforces 上登的是谁」报给后台，由它存进会话级缓存。
 *
 * fire-and-forget：回报失败（后台没醒、扩展刚更新过）只是让网站那边退回 unknown，
 * 与这次抓题毫无关系，绝不能因为它影响页面。
 *
 * 只在正牌 codeforces.com 上做，且**每个页面加载只报一次** —— 这是极廉价的一读一报，
 * 后台还会按值去重，不会因为用户在 CF 上多开几页而反复写缓存。
 */
function reportCfIdentity(): void {
  if (!isCodeforcesSite()) {
    return;
  }

  browser.runtime
    .sendMessage({
      action: MessageAction.ReportCfIdentity,
      payload: { handle: currentHandle(), loggedOut: hasLoginForm() },
    })
    .catch(noop);
}

async function main(): Promise<void> {
  reportCfIdentity();

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

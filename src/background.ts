import type { Menus, Runtime, Tabs } from 'webextension-polyfill';
import { getHosts } from './hosts/hosts';
import { TARGET_SITE_PATTERNS } from './hosts/targetSites';
import { Message, MessageAction } from './models/messaging';
import { browser } from './utils/browser';
import { config } from './utils/config';
import { sendToContent } from './utils/messaging';
import { noop } from './utils/noop';
import { request, requiredPermissions } from './utils/request';

declare global {
  const PARSER_NAMES: string[];
}

/**
 * 清掉上一次运行留下的一整套菜单。
 *
 * `contextMenus.removeAll` 在 Firefox（webextension-polyfill）上是 Promise、在老一点的
 * Chrome 上只认回调；两种都接上，别让「清完了没」这件事靠猜 —— 没清干净的话下面每一次
 * create 都会撞「Cannot create item with duplicate id」。
 */
function clearContextMenus(): Promise<void> {
  return new Promise(resolve => {
    try {
      const returned = (browser.contextMenus.removeAll as (cb?: () => void) => unknown)(resolve);

      if (returned !== null && typeof returned === 'object' && 'then' in (returned as object)) {
        (returned as Promise<void>).then(resolve, resolve);
      }
    } catch {
      resolve();
    }
  });
}

async function createContextMenu(): Promise<void> {
  // Firefox for Android 上 contextMenus 整个命名空间不存在（MDN BCD: menus = ff_android false），
  // 这里也会抛 TypeError，所以先挡一下。桌面端行为不变。
  if (!browser.contextMenus) {
    return;
  }

  // 【必须幂等】菜单跟着 profile 持久化，而 onInstalled 在扩展更新、Chrome 自身升级时都会再触发
  // 一次。不先清空的话，上一次建的 163 个 id 还在，再 create 就是 163 条
  // 「Cannot create item with duplicate id parse-with-<Parser>」（2.68.1 更新后实测满屏都是）。
  await clearContextMenus();

  browser.contextMenus.create({
    id: 'parse-with',
    title: 'Parse with',
    contexts: ['action'],
  });

  browser.contextMenus.create({
    id: 'problem-parser',
    parentId: 'parse-with',
    title: 'Problem parser',
    contexts: ['action'],
  });

  browser.contextMenus.create({
    id: 'contest-parser',
    parentId: 'parse-with',
    title: 'Contest parser',
    contexts: ['action'],
  });

  for (const parser of PARSER_NAMES) {
    const isContestParser = parser.endsWith('ContestParser');

    browser.contextMenus.create({
      id: `parse-with-${parser}`,
      parentId: `${isContestParser ? 'contest' : 'problem'}-parser`,
      title: parser,
      contexts: ['action'],
    });
  }
}

async function loadContentScript(tab: Tabs.Tab, parserName: string): Promise<void> {
  // 点图标 / 按快捷键这条链路全程没有任何界面反馈：里面任何一步失败，用户看到的就是
  // 「按了没反应」，错误只留在 service worker 控制台里（unhandled rejection）。
  // 所以整段包了 try/catch，失败时用系统通知说明原因。
  try {
    // 拿不到 url 说明这个标签页没有授权（chrome:// 等特权页面，或 host 权限被收走），
    // 以前这里会直接 TypeError 变成静默失败
    const url = tab.url ?? '';

    if (url.length === 0) {
      await notify(
        INJECT_FAILED_NOTIFICATION_ID,
        '无法解析当前页面：读不到这个标签页的地址。请在题目页面上重试，或检查扩展的「网站访问权限」是否被设成了特定站点。',
      );

      return;
    }

    // localhost 的 host 权限已经在 manifest 的 host_permissions 里静态声明（见 scripts/build/extension.ts），
    // 所以这里只需要按站点补请求解析用的那几条可选权限
    const permissionOrigins: string[] = [];

    for (const prefix in requiredPermissions) {
      if (url.startsWith(prefix)) {
        permissionOrigins.push(requiredPermissions[prefix]);
      }
    }

    if (permissionOrigins.length > 0) {
      await browser.permissions.request({ origins: permissionOrigins });
    }

    await browser.scripting.executeScript({
      target: {
        tabId: tab.id,
      },
      files: ['js/content.js'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    await notify(
      INJECT_FAILED_NOTIFICATION_ID,
      `解析脚本注入失败：${message}。如果扩展目录被重新构建过，请在 chrome://extensions 里点一次「重新加载」。`,
    );

    return;
  }

  sendToContent(tab.id, MessageAction.Parse, { parserName });
}

function onAction(tab: Tabs.Tab): void {
  loadContentScript(tab, null);
}

function onContextMenu(info: Menus.OnClickData, tab: Tabs.Tab): void {
  if (info.menuItemId.toString().startsWith('parse-with-')) {
    const parserName = info.menuItemId.toString().split('parse-with-').pop();
    loadContentScript(tab, parserName);
  }
}

const NO_RECEIVER_NOTIFICATION_ID = 'cp-no-receiver';
const INJECT_FAILED_NOTIFICATION_ID = 'cp-inject-failed';

/** 系统通知的统一出口：通知本身失败（例如用户关掉了通知权限）不影响主流程 */
async function notify(id: string, message: string): Promise<void> {
  try {
    await browser.notifications.create(id, {
      type: 'basic',
      // 必须给绝对 URL：给 'icons/icon-128.png' 这种相对路径时 Chrome 会直接报
      // 「Unable to download all specified images.」，通知一条都弹不出来
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title: 'CC for Web',
      message,
    });
  } catch {
    //
  }
}

async function notifyNoReceiver(): Promise<void> {
  await notify(
    NO_RECEIVER_NOTIFICATION_ID,
    '没有找到接收端：请先打开题目管理网站，或确认本地工具（VS Code 的 CPH、CP Editor 等）正在运行。',
  );
}

async function sendTask(tabId: number, messageId: string, data: string): Promise<void> {
  try {
    const hosts = await getHosts();
    const results = await Promise.allSettled(hosts.map(host => host.send(data)));
    const delivered = results.some(result => result.status === 'fulfilled');

    // 选项页把两侧都关掉时 hosts 为空，此时没投递是用户的选择，不该拿「没有接收端」去打扰他
    if (!delivered && hosts.length > 0) {
      await notifyNoReceiver();
    }

    // 这里刻意回 Done 而非 Failed：content.ts 收到 SendTaskFailed 会在 OJ 页面上弹出
    // 一句写死的 "Something went wrong while running ..."，与「没有接收端」这个真实原因对不上。
    // 用户提示由上面的系统通知承担。
    sendToContent(tabId, MessageAction.SendTaskDone, { messageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    sendToContent(tabId, MessageAction.SendTaskFailed, { messageId, message });
  }
}

async function makeRequest(
  tabId: number,
  messageId: string,
  url: string,
  options: RequestInit,
  retries: number,
): Promise<void> {
  const permissionGranted = await browser.permissions.contains({ origins: [url] });
  if (!permissionGranted) {
    sendToContent(tabId, MessageAction.FetchFailed, {
      messageId,
      message: `Competitive Companion does not have permission to request ${url}`,
    });

    return;
  }

  try {
    const content = await request(url, options, retries);
    sendToContent(tabId, MessageAction.FetchResult, { messageId, content });
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    sendToContent(tabId, MessageAction.FetchFailed, { messageId, message });
  }
}

// ------------------------------------------------------------ 整场抓样例（网页发起）
//
// 【干什么】网页把一场比赛的题目列表地址（`/contest/{id}/problems`）递过来，这里开一个
// **不激活的标签页**把它读一遍，解析结果照常逐题投递给网页 —— 网页那边不需要为「补样例」
// 再造一条入库路径，收到题目就按 url 并进已有的题里（见站点侧 importProblem）。
//
// 【为什么非要在扩展里做】Codeforces 的题目页没有 CORS 头，网页 fetch 不到 HTML；而整场题面
// 在这一页上就全都在（实测 2276：7 个 `.problem-frames > div`、7 组 `.input pre`），
// 所以只要有一个带用户登录态的浏览器上下文读一遍就够了。
//
// 【为什么开标签页而不是后台直接 fetch】解析器要 `DOMParser` 与真实 DOM 选择器，而 MV3 的
// service worker 里没有 DOM。开一个 active:false 的标签页拿到的是真实渲染结果，Cloudflare
// 挑战也交给浏览器自己去过 —— 这两件在后台 fetch 里都做不到。
//
// 【进度与收尾靠什么】解析完由 content.js 逐题 `.send()`，每题一条 SendTask 回到这里；
// 这里数着条数，凑满 `batch.size` 就收尾。不另造一条进度消息：这批题本来就会一条条
// 投给网页，网页自己也能数。
//
// 【为什么一次只许一场】两场同时跑会在同一条投递通道上混账，谁也说不清哪条属于哪批。

/** 等标签页 load 完的上限。CF 慢的时候 10 秒都正常，别卡太紧 */
const SCRAPE_LOAD_TIMEOUT = 45000;
/** 整趟的上限：load + 解析 + 逐题投递 */
const SCRAPE_TOTAL_TIMEOUT = 120000;
/** 最后一题投递完到关标签页之间的缓冲：SendTaskDone 还要送回那个标签页 */
const SCRAPE_CLOSE_DELAY = 300;

interface PendingScrape {
  requestId: string;
  tabId: number;
  /** 这批一共几题（从第一条投递的 `batch.size` 学来）；0 = 还没学到 */
  expected: number;
  received: number;
  timer?: ReturnType<typeof setTimeout>;
}

let activeScrape: PendingScrape | null = null;

/** 结果广播给本站每一个标签页（同站多开时都该知道），哪个都没开着就悄悄结束 */
async function broadcastToSite(action: string, payload: Record<string, unknown>): Promise<void> {
  const tabs = await browser.tabs.query({ url: TARGET_SITE_PATTERNS }).catch((): Tabs.Tab[] => []);

  await Promise.all(
    tabs.map(tab =>
      typeof tab.id === 'number'
        ? browser.tabs.sendMessage(tab.id, { action, payload }).catch(noop)
        : Promise.resolve(),
    ),
  );
}

function finishScrape(scrape: PendingScrape, result: { ok: boolean; count: number; reason?: string }): void {
  if (scrape.timer !== undefined) {
    clearTimeout(scrape.timer);
  }

  if (activeScrape === scrape) {
    activeScrape = null;
  }

  browser.tabs.remove(scrape.tabId).catch(noop);
  broadcastToSite('cp-scrape-contest-done', {
    requestId: scrape.requestId,
    ok: result.ok,
    count: result.count,
    reason: result.reason ?? '',
  }).catch(noop);
}

/** 轮询标签页的 load 状态：不挂 onUpdated 是为了免去「监听器什么时候摘掉」这笔账 */
async function waitForTabLoaded(tabId: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === 'complete') {
        return true;
      }
    } catch {
      // 标签页被用户关了
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return false;
}

/**
 * 开一趟整场抓取。返回 `accepted` 只表示「已经开跑」，最终成败由
 * `cp-scrape-contest-done` 广播回来 —— 网页拿到 accepted 就可以先挂上「抓取中」。
 */
async function scrapeContest(requestId: unknown, url: unknown): Promise<{ accepted: boolean; reason?: string }> {
  if (activeScrape !== null) {
    return { accepted: false, reason: 'busy' };
  }

  if (typeof url !== 'string' || !/^https?:\/\/([^/]*\.)?codeforces\.(com|ml|net|es)\//i.test(url)) {
    return { accepted: false, reason: 'bad-url' };
  }

  let tabId: number;
  try {
    const tab = await browser.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') {
      return { accepted: false, reason: 'tab-failed' };
    }

    tabId = tab.id;
  } catch {
    return { accepted: false, reason: 'tab-failed' };
  }

  const scrape: PendingScrape = {
    requestId: typeof requestId === 'string' ? requestId : '',
    tabId,
    expected: 0,
    received: 0,
  };

  activeScrape = scrape;
  scrape.timer = setTimeout(
    () => finishScrape(scrape, { ok: false, count: scrape.received, reason: 'timeout' }),
    SCRAPE_TOTAL_TIMEOUT,
  );

  // 等页面、注入解析器、发 Parse。这一段不挡网页：它已经拿到 accepted 了
  void (async () => {
    if (!(await waitForTabLoaded(tabId, SCRAPE_LOAD_TIMEOUT))) {
      finishScrape(scrape, { ok: false, count: 0, reason: 'load-failed' });
      return;
    }

    // content.js 是一次性监听器（处理完一条消息就摘掉），每次解析前都要重新注入
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ['js/content.js'] });
    } catch {
      finishScrape(scrape, { ok: false, count: 0, reason: 'inject-failed' });
      return;
    }

    try {
      await browser.tabs.sendMessage(tabId, {
        action: MessageAction.Parse,
        payload: { parserName: 'CodeforcesContestParser' },
      });
    } catch {
      finishScrape(scrape, { ok: false, count: 0, reason: 'parse-failed' });
    }
  })();

  return { accepted: true };
}

/** 数一条投递：凑满 `batch.size` 就安排收尾 */
function noteScrapeDelivery(raw: unknown): void {
  const scrape = activeScrape;
  if (scrape === null) {
    return;
  }

  scrape.received += 1;

  if (scrape.expected === 0 && typeof raw === 'string') {
    try {
      const size = JSON.parse(raw)?.batch?.size;
      if (typeof size === 'number' && size > 0) {
        scrape.expected = size;
      }
    } catch {
      // 认不出 batch 就按「来一条算一条」，最后由总超时收尾
    }
  }

  if (scrape.expected > 0 && scrape.received >= scrape.expected) {
    // 缓冲一下再关：最后一题的 SendTaskDone 还要送回那个标签页
    setTimeout(() => finishScrape(scrape, { ok: true, count: scrape.received }), SCRAPE_CLOSE_DELAY);
  }
}

/** 允许网页修改的配置键白名单：只放投递目标开关，别的键一律不认 */
const WRITABLE_CONFIG_KEYS = ['sendToWebPage', 'sendToLocalTools'] as const;
type WritableConfigKey = (typeof WRITABLE_CONFIG_KEYS)[number];

interface ExtensionInfo {
  version: string;
  commands: Array<{ name: string; description: string; shortcut: string }>;
  config: Record<WritableConfigKey, boolean>;
  /**
   * 这台扩展**会做**的事（2026-10-11 新增）。网站按它决定要不要显示某些按钮，
   * 而不是去比版本号大小 —— 那笔账一旦记错方向就反了，且每加一条能力都得回来改比较逻辑。
   *
   * `fill-code`：能替用户在 Codeforces 上代填云同步的验证码（见 src/fillCode.ts）。
   *  网站拿不到这一条就不显示代填按钮，行为与老版本完全一致 —— 这正是「加一对消息
   *  不必两边同版发布」的前提：老网站会忽略这个字段，老扩展也不会有这个字段。
   * `cf-check`：能回答「这个浏览器在 Codeforces 上登的是不是你填的那个 handle」
   *  （见下面 Codeforces 登录态那一段与 src/cfIdentity.ts）。站点拿不到这一条就不问，
   *  界面维持「失败后才知道」的现状。
   * `fill-saved`：代填这一趟会**自己跑到保存落下去**，然后（1）关掉它自己开的那个
   *  Codeforces 标签页、（2）回一条 `cp-fill-code-saved` 告诉网页「可以验证了」（2026-10-20 加，
   *  见下面 finishCodeFill）。站点拿不到这一条就照旧让用户自己点验证，也就不会去等那条回报。
   * `submit-code`：能把网页递来的源码提交到 Codeforces，并轮询判定推回网页（2026-10-23 加，
   *  见下面 submitOnCodeforces 与 src/submitCode.ts）。站点拿不到这一条就不显示提交按钮，
   *  行为与老版本完全一致。
   */
  capabilities: string[];
}

const CAPABILITIES = [
  'fill-code',
  'cf-check',
  'contest-batch',
  'fill-saved',
  'submit-code',
  // 比赛动作（2026-10-26 加，见下面「比赛动作」那一段与 src/contestActions.ts）：
  //   contest-schedule   —— 能读 /contests 列表上每一场的报名状态
  //   contest-register   —— 能替用户在 CF 上提交报名表单（仅在用户显式点按确认后）
  //   contest-virtual    —— 能替用户开一场 VP（同上）
  //   contest-unofficial —— 能读某一场里指定 handle 的非正式名次
  'contest-schedule',
  'contest-register',
  'contest-virtual',
  'contest-unofficial',
  // 报名时能选「不计分」（2026-10-30 加）：只有允许 unrated 的轮次，CF 的报名表单里才有那颗
  // 控件；网站拿到这一条才在确认卡片上摆「计分 / 不计分」，老扩展下那一行不出现
  'contest-register-unrated',
  // 开 VP 时能拨「Virtual start time」（2026-11-03 加）：网站拿到这一条才在确认卡片上摆
  // 开始时间。老扩展不认识 `startAt`，会按「现在开始」提交 —— 那等于把用户选的时间悄悄吃掉，
  // 所以站点先看能力位，没有就整行不出现
  'contest-virtual-start-time',
];

/**
 * commands 在 Firefox for Android 上也整个不存在（MDN BCD: ff_android = false），
 * 拿不到就回空数组：握手只要「有 info」就算已安装，快捷键列表为空即可
 * （安卓本来也没有键盘快捷键可显示）。
 */
async function getCommands(): Promise<Array<{ name?: string; description?: string; shortcut?: string }>> {
  if (!browser.commands) {
    return [];
  }

  try {
    return await browser.commands.getAll();
  } catch {
    return [];
  }
}

/**
 * 供目标网站通过桥接脚本（src/bridge.ts）握手查询：
 * 版本号用于网站判断扩展是否已安装，commands 用于展示扩展的快捷键绑定，
 * config 是投递目标开关的当前值（网站据此渲染开关状态）。
 * 注意：Chrome 没有任何 API 能让网页改写这些快捷键，网站只能展示 + 引导用户去
 * chrome://extensions/shortcuts 手动改（网页也无法直接跳转到 chrome:// 地址）。
 */
async function getExtensionInfo(): Promise<ExtensionInfo> {
  const [commands, sendToWebPage, sendToLocalTools] = await Promise.all([
    getCommands(),
    config.get('sendToWebPage'),
    config.get('sendToLocalTools'),
  ]);

  return {
    version: browser.runtime.getManifest().version,
    commands: commands.map(command => ({
      name: command.name ?? '',
      description: command.description ?? '',
      shortcut: command.shortcut ?? '',
    })),
    config: { sendToWebPage, sendToLocalTools },
    capabilities: CAPABILITIES,
  };
}

/** 写入投递目标开关。只认白名单键与布尔值，其余一律拒绝，避免网页乱改存储 */
async function setConfig(key: unknown, value: unknown): Promise<boolean> {
  if (typeof key !== 'string' || !WRITABLE_CONFIG_KEYS.includes(key as WritableConfigKey)) {
    return false;
  }

  if (typeof value !== 'boolean') {
    return false;
  }

  await config.set(key as WritableConfigKey, value);
  return true;
}

/** 等网页回答「这道题要不要抓」的上限。与 bridge.ts 里的同名上限对齐：加一层保险，
 *  桥接脚本不在（扩展刚重载、目标站标签页没刷新）时也一定能结算 */
const NEED_QUERY_TIMEOUT = 2500;

/**
 * 问目标网站的标签页「这道题要不要抓」。
 *
 * 判断权在网页那一侧：它比扩展更清楚「这道题在不在我的工作区里、样例是不是空的」
 * （扩展没有工作区的可见性）。扩展只负责把页面地址转过去，再把网页的答复汇总回来。
 *
 * 同站多开时全问一遍，任意一个说「要」就算要 —— 投递本来也是往所有标签页广播。
 */
async function queryPageNeed(url: unknown): Promise<boolean> {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  const tabs = await browser.tabs.query({ url: TARGET_SITE_PATTERNS });
  const tabIds = tabs.map(tab => tab.id).filter((id): id is number => typeof id === 'number');

  if (tabIds.length === 0) {
    return false;
  }

  const answers = await Promise.all(
    tabIds.map(async tabId => {
      try {
        const response = (await Promise.race([
          browser.tabs.sendMessage(tabId, { action: 'cp-query-need', payload: { url } }),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), NEED_QUERY_TIMEOUT)),
        ])) as { need?: unknown } | undefined;

        return response?.need === true;
      } catch {
        // 桥接脚本尚未注入（扩展刚重载、标签页没刷新）：这一页当作「不要」
        return false;
      }
    }),
  );

  return answers.some(Boolean);
}

/** Codeforces 的 Social 设置页 —— Last name 那一栏只在这一页上，也是代填脚本的注入范围 */
const CF_SOCIAL_URL = 'https://codeforces.com/settings/social';

/** 等标签页加载完成的轮询间隔与上限（新开一页要几秒，所以给得比别处宽） */
const TAB_POLL_INTERVAL = 200;
const TAB_LOAD_TIMEOUT = 15000;
/** 等内容脚本回话的上限。它只做几次 querySelector，正常是毫秒级 */
const FILL_RESPONSE_TIMEOUT = 5000;

interface FillResult {
  ok: boolean;
  reason?: string;
}

/**
 * 一趟代填的结果 + 它用过的那个标签页。
 *
 * `tabId` / `created` 是 2026-10-20 为「填完就收工」加的：**只有扩展自己开的页才关**，
 * 用户自己开在 Social 一页上的标签页不动 —— 他可能正拿那一页看别的东西，
 * 替他关掉等于替他决定那个标签页没用了。
 */
interface FillOutcome {
  result: FillResult;
  tabId: number | null;
  created: boolean;
}

/**
 * 轮询到标签页加载完成。被关掉 / 拿不到状态都算失败 —— 调用方把它折成「没能打开设置页」。
 *
 * ⚠️ 只认 `status === 'complete'` 不够：**新建的标签页在导航真正开始之前就可能报 complete**
 * （那会儿地址还是 `about:blank`）。一键提交会因此在空白页上问内容脚本、当然没人应答，
 * 最后报「提交页认不出来」并把标签页关掉（2026-10-23 实报）。所以还要确认它已经落在
 * 真的文档上（http / https）。
 */
function isRealDocument(url: string | undefined): boolean {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

async function waitForTabComplete(tabId: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const tab = await browser.tabs.get(tabId);

      if (tab.status === 'complete' && isRealDocument(tab.url)) {
        return true;
      }
    } catch {
      return false;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, TAB_POLL_INTERVAL));
  }
}

/**
 * 等到这一页的 DOM 可以读（DOMContentLoaded）就返回，不等 `load`。
 *
 * 【为什么读类动作用它】CF 的比赛表格是服务端渲染的，DOM 一解析完就在文档里；
 * 而 `load` 还要等广告、统计脚本这些与内容无关的资源（2026-10-29 实测 /contests/page/1：
 * 表格 3.0 s 可读，`load` 5.3–5.9 s）。等 `load` 每次白等两三秒，CF 再慢一点就顶到
 * TAB_LOAD_TIMEOUT，整条读失败 —— 报名状态那一列直接显示成「—」。
 *
 * 【判据为什么是 readyState 而不是找表格】认页面的活只能有一个出处：脚本在不在、这是挑战页
 * 还是登录页，全交给 contestActions.js 里的 pageProblem（见 src/cfIdentity.ts）。这里只负责
 * 「文档能不能读」，读到之后由内容脚本自己回答。
 */
async function waitForTabDom(tabId: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const [frame] = await browser.scripting.executeScript({
        target: { tabId },
        func: () => document.readyState !== 'loading',
      });

      if (frame?.result === true) {
        return true;
      }
    } catch {
      // 正在导航 / 文档还没建出来：下一轮再问
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, TAB_POLL_INTERVAL));
  }
}

/** 把内容脚本的回应收成结果对象；形状不对就回 null，由调用方当「没答上来」处理 */
function readFillResult(value: unknown): FillResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as { ok?: unknown; reason?: unknown };

  if (typeof record.ok !== 'boolean') {
    return null;
  }

  return { ok: record.ok, reason: typeof record.reason === 'string' ? record.reason : '' };
}

/**
 * 问一次代填脚本，并等它回话。超时被当成「没答上来」而不是失败 —— 两者的处理不同：
 * 没答上来还要再补注入一次脚本（扩展刚重载过、这一页没刷新时就是这样）。
 */
async function askFillCode(tabId: number, handle: string, code: string): Promise<FillResult | null> {
  const response = (await Promise.race([
    browser.tabs.sendMessage(tabId, { action: MessageAction.FillCode, payload: { handle, code } }),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), FILL_RESPONSE_TIMEOUT)),
  ])) as unknown;

  return readFillResult(response);
}

/**
 * 替用户在 Codeforces 上把云同步的验证码填进 Last name 并保存（网站侧点颗按钮发起一次）
 *
 * 【为什么由扩展做】网站自己做不到：它拿不到 Codeforces 的 DOM（跨源）。而这一步必须在
 * **带着用户登录态**的 Codeforces 页面上完成，正是扩展的地盘。整趟都发生在浏览器里，
 * 扩展只回一个原因枚举，从不回传 cookie 或页面内容 —— 服务端的信任模型一字不变。
 *
 * 【标签页策略】已经开在 Social 一页上的标签页优先复用（不动用户的标签页）；否则新开一个
 * 并让它到前台 —— 这样用户能亲眼看到填了什么，没登录时也能就地在那一页登录后重试。
 * 刻意**不**把已有标签页导航走：用户可能正在那上面做别的事（比如正在交题）。
 *
 * 【填完之后】2026-10-20 起这一趟不止「把字填进去」，还要跟到**保存真的落下去**为止，
 * 好让网页立刻接着验证（见 finishCodeFill）。所以返回值多带了它用过的标签页 ——
 * 收尾那一步要拿它去听跳转、并在成功之后关掉（仅限扩展自己开的页）。
 *
 * 失败时一律**不关标签页**：无论是没登录还是页面认不出来，用户都需要那一页在手边。
 */
async function fillCodeOnCodeforces(handle: unknown, code: unknown): Promise<FillOutcome> {
  if (typeof code !== 'string' || code.length === 0) {
    return { result: { ok: false, reason: 'page' }, tabId: null, created: false };
  }

  const handleName = typeof handle === 'string' ? handle : '';

  let tabId: number | undefined;
  let created = false;

  try {
    const existing = await browser.tabs.query({ url: [`${CF_SOCIAL_URL}*`] });
    tabId = existing.map(tab => tab.id).find((id): id is number => typeof id === 'number');
  } catch {
    tabId = undefined;
  }

  if (tabId === undefined) {
    try {
      const tab = await browser.tabs.create({ url: CF_SOCIAL_URL });
      tabId = typeof tab.id === 'number' ? tab.id : undefined;
      created = tabId !== undefined;
    } catch {
      tabId = undefined;
    }
  }

  if (tabId === undefined) {
    return { result: { ok: false, reason: 'no-tab' }, tabId: null, created: false };
  }

  const used = tabId;

  if (!(await waitForTabComplete(used, TAB_LOAD_TIMEOUT))) {
    return { result: { ok: false, reason: 'no-tab' }, tabId: used, created };
  }

  try {
    const answer = await askFillCode(used, handleName, code);

    if (answer !== null) {
      return { result: answer, tabId: used, created };
    }

    // 没有应答：多半是这一页在扩展重载之前就开着，代填脚本不在。补注入一次再问
    await browser.scripting.executeScript({ target: { tabId: used }, files: ['js/fillCode.js'] });

    const retry = await askFillCode(used, handleName, code);

    return { result: retry ?? { ok: false, reason: 'page' }, tabId: used, created };
  } catch {
    return { result: { ok: false, reason: 'page' }, tabId: used, created };
  }
}

/**
 * 提交之后那次整页跳转最多等多久。
 *
 * CF 的 Social 表单是普通 POST，回来还是 `/settings/social` —— **URL 不会变**，所以
 * 「保存成功了」只能从 status 的 `loading` → `complete` 这一趟看出来。平时一两百毫秒就完。
 */
const FILL_SAVE_TIMEOUT = 10000;

/**
 * 等这一次提交真的走完一趟跳转（loading → complete）。
 *
 * 必须在代填脚本回话**之后**才开始听，而它 sendResponse 之后还要等 50ms 才点提交
 * （见 fillCode.ts 的 SUBMIT_DELAY），这段时间足够把监听挂上。也刻意不用轮询：
 * 一次很快的 POST 可能整个落在两次轮询之间，那就白等了。
 */
function waitForTabReload(tabId: number, timeout: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let sawLoading = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (saved: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      resolve(saved);
    };

    function onUpdated(id: number, changeInfo: Tabs.OnUpdatedChangeInfoType): void {
      if (id !== tabId) {
        return;
      }

      if (changeInfo.status === 'loading') {
        sawLoading = true;

        return;
      }

      if (changeInfo.status === 'complete' && sawLoading) {
        finish(true);
      }
    }

    browser.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => finish(false), timeout);
  });
}

/**
 * 代填的收尾：等保存落下去 → 关掉扩展自己开的那个标签页 → 告诉网页「可以验证了」。
 *
 * 【为什么由扩展回报，而不是网页自己等一个固定延时】网页看不到 Codeforces 那一侧什么时候
 * 真的保存好：猜短了验证必被打回（服务端读到的还是旧 Last name），猜长了白转圈。
 * 而这件事只有手里握着那个标签页的人知道。
 *
 * 【只关自己开的页】复用的那个标签页可能是用户自己开着的（他也许正在上面看资料），
 * 替他关掉是越权。于是「关不关」看 `created`，而「能不能验证」看 `saved` —— 两者分开。
 *
 * 【没看到跳转就不关】保存没落下去时用户得能回到那一页看看究竟怎么了，这与
 * 「失败时不关标签页」是同一条纪律。
 */
async function finishCodeFill(requestId: unknown, outcome: FillOutcome): Promise<void> {
  if (outcome.tabId === null) {
    return;
  }

  const saved = await waitForTabReload(outcome.tabId, FILL_SAVE_TIMEOUT);

  if (saved && outcome.created) {
    await browser.tabs.remove(outcome.tabId).catch(noop);
  }

  await broadcastToSite('cp-fill-code-saved', {
    requestId: typeof requestId === 'string' ? requestId : '',
    saved,
  }).catch(noop);
}

// ------------------------------------------------------ 一键提交（网页发起，2026-10-23）
//
// 【干什么】网页把「题目地址 + 当前编辑器正文 + 语言」递过来，这里开一个**后台标签页**把提交页
// 打开、交给 src/submitCode.ts 填表并点提交，然后跟到 `/my` 页上把判定轮询出来，逐次广播给网页。
//
// 【为什么不后台 fetch】提交页要 CSRF token，表单必须从页面自己交出去；而且 Codeforces
// 对 `chrome-extension://` 的 Origin 一向不客气。开一个真实标签页最稳。
//
// 【信任边界】地址不信任网页递来的那一份：parseSubmitTarget 只认四种 Codeforces 题目地址，
// 自己算出提交页；源码原文写进提交框，与用户手工粘贴等价。不读 cookie、不回传页面内容。
//
// 【标签页策略】**总是新开一个后台页**（不复用已有标签页）：用户可能正开着提交页在写别的东西，
// 替他把 textarea 覆盖掉是越权。没登录时把这一页亮出来让用户就地登录并保留；其余失败
// （题目没了 / 编译器没了 / 被拒收 / 读不到提交号）收尾时关掉它 —— 那几页都是扩展自己开的。
// **判定为非 AC 不关**：那一页是用户看「具体怎么错的」的现场，收尾时导航到提交详情页并亮到前台
// （见 watchSubmission）；只有 AC 才收掉。

/** 等提交脚本回话的上限。它只做几次 querySelector + 赋值，正常是毫秒级 */
const SUBMIT_RESPONSE_TIMEOUT = 8000;
/** 点提交之后等整页跳到 `/my` 的上限 */
const SUBMIT_NAV_TIMEOUT = 20000;
/** 判定轮询的总时长与间隔：CF 排队 + 评测通常几十秒，给两分钟足够 */
const SUBMIT_VERDICT_TIMEOUT = 120000;
const SUBMIT_POLL_INTERVAL = 2000;

interface SubmitTarget {
  submitUrl: string;
  myUrl: string;
  /** `contest/2276` / `gym/100001` / `group/123/contest/456`：拼提交详情页要用 */
  base: string;
  index: string;
}

interface SubmitResult {
  ok: boolean;
  reason?: string;
  submissionId?: string;
  verdict?: string;
}

interface SubmissionSnapshot {
  found: boolean;
  submissionId: string;
  verdict: string;
}

/** `/contest/2276/problem/C`、`/gym/100001/problem/A`、`/group/123/contest/456/problem/B` */
const CF_CONTEST_PROBLEM = /^\/(contest\/(\d+)|gym\/(\d+)|group\/(\d+)\/contest\/(\d+))\/problem\/([A-Z]\d{0,2})\/?$/i;
/** `/problemset/problem/2276/C`：与上面是同一道题，提交页在 `/contest/{id}/submit` */
const CF_PROBLEMSET_PROBLEM = /^\/problemset\/problem\/(\d+)\/([A-Z]\d{0,2})\/?$/i;

/**
 * 把网页递来的题目地址解析成提交页与「我的提交」页。只认正牌 codeforces.com ——
 * 镜像站是另一套登录态，替它提交只会把源码交到错误的地方。
 */
function parseSubmitTarget(url: unknown): SubmitTarget | null {
  if (typeof url !== 'string') {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') {
    return null;
  }

  if (parsed.hostname !== 'codeforces.com' && parsed.hostname !== 'www.codeforces.com') {
    return null;
  }

  const contest = CF_CONTEST_PROBLEM.exec(parsed.pathname);
  const problemset = CF_PROBLEMSET_PROBLEM.exec(parsed.pathname);

  if (contest === null && problemset === null) {
    return null;
  }

  const base = contest !== null ? contest[1] : `contest/${problemset![1]}`;
  const index = (contest !== null ? contest[6] : problemset![2]).toUpperCase();

  return {
    submitUrl: `https://codeforces.com/${base}/submit`,
    myUrl: `https://codeforces.com/${base}/my`,
    base,
    index,
  };
}

/** 把内容脚本的回应收成结果对象；形状不对就回 null，由调用方当「没答上来」处理 */
function readSubmitResult(value: unknown): { ok: boolean; reason: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as { ok?: unknown; reason?: unknown };

  if (typeof record.ok !== 'boolean') {
    return null;
  }

  return { ok: record.ok, reason: typeof record.reason === 'string' ? record.reason : '' };
}

function readSubmissionSnapshot(value: unknown): SubmissionSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as { found?: unknown; submissionId?: unknown; verdict?: unknown };

  if (record.found !== true) {
    return null;
  }

  return {
    found: true,
    submissionId: typeof record.submissionId === 'string' ? record.submissionId : '',
    verdict: typeof record.verdict === 'string' ? record.verdict : 'testing',
  };
}

/** 问一次提交脚本；没应答（脚本不在这一页 / 扩展刚重载）回 null */
async function askSubmitCode(
  tabId: number,
  payload: { source: string; language: string; index: string },
): Promise<{ ok: boolean; reason: string } | null> {
  try {
    const response = (await Promise.race([
      browser.tabs.sendMessage(tabId, { action: MessageAction.SubmitCode, payload }),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SUBMIT_RESPONSE_TIMEOUT)),
    ])) as unknown;

    return readSubmitResult(response);
  } catch {
    return null;
  }
}

/** 问一次「这条提交现在什么状态」；失败回 null（下一轮再问） */
async function askReadSubmission(tabId: number, submissionId: string): Promise<SubmissionSnapshot | null> {
  try {
    const response = (await Promise.race([
      browser.tabs.sendMessage(tabId, {
        action: MessageAction.ReadSubmission,
        payload: { submissionId },
      }),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SUBMIT_RESPONSE_TIMEOUT)),
    ])) as unknown;

    return readSubmissionSnapshot(response);
  } catch {
    return null;
  }
}

/** 提交脚本在这一页上不在？补注入一次 —— 多半是这一页在扩展重载之前就开着 */
async function injectSubmitScript(tabId: number, file: string = 'js/submitCode.js'): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [file] });
  } catch {
    // 注入不进去不是错误本身：调用方会再问一次，问不到就按失败收场
  }
}

/** 当前标签页的地址；被关掉 / 读不到时回空串 */
async function tabUrlOf(tabId: number): Promise<string> {
  try {
    return (await browser.tabs.get(tabId)).url ?? '';
  } catch {
    return '';
  }
}

/** 等标签页跳到某个地址并加载完成 */
async function waitForTabUrl(tabId: number, prefix: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const tab = await browser.tabs.get(tabId);

      if (tab.status === 'complete' && (tab.url ?? '').startsWith(prefix)) {
        return true;
      }
    } catch {
      return false;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, TAB_POLL_INTERVAL));
  }
}

/**
 * 盯一条提交的判定，变一次广播一次 `cp-submit-status`。
 *
 * 判定到终态（或总超时）之前，那一页得一直开着让脚本现拉 HTML。
 *
 * 【终态之后分两路】`ac` 收掉这一页；非 AC **留着**，并直接导航到这一条的详情页、亮到前台 ——
 * 用户要看「具体怎么错的」（挂在第几个测试点、编译错误原文、RE 输出），只有 Codeforces 自己的
 * 页面给得出，留在 `/my` 列表上还得再点一次才到得了现场。总超时（还停在 testing）也算非 AC：
 * 同样留着并跳到详情页，让用户自己看那条提交卡在哪。
 * 只关自己开的页（本流程永远是新开的，所以 `created` 恒为真；端口开在这里是为了以后
 * 若改成复用也能一眼看出该看哪个值）。
 */
async function watchSubmission(
  requestId: string,
  tabId: number,
  submissionId: string,
  submissionUrl: string,
  created: boolean,
): Promise<void> {
  const deadline = Date.now() + SUBMIT_VERDICT_TIMEOUT;
  let last = 'testing';
  let injected = false;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SUBMIT_POLL_INTERVAL));

    const snapshot = await askReadSubmission(tabId, submissionId);

    if (snapshot === null) {
      // 这一页的提交脚本不在（扩展重载过 / 页面还没就绪）：补注入一次再问，只补一次
      if (!injected) {
        injected = true;
        await injectSubmitScript(tabId);
      }

      continue;
    }

    if (snapshot.verdict.length === 0 || snapshot.verdict === last) {
      continue;
    }

    last = snapshot.verdict;

    await broadcastToSite('cp-submit-status', { requestId, submissionId, verdict: last }).catch(noop);

    if (last !== 'testing') {
      break;
    }
  }

  if (!created) {
    return;
  }

  if (last === 'ac') {
    await browser.tabs.remove(tabId).catch(noop);
    return;
  }

  await browser.tabs.update(tabId, { url: submissionUrl, active: true }).catch(noop);
}

/**
 * 把网页递来的源码提交到 Codeforces，并在成功之后挂着盯判定。
 *
 * 回给网页的 `cp-submit-result` 只说「表单交出去了没有 + 提交号」，判定走 `cp-submit-status`
 * 这条独立的广播（见 watchSubmission）—— 网页把按钮转圈与结果通知分成两件事处理。
 */
async function submitOnCodeforces(
  requestId: unknown,
  url: unknown,
  source: unknown,
  language: unknown,
): Promise<SubmitResult> {
  const target = parseSubmitTarget(url);

  if (target === null) {
    return { ok: false, reason: 'unsupported-url' };
  }

  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }

  if (typeof language !== 'string' || language.length === 0) {
    return { ok: false, reason: 'language-missing' };
  }

  let tabId: number;

  try {
    const tab = await browser.tabs.create({ url: target.submitUrl, active: false });

    if (typeof tab.id !== 'number') {
      return { ok: false, reason: 'no-tab' };
    }

    tabId = tab.id;
  } catch {
    return { ok: false, reason: 'no-tab' };
  }

  if (!(await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT))) {
    await browser.tabs.remove(tabId).catch(noop);
    return { ok: false, reason: 'no-tab' };
  }

  // 没登录时 CF 会跳到 /enter：把这一页亮出来让用户就地登录，并**保留**它 ——
  // 关掉等于把「去哪儿登录」这个唯一线索也收走了
  if ((await tabUrlOf(tabId)).includes('/enter')) {
    await browser.tabs.update(tabId, { active: true }).catch(noop);
    return { ok: false, reason: 'not-logged-in' };
  }

  const payload = { source, language, index: target.index };

  let answer = await askSubmitCode(tabId, payload);

  if (answer === null) {
    await injectSubmitScript(tabId);
    answer = await askSubmitCode(tabId, payload);
  }

  const result = answer ?? { ok: false, reason: 'page' };

  if (!result.ok) {
    // `not-logged-in` 要亮出来让用户就地登录；`challenge`（Cloudflare 人机验证）与
    // `page`（找不到提交表单）同样留着 —— 那一页就是唯一的线索（验证 / 改版 / 被重定向），
    // 关掉等于把现场一并收走。其余原因（题目没了 / 编译器没了）是确定结论，关掉别堆标签页。
    if (result.reason === 'not-logged-in' || result.reason === 'challenge' || result.reason === 'page') {
      await browser.tabs.update(tabId, { active: true }).catch(noop);
    } else {
      await browser.tabs.remove(tabId).catch(noop);
    }

    return result;
  }

  // 表单已经交出去了：等页面跳到 /my。跳不过去多半是 CF 拒收（重复代码 / 比赛未开始等）
  if (!(await waitForTabUrl(tabId, target.myUrl, SUBMIT_NAV_TIMEOUT))) {
    await browser.tabs.remove(tabId).catch(noop);
    return { ok: false, reason: 'rejected' };
  }

  let snapshot = await askReadSubmission(tabId, '');

  if (snapshot === null) {
    await injectSubmitScript(tabId);
    snapshot = await askReadSubmission(tabId, '');
  }

  if (snapshot === null || snapshot.submissionId.length === 0) {
    // 提交确实交出去了，只是读不到提交号：照实回 ok，判定就盯不成了
    await browser.tabs.remove(tabId).catch(noop);
    return { ok: true, submissionId: '', verdict: 'testing' };
  }

  void watchSubmission(
    typeof requestId === 'string' ? requestId : '',
    tabId,
    snapshot.submissionId,
    `https://codeforces.com/${target.base}/submission/${snapshot.submissionId}`,
    true,
  );

  return { ok: true, submissionId: snapshot.submissionId, verdict: 'testing' };
}

// ------------------------------------------------------- 比赛动作（2026-10-26 加）
//
// 【四条动作的共同形状】开一个后台标签页 → 等它加载 → 让 content script（src/contestActions.ts）
// 在那一页上读一次 / 点一次 → 把结果折成枚举回给网页。网站自己做不到：跨源拿不到 CF 的会话，
// 而报名与开 VP 都必须带着用户的登录态、对着 CF 自己的表单发 POST。
//
// 【与一键提交同一条信任边界】只回原因枚举、状态枚举与名次数字，**不回传页面内容**；
// 报名与开 VP 只在用户显式点按之后发生一次，后台不做轮询、不自动报名。
//
// 【标签页策略】读类动作（报名状态 / 非正式名次）用完就关，不打扰用户；
// 报名与开 VP 失败时**留着并亮出来** —— 那一页就是唯一线索（没登录 / 人机校验 / CF 说没资格），
// 关掉等于把现场一并收走。成功则关掉：报名状态下一次刷新会重新读，不需要它留着。

const CONTEST_ACTIONS_FILE = 'js/contestActions.js';
const CF_CONTESTS_URL = 'https://codeforces.com/contests/page/1';

interface ContestTarget {
  registrationUrl: string;
  virtualUrl: string;
  /** 好友榜（含非正式选手）。登录后一页就能拿到本人与好友，且名次是总榜名次 */
  standingsUrl: string;
}

/** 只认纯数字的比赛号：网页递来的东西一律当不可信输入，拼进 URL 之前先归一化 */
function contestTargetOf(contestId: unknown): ContestTarget | null {
  const id = typeof contestId === 'string' || typeof contestId === 'number' ? String(contestId).trim() : '';

  if (!/^\d+$/.test(id)) {
    return null;
  }

  return {
    registrationUrl: `https://codeforces.com/contestRegistration/${id}`,
    virtualUrl: `https://codeforces.com/contestRegistration/${id}/virtual/true`,
    standingsUrl: `https://codeforces.com/contest/${id}/standings/friends/true?showUnofficial=true`,
  };
}

/** 等这一页可以动到某个程度：`waitForTabComplete`（整页 load 完）或 `waitForTabDom`（DOM 可读） */
type TabReady = (tabId: number, timeout: number) => Promise<boolean>;

/** 开一个不激活的标签页并等它到位；失败（开不出来 / 超时）一律回 null 并收掉半成品 */
async function openSilentCfTab(url: string, ready: TabReady = waitForTabComplete): Promise<number | null> {
  let tabId: number;

  try {
    const tab = await browser.tabs.create({ url, active: false });

    if (typeof tab.id !== 'number') {
      return null;
    }

    tabId = tab.id;
  } catch {
    return null;
  }

  if (!(await ready(tabId, TAB_LOAD_TIMEOUT))) {
    await browser.tabs.remove(tabId).catch(noop);
    return null;
  }

  return tabId;
}

/**
 * 问一次比赛动作脚本。
 *
 * `inject` 只给**读类**动作用：这一页是刚开的，声明式注入本来就该在；补注入只是兜底
 * （扩展在这页打开前刚被重载过）。报名 / 开 VP 坚决不补注入 —— 万一第一份脚本其实
 * 只是慢了半拍，补注入会让同一个表单被交两次，那是不可逆的。
 */
async function askContestAction(
  tabId: number,
  action: MessageAction,
  payload: Record<string, unknown> = {},
  inject = false,
): Promise<unknown> {
  const ask = async (): Promise<unknown> => {
    try {
      return await Promise.race([
        browser.tabs.sendMessage(tabId, { action, payload }),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SUBMIT_RESPONSE_TIMEOUT)),
      ]);
    } catch {
      return undefined;
    }
  };

  const answer = await ask();

  if (answer !== undefined || !inject) {
    return answer;
  }

  await injectSubmitScript(tabId, CONTEST_ACTIONS_FILE);

  return ask();
}

const REGISTRATION_STATES = ['open', 'before', 'closed', 'registered', 'count', 'unknown'];

/** 把内容脚本的报名状态回执收成白名单过的形状：认不出的值一律丢掉，网站按「—」显示 */
function readStatesReply(value: unknown): { ok: boolean; reason: string; states: Record<string, string> } {
  const record = value as { ok?: unknown; reason?: unknown; states?: unknown } | null | undefined;
  const states: Record<string, string> = {};

  if (typeof record?.states === 'object' && record.states !== null) {
    for (const [id, state] of Object.entries(record.states as Record<string, unknown>)) {
      if (/^\d+$/.test(id) && typeof state === 'string' && REGISTRATION_STATES.includes(state)) {
        states[id] = state;
      }
    }
  }

  return {
    ok: record?.ok === true,
    reason: typeof record?.reason === 'string' ? record.reason : 'page',
    states,
  };
}

interface RankEntry {
  handle: string;
  rank: number;
  unofficial: boolean;
}

function readRankReply(value: unknown): {
  ok: boolean;
  reason: string;
  source: string;
  ranks: RankEntry[];
} {
  const record = value as { ok?: unknown; reason?: unknown; source?: unknown; ranks?: unknown } | null | undefined;
  const ranks: RankEntry[] = [];

  if (Array.isArray(record?.ranks)) {
    for (const item of record.ranks as unknown[]) {
      const entry = item as { handle?: unknown; rank?: unknown; unofficial?: unknown };

      // 只收「handle 是字符串 + 名次是有限数字」的条目：名次是要显示给用户的，宁可缺一条也不显示脏值
      if (
        typeof entry.handle === 'string' &&
        typeof entry.rank === 'number' &&
        Number.isFinite(entry.rank) &&
        entry.rank > 0
      ) {
        ranks.push({ handle: entry.handle, rank: entry.rank, unofficial: entry.unofficial === true });
      }
    }
  }

  return {
    ok: record?.ok === true,
    reason: typeof record?.reason === 'string' ? record.reason : 'page',
    source: record?.source === 'friends' || record?.source === 'page1' ? record.source : '',
    ranks,
  };
}

/** 等标签页离开某个地址前缀（表单交出去之后就是这一下跳转） */
async function waitForTabLeave(tabId: number, prefix: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const tab = await browser.tabs.get(tabId);

      if (tab.status === 'complete' && !(tab.url ?? '').startsWith(prefix)) {
        return true;
      }
    } catch {
      return false;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, TAB_POLL_INTERVAL));
  }
}

/** 读 /contests/page/1 上每一场的报名状态（赛程那一列）。读完就关页，不打扰用户 */
async function readContestStatesOnCodeforces(): Promise<{
  ok: boolean;
  reason: string;
  states: Record<string, string>;
}> {
  // 只等到 DOM 可读：表格是服务端渲染的，等 load 白等两三秒（见 waitForTabDom）
  const tabId = await openSilentCfTab(CF_CONTESTS_URL, waitForTabDom);

  if (tabId === null) {
    return { ok: false, reason: 'no-tab', states: {} };
  }

  try {
    // 没登录时 CF 会把它导到 /enter，那一页上没有比赛表格
    if ((await tabUrlOf(tabId)).includes('/enter')) {
      return { ok: false, reason: 'not-logged-in', states: {} };
    }

    const answer = await askContestAction(tabId, MessageAction.ReadContestStates, {}, true);

    return answer === undefined ? { ok: false, reason: 'page', states: {} } : readStatesReply(answer);
  } finally {
    await browser.tabs.remove(tabId).catch(noop);
  }
}

/**
 * 替用户提交报名 / 开一场 VP。两种动作走同一个形状：打开那一页 → 点一次表单 → 等它跳走。
 *
 * `unrated`（2026-10-30 加）只对「报名」有意义：用户在网站的确认卡片上选了「不计分」，
 * 这里原样交给内容脚本去拨那颗控件；VP 页不碰。设不上控件时内容脚本回 `unrated-unavailable`，
 * 这次报名就**不提交** —— 报名的计分方式不可逆，宁可不做，也不替他按计分报下去。
 *
 * `startAt`（2026-11-03 加）只对「开 VP」有意义：毫秒时间戳，内容脚本把它填进 CF 表单的
 * `Virtual start time`；0 / 缺省 = 不动那一行，CF 的默认值就是「现在」。
 *
 * 回给网页的只有枚举。**这个函数只在网页侧用户确认之后被调用一次**，它自己不做任何
 * 自动重试或轮询 —— 报名是不可逆的，宁可让用户再点一次，也不要替他重放。
 */
async function submitContestEntry(
  contestId: unknown,
  kind: 'register' | 'virtual',
  options: { unrated?: boolean; startAt?: number } = {},
): Promise<{ ok: boolean; reason: string }> {
  const target = contestTargetOf(contestId);

  if (target === null) {
    return { ok: false, reason: 'bad-contest' };
  }

  const tabId = await openSilentCfTab(kind === 'virtual' ? target.virtualUrl : target.registrationUrl);

  if (tabId === null) {
    return { ok: false, reason: 'no-tab' };
  }

  const action = kind === 'virtual' ? MessageAction.StartVirtual : MessageAction.SubmitRegistration;
  const payload = { unrated: options.unrated === true, startAt: options.startAt ?? 0 };
  const result = readSubmitResult(await askContestAction(tabId, action, payload)) ?? { ok: false, reason: 'page' };

  if (!result.ok) {
    // 这三种都指向「那一页上有用户要看 / 要做的事」：登录、过人机校验、看 CF 到底说了什么。
    // 其余原因（没资格 / 已报过名）是确定结论，关掉别堆标签页
    if (result.reason === 'not-logged-in' || result.reason === 'challenge' || result.reason === 'page') {
      await browser.tabs.update(tabId, { active: true }).catch(noop);
    } else {
      await browser.tabs.remove(tabId).catch(noop);
    }

    return result;
  }

  // 表单交出去了：等它离开 /contestRegistration/。跳不过去多半是 CF 拒收（资格 / 资格赛时段 /
  // 重复报名），现场留着让用户自己看那一页说了什么
  if (!(await waitForTabLeave(tabId, 'https://codeforces.com/contestRegistration/', SUBMIT_NAV_TIMEOUT))) {
    await browser.tabs.update(tabId, { active: true }).catch(noop);
    return { ok: false, reason: 'rejected' };
  }

  await browser.tabs.remove(tabId).catch(noop);
  return { ok: true, reason: '' };
}

/** 读某一场里这些 handle 的非正式名次。好友榜优先，第一页合并榜兜底（见 src/contestActions.ts） */
async function readUnofficialRanks(
  contestId: unknown,
  handles: unknown,
): Promise<{ ok: boolean; reason: string; source: string; ranks: RankEntry[] }> {
  const target = contestTargetOf(contestId);
  const wanted = Array.isArray(handles)
    ? handles.filter((handle): handle is string => typeof handle === 'string' && handle.trim().length > 0)
    : [];

  if (target === null) {
    return { ok: false, reason: 'bad-contest', source: '', ranks: [] };
  }

  if (wanted.length === 0) {
    return { ok: false, reason: 'bad-handles', source: '', ranks: [] };
  }

  const tabId = await openSilentCfTab(target.standingsUrl);

  if (tabId === null) {
    return { ok: false, reason: 'no-tab', source: '', ranks: [] };
  }

  try {
    const answer = await askContestAction(tabId, MessageAction.ReadUnofficialRank, { handles: wanted }, true);

    return answer === undefined ? { ok: false, reason: 'page', source: '', ranks: [] } : readRankReply(answer);
  } finally {
    await browser.tabs.remove(tabId).catch(noop);
  }
}

// ------------------------------------------------- Codeforces 登录态（会话级缓存）
//
// 【它解决什么】网站取码之后，代填那一步能不能成，取决于「这个浏览器里登的是不是这个 handle」。
// 没有这个缓存，用户只能白点一次、等失败文案才知道。有了它，站点可以**提前**说清。
//
// 【为什么缓存只在会话级】值本身是"这台浏览器此刻的 CF 登录态"——一个会话级事实。
// 用 storage.session（随浏览器关闭清空），刻意**不**落盘：把「你用哪个 CF 账号」写进磁盘
// 是没必要的持久化，而它随时能从页面重新读到。
//
// 【为什么只回枚举】站点问的是「登的是不是 he-jie」，这里**本地比对**后只回
// match / mismatch / not-logged-in / unknown —— **没有任何站点原本不知道的信息离开浏览器**
// （handle 明文是站点自己填的）。于是扩展在商店里也不必新增「收集并发送用户名」这类声明。
// 详见 src/cfIdentity.ts 开头：这个值只够驱动界面提示，绝不能当身份凭据。

interface CfIdentitySnapshot {
  /** 页面上读到的 handle；空串 = 读得到页面但读不到用户名（改版 / 没渲染完） */
  handle: string;
  /** 明确看到登录表单：这个浏览器没登录 Codeforces */
  loggedOut: boolean;
  /** 记下来的时刻（毫秒） */
  at: number;
}

const CF_IDENTITY_KEY = 'cf-identity';

/**
 * 缓存保鲜期。超过就当「不知道」—— 用户可能在别处登出或换了号，
 * 一个陈旧的值比没有更糟：界面会信誓旦旦地说错话。
 */
const CF_IDENTITY_TTL = 30 * 60 * 1000;

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function sessionArea(): StorageArea | null {
  // storage.session 在 Firefox 115 之前、以及安卓某些版本上不存在。拿不到就退化成
  // 「只在这次 service worker 活着期间有效」—— 会更常回 unknown（界面退回现状），
  // 但不会出错。刻意**不**回退到 storage.local：那是把 CF 账号写进磁盘。
  const area = (browser.storage as { session?: StorageArea }).session;

  return area !== undefined && area.get !== undefined ? area : null;
}

let cfIdentityMemory: CfIdentitySnapshot | null = null;

function normalizeSnapshot(value: unknown): CfIdentitySnapshot | null {
  const raw = value as Partial<CfIdentitySnapshot> | null | undefined;

  if (raw === null || raw === undefined || typeof raw.handle !== 'string') {
    return null;
  }

  return {
    handle: raw.handle,
    loggedOut: raw.loggedOut === true,
    at: typeof raw.at === 'number' ? raw.at : 0,
  };
}

async function readCfIdentity(): Promise<CfIdentitySnapshot | null> {
  const area = sessionArea();

  if (area !== null) {
    try {
      return normalizeSnapshot((await area.get(CF_IDENTITY_KEY))[CF_IDENTITY_KEY]);
    } catch {
      return null;
    }
  }

  return cfIdentityMemory;
}

async function writeCfIdentity(handle: string, loggedOut: boolean): Promise<void> {
  const snapshot: CfIdentitySnapshot = { handle, loggedOut, at: Date.now() };

  cfIdentityMemory = snapshot;

  const area = sessionArea();

  if (area !== null) {
    try {
      await area.set({ [CF_IDENTITY_KEY]: snapshot });
    } catch {
      // 缓存写不进去不是错误：下次问就是 unknown，界面退回改动前的样子
    }
  }
}

/** 只有正牌 Codeforces 页面的回报才算数（见 src/cfIdentity.ts 的 isCodeforcesSite） */
function isCodeforcesTab(sender: Runtime.MessageSender): boolean {
  const url = sender.tab?.url ?? '';

  return url.startsWith('https://codeforces.com/') || url.startsWith('https://www.codeforces.com/');
}

/** 内容脚本捎带报上来的登录态：落缓存 */
async function recordCfIdentity(handle: unknown, loggedOut: unknown): Promise<void> {
  await writeCfIdentity(typeof handle === 'string' ? handle.trim() : '', loggedOut === true);
}

/** 缓存里的登录态对「站点问的这个 handle」怎么答 */
function cfIdentityStatus(snapshot: CfIdentitySnapshot | null, handle: string): string {
  if (snapshot === null || Date.now() - snapshot.at > CF_IDENTITY_TTL) {
    return 'unknown';
  }

  if (snapshot.loggedOut) {
    return 'not-logged-in';
  }

  if (snapshot.handle.length === 0 || handle.length === 0) {
    return 'unknown';
  }

  return snapshot.handle.toLowerCase() === handle.toLowerCase() ? 'match' : 'mismatch';
}

/**
 * 代填那一趟问到了实况，顺手把缓存对齐 —— 这是免费的新鲜度：下一次问就准了。
 *
 * `handle-mismatch` 说明缓存里的值和实况对不上（用户换过号、或在别处登出过），
 * 但我们**并不知道**实况是谁，所以只作废（记成「读得到页面但读不到用户名」），不猜。
 */
async function syncCfIdentityFromFill(handle: string, result: FillResult): Promise<void> {
  if (result.ok) {
    await writeCfIdentity(handle, false);
    return;
  }

  if (result.reason === 'not-logged-in') {
    await writeCfIdentity('', true);
    return;
  }

  if (result.reason === 'handle-mismatch') {
    await writeCfIdentity('', false);
  }
}

function handleMessage(
  message: Message | any,
  sender: Runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true {
  if (message.action === 'cp-get-info') {
    getExtensionInfo()
      .then(info => sendResponse(info))
      .catch(() => sendResponse(null));

    return true;
  }

  // 网页侧（设置面板的投递目标开关）改配置：写成功与否都回 { ok, value }
  if (message.action === 'cp-set-config') {
    setConfig(message.key, message.value)
      .then(async ok => sendResponse({ ok, key: message.key, value: ok ? await config.get(message.key) : undefined }))
      .catch(() => sendResponse({ ok: false }));

    return true;
  }

  // 网页侧（云端同步的取码那一步）请扩展去 Codeforces 代填验证码。
  // 与抓题不同，这一趟不需要网页在工作区里做什么，所以只把结果原样回给发起方；
  // 「填好了」之后还要跟到保存落下去，那一段的结果另走 cp-fill-code-saved 广播（见 finishCodeFill）
  if (message.action === 'cp-fill-code') {
    fillCodeOnCodeforces(message.handle, message.code)
      .then(outcome => {
        // 顺手把会话缓存对齐（不问成败都可能有收获）：失败时不算错，吞掉即可
        syncCfIdentityFromFill(typeof message.handle === 'string' ? message.handle : '', outcome.result).catch(noop);
        sendResponse(outcome.result);

        if (outcome.result.ok) {
          finishCodeFill(message.requestId, outcome).catch(noop);
        }
      })
      .catch(() => sendResponse({ ok: false }));

    return true;
  }

  // 网页问「这个浏览器登的是不是这个 handle」：只回枚举，不回用户名（见上面那一段）
  if (message.action === 'cp-cf-check') {
    const handle = typeof message.handle === 'string' ? message.handle : '';

    readCfIdentity()
      .then(snapshot => sendResponse({ status: cfIdentityStatus(snapshot, handle) }))
      .catch(() => sendResponse({ status: 'unknown' }));

    return true;
  }

  // 网页请扩展整场抓样例：开静默标签页读一遍 `/contest/{id}/problems`，
  // 解析结果照常逐题走 cp-task 投递。这里只回「开跑没有」，成败由
  // cp-scrape-contest-done 广播回网页（见 scrapeContest）。
  if (message.action === 'cp-scrape-contest') {
    scrapeContest(message.requestId, message.url)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ accepted: false, reason: 'failed' }));

    return true;
  }

  // 网页请扩展一键提交：开后台页填表、点提交，再把判定轮询出来广播回去（见 submitOnCodeforces）。
  // 这一条与上面几条一样**只在用户显式点按时发生**，不轮询、不后台自动跑
  if (message.action === 'cp-submit') {
    submitOnCodeforces(message.requestId, message.url, message.sourceCode, message.language)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: 'page' }));

    return true;
  }

  // 网页读赛程上每一场的报名状态（2026-10-26 加）：开一页 /contests/page/1 读一次就关
  if (message.action === 'cp-contest-states') {
    readContestStatesOnCodeforces()
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: 'page', states: {} }));

    return true;
  }

  // 网页请扩展替用户报名 / 开一场 VP：只在用户显式点按确认之后发生一次（见 submitContestEntry）
  if (message.action === 'cp-register' || message.action === 'cp-start-virtual') {
    const kind = message.action === 'cp-start-virtual' ? 'virtual' : 'register';
    const startAt = typeof message.startAt === 'number' ? message.startAt : 0;

    submitContestEntry(message.contestId, kind, { unrated: message.unrated === true, startAt })
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: 'page' }));

    return true;
  }

  // 网页问「我在这场里的非正式名次」：只回数字与是不是非正式，不回任何页面内容（见 readUnofficialRanks）
  if (message.action === 'cp-unofficial-rank') {
    readUnofficialRanks(message.contestId, message.handles)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: 'page', source: '', ranks: [] }));

    return true;
  }

  if (sender.tab) {
    if (message.action === MessageAction.SendTask) {
      // 这条投递是不是我们自己开的那场抓取发来的：先投递，再记账。
      // 先投递是因为收尾会关掉那个标签页，得让最后一题的 SendTaskDone 有机会送回去
      const fromScrape = activeScrape !== null && sender.tab.id === activeScrape.tabId;

      sendTask(sender.tab.id, message.payload.messageId, message.payload.message);

      if (fromScrape) {
        noteScrapeDelivery(message.payload.message);
      }
    } else if (message.action === MessageAction.ReportCfIdentity) {
      // 只认正牌 Codeforces 标签页的回报：sender.tab.url 拿得到，说明扩展对那个域有 host 权限
      if (isCodeforcesTab(sender)) {
        recordCfIdentity(message.payload?.handle, message.payload?.loggedOut)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));

        return true;
      }

      sendResponse({ ok: false });
      return true;
    } else if (message.action === MessageAction.CheckSampleNeeded) {
      // 自动解析脚本问「这个页面要不要抓」（src/autoParse.ts）：网页说不要就回 url: null
      queryPageNeed(message.payload?.url)
        .then(need => sendResponse({ url: need ? message.payload?.url : null }))
        .catch(() => sendResponse({ url: null }));

      return true;
    } else if (message.action === MessageAction.RequestAutoParse) {
      // 样例已经在页面上了：走与点图标 / 按快捷键完全相同的那条链路
      loadContentScript(sender.tab, null);
      sendResponse({ ok: true });

      return true;
    } else if (message.action === MessageAction.Fetch) {
      makeRequest(
        sender.tab.id,
        message.payload.messageId,
        message.payload.url,
        message.payload.options,
        message.payload.retries,
      );
    }
  }

  // 其余消息不需要异步响应，立刻回一个空响应把通道关掉，
  // 否则调用方的 runtime.sendMessage Promise 会一直挂着不结算。
  sendResponse(undefined);
  return true;
}

browser.action.onClicked.addListener(onAction);
browser.runtime.onMessage.addListener(handleMessage);
browser.runtime.onInstalled.addListener(createContextMenu);

// 【安卓致命点】Firefox for Android 上 contextMenus 命名空间整个不存在；
// 顶层直接访问 browser.contextMenus.onClicked 会在模块求值时抛 TypeError，
// 把上面几条 addListener 一起带走 —— 症状是安卓上握手与抓题全哑（网站显示「未检测到」）。
if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener(onContextMenu);
}

/**
 * 给**已经打开**的目标网站标签页补注入桥接脚本（js/bridge.js）。
 *
 * 【为什么需要】内容脚本只在页面加载那一刻注入（manifest 的 document_start）。页面开在扩展
 * 安装 / 更新 / 重载**之前**的那些标签页里没有桥，网站那边的探活（cp-ping → cp-info）永远
 * 没人接，界面停在「未检测到」、只有用户自己刷新页面才能恢复（网站仓库 HANDOFF §13.7.1
 * 第三种「装了也探不到」）。这里在扩展启动时主动补一份，把那一步去掉。
 *
 * 【为什么挂在启动处而不是 onInstalled】在扩展管理页点「重新加载」不一定触发 onInstalled，
 * 但一定会重启后台；装上、更新完也同样会运行到这里。bridge.js 自带幂等标记（见
 * src/bridge.ts 末尾），重复注入是空操作，所以每次启动无脑补一遍是安全的。
 *
 * 【注入范围】直接读 manifest 里 bridge 那一条的 matches：生产构建已经把 localhost 剔掉
 * （scripts/build/extension.ts 的 DEV_ONLY_SITE_PATTERNS），运行时不再自己判一遍，免得
 * 两份清单走偏。单页失败（已丢弃、正在导航、权限被收回）一律忽略 —— 这只是把「本来要刷新
 * 页面」的那一步省掉，失败时行为与改动前相同。
 */
async function ensureBridges(): Promise<void> {
  // Firefox for Android 上 scripting 命名空间存在的版本有限，缺了就当没有这条路（同 contextMenus）
  if (!browser.scripting) {
    return;
  }

  const entry = browser.runtime.getManifest().content_scripts?.find(script => script.js?.includes('js/bridge.js'));
  const matches = entry?.matches ?? [];

  if (matches.length === 0) {
    return;
  }

  const tabs = await browser.tabs.query({ url: matches }).catch((): Tabs.Tab[] => []);

  await Promise.all(
    tabs.map(async tab => {
      if (typeof tab.id !== 'number') {
        return;
      }

      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['js/bridge.js'] }).catch(noop);
    }),
  );
}

// 后台每次启动都补一遍：扩展装上 / 更新 / 重载之后，已经打开的网站页面不必刷新也能被探到
void ensureBridges();

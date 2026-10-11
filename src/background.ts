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

function createContextMenu(): void {
  // Firefox for Android 上 contextMenus 整个命名空间不存在（MDN BCD: menus = ff_android false），
  // 这里也会抛 TypeError，所以先挡一下。桌面端行为不变。
  if (!browser.contextMenus) {
    return;
  }

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
   */
  capabilities: string[];
}

const CAPABILITIES = ['fill-code', 'cf-check'];

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
 * 轮询到标签页加载完成。被关掉 / 拿不到状态都算失败 —— 调用方把它折成「没能打开设置页」。
 */
async function waitForTabComplete(tabId: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const tab = await browser.tabs.get(tabId);

      if (tab.status === 'complete') {
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
 * 失败时一律**不关标签页**：无论是没登录还是页面认不出来，用户都需要那一页在手边。
 */
async function fillCodeOnCodeforces(handle: unknown, code: unknown): Promise<FillResult> {
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, reason: 'page' };
  }

  const handleName = typeof handle === 'string' ? handle : '';

  let tabId: number | undefined;

  try {
    const existing = await browser.tabs.query({ url: [`${CF_SOCIAL_URL}*`] });
    tabId = existing.map(tab => tab.id).find((id): id is number => typeof id === 'number');
  } catch {
    tabId = undefined;
  }

  if (tabId === undefined) {
    try {
      const created = await browser.tabs.create({ url: CF_SOCIAL_URL });
      tabId = typeof created.id === 'number' ? created.id : undefined;
    } catch {
      tabId = undefined;
    }
  }

  if (tabId === undefined) {
    return { ok: false, reason: 'no-tab' };
  }

  if (!(await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT))) {
    return { ok: false, reason: 'no-tab' };
  }

  try {
    const answer = await askFillCode(tabId, handleName, code);

    if (answer !== null) {
      return answer;
    }

    // 没有应答：多半是这一页在扩展重载之前就开着，代填脚本不在。补注入一次再问
    await browser.scripting.executeScript({ target: { tabId }, files: ['js/fillCode.js'] });

    const retry = await askFillCode(tabId, handleName, code);

    return retry ?? { ok: false, reason: 'page' };
  } catch {
    return { ok: false, reason: 'page' };
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
  // 与抓题不同，这一趟不需要网页在工作区里做什么，所以只把结果原样回给发起方
  if (message.action === 'cp-fill-code') {
    fillCodeOnCodeforces(message.handle, message.code)
      .then(result => {
        // 顺手把会话缓存对齐（不问成败都可能有收获）：失败时不算错，吞掉即可
        syncCfIdentityFromFill(typeof message.handle === 'string' ? message.handle : '', result).catch(noop);
        sendResponse(result);
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

  if (sender.tab) {
    if (message.action === MessageAction.SendTask) {
      sendTask(sender.tab.id, message.payload.messageId, message.payload.message);
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

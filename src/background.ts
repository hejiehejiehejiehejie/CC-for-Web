import type { Menus, Runtime, Tabs } from 'webextension-polyfill';
import { getHosts } from './hosts/hosts';
import { TARGET_SITE_PATTERNS } from './hosts/targetSites';
import { Message, MessageAction } from './models/messaging';
import { browser } from './utils/browser';
import { config } from './utils/config';
import { sendToContent } from './utils/messaging';
import { request, requiredPermissions } from './utils/request';

declare global {
  const PARSER_NAMES: string[];
}

function createContextMenu(): void {
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
    browser.commands.getAll(),
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

  if (sender.tab) {
    if (message.action === MessageAction.SendTask) {
      sendTask(sender.tab.id, message.payload.messageId, message.payload.message);
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
browser.contextMenus.onClicked.addListener(onContextMenu);
browser.runtime.onMessage.addListener(handleMessage);
browser.runtime.onInstalled.addListener(createContextMenu);

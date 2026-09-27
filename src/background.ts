import type { Menus, Runtime, Tabs } from 'webextension-polyfill';
import { getHosts } from './hosts/hosts';
import { Message, MessageAction } from './models/messaging';
import { browser } from './utils/browser';
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
  // 改造后不再向 localhost 发请求，所以这里不再预置 localhost 权限（少弹一次授权）
  const permissionOrigins: string[] = [];

  for (const prefix in requiredPermissions) {
    if (tab.url.startsWith(prefix)) {
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

const NO_TARGET_NOTIFICATION_ID = 'cph-no-target-tab';

async function notifyNoTargetTab(): Promise<void> {
  try {
    await browser.notifications.create(NO_TARGET_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'CC for Web',
      message: '没有找到已打开的题目管理网站，请先打开后再解析。',
    });
  } catch {
    // 通知失败不影响主流程
  }
}

async function sendTask(tabId: number, messageId: string, data: string): Promise<void> {
  try {
    const hosts = await getHosts();
    const results = await Promise.allSettled(hosts.map(host => host.send(data)));
    const delivered = results.some(result => result.status === 'fulfilled');

    if (!delivered) {
      await notifyNoTargetTab();
    }

    // 这里刻意回 Done 而非 Failed：content.ts 收到 SendTaskFailed 会在 OJ 页面上弹出
    // 一句写死的 "Something went wrong while running ..."，与「没开网站」这个真实原因对不上。
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

interface ExtensionInfo {
  version: string;
  commands: Array<{ name: string; description: string; shortcut: string }>;
}

/**
 * 供目标网站通过桥接脚本（src/bridge.ts）握手查询：
 * 版本号用于网站判断扩展是否已安装，commands 用于展示扩展的快捷键绑定。
 * 注意：Chrome 没有任何 API 能让网页改写这些快捷键，网站只能展示 + 引导用户去
 * chrome://extensions/shortcuts 手动改（网页也无法直接跳转到 chrome:// 地址）。
 */
async function getExtensionInfo(): Promise<ExtensionInfo> {
  const commands = await browser.commands.getAll();

  return {
    version: browser.runtime.getManifest().version,
    commands: commands.map(command => ({
      name: command.name ?? '',
      description: command.description ?? '',
      shortcut: command.shortcut ?? '',
    })),
  };
}

function handleMessage(
  message: Message | any,
  sender: Runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true {
  if (message.action === 'cph-get-info') {
    getExtensionInfo()
      .then(info => sendResponse(info))
      .catch(() => sendResponse(null));

    return true;
  }

  if (sender.tab) {
    if (message.action === MessageAction.SendTask) {
      sendTask(sender.tab.id, message.payload.messageId, message.payload.message);
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

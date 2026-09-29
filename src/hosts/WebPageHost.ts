import { browser } from '../utils/browser';
import { uuidv4 } from '../utils/random';
import { Host } from './Host';
import { TARGET_SITE_PATTERNS } from './targetSites';

/**
 * 把 payload 推送给浏览器里打开的目标网站标签页（接收端之一，与本地工具并列，见 hosts.ts）。
 *
 * 与上游 Host 的契约保持一致（send() 返回 Promise<void>）：
 *   - 投递成功 -> resolve
 *   - 没找到目标标签页 / 一个都没投出去 -> reject，由 background.ts 的 sendTask 决定怎么提示用户
 */
export class WebPageHost extends Host {
  public async send(data: string): Promise<void> {
    // url 过滤需要 host_permissions 覆盖该 URL；只声明 activeTab 时查不到任何标签页
    const tabs = await browser.tabs.query({ url: TARGET_SITE_PATTERNS });
    const tabIds = tabs.map(tab => tab.id).filter((id): id is number => typeof id === 'number');

    if (tabIds.length === 0) {
      throw new Error('NO_TARGET_TAB');
    }

    // 同站多开时全部投递，由页面按 taskId 去重
    const taskId = uuidv4();
    let delivered = 0;

    await Promise.all(
      tabIds.map(async tabId => {
        try {
          await browser.tabs.sendMessage(tabId, { action: 'cph-task', taskId, payload: data });
          delivered += 1;
        } catch {
          // 桥接脚本尚未注入（扩展刚重载、标签页没刷新），跳过即可
        }
      }),
    );

    if (delivered === 0) {
      throw new Error('NO_TARGET_TAB');
    }
  }
}

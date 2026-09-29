import { config } from '../utils/config';
import { CHelperHost } from './CHelperHost';
import { CustomHost } from './CustomHost';
import { Host } from './Host';
import { WebPageHost } from './WebPageHost';

/**
 * 访问本地工具需要的 host 权限（manifest 的 host_permissions 引用这里）。
 *
 * 匹配模式不带端口就覆盖 localhost 的所有端口，所以一条就够，不用按端口逐个声明。
 * 这些 URL 只有扩展后台会发（content script 发会被页面的 CORS / 混合内容规则拦住），
 * 而扩展只要声明了 host 权限就允许访问本地网络，不受 Chrome 142+ 本地网络访问权限的限制。
 */
export const LOCAL_TOOL_ORIGINS: string[] = ['http://localhost/*'];

const localToolPorts = [
  1327, // cpbooster
  4244, // Hightail
  6174, // Mind Sport
  10042, // acmX
  10043, // Caide and AI Virtual Assistant
  10045, // CP Editor
  27121, // Competitive Programming Helper（VS Code 扩展）
];

/**
 * 解析结果的接收端：目标网站标签页 + 本地工具，两侧都由选项页开关控制，默认都开。
 *
 * 两侧都投递是刻意的——网站和本地工具各看各的，没有「谁优先、谁兜底」的关系；
 * 单侧失败不影响另一侧（调用方用 allSettled，见 background.ts 的 sendTask）。
 */
export async function getHosts(): Promise<Host[]> {
  const [sendToWebPage, sendToLocalTools, customPorts] = await Promise.all([
    config.get('sendToWebPage'),
    config.get('sendToLocalTools'),
    config.get('customPorts'),
  ]);

  const hosts: Host[] = [];

  if (sendToWebPage) {
    hosts.push(new WebPageHost());
  }

  if (sendToLocalTools) {
    // CHelperHost 走 4243，但 body 格式与其它工具不同（前置 json\n），所以单独一个类
    const ports = [...new Set(localToolPorts.concat(customPorts))];

    hosts.push(new CHelperHost(), ...ports.map(port => new CustomHost(port)));
  }

  return hosts;
}

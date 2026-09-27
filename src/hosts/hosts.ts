import { config } from '../utils/config';
import { CHelperHost } from './CHelperHost';
import { CustomHost } from './CustomHost';
import { Host } from './Host';
import { WebPageHost } from './WebPageHost';

/**
 * 改造开关：true = 推送给浏览器里的目标网站标签页（改造后的行为）。
 * 临时需要退回「POST 到 localhost 各端口」时，把它改成 false 即可，
 * 下面那一支是上游原样逻辑，不要删——它同时是为了合并 upstream 时冲突最小。
 */
const USE_WEB_PAGE_HOST = true;

const defaultHosts: Host[] = [new CHelperHost()];
const defaultPorts = [
  1327, // cpbooster
  4244, // Hightail
  6174, // Mind Sport
  10042, // acmX
  10043, // Caide and AI Virtual Assistant
  10045, // CP Editor
  27121, // Competitive Programming Helper
];

export async function getHosts(): Promise<Host[]> {
  if (USE_WEB_PAGE_HOST) {
    return [new WebPageHost()];
  }

  const customPorts = await config.get('customPorts');
  const uniquePorts = [...new Set(defaultPorts.concat(customPorts))];
  return defaultHosts.concat(uniquePorts.map(port => new CustomHost(port)));
}

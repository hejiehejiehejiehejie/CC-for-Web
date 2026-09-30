/**
 * 目标网站的 URL 匹配规则：单一出处。
 *
 * 同时被两处引用，改这里就够：
 *   - src/hosts/WebPageHost.ts  —— tabs.query 的 url 过滤
 *   - scripts/build/extension.ts —— manifest 的 host_permissions / content_scripts.matches
 *
 * 注意：localhost 与 127.0.0.1 是不同 origin；带 www 与不带 www 也是不同 origin，
 * 四个都要写，否则匹配不上就等同于「网站没打开」。
 */
export const TARGET_SITE_PATTERNS: string[] = [
  'http://localhost:5199/*',
  'http://127.0.0.1:5199/*',
  'https://www.998244353.best/*',
  'https://998244353.best/*',
];

/**
 * 「样例待抓」自动解析脚本的注入范围。注意这是题目**来源**站点，与上面的目标网站不是一回事：
 * 上面的站点是题目投递的目的地，这里是扩展要主动去读 DOM 的站点。
 *
 * 目前只列 Codeforces：网页侧的抽题面板只支持 CF，而 CF 的 problemset 接口不返回样例、
 * 题目页面又没带 CORS 头，网页自己 fetch 不到，只能由扩展在页面里读。
 *
 * 每多列一个站点，就多一份「扩展在你浏览该站时自动读页面」的授权面（安装时 Chrome 会
 * 逐站点提示「读取你在 xxx 上的数据」），所以按需再加，不要顺手把上游支持的一堆 OJ 都列上。
 */
export const AUTO_PARSE_SITE_PATTERNS: string[] = ['https://codeforces.com/*'];

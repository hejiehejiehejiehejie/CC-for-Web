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
  'http://localhost:5173/*',
  'http://127.0.0.1:5173/*',
  'https://www.998244353.best/*',
  'https://998244353.best/*',
];

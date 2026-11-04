/**
 * 目标网站的 URL 匹配规则：单一出处。
 *
 * 同时被两处引用，改这里就够：
 *   - src/hosts/WebPageHost.ts  —— tabs.query 的 url 过滤
 *   - scripts/build/extension.ts —— manifest 的 host_permissions / content_scripts.matches
 *
 * 注意：localhost 与 127.0.0.1 是不同 origin；带 www 与不带 www 也是不同 origin，
 * 四个都要写，否则匹配不上就等同于「网站没打开」。
 *
 * 本机两条**不带端口**：匹配模式里的端口既不被 Firefox 接受（整个扩展加载失败），
 * 也钉不住开发现场 —— Vite 的 strictPort 是 false，5199 被占时会顺延；
 * 想验生产构建还得跑 preview（默认 4173）。不带端口则本机所有端口一起覆盖。
 * 生产构建会按 DEV_ONLY_SITE_PATTERNS 把它们剔除（见 scripts/build/extension.ts）。
 */
export const TARGET_SITE_PATTERNS: string[] = [
  'http://localhost/*',
  'http://127.0.0.1/*',
  'https://www.998244353.best/*',
  'https://998244353.best/*',
];

/**
 * 题目**来源**站点（自动解析脚本的注入范围）的清单不在这里 —— 它由 parser 注册表推导，
 * 见 src/hosts/sourceSitePatterns.ts，消费方是构建脚本 scripts/build/extension.ts。
 *
 * 注意来源站点与上面的目标网站不是一回事：上面是题目投递的**目的地**，来源站点是扩展要主动
 * 读 DOM 的**题目页**。两者混用会让权限声明莫名其妙。
 *
 * 别把推导结果搬回本文件：本文件被后台脚本（src/background.ts）引用，一旦在这里 import
 * 注册表，163 个 parser 连同 jszip / pdfjs 都会被并进后台 bundle。
 */

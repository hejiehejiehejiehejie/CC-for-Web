import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { LOCAL_TOOL_ORIGINS } from '../../src/hosts/hosts';
import { getSourceSitePatterns, isValidMatchPattern } from '../../src/hosts/sourceSitePatterns';
import { TARGET_SITE_PATTERNS } from '../../src/hosts/targetSites';
import { parsers } from '../../src/parsers/parsers';
import { requiredPermissions } from '../../src/utils/request';
import { projectRoot } from '../utils';
import { commonOptions, getBuildDirectory } from './utils';

type BrowserId = 'chrome' | 'edge' | 'opera' | 'firefox';

interface BrowserTarget {
  /** 日志 / 报错里的展示名 */
  label: string;
  /** Chromium 系（含 Edge / Opera）用 MV3 的 service worker，Firefox 目前只能用 event page */
  background: 'service-worker' | 'event-page';
  /** 可选 host 权限落在哪个字段：Chromium 系是 optional_host_permissions，Firefox 是 optional_permissions */
  optionalHostPermissionsField: 'optional_host_permissions' | 'optional_permissions';
  /** 只有 Firefox 需要 */
  browserSpecificSettings?: Record<string, unknown>;
  /**
   * 覆盖 manifest 的 description（默认取 package.json 的 description）。
   * 只有 Firefox 用到：安卓上只有 Firefox for Android 支持扩展，Chrome/Edge/Opera 的
   * 移动端根本装不了扩展，给它们挂「支持安卓」会让商店页失真。
   */
  descriptionOverride?: string;
}

/**
 * 支持的构建目标。
 *
 * 四个 target 实际只有三个维度不同（见上面接口）。新增浏览器时在这里加一条即可，
 * 不要退回 `if (target === 'chrome') ... else ...` —— 那样任何漏网的 target 都会
 * 静默生成 firefox 的 manifest。
 */
const BROWSERS: Record<BrowserId, BrowserTarget> = {
  chrome: {
    label: 'Chrome',
    background: 'service-worker',
    optionalHostPermissionsField: 'optional_host_permissions',
  },
  edge: {
    label: 'Edge',
    background: 'service-worker',
    optionalHostPermissionsField: 'optional_host_permissions',
  },
  opera: {
    label: 'Opera',
    background: 'service-worker',
    optionalHostPermissionsField: 'optional_host_permissions',
  },
  firefox: {
    label: 'Firefox',
    background: 'event-page',
    optionalHostPermissionsField: 'optional_permissions',
    browserSpecificSettings: {
      gecko: {
        // 不用上游的 GUID：AMO 按 ID 认扩展，共用 ID 会在提交时被拒（Duplicate add-on ID）。
        // 所以这里必须是本 fork 自己的 ID，且一经发布不可再改（换了等于另一个扩展）。
        id: 'cc-for-web@998244353.best',
        data_collection_permissions: {
          required: ['websiteContent'],
        },
      },
      // 这几行一去掉，扩展就退回「仅桌面版」：MDN 说得很死——要让 Firefox for Android 能用，
      // 必须显式给出 gecko_android（空对象也行），否则 AMO 与安卓端都不认（安装入口直接不出现）。
      // 下限取 142 而不是 120：上面的 data_collection_permissions 是 AMO 现在强制要的键，
      // 而安卓端要到 142 才认识它；标 120 会被 web-ext lint 报
      // KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION（等于声称支持一群读不懂这个键的旧版本）。
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
    // 安卓支持是本 fork 相比上游（仅桌面）的差异点，写进商店摘要；AMO 摘要上限 250 字符，这句 ~160
    descriptionOverride:
      'Parses competitive programming problems and sends them to your editor or online judge. Fork of Competitive Companion, now also working on Firefox for Android.',
  },
};

const target = process.argv[2] ?? '';
const browser = (BROWSERS as Record<string, BrowserTarget | undefined>)[target];

if (!browser) {
  throw new Error(`Unknown build target "${target}". Expected one of: ${Object.keys(BROWSERS).join(', ')}`);
}

const isProduction = process.argv[3] === 'true';
const watch = process.argv[4] === 'true';

const buildDirectory = await getBuildDirectory(target);

// 本机站点只在本地开发时有意义（Vite dev server / preview）。
// 生产包必须剔除：商店审查会追问「为什么需要读取 localhost」，而真实用户根本用不到。
// 不带端口是刻意的 —— 覆盖开发端口顺延与 preview，且带端口的写法 Firefox 不认
// （见 src/hosts/targetSites.ts）。
// 注意只能在构建期过滤——targetSites.ts 里的常量是开发态运行时也要用的。
const DEV_ONLY_SITE_PATTERNS = ['http://localhost/*', 'http://127.0.0.1/*'];

const sitePatterns = TARGET_SITE_PATTERNS.filter(pattern => !isProduction || !DEV_ONLY_SITE_PATTERNS.includes(pattern));

/**
 * 代填验证码脚本（src/fillCode.ts）的注入范围，2026-10-11 新增。
 *
 * 只有 Codeforces 的 Social 设置页 —— 云同步那枚验证码要填的 Last name 只在这一页上。
 * 【为什么不跟着 sourceSitePatterns 走】那份是「需要读 DOM 抓样例的题目页」，
 * 由 parser 注册表推导（都是 contest / problemset / gym 这类题目路径）。一个设置页并进去，
 * 既让「自动解析」的注入面毫无必要地变大，也让那份推导多出一条与抓题无关的账。
 * 【为什么必须单独声明权限】Social 页不在任何 parser 的路径里，不声明的话
 * host_permissions 覆盖不到它，后台的 tabs.query 与 executeScript 都会失败。
 */
const FILL_CODE_SITE_PATTERNS = ['https://codeforces.com/settings/social*'];

/**
 * 一键提交脚本（src/submitCode.ts）的注入范围，2026-10-23 新增。
 *
 * 两页都要：提交页（填表 + 点提交）与「我的提交」页（后台隔几秒问一次判定）。
 * 用 `*.codeforces.com` 而不是裸域：匹配模式里 `*.example.com` 同时覆盖 apex 与子域，
 * 万一用户被导到 `www.` 上也还认得。
 *
 * 【为什么也单独声明权限】这两类路径不在任何 parser 的题目路径里，不声明的话
 * host_permissions 覆盖不到，后台的 tabs.query / executeScript 都会失败。
 */
const SUBMIT_SITE_PATTERNS = [
  'https://*.codeforces.com/contest/*/submit*',
  'https://*.codeforces.com/gym/*/submit*',
  'https://*.codeforces.com/group/*/contest/*/submit*',
  'https://*.codeforces.com/contest/*/my*',
  'https://*.codeforces.com/gym/*/my*',
  'https://*.codeforces.com/group/*/contest/*/my*',
];

/**
 * 比赛动作脚本（src/contestActions.ts）的注入范围，2026-10-26 新增。
 *
 * 三处页面：比赛列表（读报名状态）、报名 / VP 页（提交表单）、榜单（读非正式名次）。
 * 与一键提交同样单独声明 host 权限 —— 这几类路径不在任何 parser 的题目路径里，
 * 不声明的话后台的 tabs.create 会被拦、executeScript 的兜底也注入不进去。
 *
 * `/contests/*` 只匹配 `/contests/page/1` 这类子路径（不带星号的裸 `/contests` 会被 CF
 * 重定向到某场比赛页，本来也不读它）。
 */
const CONTEST_ACTIONS_SITE_PATTERNS = [
  'https://*.codeforces.com/contests/*',
  'https://*.codeforces.com/contestRegistration/*',
  'https://*.codeforces.com/contest/*/standings*',
  'https://*.codeforces.com/gym/*/standings*',
  'https://*.codeforces.com/group/*/contest/*/standings*',
];

// 题目**来源**站点：从 parser 注册表推导（见 src/hosts/sourceSitePatterns.ts），不再手写。
// 这里顶层 import 注册表是安全的——构建脚本本来就会加载全部 parser（见 scripts/build/utils.ts），
// 构建产物里不会因此多出任何东西。
const sourceSitePatterns = getSourceSitePatterns(parsers);

// host_permissions 里三个来源可能重叠（比如自家站点、来源站点、localhost 工具），
// 去重是为了让生成物可读、diff 可审；重复项本身不影响扩展行为。
const hostPermissions = [
  ...new Set([
    ...sitePatterns,
    ...sourceSitePatterns,
    ...FILL_CODE_SITE_PATTERNS,
    ...SUBMIT_SITE_PATTERNS,
    ...CONTEST_ACTIONS_SITE_PATTERNS,
    ...LOCAL_TOOL_ORIGINS,
  ]),
];

// 匹配模式写错不是「这一条失效」，而是整个扩展加载失败（带端口的写法在 Firefox 上就是如此，
// 见 sourceSitePatterns.ts）。校验只用推导出来的那一份——它由注册表汇总而成，是最可能溜进
// 脏数据的地方；sitePatterns 与 LOCAL_TOOL_ORIGINS 是手写的常量，人为控制。
const malformedSourcePatterns = sourceSitePatterns.filter(pattern => !isValidMatchPattern(pattern));

if (malformedSourcePatterns.length > 0) {
  throw new Error(`推导出的来源站点里有非法匹配模式：\n${malformedSourcePatterns.join('\n')}`);
}

await Promise.all(
  [
    {
      from: async () => {
        const packageJsonFile = path.join(projectRoot, 'package.json');
        const packageJsonContent = await fs.promises.readFile(packageJsonFile, { encoding: 'utf-8' });
        const packageJson = JSON.parse(packageJsonContent);

        const optionalHostPermissions = Object.values(requiredPermissions);

        const manifest: Record<string, any> = {
          manifest_version: 3,

          name: packageJson.productName,
          description: packageJson.description,
          version: packageJson.version,

          author: packageJson.author,
          // 商店页的 Website 字段要求指向自己的网站，所以用 package.json 的 homepage
          // （repository 仍指向上游 fork 源，保留归属）
          homepage_url: packageJson.homepage,

          // notifications：所有接收端都没收到时弹系统通知
          permissions: ['activeTab', 'contextMenus', 'storage', 'scripting', 'notifications'],
          // 三类来源的合集（见上方 hostPermissions 的构造）：
          //   - 目标网站：题目投递的目的地，同时也是 bridge.js 的注入范围，
          //     且必须覆盖 tabs.query 要过滤的 URL；
          //   - 来源站点：由 parser 注册表推导的全部题目站，autoParse.js 要在这些页面读 DOM，
          //     同时也让后台的 executeScript 注入不必再逐站弹权限框；
          //   - localhost：向本地工具（VS Code 的 CPH、CP Editor、CHelper 等）POST 需要的权限，
          //     与上游一致放在必选权限里——安装时会多一条「读取您在 localhost 上的数据」提示，
          //     但之后不再弹框。
          // 数量不少（每个支持的题目站一条），这是「打开题目页即自动解析」的代价：
          // 用户可以随时在浏览器里关掉本站点的访问权限，扩展会退回手动解析。
          host_permissions: hostPermissions,

          // 桥接脚本：在目标网站里把扩展消息转成 window.postMessage，
          // 让网页（拿不到 chrome.runtime）也能收到题目、并握手查询扩展信息。
          // document_start 是为了让网页在 DOMContentLoaded 时握手就能收到回应。
          //
          // 自动解析脚本：注入到来源站点，页面加载后自问「这道题要不要抓样例」。
          // document_idle 是刻意的——它要等的是样例 DOM，document_start 时页面上还什么都没有；
          // 真正的等待逻辑在脚本内部（见 src/autoParse.ts）
          content_scripts: [
            {
              matches: sitePatterns,
              js: ['js/bridge.js'],
              run_at: 'document_start',
            },
            {
              matches: sourceSitePatterns,
              js: ['js/autoParse.js'],
              run_at: 'document_idle',
            },
            // 代填验证码：只在 Codeforces 的 Social 设置页上待命（见 FILL_CODE_SITE_PATTERNS）。
            // document_idle 与自动解析一致 —— 表单是服务端渲染的，等到 DOM 稳了再待命最省事，
            // 它平时什么都不做，只在后台要求时填一次。
            {
              matches: FILL_CODE_SITE_PATTERNS,
              js: ['js/fillCode.js'],
              run_at: 'document_idle',
            },
            // 一键提交：提交页与「我的提交」页都要待命（见 SUBMIT_SITE_PATTERNS）。
            // document_idle 同上 —— 表单与提交记录都是服务端渲染的，等 DOM 稳了再待命；
            // 平时什么都不做，只在后台要求时填一次 / 读一次
            {
              matches: SUBMIT_SITE_PATTERNS,
              js: ['js/submitCode.js'],
              run_at: 'document_idle',
            },
            // 比赛动作：比赛列表 / 报名页 / 榜单（见 CONTEST_ACTIONS_SITE_PATTERNS）。
            // document_idle 同上 —— 表格、表单、榜单都是服务端渲染的；平时什么都不做，
            // 只在后台要求时读一次 / 点一次
            {
              matches: CONTEST_ACTIONS_SITE_PATTERNS,
              js: ['js/contestActions.js'],
              run_at: 'document_idle',
            },
          ],

          icons: {
            '16': 'icons/icon-16.png',
            '19': 'icons/icon-19.png',
            '20': 'icons/icon-20.png',
            '24': 'icons/icon-24.png',
            '32': 'icons/icon-32.png',
            '38': 'icons/icon-38.png',
            '48': 'icons/icon-48.png',
            '64': 'icons/icon-64.png',
            '96': 'icons/icon-96.png',
            '128': 'icons/icon-128.png',
          },

          options_ui: {
            page: 'options.html',
          },

          action: {
            default_title: 'Parse task',
            default_icon: {
              '16': 'icons/icon-16.png',
              '19': 'icons/icon-19.png',
              '20': 'icons/icon-20.png',
              '24': 'icons/icon-24.png',
              '32': 'icons/icon-32.png',
              '38': 'icons/icon-38.png',
              '48': 'icons/icon-48.png',
              '64': 'icons/icon-64.png',
              '96': 'icons/icon-96.png',
            },
          },

          commands: {
            _execute_action: {
              suggested_key: {
                default: 'Ctrl+Shift+U',
              },
            },
          },
        };

        // 可选 host 权限的字段名按浏览器分（见 BROWSERS 表）
        manifest[browser.optionalHostPermissionsField] = optionalHostPermissions;

        manifest.background =
          browser.background === 'service-worker'
            ? {
                service_worker: 'js/background.js',
                type: 'module',
              }
            : {
                scripts: ['js/background.js'],
                type: 'module',
              };

        if (browser.browserSpecificSettings) {
          manifest.browser_specific_settings = browser.browserSpecificSettings;
        }

        if (browser.descriptionOverride) {
          manifest.description = browser.descriptionOverride;
        }

        return JSON.stringify(manifest, null, 2);
      },
      to: path.resolve(buildDirectory, 'manifest.json'),
    },
    {
      from: path.resolve(projectRoot, 'media/icons'),
      to: path.resolve(buildDirectory, 'icons'),
    },
    {
      from: path.resolve(projectRoot, 'src/options.html'),
      to: path.resolve(buildDirectory, 'options.html'),
    },
    {
      from: path.resolve(projectRoot, 'LICENSE'),
      to: path.resolve(buildDirectory, 'LICENSE'),
    },
  ].map(async ({ from, to }) => {
    if (typeof from === 'function') {
      await fs.promises.writeFile(to, await from());
    } else {
      await fs.promises.cp(from, to, { recursive: true });
    }

    console.log(`Created ${path.relative(projectRoot, to)}`);
  }),
);

const options: esbuild.BuildOptions = {
  ...commonOptions,
  entryPoints: [
    path.resolve(projectRoot, 'src/autoParse.ts'),
    path.resolve(projectRoot, 'src/background.ts'),
    path.resolve(projectRoot, 'src/bridge.ts'),
    path.resolve(projectRoot, 'src/content.ts'),
    path.resolve(projectRoot, 'src/fillCode.ts'),
    path.resolve(projectRoot, 'src/submitCode.ts'),
    path.resolve(projectRoot, 'src/contestActions.ts'),
    path.resolve(projectRoot, 'src/options.ts'),
  ],
  outdir: path.resolve(buildDirectory, 'js'),
  bundle: true,
  format: 'esm',
  minifyWhitespace: isProduction,
  minifySyntax: isProduction,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

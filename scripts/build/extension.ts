import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { LOCAL_TOOL_ORIGINS } from '../../src/hosts/hosts';
import { AUTO_PARSE_SITE_PATTERNS, TARGET_SITE_PATTERNS } from '../../src/hosts/targetSites';
import { requiredPermissions } from '../../src/utils/request';
import { projectRoot } from '../utils';
import { commonOptions, getBuildDirectory } from './utils';

const target = process.argv[2];
const isProduction = process.argv[3] === 'true';
const watch = process.argv[4] === 'true';

const buildDirectory = await getBuildDirectory(target);

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
          homepage_url: packageJson.repository,

          // notifications：所有接收端都没收到时弹系统通知
          permissions: ['activeTab', 'contextMenus', 'storage', 'scripting', 'notifications'],
          // 目标网站：这组 origin 同时也是 content_scripts 的注入范围，且必须覆盖 tabs.query 要过滤的 URL；
          // localhost：向本地工具（VS Code 的 CPH、CP Editor、CHelper 等）POST 需要的 host 权限，
          // 与上游一致放在必选权限里——安装时会多一条「读取您在 localhost 上的数据」提示，但之后不再弹框
          // 来源站点（CF）：自动解析脚本要能在用户打开题目页时读它的 DOM，同时也让后台的
          // executeScript 注入不必再按站点弹权限框
          host_permissions: [...TARGET_SITE_PATTERNS, ...AUTO_PARSE_SITE_PATTERNS, ...LOCAL_TOOL_ORIGINS],

          // 桥接脚本：在目标网站里把扩展消息转成 window.postMessage，
          // 让网页（拿不到 chrome.runtime）也能收到题目、并握手查询扩展信息。
          // document_start 是为了让网页在 DOMContentLoaded 时握手就能收到回应。
          //
          // 自动解析脚本：注入到来源站点，页面加载后自问「这道题要不要抓样例」。
          // document_idle 是刻意的——它要等的是样例 DOM，document_start 时页面上还什么都没有；
          // 真正的等待逻辑在脚本内部（见 src/autoParse.ts）
          content_scripts: [
            {
              matches: TARGET_SITE_PATTERNS,
              js: ['js/bridge.js'],
              run_at: 'document_start',
            },
            {
              matches: AUTO_PARSE_SITE_PATTERNS,
              js: ['js/autoParse.js'],
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

        if (target === 'chrome') {
          manifest.optional_host_permissions = optionalHostPermissions;

          manifest.background = {
            service_worker: 'js/background.js',
            type: 'module',
          };
        } else {
          manifest.optional_permissions = optionalHostPermissions;

          manifest.background = {
            scripts: ['js/background.js'],
            type: 'module',
          };

          manifest.browser_specific_settings = {
            gecko: {
              id: '{74e326aa-c645-4495-9287-b6febc5565a7}',
              data_collection_permissions: {
                required: ['websiteContent'],
              },
            },
          };
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

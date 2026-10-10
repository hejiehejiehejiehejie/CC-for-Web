import type { Parser } from '../parsers/Parser';

/**
 * 题目**来源**站点的匹配模式：从 parser 注册表推导。
 *
 * 【为什么不手写清单】手写一份「支持站点」数组必然与 src/parsers/ 下的实际能力漂移：
 * 每加一个 parser 就得记得回来补一条，忘了的症状是「manifest 里没有该站 → autoParse 不注入
 * → 自动解析静默失效」，没有任何报错。而 getMatchPatterns() 是编译期强制的抽象方法
 * （见 src/parsers/Parser.ts），从它推导漏不掉。
 *
 * 推导结果与 README「Supported websites」表一一对应：表上是 118 个站点，展开成模式是
 * 180 条 —— 差在镜像域（Codeforces 有 codeforces.com / *.codeforces.com / codeforc.es /
 * codeforces.ml / codeforces.net）、http 与 https 两种写法，以及 *.kattis.com 这类通配。
 *
 * 【为什么是纯函数、不 import 注册表】把注册表交给调用方传进来，本文件就零依赖，构建脚本和
 * 测试都能安全引用。反向依赖（本文件 import parsers）会把全部 parser 连同 jszip / pdfjs
 * 带进 import 方的 bundle —— src/hosts/targetSites.ts 与本文件同目录、且被后台脚本引用，
 * 一旦串起来就是几百 KB 的无谓体积。
 */

/** 一条 match pattern 拆出来的三段，path 原样保留（含 `*` 通配） */
interface ParsedPattern {
  scheme: string;
  host: string;
  path: string;
}

/**
 * 拆解一条 match pattern。不是 http(s) 模式（file:、ftp: 等）返回 null，
 * 这类模式不该出现在 host_permissions 里。
 *
 * 端口必须剥掉：parser 侧确实存在 `acm.sztu.edu.cn:40080`、`lysoi.top:88` 这类写法，
 * 而 Firefox 的匹配模式语法里没有端口槽位（Chrome 支持、Firefox 不接受，
 * 见 https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns）。
 * 带端口的模式写进 Firefox 的 manifest 不是「这一条失效」而是**整个扩展加载失败**。
 */
function parsePattern(pattern: string): ParsedPattern | null {
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(pattern.trim());
  if (match === null) {
    return null;
  }

  return {
    scheme: match[1],
    host: match[2].replace(/:\d+$/, ''),
    path: match[3] ?? '/',
  };
}

/**
 * 通配到全部站点的 host（字面量就是单个星号）。归一化后 host 位置是星号、path 是 `/*`，
 * 那等于向用户申请「读取你在所有网站的数据」——与「支持某些题目站点」是两回事，必须丢弃。
 * 目前只有 DOMjudgeContestParser 产出这种模式（它靠 path 认站），该站点退回右键菜单手动解析。
 */
const WHOLE_WEB_HOSTS = new Set(['*']);

/**
 * 通用平台（本身不是判题站）的 host。这类域名上收敛成 `host/*` 会让商店审核起疑——
 * 「一个刷题扩展为什么要读 facebook.com 的全部数据」——而 parser 实际只用其中一个路径，
 * 所以对这些 host 保留 parser 的原始 path。
 *
 * 判据是「这个域名是不是只为判题服务」：Codeforces、洛谷整站都是题库，收敛无所谓；
 * www.facebook.com 上只有 Meta Coding Competitions 那一块是题目。
 */
const PLATFORM_HOSTS = new Set(['www.facebook.com']);

/**
 * 结构性校验：scheme + host + path 三段齐全，host 非空、不含端口、不是全网通配。
 *
 * 匹配模式写错不是「这一条失效」，而是整个扩展加载失败，所以构建期要用它拦一道
 * （见 scripts/build/extension.ts），别让脏数据跑到用户手里。
 */
export function isValidMatchPattern(pattern: string): boolean {
  const match = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (match === null) {
    return false;
  }

  const host = match[2];
  return host.length > 0 && host !== '*' && !host.includes(':');
}

/**
 * 从 parser 注册表推导来源站点模式：归一化 + 丢弃全网权限 + 去重 + 排序。
 *
 * 排序是为了让产出稳定 —— 清单会进 manifest，diff 必须可读、可审。
 */
export function getSourceSitePatterns(parsers: readonly Parser[]): string[] {
  const patterns = new Set<string>();

  for (const parser of parsers) {
    for (const raw of parser.getMatchPatterns()) {
      const parsed = parsePattern(raw);

      if (parsed === null || WHOLE_WEB_HOSTS.has(parsed.host)) {
        continue;
      }

      // path 收敛为 `/*`：权限的作用是让脚本能读这个站点，具体哪些路径算题目由 parser 的
      // getRegularExpressions() 在运行时判定。把上游那些细路径全写进权限声明只会让清单变长、
      // 让审核更难读懂。通用的平台域名例外，见 PLATFORM_HOSTS。
      const path = PLATFORM_HOSTS.has(parsed.host) ? parsed.path : '/*';

      patterns.add(`${parsed.scheme}://${parsed.host}${path}`);
    }
  }

  return [...patterns].sort();
}

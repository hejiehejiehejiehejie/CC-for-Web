# AMO (addons.mozilla.org) 上架文案与提交清单

这份文件是 CC for Web 在 **AMO** 上的**唯一文案出处**。和 `SUBMISSION-EDGE.md` 对称：那份管 Edge Partner Center，这份管 AMO。

**为什么不合并**：两家的字段、字数上限、审核流程都不一样，且 AMO **不会**从 manifest 自动填描述（Edge 会）。硬凑一份必然又要拆回去。

**维护约定**：

- AMO 表单里改文案**不会回写到这里**。改完商店页要回来同步本文件，否则下次升版本又会拿旧稿去贴（2026-10-10 就因为这个把 Edge 的稿子误当成 AMO 的，见 §5）。
- 本文件里的长描述是把 **AMO 上原稿**逐字保留、再叠加增量，不要整段重写 —— 商店页的措辞是历史积累出来的，重写会丢掉已过审的表述。
- 只有「摘要」跟着包走（它写进 manifest），其余都是纯表单内容。

---

## 1. 本次提交：2.66.5（2026-10-20 起稿，**尚未提交**）

**2.66.5 改的只有行为，商店文案一个字没动**：加了 `fill-saved` 能力 —— 代填之后扩展自己等保存落定、关掉它自己开的那一页，再把结果回报给站点（站点据此自动完成验证）。manifest 的权限（184 条 `host_permissions`）、内容脚本（3 条）、`browser_specific_settings`（含 `gecko_android` 142）与 2.66.4 **逐字相同**，所以 §1.2–§1.6 照用。下文凡是写着「2.66.4」的地方都是那一版定稿时留下的口径，本版沿用它的决定，**不要按 2.66.5 重新理解一遍**。

### 1.1 上传哪两个文件

| 格    | 文件                                   | 说明                                                |
| ---- | ------------------------------------ | ------------------------------------------------- |
| 新版扩展 | `dist/cc_for_web-2.66.5-firefox.zip` | `pnpm package:firefox` 的产物（本机用 `tsx scripts/build/extension.ts firefox true false` + `web-ext build`，等价） |
| 源代码  | `dist/cc_for_web-2.66.5-source.zip`  | **每次升版本都要重传一份**，AMO 不记忆上一次。本版改动已提交（`7300d62`），这一份就是 `git archive HEAD` 的产物，可以直接上传 |

表单第一屏会问「是否使用代码生成或压缩工具」——本扩展用 esbuild 打包 + 压缩，必须答**是**，然后在这一屏上传源码包。

### 1.2 兼容平台（Compatible platforms）

- ☑ Firefox 桌面版
- ☑ **Firefox for Android**

两个都要勾。安卓端能装是因为 manifest 里有 `gecko_android`（下限 **142.0**，不是随便填的：AMO 强制的 `data_collection_permissions` 安卓端 142 才认识）。只勾桌面版，手机上就装不了。

### 1.3 摘要（Summary，上限 250 字符）

这一格应当与包内 manifest 的 `description` **完全一致**（158 字符）。**2.66.4 刻意不动它**：250 字符的上限已经被吃掉大半，再塞「代填」会把抓题那句挤掉，而抓题才是这个扩展的主业；新能力写在 §1.4 的长描述里：

```text
Parses competitive programming problems and sends them to your editor or online judge. Fork of Competitive Companion, now also working on Firefox for Android.
```

真源是 `scripts/build/extension.ts` 里 firefox 目标的 `descriptionOverride`（默认值取 `package.json` 的 `description`）。**只有 Firefox 目标有「Android」这句** —— Chrome / Edge / Opera 的移动端根本装不了扩展，给它们挂安卓支持会让商店页失真。

### 1.4 描述（Description）

存量原文逐字保留，**本次只加一段**（第 4 段：与 998244353.best 配合的登录态预检与验证码代填）；摘要、安卓段与「Problem parsing…」一节都不动。整段粘贴：

```text
CC for Web parses competitive programming problems and sends the parsed data into the companion web judge at 998244353.best, or to a tool running on your own machine.

Using it is very simple. Open https://www.998244353.best/, navigate to a problem page and click on the toolbar icon. On Codeforces the problem is parsed automatically as well, and you can use the Ctrl+Shift+U shortcut instead of the toolbar icon (configurable on about:addons > Cog > Manage Extension Shortcuts). The statement, samples, time limit and problem link then land in the judge's workspace, ready to run — no copy-pasting. If you also have a local tool listening, the same data is delivered to it over localhost. Both destinations have their own switch in the extension's options.

Firefox for Android (142+) is supported: the same parsed data lands in the companion web judge from a phone. The Ctrl+Shift+U shortcut is desktop-only — on Android, use the extension's icon in the browser menu.

When you use the companion web judge at 998244353.best, the extension also handles the one part of its sign-in that happens on Codeforces. It tells the site whether this browser is signed in as the Codeforces account you entered — comparing the handle locally and answering only yes / no / not signed in / unknown, so nothing the site does not already know leaves the browser — and, when you click the button, it writes the site's verification code into the Last name field of your Codeforces Social settings page and saves it. It fills that one field only, reads no cookies or credentials, and uploads nothing.

**Problem parsing is set up for the following websites out of the box:**
- every supported judge, via the toolbar icon;
- Codeforces parses fully automatically when you open a problem page, and other judges fill in the samples automatically once the problem is in your workspace.

Extra problem resources are fetched from these hosts only when a problem needs them, and only after you grant access at runtime:
- Google Coding Competitions
- TLX
- beecrowd

**Tools that use Competitive Companion:**
The data is delivered in the standard Competitive Companion format, so any tool that speaks it works — for example CP Editor, CHelper, JHelper, Competitive Programming Helper (VS Code), CompetiTest.nvim, or your own script. The format is documented in the README: https://github.com/jmerle/competitive-companion#custom-tools

---

This add-on is an independent, MIT-licensed fork of Competitive Companion by Jasper van Merle (https://github.com/jmerle/competitive-companion). It adds delivery into the companion web judge at https://www.998244353.best/, which the original does not provide. All original attribution is preserved.
```

### 1.5 审核者备注（Reviewer notes）

源码包这一屏下面那格。要回答「构建环境 / 怎么复现」，原文粘贴：

```text
Build instructions are in BUILD-INSTRUCTIONS.md at the root of the source package.
Note that the install line includes --ignore-scripts: a plain
`pnpm install --frozen-lockfile` aborts because two dev-only dependencies
(canvas, needed by jest-environment-jsdom, and puppeteer) run native install
scripts that need system cairo and a Chromium download. Neither is used to build
the extension; esbuild's platform binary comes from its optionalDependencies.
With --ignore-scripts, `pnpm build:firefox` reproduces build-firefox/ exactly as
submitted.
```

**2.66.4 还多了一条内容脚本**，审核员会看到它 —— 主动说清比被问到好（同样原文粘贴）：

```text
This version ships a third content script, js/fillCode.js. It is registered for
exactly one URL — https://codeforces.com/settings/social* — and does one thing:
when the user clicks the fill-in button on 998244353.best, it writes the site's
verification code into the Last name field of that page and submits the form.
It reads no cookies, no storage and no credentials, and it never returns page
content — only a short status (not signed in / wrong account / page not
recognised). The extra host permission exists for this single URL, and it is not
part of the parser registry.
```

### 1.6 权限说明

审核员大概率会问「为什么要 184 条 host 权限」。可直接引用的口径：

- `host_permissions` 共 **184** 条：其中 **183** 条是**构建期从 parser 注册表机推出**的（`scripts/build/extension.ts` 消费 `src/hosts/sourceSitePatterns.ts`），不是手写的；对应 118 个在线判题站点的域，加上镜像域 / 仅 http 的站 / 少数子域通配后膨胀到 180 条，再加本机投递目标与本站。第 **184** 条是 `https://codeforces.com/settings/social*` —— **不在 parser 注册表里**，是云同步代填验证码那一个页面专用的（说明见 §1.5）。
- `content_scripts` 三条：`js/bridge.js` **2** 条（本站与 localhost 的握手）、`js/autoParse.js` **180** 条（题目来源站点上的「待抓样例」探询）、`js/fillCode.js` **1** 条（只注入上面那条 host 权限指向的 Codeforces 设置页）。
- 高风险的几个域已刻意收窄：Meta Coding Competitions 实际在 `www.facebook.com` 上，权限只给 `/codingcompetitions/*/problems/*`；已剔除裸 IP 与个人站 / 校级站。
- 其余权限：`activeTab`（只在用户点图标或按快捷键时读当前页 URL）/ `scripting`（注入上面那三条内容脚本，都是扩展自己的代码，不是远程代码）、`contextMenus`、`storage`、`notifications`。
- 声明 `data_collection_permissions.required = ["websiteContent"]`，读的只有用户当前打开的那一页。**2.66.4 不新增这一栏**：预检读的是页头那枚公开链接、代填是**往**页面写一格（写入不属于数据收集），两者都不碰凭据 —— 主动说明放在 §1.5 的审核者备注里。

### 1.7 测试说明

正文沿用 `SUBMISSION-EDGE.md` §4「Certification testing notes」那一格 —— 内容与本扩展一致，**不在这里另抄一份**（抄两份必然会分叉）。

AMO 上额外补这一段（只在 2.66.3 这一版需要，后续版本可删）：

```text
A note on Firefox for Android. On Android the contextMenus and commands
namespaces do not exist at all, and older builds of this add-on threw a
TypeError while the background script was loading, which silently killed the
whole background — the symptom was that clicking the icon did nothing. That is
fixed in this version, and the add-on was verified on a real device running
Firefox 143. The Ctrl+Shift+U shortcut does not apply on Android; use the
extension's icon in the browser menu instead.
```

---

## 2. 每次升版本的固定三步

```bash
# 1. 改版本号（package.json）后出扩展包
pnpm package:firefox          # → dist/cc_for_web-<版本>-firefox.zip

# 2. 把全部改动提交 —— 源码包走 git archive，未提交的会被漏掉
git status                    # 确认干净，尤其留意「未跟踪的新文件」

# 3. 出源码包
git archive --format=zip -o dist/cc_for_web-<版本>-source.zip HEAD
```

**第 2 步是真会踩的坑**：2.66.3 出包时 `src/hosts/sourceSitePatterns.ts` 还是未跟踪的新文件，而它被 `scripts/build/extension.ts` 直接 import —— 不提交就进不了源码包，审核员按 `BUILD-INSTRUCTIONS.md` 构建会 import 失败。

出完包建议做一次**干净复现**：把源码包解压到空目录，照 `BUILD-INSTRUCTIONS.md` 跑一遍，产物应当与上传的扩展包逐字节一致（2.66.3 已验过）。

---

## 3. 版本记录

| 版本     | 日期                 | AMO 上的文案改动                                                                                             |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------ |
| 2.66.5 | 2026-10-20（起稿，未提交） | **文案与权限一律不动**，只加 `fill-saved` 能力（代填后等保存落定、关掉自己开的标签页、回报站点）。审核员问「这版改了什么」时答：代填那一步现在会自己等到 Codeforces 保存完成再收工，仍然只写 Last name 一个格子，不新增任何权限 |
| 2.66.4 | 2026-10-11（起稿，未提交） | 描述新增第 4 段：与 998244353.best 配合的两项便利（登录态预检、验证码代填）；审核者备注补第三条内容脚本的说明；权限数字 183→184、内容脚本 2→3。**摘要与其余段落一字未动** |
| 2.66.3 | 2026-10-10         | 描述新增安卓支持段；「Problem parsing…」一节由「只有 Codeforces」改为「全部支持的站点 + 工具栏图标」；摘要追加 fork 与安卓说明。描述正文的其余部分保持原样        |

---

## 4. 已知待办

- [ ] `SUBMISSION-EDGE.md` §3.2 的中英长稿里也有一句「已在 Firefox for Android 上验证可用」。Edge 移动端装不了扩展，这句放在 Edge 的商店页是多余的，建议删掉（**未做**）。

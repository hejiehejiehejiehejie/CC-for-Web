# Edge Add-ons 上架材料（CC for Web）

> **这份文件是什么**：Microsoft Edge Add-ons（Partner Center）提交时逐格要填的文案与素材规格，集中放一处，避免每次翻聊天记录。
> **维护义务**：下面第 2 节的内容**直接来自 manifest**，改 `package.json` / `scripts/build/extension.ts` 的任何上架相关字段后，回来同步这一节。第 3 节的权限清单同理——manifest 里加一个权限，这里就要加一条理由。
> **状态**：代码侧已就绪（包可产出、manifest 已按上架要求整理），宣传图与第 3 张截图已生成。**未完成**的是 Partner Center 账号注册、第 1 / 2 张截图（只能真机手拍）、以及站点部署（隐私政策 URL 要可达才能填）。

---

## 0. 包

| 项 | 值 |
| --- | --- |
| 产物 | `dist/cc_for_web-<version>-edge.zip`（`web-ext` 会把 `productName` 里的空格转成下划线） |
| 当前版本 | `2.66.2` |
| 构建目录 | `build-edge/`（与 `build-chrome/` **逐字节相同**，见第 8 节的校验） |

重新构建并打包：

```bash
pnpm package:edge
```

本机没装 pnpm 时的等价写法：

```bash
node node_modules/tsx/dist/cli.mjs scripts/build/extension.ts edge true false
./node_modules/.bin/web-ext build -s build-edge/ -a dist/ -o -n "{name}-{version}-edge.zip"
```

---

## 1. manifest 里会进商店页的字段（**只读**）

Edge 会把 manifest 的 `name` 与 `description` 自动填进商店页，且这两格在 Partner Center 的 **Store Listings** 页上是**只读的**——要改只能改 manifest 再重新上传包。

| manifest 字段 | 当前值 | 出处 |
| --- | --- | --- |
| `name` | `CC for Web` | `package.json` 的 `productName` |
| `description` | `Parses competitive programming problems and sends them to your editor or online judge.` | `package.json` 的 `description` |
| `version` | `2.66.2` | `package.json` 的 `version` |
| `homepage_url` | `https://www.998244353.best/` | `package.json` 的 `homepage`（**不是** `repository`——那个仍指向上游 fork 源，保留归属） |
| `author` | `Jasper van Merle` | `package.json` 的 `author`（上游作者，fork 归属） |

> 商店页显示的开发者名取自 **Partner Center 注册时填的开发者/组织名**，与 manifest 的 `author` 无关。

---

## 2. Privacy 页（Partner Center 左侧 **Privacy**）

这一页有五个板块，全部必须与扩展的实际行为一致——填错会被判定违反 Developer policies，导致额外审核或直接驳回。

### 2.1 Single Purpose（单一用途）

```text
This extension has exactly one purpose: parse the competitive-programming problem
page the user is currently viewing into structured data, and deliver it to a
destination the user chooses — a tool running on the user's own machine, or the
online judge site the user is already working in. The extension provides no
browsing, search, download, or advertising functionality.
```

### 2.2 Permission justification（逐条）

Partner Center 会按 manifest 里的权限逐个给出输入框。逐条粘贴：

**`activeTab`**

```text
Read the URL of the current tab at the moment the user clicks the extension icon
or presses its keyboard shortcut, so the extension can tell whether the current
page is a supported problem page. The permission is only exercised on that
explicit user action.
```

**`contextMenus`**

```text
Add a single "Parse this problem" item to the page context menu on supported
problem sites, so the user can trigger parsing without the toolbar icon.
```

**`storage`**

```text
Persist the user's own delivery preferences (whether to send to the local tool,
whether to send to the web judge). No problem content or personal data is stored.
```

**`scripting`**

```text
Inject the extension's own parsing/bridge script into supported pages: an
optional auto-parse script on the problem site, and a bridge script on the user's
own judge site so the page can receive the parsed problem. This is how the
extension delivers its single purpose; no remote code is injected.
```

**`notifications`**

```text
When delivery or script injection fails, show a system notification explaining
why. Without it the user sees nothing at all after pressing the shortcut, which
is indistinguishable from a broken extension.
```

**Host permission — `https://codeforces.com/*`**

```text
Read the problem statement and sample test data from the DOM of the problem page
the user has open, which is the data the user asked to be parsed.
```

**Host permission — `https://www.998244353.best/*` and `https://998244353.best/*`**

```text
The user's own judge site (developed by the same publisher). The extension
performs a handshake with this page and delivers parsed problems into its editor.
```

**Host permission — `http://localhost/*`**

```text
Deliver parsed problems to a tool the user runs on their own machine (code
editor extensions and similar local tools listen on localhost). This is a
machine-local request to a server the user is running; nothing leaves the user's
computer.
```

**Optional host permissions — `https://codejam.googleapis.com/dashboard/get_file/*`, `https://api.tlx.toki.id/v2/*`, `https://resources.beecrowd.com/*`**

```text
Download problem resources that these judge sites host on separate external
domains. Requested at runtime only when the user parses a problem on the
corresponding site, and denied access simply disables that one site's extra
resources.
```

> **注意**：开发端口 `http://localhost:5199/*` 与 `http://127.0.0.1:5199/*` 已在生产构建中被剔除（`scripts/build/extension.ts` 的 `DEV_ONLY_SITE_PATTERNS`）。若哪天在提交材料里看到它们，说明构建参数被改成了非生产（`isProduction=false`）。

### 2.3 Are you using remote code?（是否使用远程代码）

**选择 `No`。**

```text
All extension code is bundled inside the package. The extension never loads or
executes remote scripts. Network requests are made only to fetch problem
statement data (not executable code) from the sites listed above.
```

### 2.4 Data usage（数据用途）

要点（对着 Partner Center 的复选框与说明框如实勾选）：

```text
Data handled: the URL of the current tab (read only at the moment the user
invokes the extension) and the statement/sample text of the problem page the
user is viewing.

Where it goes: only to the destination the user chose — a tool running on the
user's own machine over localhost, or the user's own judge site. No data is sent
to the publisher's servers.

Retention: the extension keeps no server-side copy and does not persist problem
content. Delivery preferences are the only thing stored, locally, in the
browser.

Not collected: personally identifying information, authentication credentials,
health or financial data, location, browsing history beyond the single current
tab URL used at invocation time.

Not done: no selling, renting, or sharing of data with third parties; no
advertising; no analytics or profiling.
```

### 2.5 Privacy policy URL

```text
https://www.998244353.best/privacy.html
```

英文版（同一政策的英文页，供审核员阅读）：`https://www.998244353.best/privacy.en.html`

> **前置条件**：这两页在站点仓库（`wasm-oj-frontend`）里，**必须先部署上线**才能填——Partner Center 会校验 URL 可达，未上线的地址填不进去。
> 该页的维护纪律写在站点仓库 `HANDOFF.md` 第 12 节：内容必须与站点实际行为一致（云端同步上传的是公开可读的偏好项；切到 Piston / Judge0 时代码发往用户自己填的地址）。

---

## 3. Store listing（商店清单）

### 3.1 固定选项

| 字段 | 建议值 |
| --- | --- |
| **Category** | `Developer tools` |
| **Mature content** | 不勾（无成熟内容） |
| **Visibility** | `Public` |
| **Markets** | 全部（或至少 `China` + `United States`） |
| **Website** | `https://www.998244353.best/`（该字段要求指向自己的网站） |
| **Support contact detail** | `https://github.com/hejiehejiehejiehejie/cph-companion/issues` |

### 3.2 文案（按语言填写时粘贴）

manifest 的 `description` 会自动填默认语言那一格且只读；Partner Center 的 **Details for `<language>`** 允许按语言补充。下面两段是备用稿：

**中文（`zh-CN`）**

```text
把 Codeforces 的题面与样例一键送进你正在用的编辑器。

打开题目页，点一下工具栏图标或按 Ctrl+Shift+U，扩展就会解析题面、样例与题目信息，
投递给下面两个接收端（各自可开关，默认都开）：

· 你的在线判题网站：题面、样例、时限、题目链接直接落到工作区，不用复制粘贴；
· 本机运行的工具：通过 localhost 投递给本机的编辑器插件。

扩展不上传任何数据到开发者服务器：解析结果只在本机与你自己打开的那一页之间传递。
不收集浏览历史，不做广告，不做埋点。
```

**英文（`en`）**

```text
Send a Codeforces problem straight into the editor you are already using.

Open a problem page, click the toolbar icon (or press Ctrl+Shift+U), and the
extension parses the statement, samples and metadata and delivers them to two
destinations — each with its own switch, both on by default:

- your online judge site: statement, samples, time limit and problem link land in
  your workspace, no copy-pasting;
- a tool on your own machine: delivered over localhost to editor extensions.

Nothing is uploaded to the developer's servers. The parsed result travels only
between your browser and the page you already have open. No browsing history,
no ads, no analytics.
```

---

## 4. Certification testing notes（给审核员的测试说明）

**这一格很关键。** 本扩展只在特定站点生效，审核员打开任意网页会「毫无反应」，很容易被判成功能异常。原文粘贴：

```text
This extension only works on specific sites, so please follow these steps.

BASIC CHECK (no setup needed)
1. Open any Codeforces problem page, for example:
   https://codeforces.com/problemset/problem/4/A
2. Click the extension icon in the toolbar, or press Ctrl+Shift+U.
3. The extension parses the page and shows a system notification.
   NOTE: with no destination configured, the notification will say that no
   destination was found. THIS IS EXPECTED BEHAVIOUR, not a fault.

FULL DELIVERY CHECK
4. Open https://www.998244353.best/ — the page will indicate that the extension
   is installed.
5. Go back to the Codeforces problem page and press Ctrl+Shift+U. The problem is
   imported into the editor on that site.

WHAT THE EXTENSION NEVER DOES
It does not upload anything to the developer's servers. Parsed data travels only
between the user's browser, a tool running on the user's own machine (localhost)
and the user's own judge site.

Permissions in plain terms
- activeTab / scripting: read the current problem page only when the user clicks
  the icon or presses the shortcut, and inject the parser into it.
- contextMenus: add one "Parse this problem" right-click item on supported sites.
- storage: remember the user's two delivery switches.
- notifications: explain failures (otherwise the shortcut looks like it did
  nothing).
- codeforces.com host permission: read the statement and samples from the page.
- 998244353.best host permission: deliver the parsed problem into the user's own
  judge site.
- localhost host permission: deliver to a tool the user runs on their own machine.
```

---

## 5. 素材规格

| 素材 | 规格 | 数量 | Edge 取哪个文件 | 状态 |
| --- | --- | --- | --- | --- |
| 截图 | **1280×800** 或 640×480 | 最多 6 张，建议 3 张 | 见 5.1 | 第 3 张已生成（4 张备选），第 1、2 张待手拍 |
| 小宣传图 | 440×280 | 1 张 | `media/banners/chrome-small-promo.png` | 已生成 |
| 大宣传图 | 1400×560 | 1 张 | `media/banners/chrome-marquee-promo.png` | 已生成 |
| 包内图标 | 已含 10 个尺寸（最大 128px） | — | `media/icons/` | 已有 |

**宣传图与 Chrome 共用同一份文件**：Edge 的 440×280 / 1400×560 与 Chrome 的 small / marquee 规格完全一致，
生成的像素也一模一样，因此不另存 `edge-*` 副本，上传统一取 `media/banners/` 下这两个文件。
（`chrome-large-promo.png` 是 920×680，Chrome Web Store 独有规格，Edge 不需要。）

重新生成全部宣传图：

```bash
pnpm generate-banners
# 本机没有 pnpm 时：
node node_modules/tsx/dist/cli.mjs scripts/generate-banners.ts
```

`scripts/generate-banners.ts` 顶部的 `PRODUCT_NAME` 与 `TAGLINE` 是唯一改文案的地方。**字标必须与 manifest 的
`productName`（`CC for Web`）一致**——商店页标题由 manifest 自动填充且只读，图上的名字与之不符会让审核员
以为装错了扩展。改文案后重新跑一次上面的命令即可，4 张图会按各自画布自动挑横排或竖排布局。

主色沿用站点与扩展一致的蓝 `#0e639c`。

### 5.1 三张截图的内容与来源

| # | 内容 | 怎么产 | 状态 |
| --- | --- | --- | --- |
| 1 | Codeforces 题目页 + 工具栏图标（说明「点哪里」） | 真机手拍，见 5.1.1 | 待拍 |
| 2 | 解析成功后的系统通知 | 真机手拍，见 5.1.2 | 待拍 |
| 3 | 题目已导入 `www.998244353.best` 编辑器的工作区（说明「结果长什么样」） | 脚本自动，见 5.1.3 | 已生成，4 张备选 |

三张都必须是 **1280×800**。第 1、2 张只能手拍：工具栏图标画在浏览器 UI 上、通知卡片画在
操作系统层，页面内的自动化（puppeteer / CDP）够不着这两处——不是没试过，是结构上截不到。

墙上有个坑：Retina 手拍出来是 2560×1600，**必须缩一半**才能上传。缩放与复核：

```bash
sips -g pixelWidth -g pixelHeight shot.png        # 看尺寸
sips -z 800 1280 shot.png --out out.png           # 缩到 1280×800
sips -g pixelWidth -g pixelHeight out.png         # 复核：必须 1280 / 800
```

`sips -z` 是**拉伸**（不管宽高比），所以框选时就得照着 16:10 拖；差几个像素看不出变形，
差一成就明显了。

#### 5.1.1 第 1 张：工具栏图标（手拍）

1. Chrome 里只留一个标签页，打开一道真的题目页（建议 `https://codeforces.com/problemset/problem/4/A`，
   题面短、一眼能看出是题目页）。浏览器缩放保持 100%。
2. **用没登录的窗口**。这张图提交后是公开的——登录态会带出右上角的用户名、以及页面顶部的
   个人按钮。审核员看到是谁的账号无所谓，但没必要。
3. 关掉书签栏、下载条、翻译提示这类会在顶部多占一行的东西。
4. 把窗口拉到**内容区高度 ≥ 800 逻辑点**（MacBook 常见的 1512×982 屏幕放得下），
   窗口摆到屏幕左上角附近，让地址栏和工具栏完整可见。
5. `Cmd+Shift+4`，从**窗口左上角（地址栏左边缘）**开始拖。拖的时候 macOS 会在选框旁实时显示
   尺寸读数，**拖到读数正好 `2560 × 1600`** 松手 —— 这就是 1280×800 逻辑点，Retina 下的 2 倍图。
6. 按上面的 `sips` 两步缩放 + 复核。

#### 5.1.2 第 2 张：系统通知（手拍）

通知卡片是操作系统画在屏幕右上角的，不属于任何窗口，而且几秒后自动消失 —— 手速不够就容易空拍。
用 `screencapture` 的**延时**功能，把「按快捷键」和「截图」拆开：

```bash
# 8 秒后按给定矩形截图。x,y 换成 Chrome 窗口左上角的坐标（窗口摆到左上角就是 0,25 附近，
# 25 是菜单栏高度；不同机型菜单栏高度不一样，先试一张看有没有把菜单栏切进来）。
# -R 用的是逻辑点，Retina 上出图仍是 2560×1600，之后按上面的 sips 缩到 1280×800。
screencapture -x -R 0,25,1280,800 -T 8 ~/Desktop/shot2.png
```

回车之后 8 秒内切到 Chrome，在题目页上按 `Ctrl+Shift+U`（macOS 上是这个键，不是 ⌘），
等通知从右上角滑出来 —— 截图会自动落盘，不需要再动手。

通知文案有两种（成功 / 「没找到接收端」的失败提示）。**要拍成功那一条**：先在设置里
打开「投递到本机」或让站点页面开着（站点在的时候通知会写「已投递」）。拍出来的失败提示
会让审核员以为扩展坏了。

#### 5.1.3 第 3 张：站点工作区（脚本自动）

脚本在**站点仓库**（`wasm-oj-frontend`）里：`scripts/generate-store-screenshots.mjs`。

```bash
cd <站点仓库>
npm run screenshots:store
```

它自己挑一个空闲端口起 dev server、跑完自动关（不跟常驻的 `npm run dev` 抢 5199）。
产出在 `screenshots/`（该目录在站点仓库的 `.gitignore` 里，是本地物料、不进仓库）：

| 文件 | 内容 |
| --- | --- |
| `store-workspace-en-explorer.png` | 英文界面 + 资源管理器（文件树）**← 首选** |
| `store-workspace-en-tests.png` | 英文界面 + 评测样例面板 |
| `store-workspace-zh-explorer.png` | 中文界面 + 资源管理器 |
| `store-workspace-zh-tests.png` | 中文界面 + 评测样例面板 |

**首选 `en-explorer`**：它与 manifest 自动填进商店页的英文名 / 英文描述同一套语言，
而且「题目按 年月 / OJ / 难度 落进工作区」正是这个扩展的卖点。
`tests` 那两张是备选（把「样例也一起抓过来了」这件事画得更直白）。
中英两套都出，是因为 Partner Center 的 Store listings 按语言分页，各语言可以配各自的图；
不确定能不能分语言配的话，就只上英文那两张。

**这不是摆拍**：脚本投递的是扩展真的会发的那条 `cp-task` 消息（真实题目 JSON），
走站点自己的 `useCompanionBridge → importProblem` 落盘链路，树、页签、样例都是真状态。
脚本注意事项写在文件头（VFS 就绪时机、每张图用一个全新浏览器上下文那几条），改脚本前先读那段。

截图里的题目是 Codeforces 158A「Next Round」——样例行短，缩到 1280 宽之后评测面板里还读得清。

---

## 6. Partner Center 八步流程

1. **注册开发者账号** —— Microsoft Partner Center，Edge 扩展程序免费（需 Microsoft 账号）。注册时填的开发者/组织名会展示给用户。
2. 新建扩展，**上传包**：`dist/cc_for_web-2.66.2-edge.zip`。
3. **Availability** —— Visibility 选 `Public`，勾选市场。
4. **Properties** —— Category 选 `Developer tools`；Website 与 Support contact 见第 3.1 节。
5. **Privacy** —— 五个板块，见第 2 节。
6. **Store listings** —— 按语言补充文案，见第 3.2 节；上传截图与宣传图，见第 5 节。
7. **Certification testing notes** —— 见第 4 节。
8. **Submit** —— 之后等待认证。

---

## 7. 提交前检查清单

- [ ] 站点已部署，`https://www.998244353.best/privacy.html` 与 `/privacy.en.html` 都能打开
- [ ] `pnpm package:edge` 产出的包**是生产构建**（manifest 里**不含** `localhost:5199`，见第 2.2 节末尾）
- [ ] `diff build-chrome/manifest.json build-edge/manifest.json` 无输出（Edge 与 Chrome 分包完全一致）
- [ ] manifest 的 `version` 与 `package.json` 一致，且比上一次提交的版本高
- [ ] manifest 的 `description` 与 `homepage_url` 符合第 1 节的预期值
- [ ] 两张宣传图已就位（`media/banners/chrome-small-promo.png` 440×280、`chrome-marquee-promo.png` 1400×560）
- [ ] 三张截图已按第 5.1 节出好，且都是 1280×800（第 3 张用 `npm run screenshots:store` 出，第 1、2 张手拍）
- [ ] 宣传图与截图上的产品名都是 `CC for Web`（与 manifest 一致）
- [ ] Partner Center 注册信息里的开发者名想清楚了（会公开显示）

---

## 8. 后续：Firefox AMO / Opera / 国内商店能复用的部分

- **包**：`build-firefox/` 与 `build-edge/` 的区别只有三处（`optional_permissions`、`background.scripts`、`browser_specific_settings`），已在 `scripts/build/extension.ts` 的 `BROWSERS` 表里显式声明。
- **可整段复用**：第 2.1 / 2.2 / 2.3 / 2.4 节（Single Purpose、权限理由、远程代码、数据用途）——AMO 的 **Privacy practices** 问的是同一批事情。
- **可复用**：第 3.2 节的商店文案、第 5 节的素材规格（AMO 的截图尺寸要求不同，需另查）。
- **AMO 独有的两件事**：① 审核要求**提交源码 + 可复现构建说明**（因为我们用 esbuild 打包压缩过）；② Firefox 下 `chrome://extensions` 那类提示文案要换成 `about:debugging`。
- **Opera / 国内商店**：基本直接吃 Chromium 系的包，但各自开放平台的资质与审核标准要单独查。

---

## 9. 未决事项

- **扩展仓库与站点仓库的版本号对不上**：扩展是 `2.66.2`，站点 `HANDOFF.md` 里记录的 `EXTENSION_VERSION` 是 `2.66.0`。上架后站点分发包（`public/extension/cc-for-web-<版本>.zip`）要不要一并跟进多浏览器版本、以及新包的文件命名规则，尚未决定。
- **`author` 仍是上游作者** `Jasper van Merle`：这是 MIT fork 的归属声明，建议保留；若 Partner Center 的开发者名与之不一致，审核员可能会问，届时按「fork 关系」如实解释即可。
- **截图**：第 3 张（站点工作区）已能脚本生成（第 5.1.3 节，4 张备选在站点仓库的 `screenshots/`）。
  第 1、2 张（工具栏图标、系统通知）只能真机手拍，操作单见第 5.1.1 / 5.1.2 节 —— **这是还挡着提交的唯一实体物料**。
- **宣传图上的标语是英文且写死了**：`TAGLINE = 'From Codeforces to your editor'`，与商店页的中英双语文案不是同一套。若要按语言分别出图，需要给 `generate-banners.ts` 加一层语言参数。

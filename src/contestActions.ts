/**
 * 比赛动作脚本（2026-10-26 加，扩展 2.68.0）：声明式注入到 Codeforces 的四个位置 ——
 *   - `/contests/page/1`：读每一场的报名状态（MessageAction.ReadContestStates）
 *   - `/contestRegistration/{id}`：提交报名表单（MessageAction.SubmitRegistration）
 *   - `/contestRegistration/{id}/virtual/true`：开一场 VP（MessageAction.StartVirtual）
 *   - `/contest/{id}/standings*`：读指定 handle 的非正式名次（MessageAction.ReadUnofficialRank）
 * 注入点见 scripts/build/extension.ts 的 CONTEST_ACTIONS_SITE_PATTERNS。
 *
 * 【为什么必须走扩展】题目管理网站（998244353.best）自己做不到：它跨源拿不到 CF 的会话，
 * 而报名与开 VP 都是必须带着用户登录态、对着 CF 自己的表单发 POST 的动作。
 * 扩展本来就注入在 codeforces.com，正是干这件事的位置。
 *
 * 【信任边界，与一键提交一字不差】
 *   - 不读 `document.cookie`，不走任何 Codeforces 接口取凭据；
 *   - 报名 / 开 VP 只在**用户显式点按确认之后**发生，由后台在那一次请求里触发；
 *     本脚本平时什么都不做，绝不自动报名；
 *   - 回给后台的只有原因枚举、状态枚举与名次数字，**不回传页面内容**。
 *
 * 【reason 是跨仓契约】与网站侧 useCompanionBridge.js 的 `cp-register-result` 等一一对应：
 *   `not-logged-in` / `challenge` / `page` / `not-eligible` / `already-registered` /
 *   `unrated-unavailable`（2026-10-30 加：要的是不计分，可这一页没有那个控件）。
 * 其余原因（`rejected`、`timeout`、`no-tab`、`bad-contest`）由后台与网站侧产生。
 *
 * 【报名状态也是契约】`open` / `before` / `closed` / `registered` / `count` / `unknown`，
 * 网站按它决定那一列显示什么。`count` 是「只剩参赛人数那条链接」——比赛进行中与已结束都长这样，
 * 分不出能不能报名，所以单独留一个值，让网站显示成「—」而不是瞎猜一个。
 *
 * 【2026-11-03 两处改动】① `applyField` 不再对未选中的单选框派发 change —— CF 以前会把
 * 「个人 / 队伍」的内部变量记成 team，提交时报 "Please, choose the team"；② 开 VP 时可以带
 * 一个 `startAt`（毫秒时间戳），填进 CF 表单的 `Virtual start time`。
 *
 * 【2026-11-03 第二批】① 读报名状态时顺带读 `/contests` 右侧的「Recent virt. contests」，
 * 把账号上每一场 VP 的开始时刻带回去（站点据此把比赛摆到 VP 的时刻、开赛前锁题锁榜）；
 * ② 读非正式名次时连计分与逐题格一起读回来（`score` / `cells`），站点才能把 VP 那一行
 * 画进榜表格里。仍然只回数字与页面上的短文字，不回传页面内容。
 *
 * 【2026-11-03 修（拿 2278 的真实页面抓出）】① 好友榜的名次格是 `2 (1236)` 两段 ——
 * 括号里才是总榜名次，只取第一个数会把「好友内第 2」当成「总榜第 2」；② CF 的表头不在
 * `<thead>` 里，整张表只有一个 tbody、第一行是 `<th>` —— 只认 thead 会一个题格都读不到。
 */
import { pageProblem } from './cfIdentity';
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';

/** 表单一交出去页面就整页跳转，这一小段延迟是给 sendResponse 留出把消息发出去的时间 */
const SUBMIT_DELAY = 50;

/** CF 的日期框 / 「Recent virt. contests」用英文月份缩写（页面上自己渲染出来就是 `Nov/03/2026`） */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type RegistrationState = 'open' | 'before' | 'closed' | 'registered' | 'count' | 'unknown';

/** 报名方式：计分 / 不计分。CF 只对允许 unrated 的轮次给出这个控件（2026-10-30 加） */
type RatingChoice = 'rated' | 'unrated';

type PageReason =
  | ''
  | 'not-logged-in'
  | 'challenge'
  | 'page'
  | 'not-eligible'
  | 'already-registered'
  /** 用户要的是不计分，但这场报名的表单里根本没有那个控件 —— 不提交，让他自己去 CF 看 */
  | 'unrated-unavailable';

interface ActionReply {
  ok: boolean;
  reason: PageReason;
}

interface StatesReply {
  ok: boolean;
  reason: PageReason;
  states: Record<string, RegistrationState>;
  /**
   * CF「Recent virt. contests」里列出的虚拟参赛（2026-11-03 加）。
   *
   * 【为什么要读它】VP 是账号级事实：`contest.list` 里那一场仍是官方时刻，用户开过 VP 之后
   * 应当按自己定的时刻参赛。站点靠这份列表知道「这一场几点开始」，包括在别处开的那些。
   */
  virtuals: VirtualEntry[];
}

interface VirtualEntry {
  id: string;
  name: string;
  /** VP 开始时刻（毫秒时间戳，UTC） */
  startMs: number;
}

interface RankEntry {
  handle: string;
  /** 榜单上的名次数字（含非正式选手的总榜名次） */
  rank: number;
  /** 这一行是不是非正式（VP / unrated）选手 —— 网站据此打一枚标记 */
  unofficial: boolean;
  /** 计分列的文字（CF 是总分，ICPC 是过题数）；读不到为空串 */
  score: string;
  /** 题号 → 那一格的文字（`+1 00:23` / `-1` / `.`）：网站拿它画 VP 那一行 */
  cells: Record<string, string>;
}

interface RankReply {
  ok: boolean;
  reason: PageReason;
  /** 名次是从哪一页读到的：好友榜 / 合并榜第一页；空串 = 没读到 */
  source: 'friends' | 'page1' | '';
  ranks: RankEntry[];
}

// ------------------------------------------------------------ 报名状态

/**
 * 一行比赛末尾那个单元格说的是什么。
 *
 * 认字不认结构：CF 这一列由服务端直接渲染成文字 / 链接，没有稳定的 class 可用，
 * 唯一可靠的信息就是那几句话（2026-10-26 实测页面；2026-10-30 补全语料）：
 *
 *   `Registration completed x17284`  已报名
 *   `Register » x1521 Until closing 4 days`  报名开放、尚未报名
 *   `Before registration 3 days`  报名还没开放
 *   `Registration closed`  报名已关
 *   `x17284`  进行中 / 已结束（只剩人数，分不出报名与否）
 */
function registrationStateOf(row: Element): RegistrationState {
  const cell = row.lastElementChild;

  if (cell === null) {
    return 'unknown';
  }

  const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();

  // 「已报名」CF 写的是 **Registration completed**（原文：`Registration completed x17284`），
  // 里面**没有 registered 这个词** —— 2026-10-30 前这里只认 /registered/i，已报名的行一路落到
  // 后面的分支，最后返回 unknown，站点的赛程就把它显示成「—」。
  // 顺序仍然要在「Registration closed」前面判：两句都以 Registration 开头。
  if (/registration (is )?completed|registered/i.test(text)) {
    return 'registered';
  }

  if (/before registration/i.test(text)) {
    return 'before';
  }

  if (/registration (is )?closed|registration (has )?ended/i.test(text)) {
    return 'closed';
  }

  if (cell.querySelector('a[href*="/contestRegistration/"]') !== null || /register\s*»/i.test(text)) {
    return 'open';
  }

  if (cell.querySelector('a[href*="/contest/"]') !== null || /participant/i.test(text)) {
    return 'count';
  }

  return 'unknown';
}

function readContestStates(): Record<string, RegistrationState> {
  const states: Record<string, RegistrationState> = {};

  for (const row of Array.from(document.querySelectorAll('tr[data-contestid]'))) {
    const id = row.getAttribute('data-contestid') ?? '';

    if (/^\d+$/.test(id)) {
      states[id] = registrationStateOf(row);
    }
  }

  return states;
}

function readStates(): StatesReply {
  const problem = pageProblem();

  if (problem !== '') {
    return { ok: false, reason: problem, states: {}, virtuals: [] };
  }

  const states = readContestStates();

  // 一行都认不出来 = 这一页不是比赛列表（被重定向 / 改版），别让网站把整列都渲染成「—」
  if (Object.keys(states).length === 0) {
    return { ok: false, reason: 'page', states: {}, virtuals: [] };
  }

  return { ok: true, reason: '', states, virtuals: readVirtualContests() };
}

// ------------------------------------------------------------ 虚拟参赛（VP）列表

/**
 * 页面自己用的时区偏移（分钟）。
 *
 * 「Recent virt. contests」里的 `data-virtual-start-time` 是按页面时区渲染的
 * （`<meta name="utc_offset" content="+03:00"/>` 就是它）。不带上这个偏移，
 * 东八区的用户会读出三小时的偏差 —— VP 的开始时刻差三小时，整个赛程都是错的。
 */
function pageUtcOffsetMinutes(): number {
  const content = document.querySelector('meta[name="utc_offset"]')?.getAttribute('content') ?? '';
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(content.trim());

  if (match === null) {
    return 0;
  }

  const minutes = Number(match[2]) * 60 + Number(match[3]);

  return match[1] === '-' ? -minutes : minutes;
}

/** `Nov/03/2026 01:55`（页面时区）→ 毫秒时间戳；解析不出返回 0 */
function parsePageTime(text: string, offsetMinutes: number): number {
  const match = /^([A-Z][a-z]{2})\/(\d{1,2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(text.trim());

  if (match === null) {
    return 0;
  }

  const month = MONTH_NAMES.indexOf(match[1]);

  if (month < 0) {
    return 0;
  }

  const utc = Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]));

  return utc - offsetMinutes * 60000;
}

/**
 * 最近的那一场 VP 显示的是一枚倒计时（`00:05:21`，带 countdown 类）：拿它比绝对时刻准 ——
 * 不受页面时区与本地时钟差的影响。格式认不出（比如「1 day」这种长距离写法）就退回绝对时刻。
 */
function countdownStartMs(anchor: Element): number {
  if (!anchor.classList.contains('countdown')) {
    return 0;
  }

  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec((anchor.textContent ?? '').trim());

  if (match === null) {
    return 0;
  }

  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

  return Date.now() + seconds * 1000;
}

/**
 * 读 /contests 右侧「Recent virt. contests」。
 *
 * 每行一条 `a.change-virtual-contest-start-time[data-contest-id][data-virtual-start-time]`，
 * 名字在同一个 `<tr>` 的第一个单元格里（后面还跟着一个 `Enter »` 链接）。
 * 只回 id / 名字 / 开始时刻 —— 页面上别的东西一律不读。
 */
function readVirtualContests(): VirtualEntry[] {
  const box = document.querySelector('.virtual-contests');

  if (box === null) {
    return [];
  }

  const entries: VirtualEntry[] = [];
  const offsetMinutes = pageUtcOffsetMinutes();

  for (const link of Array.from(box.querySelectorAll('a.change-virtual-contest-start-time'))) {
    const id = link.getAttribute('data-contest-id') ?? '';

    if (!/^\d+$/.test(id)) {
      continue;
    }

    const startMs =
      countdownStartMs(link) || parsePageTime(link.getAttribute('data-virtual-start-time') ?? '', offsetMinutes);

    if (startMs <= 0) {
      continue;
    }

    // 名字：单元格里除了名字还有一个「Enter »」链接，复制一份、摘掉链接再取文字
    const nameCell = link.closest('tr')?.querySelector('td');
    let name = '';

    if (nameCell !== null && nameCell !== undefined) {
      const copy = nameCell.cloneNode(true) as Element;
      copy.querySelectorAll('a').forEach(anchor => anchor.remove());
      name = (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    entries.push({ id, name, startMs: Math.round(startMs) });
  }

  return entries;
}

// ------------------------------------------------------------ 报名 / 开 VP

/**
 * 报名表单位置。
 *
 * 不按 class 认：CF 的报名页与 VP 页用的不是同一套 id，而两者都必然含有确认字段
 * （`takePartAs` 或 `action`）。按字段找，两种页面一次都认得出。
 */
function findRegistrationForm(): HTMLFormElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLFormElement>('form')).find(
      form => form.querySelector('input[name="takePartAs"], input[name="action"]') !== null,
    ) ?? null
  );
}

/**
 * 把表单里的某个字段设成目标值。
 *
 * 三种控件都要照顾到：隐藏框直接改 value；复选框按「值是 true 就勾上」处理
 * （VP 页的 `virtual` / `requiredConfirmation` 就是复选框）；单选框只勾值对得上的那一颗。
 * 改完派发 change —— 报名页会在 change 里联动团队选择区，不派发的话提上去的还是旧状态。
 *
 * 【只对真正变了的单选框 / 复选框派发】CF 的报名页把 `takePartAs` 的当前值缓存在一个变量里，
 * change 处理器读的是**触发事件那颗 radio 的 value**，不看它 checked 与否（2026-11-03 实测）：
 * 我们连「as a team member」那颗（未选中）也派发一次 change，CF 就把内部变量记成 team、
 * 展开团队选择区，提交时校验报 "Please, choose the team" —— 明明界面上勾的是个人。
 */
function applyField(form: HTMLFormElement, name: string, value: string): void {
  const fields = Array.from(form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));

  for (const field of fields) {
    if (field.type === 'checkbox') {
      const next = value === 'true' || field.value === value;

      if (field.checked === next) {
        continue;
      }

      field.checked = next;
    } else if (field.type === 'radio') {
      const next = field.value === value;

      if (field.checked === next) {
        continue;
      }

      field.checked = next;
    } else {
      field.value = value;
    }

    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * 一个控件自己那段文字：name / value / aria-label / 包着它的 label / `label[for]` /
 * 紧跟在它后面的那段纯文字，全部拼起来认。
 *
 * CF 把说明写在哪一处不固定 —— 有时是 `<label><input …> participate as rated</label>`，
 * 有时是 `<input …> participate as rated` 这种裸文本兄弟节点。所以不认结构，认词。
 */
function controlLabel(field: HTMLInputElement | HTMLSelectElement, form: HTMLFormElement): string {
  const parts: string[] = [field.getAttribute('name') ?? '', field.value ?? '', field.getAttribute('aria-label') ?? ''];

  const wrapper = field.closest('label');

  if (wrapper !== null) {
    parts.push(wrapper.textContent ?? '');
  }

  const id = field.getAttribute('id');

  if (id !== null && id !== '') {
    const explicit = form.querySelector(`label[for="${CSS.escape(id)}"]`);

    if (explicit !== null) {
      parts.push(explicit.textContent ?? '');
    }
  }

  const next = field.nextSibling;

  if (next !== null && next.nodeType === Node.TEXT_NODE) {
    parts.push(next.textContent ?? '');
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** 这段文字说的是哪一边；两个词都没有 = 与计分无关的控件（比如「个人 / 队伍」那一组） */
function ratingSide(text: string): RatingChoice | '' {
  // unrated 里也含 rated，先认它
  if (/unrated/i.test(text)) {
    return 'unrated';
  }

  if (/rated/i.test(text)) {
    return 'rated';
  }

  return '';
}

/**
 * 把「计分 / 不计分」按用户的选择设进表单，返回**到底设上了没有**。
 *
 * 【认字不认结构】CF 对允许 unrated 的轮次会放一个带 rated / unrated 字样的控件，但它是
 * 复选框、单选组还是下拉框，各轮次的页面并不一致（2026-10-30 定：三种都按词认）。
 * `takePartAs` 那一组是「个人 / 队伍」，与计分无关，名字里带 rating 也一律跳过。
 *
 * 【设不上就不提交】调用方靠这个布尔决定要不要回 `unrated-unavailable`：用户要的是不计分，
 * 而这一页没有那个控件，替他按计分报下去是不可逆的错 —— 宁可让他自己去看一眼。
 */
function applyRatingChoice(form: HTMLFormElement, choice: RatingChoice): boolean {
  const fields = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[type="checkbox"], input[type="radio"], select'),
  );

  let applied = false;

  for (const field of fields) {
    if ((field.getAttribute('name') ?? '') === 'takePartAs') {
      continue;
    }

    // 下拉框：两个选项都在同一个控件里，按 option 的文字挑
    if (field instanceof HTMLSelectElement) {
      const option = Array.from(field.options).find(
        candidate => ratingSide(`${candidate.value} ${candidate.textContent ?? ''}`) === choice,
      );

      if (option !== undefined) {
        field.value = option.value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        applied = true;
      }

      continue;
    }

    const side = ratingSide(controlLabel(field, form));

    if (side === '') {
      continue;
    }

    field.checked = side === choice;
    field.dispatchEvent(new Event('change', { bubbles: true }));

    // 复选框两边都能表达：勾上=它自己那一边，不勾=另一边。所以只要认出了它是计分相关的，
    // 「设上了」就成立 —— 「participate as rated」那颗不勾，本身就是不计分报名（实测最常见的
    // 形态就是这个，2026-10-30）。单选组反过来：每颗只管自己那一边，没有要的那颗就是没有。
    if (field.type === 'checkbox' || side === choice) {
      applied = true;
    }
  }

  return applied;
}

/** 只有 `action=formSubmitted` 是服务端要求的确认字段：缺了就补一个隐藏框 */
function ensureField(form: HTMLFormElement, name: string, value: string): void {
  if (form.querySelector(`input[name="${name}"]`) !== null) {
    applyField(form, name, value);
    return;
  }

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  form.appendChild(input);
}

/** 直接写值、不派发事件：给挂了 jQuery 小部件的输入框用（见 applyVirtualStartAt） */
function setFieldValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);

  if (field !== null) {
    field.value = value;
  }
}

/** CF 的日期框用英文月份缩写（见文件顶部 MONTH_NAMES） */
function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 把用户选的虚拟参赛开始时刻填进 CF 的 VP 表单。
 *
 * 【与页面自己的初始化同格式】CF 的 `setupFormDatetimePicker` 把隐藏字段 `initialDatetime`
 * （服务器时区的 `Nov/03/2026 01:35`）换算成本地时间，拆进 `startDay` + `startTime` 两个输入框，
 * 服务端再靠 `clientTimezoneOffset`（分钟，东八区是 480）把它们换算回 UTC。这里照同样的格式填：
 * 鼠标不动直接提交时，服务端收到的就是我们在这里写的这串。
 *
 * 【不派发事件】两个输入框各挂了一个 jQuery 小部件（datepick / timeEntry），它们的解析挂在
 * input / blur 上 —— 直接写值等于页面初始化那一刻的写法；派发 change 反而可能让部件按自己的
 * 显示格式重排一遍，把要提交的值改掉。
 */
function applyVirtualStartAt(form: HTMLFormElement, startAt: number): void {
  const date = new Date(startAt);

  if (Number.isNaN(date.getTime())) {
    return;
  }

  const day = `${MONTH_NAMES[date.getMonth()]}/${padTwo(date.getDate())}/${date.getFullYear()}`;
  const clock = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;

  setFieldValue(form, 'startDay', day);
  setFieldValue(form, 'startTime', clock);
  // getTimezoneOffset() 是「本地比 UTC 早多少分钟」的反号（东八区返回 -480），与 moment().utcOffset() 同号
  setFieldValue(form, 'clientTimezoneOffset', String(-date.getTimezoneOffset()));
}

/** 点页面自己的提交按钮（挂着自己的校验与 CSRF 处理）；实在找不到才退回 form.submit() */
function submitForm(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]');

  if (button !== null) {
    button.click();
    return;
  }

  form.submit();
}

/**
 * 用户没登录 / 没有资格 / 已经报过名：这三种都不是「页面认不出来」，分开报，
 * 网站才能各给一句对得上号的话。判据是页面上那几句话，不看表单在不在 ——
 * 这三种情形下 CF 干脆不渲染报名表单。
 */
function missingFormReason(): PageReason {
  const text = document.body?.textContent ?? '';

  if (/already registered|you have registered/i.test(text)) {
    return 'already-registered';
  }

  if (
    /not available|not allowed|can ?not (participate|register)|registration (is )?closed|registration (has )?ended/i.test(
      text,
    )
  ) {
    return 'not-eligible';
  }

  return 'page';
}

/**
 * 把报名表单准备好：确认字段、个人身份、以及（可选的）计分方式 / 虚拟参赛开始时刻。
 *
 * 【unrated 只在「报名」上有意义】VP 本来就不计分，这一项对 VP 页一律不碰；
 * 用户没选（unrated 缺省 false）时走显式「计分」，与改动前一字不差。
 *
 * 【startAt 只在「开 VP」上有意义】毫秒时间戳；缺省 / 不是正数时不动那一行，
 * CF 页面自己的默认值就是「现在」，与改动前一字不差。
 */
function prepareEntry(
  kind: 'register' | 'virtual',
  options: { unrated?: boolean; startAt?: number } = {},
): { result: ActionReply; form: HTMLFormElement | null } {
  const problem = pageProblem();

  if (problem !== '') {
    return { result: { ok: false, reason: problem }, form: null };
  }

  const form = findRegistrationForm();

  if (form === null) {
    return { result: { ok: false, reason: missingFormReason() }, form: null };
  }

  // 两个确认字段是 CF 自己的表单要求的，缺一个服务端都会把这次 POST 当成没确认过
  ensureField(form, 'action', 'formSubmitted');
  applyField(form, 'takePartAs', 'personal');

  if (kind === 'register') {
    const wantUnrated = options.unrated === true;

    // 计分是默认值：有那颗控件就显式选回来，没有也不必报错（页面默认就是计分）。
    // 不计分反过来 —— 设不上就说明这一场没有这个选项，绝不替他按计分报下去
    if (wantUnrated) {
      if (!applyRatingChoice(form, 'unrated')) {
        return { result: { ok: false, reason: 'unrated-unavailable' }, form: null };
      }
    } else {
      applyRatingChoice(form, 'rated');
    }
  }

  if (kind === 'virtual') {
    // VP 页的隐藏字段：virtual 打开了才走虚拟参赛那条分支；teamId=-1 是「个人身份」
    applyField(form, 'virtual', 'true');
    applyField(form, 'requiredConfirmation', 'true');
    applyField(form, 'teamId', '-1');

    if (typeof options.startAt === 'number' && Number.isFinite(options.startAt) && options.startAt > 0) {
      applyVirtualStartAt(form, options.startAt);
    }
  }

  return { result: { ok: true, reason: '' }, form };
}

// ------------------------------------------------------------ 非正式名次

/** 榜单里指向选手的那条 `/profile/<handle>` 链接 */
function profileHandle(link: Element): string {
  const match = /\/profile\/([^/?#]+)/.exec(link.getAttribute('href') ?? '');

  return match === null ? '' : decodeURIComponent(match[1]).trim();
}

/**
 * 非正式标记。
 *
 * 三处都认：名次后面跟的 `*`（CF 对非正式选手的惯用标法）、行上的语义 class、
 * 以及选手名旁边那枚 `sup` 标记（title 是 Virtual participant / unrated / unofficial）。
 * 全落空就当正式 —— 少打一枚标记比错打一枚好。
 */
function isUnofficialRow(row: Element, rankText: string): boolean {
  if (rankText.includes('*')) {
    return true;
  }

  if (row.classList.contains('unrated') || row.classList.contains('unofficial')) {
    return true;
  }

  return row.querySelector('sup[title*="virtual" i], sup[title*="unrated" i], sup[title*="unofficial" i]') !== null;
}

/**
 * 榜单表头给了什么：计分列在哪、每个题号占第几列。
 *
 * 【认字不认结构】CF 的榜单列随计分制变：CF 是 `# / Contestant / Score / A / B …`，
 * ICPC 是 `# / Contestant / = / Penalty / A / B …`，有的轮次末尾还多一列 Hacks。
 * 题号是 `A` / `B1` / `E2` 这样的短标；计分列是 `Score` / `=` / `Solved`。
 * 认不出表头时计分列退回第 3 列（CF 的固定版式），题号一格都不读 ——
 * 宁可少画一行成绩，也不按错的列画。
 */
function standingsColumns(doc: Document): { score: number; problems: Array<{ index: string; at: number }> } {
  // CF 的表头**不在 thead 里**：整张表只有一个 tbody，第一行是 `<th>`（2026-11-03 拿
  // 2278 的真实页面验过）。只认 thead 会让题号一个都读不到，所以先找带 `<th>` 的那一行
  const rows = Array.from(doc.querySelectorAll('.standings tr'));
  const header = rows.find(row => row.querySelector('th') !== null) ?? rows[0];
  const problems: Array<{ index: string; at: number }> = [];
  let score = -1;

  Array.from(header?.children ?? []).forEach((cell, at) => {
    const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();

    if (/^[A-Z]\d{0,2}$/.test(text)) {
      problems.push({ index: text, at });
      return;
    }

    if (score < 0 && /^(?:score|=|solved)$/i.test(text)) {
      score = at;
    }
  });

  return { score: score >= 0 ? score : 2, problems };
}

/** 一个单元格的文字：换行、连续空白归一成一个空格（CF 的题格是「判定 + 时刻」两段） */
function cellText(cell: Element | undefined): string {
  return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 在一份榜单文档里找这些 handle，各取一次名次、计分与逐题成绩 */
function readRankRows(doc: Document, wanted: Set<string>): RankEntry[] {
  const found: RankEntry[] = [];
  const columns = standingsColumns(doc);

  for (const row of Array.from(doc.querySelectorAll('.standings tr'))) {
    const link = row.querySelector('a[href*="/profile/"]');

    if (link === null) {
      continue;
    }

    const handle = profileHandle(link);

    if (!wanted.has(handle.toLowerCase())) {
      continue;
    }

    const cells = Array.from(row.children);

    if (cells.length < 2) {
      continue;
    }

    // 好友榜的名次格是**两段**：`2 (1236)` = 「好友里第 2 · 总榜第 1236」——
    // 站点要的是括号里那个总榜名次（这个口径才含非正式参赛者）。合并榜兜底页只有单个数字
    // （`1236`），没有括号时退回第一个数。2026-11-03 只取第一个数的写法报出「第 2 名」时抓出
    const rankText = (cells[0].textContent ?? '').replace(/\s+/g, ' ').trim();
    const overall = /\(\s*(\d+)\s*\)/.exec(rankText);
    const digits = /^(\d+)/.exec(rankText);
    const rank = Number.parseInt(overall?.[1] ?? digits?.[1] ?? '', 10);

    if (!Number.isFinite(rank) || rank <= 0) {
      continue;
    }

    // 题格按表头给的列位取；空串不放进 cells（网站按「没交」画点）
    const problemCells: Record<string, string> = {};

    for (const problem of columns.problems) {
      const text = cellText(cells[problem.at]);

      if (text !== '') {
        problemCells[problem.index] = text;
      }
    }

    found.push({
      handle,
      rank,
      unofficial: isUnofficialRow(row, rankText),
      score: cellText(cells[columns.score]),
      cells: problemCells,
    });
  }

  return found;
}

/** 当前榜单所属的比赛路径：`/contest/2276`、`/gym/100001`、`/group/123/contest/456` */
function standingsBase(pathname: string): string {
  const match = /^\/(?:contest\/\d+|gym\/\d+|group\/\d+\/contest\/\d+)(?=\/|$)/.exec(pathname);

  return match === null ? '' : match[0];
}

/**
 * 兜底：现拉一次合并榜第一页。
 *
 * 好友榜要求登录且只含好友；没登录、或本人根本没进过好友关系时，那一页是空的。
 * 而**第一页**合并榜带着 `showUnofficial=true`，匿名也取得到（实测 200）。
 * 只看第一页是刻意的：深翻页每个请求都会被 CF 拦一次，而「不在第一页」本身已经是可接受的答案。
 */
async function fetchFirstStandingsPage(): Promise<Document | null> {
  const base = standingsBase(window.location.pathname);

  if (base.length === 0) {
    return null;
  }

  try {
    const response = await fetch(`${window.location.origin}${base}/standings/page/1?showUnofficial=true`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    return new DOMParser().parseFromString(await response.text(), 'text/html');
  } catch {
    return null;
  }
}

async function readRanks(handles: string[]): Promise<RankReply> {
  const wanted = new Set(handles.map(handle => handle.trim().toLowerCase()).filter(handle => handle.length > 0));

  if (wanted.size === 0) {
    return { ok: false, reason: '', source: '', ranks: [] };
  }

  const local = readRankRows(document, wanted);

  if (local.length > 0) {
    return { ok: true, reason: '', source: 'friends', ranks: local };
  }

  const doc = await fetchFirstStandingsPage();

  if (doc !== null) {
    const fallback = readRankRows(doc, wanted);

    if (fallback.length > 0) {
      return { ok: true, reason: '', source: 'page1', ranks: fallback };
    }
  }

  // 两种「没找到」要分开：页面本身要求登录，和「登录了但不在第一页」。后者仍然算读成功
  const problem = pageProblem();

  if (problem !== '') {
    return { ok: false, reason: problem, source: '', ranks: [] };
  }

  return { ok: true, reason: '', source: '', ranks: [] };
}

// ------------------------------------------------------------ 消息入口

/**
 * 监听器只注册一次。
 *
 * 这个脚本有两条注入路径：manifest 的 content_scripts（document_idle）与后台在读之前发现
 * 没人应答时补注入的那一份（background.ts 的 askContestAction）。读类动作现在等到 DOM 可读
 * 就问，可能比 document_idle 早一步 —— 那时补注入的那份会先注册，紧随其后的声明式注入
 * 再注册一次，同一条消息就会回两遍。
 *
 * 标记写在 window 上、写在注册之前：两次注入落在扩展的同一个隔离世界里，后一份看得见前一份。
 */
const contestActionsWindow = window as typeof window & { __cpContestActionsInstalled?: boolean };

if (contestActionsWindow.__cpContestActionsInstalled !== true) {
  contestActionsWindow.__cpContestActionsInstalled = true;

  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message?.action === MessageAction.ReadContestStates) {
      sendResponse(readStates());
      return undefined;
    }

    if (message?.action === MessageAction.SubmitRegistration || message?.action === MessageAction.StartVirtual) {
      const kind = message.action === MessageAction.StartVirtual ? 'virtual' : 'register';
      const startAt = message.payload?.startAt;
      const { result, form } = prepareEntry(kind, {
        unrated: message.payload?.unrated === true,
        startAt: typeof startAt === 'number' ? startAt : 0,
      });

      sendResponse(result);

      // 回话先走、提交后走：页面一跳转，消息通道就没了（与 submitCode.ts 的 SUBMIT_DELAY 同一个理由）
      if (result.ok && form !== null) {
        window.setTimeout(() => submitForm(form), SUBMIT_DELAY);
      }

      return undefined;
    }

    if (message?.action === MessageAction.ReadUnofficialRank) {
      const handles = Array.isArray(message.payload?.handles) ? message.payload.handles : [];

      readRanks(handles.filter((handle: unknown): handle is string => typeof handle === 'string'))
        .then(reply => sendResponse(reply))
        .catch(() => sendResponse({ ok: false, reason: 'page', source: '', ranks: [] }));

      return true;
    }

    return undefined;
  });
}

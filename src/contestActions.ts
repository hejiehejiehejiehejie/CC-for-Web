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
 *   `not-logged-in` / `challenge` / `page` / `not-eligible` / `already-registered`。
 * 其余原因（`rejected`、`timeout`、`no-tab`、`bad-contest`）由后台与网站侧产生。
 *
 * 【报名状态也是契约】`open` / `before` / `closed` / `registered` / `count` / `unknown`，
 * 网站按它决定那一列显示什么。`count` 是「只剩参赛人数那条链接」——比赛进行中与已结束都长这样，
 * 分不出能不能报名，所以单独留一个值，让网站显示成「—」而不是瞎猜一个。
 */
import { pageProblem } from './cfIdentity';
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';

/** 表单一交出去页面就整页跳转，这一小段延迟是给 sendResponse 留出把消息发出去的时间 */
const SUBMIT_DELAY = 50;

type RegistrationState = 'open' | 'before' | 'closed' | 'registered' | 'count' | 'unknown';

type PageReason = '' | 'not-logged-in' | 'challenge' | 'page' | 'not-eligible' | 'already-registered';

interface ActionReply {
  ok: boolean;
  reason: PageReason;
}

interface StatesReply {
  ok: boolean;
  reason: PageReason;
  states: Record<string, RegistrationState>;
}

interface RankEntry {
  handle: string;
  /** 榜单上的名次数字（含非正式选手的总榜名次） */
  rank: number;
  /** 这一行是不是非正式（VP / unrated）选手 —— 网站据此打一枚标记 */
  unofficial: boolean;
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
 * 唯一可靠的信息就是那几句话（2026-10-26 实测页面）。
 */
function registrationStateOf(row: Element): RegistrationState {
  const cell = row.lastElementChild;

  if (cell === null) {
    return 'unknown';
  }

  const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();

  // 「Registered」必须排在「Registration closed」前面判：两句里都有 registration
  if (/registered/i.test(text)) {
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
    return { ok: false, reason: problem, states: {} };
  }

  const states = readContestStates();

  // 一行都认不出来 = 这一页不是比赛列表（被重定向 / 改版），别让网站把整列都渲染成「—」
  if (Object.keys(states).length === 0) {
    return { ok: false, reason: 'page', states: {} };
  }

  return { ok: true, reason: '', states };
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
 * 改完一律派发 change —— 报名页会在 change 里联动团队选择区，不派发的话提上去的还是旧状态。
 */
function applyField(form: HTMLFormElement, name: string, value: string): void {
  const fields = Array.from(form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));

  for (const field of fields) {
    if (field.type === 'checkbox') {
      field.checked = value === 'true' || field.value === value;
    } else if (field.type === 'radio') {
      field.checked = field.value === value;
    } else {
      field.value = value;
    }

    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
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

function prepareEntry(kind: 'register' | 'virtual'): { result: ActionReply; form: HTMLFormElement | null } {
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

  if (kind === 'virtual') {
    // VP 页的隐藏字段：virtual 打开了才走虚拟参赛那条分支；teamId=-1 是「个人身份」
    applyField(form, 'virtual', 'true');
    applyField(form, 'requiredConfirmation', 'true');
    applyField(form, 'teamId', '-1');
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

/** 在一份榜单文档里找这些 handle，各取一次名次 */
function readRankRows(doc: Document, wanted: Set<string>): RankEntry[] {
  const found: RankEntry[] = [];

  for (const row of Array.from(doc.querySelectorAll('.standings tr'))) {
    const link = row.querySelector('a[href*="/profile/"]');

    if (link === null) {
      continue;
    }

    const handle = profileHandle(link);

    if (!wanted.has(handle.toLowerCase())) {
      continue;
    }

    const cells = Array.from(row.children).filter(cell => cell.tagName === 'TD');

    if (cells.length < 2) {
      continue;
    }

    const rankText = (cells[0].textContent ?? '').trim();
    const digits = /^(\d+)/.exec(rankText);

    if (digits === null) {
      continue;
    }

    found.push({ handle, rank: Number.parseInt(digits[1], 10), unofficial: isUnofficialRow(row, rankText) });
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
      const { result, form } = prepareEntry(kind);

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

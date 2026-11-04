/**
 * 一键提交脚本（2026-10-23 加）：声明式注入到 Codeforces 的**提交页**与**我的提交页**
 * （`/contest/{id}/submit`、`/gym/{id}/submit`、`/group/{gid}/contest/{cid}/submit`，以及
 * 各自的 `/my`；注入点见 scripts/build/extension.ts 的 SUBMIT_SITE_PATTERNS）。
 *
 * 【它解决的问题】题目管理网站（998244353.best）想让用户按一下就交题，可它自己做不到：
 * 提交页要 CSRF token，跨源也读不到登录 cookie。扩展本来就带着用户的登录态，于是这一趟
 * 由它跑：把网页递来的源码填进表单、点提交，再到 `/my` 页上盯这条提交的判定。
 *
 * 【信任边界】与代填验证码（src/fillCode.ts）一字不差：
 *   - 不读 `document.cookie`，不走任何 Codeforces 接口取凭据；
 *   - 只把网页递来的源码写进提交框，与用户自己粘贴一遍完全等价；
 *   - 回给后台的只有原因枚举与判定码，**不回传页面内容**。
 * 网页递过来的地址后台还会再解析一遍（不信任任意 URL，见 background.ts 的 parseSubmitTarget）。
 *
 * 【两条动作】方向都是后台 -> 内容脚本（MessageAction.SubmitCode / ReadSubmission）：
 *   - SubmitCode：填表 + 点提交。回执只说明「表单交出去了没有」，此后页面会整页跳到 `/my`；
 *   - ReadSubmission：在 `/my` 页上读一次某条提交的判定。后台隔几秒问一次，用来把
 *     verdict 的变化推给网页（`cp-submit-status`）。读的是**重新拉一遍的 HTML**：那一页
 *     自己不会刷新，而这份脚本跑在同源页面里，`fetch` 天然带着登录 cookie。
 *
 * 【只回原因枚举】reason 是**跨仓契约**（与网站侧 useCompanionBridge.js 的
 * `cp-submit-result` 一一对应）：`not-logged-in` / `challenge` / `problem-missing` /
 * `language-missing` / `page` / `empty`；提交按钮一直不解禁（比如题目被锁）时也回
 * `rejected`。其余原因（`no-tab`、`timeout`、`unsupported-url` 等）由后台与网站侧产生。
 *
 * `challenge` 是 2026-10-23 实机测试后补的：干净浏览器打开 CF 提交页时会先落到 Cloudflare 的
 * 人机校验页（标题「请稍候…」）。它既不是登录页也没有提交表单，按 `page` 报会误导成「站点改版」，
 * 用户看到保留下来的那一页才知道该去完成验证。
 */
import { hasLoginForm, isChallengePage } from './cfIdentity';
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';

/**
 * 提交按钮点下去之后页面会整页跳转，这一小段延迟是给 sendResponse 留出把消息发出去的时间
 * （与 fillCode.ts 的 SUBMIT_DELAY 同一个理由）。
 */
const SUBMIT_DELAY = 50;

/**
 * 等提交按钮真的解禁的上限与步长（见 waitForSubmitEnabled）。正常路径只有几十到
 * 几百毫秒；4 秒是给「/data/problemLock 慢一点」留的余量，必须小于后台的
 * SUBMIT_RESPONSE_TIMEOUT（8 秒），否则回执会先被后台判成超时。
 */
const SUBMIT_ENABLE_TIMEOUT = 4000;
const SUBMIT_ENABLE_POLL = 50;

type SubmitReason =
  'not-logged-in' | 'challenge' | 'problem-missing' | 'language-missing' | 'page' | 'empty' | 'rejected';

interface SubmitResult {
  ok: boolean;
  reason: SubmitReason | '';
}

interface SubmissionSnapshot {
  found: boolean;
  submissionId: string;
  /** 跨仓契约的判定码：testing / ac / wa / tle / mle / re / ce / other */
  verdict: string;
}

/** 判定栏里可能出现的字样（页面改版时这条兜底比按列号取更耐用） */
const VERDICT_HINT =
  /accepted|wrong answer|time limit|memory limit|runtime error|compilation error|in queue|running|pretests passed|skipped|rejected|hacked|idleness|denial of judgement|presentation error|failed system test|happy new year/i;

/**
 * Codeforces 的判定文案 → 跨仓判定码。
 *
 * 「Pretests passed」算 ac：比赛进行中过预测试就是这个提交的结论，系统测试要等赛后才跑；
 * 不把它当终态的话，通知会一直停在「已提交」直到超时。
 */
function mapVerdict(text: string): string {
  const value = text.trim().toLowerCase();

  if (value.length === 0 || value.includes('in queue') || value.includes('running') || value.includes('testing')) {
    return 'testing';
  }

  if (value.includes('accepted') || value.includes('pretests passed') || value.includes('happy new year')) {
    return 'ac';
  }

  if (value.includes('wrong answer')) {
    return 'wa';
  }

  if (value.includes('time limit exceeded')) {
    return 'tle';
  }

  if (value.includes('memory limit exceeded')) {
    return 'mle';
  }

  if (value.includes('compilation error')) {
    return 'ce';
  }

  if (value.includes('runtime error')) {
    return 're';
  }

  return 'other';
}

/** 从一行提交里取出「提交号 + 判定」。判定优先找 CF 自己的包裹类，找不到再按字样扫各列 */
function snapshotRow(row: Element): SubmissionSnapshot {
  const submissionId = row.getAttribute('data-submission-id') ?? '';
  const wrapper = row.querySelector('.submissionVerdictWrapper');
  let verdict = wrapper?.textContent ?? '';

  if (verdict.trim().length === 0) {
    for (const cell of Array.from(row.querySelectorAll('td'))) {
      const text = (cell.textContent ?? '').trim();

      if (VERDICT_HINT.test(text)) {
        verdict = text;
        break;
      }
    }
  }

  return { found: true, submissionId, verdict: mapVerdict(verdict) };
}

/**
 * 在文档里找目标那一行：给了提交号就按号找，没给就取第一行（刚提交完，最新的一条在最上面）。
 */
function findRow(doc: Document, submissionId: string): Element | null {
  const rows = Array.from(doc.querySelectorAll('tr[data-submission-id]'));

  if (submissionId.length === 0) {
    return rows[0] ?? null;
  }

  return rows.find(row => row.getAttribute('data-submission-id') === submissionId) ?? null;
}

/** 当前页面的 DOM（刚跳转到 /my 时它就带着我们的那一行） */
function readLive(submissionId: string): SubmissionSnapshot | null {
  const row = findRow(document, submissionId);

  return row === null ? null : snapshotRow(row);
}

/**
 * 重新拉一遍当前 `/my` 页并解析。那一页自己不会更新，而这脚本跑在同源里，
 * `fetch` 带着用户的登录 cookie —— 比隔两秒整页 reload 一次轻得多。
 */
async function readFresh(submissionId: string): Promise<SubmissionSnapshot | null> {
  const response = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const row = findRow(doc, submissionId);

  return row === null ? null : snapshotRow(row);
}

async function readSubmission(submissionId: string): Promise<SubmissionSnapshot> {
  // 还没拿到提交号时看当前 DOM（后台刚等完跳转，它就是新的）；之后每次都现拉一遍
  const snapshot = submissionId.length === 0 ? readLive('') : await readFresh(submissionId);

  if (snapshot !== null) {
    return snapshot;
  }

  return { found: false, submissionId, verdict: '' };
}

/** 提交页上那个表单：优先认它自己的 class，退一步按 action 兜底 */
function findForm(): HTMLFormElement | null {
  return (
    document.querySelector<HTMLFormElement>('form.submit-form') ??
    document.querySelector<HTMLFormElement>('form[action*="/submit"]')
  );
}

/**
 * 选中题目。CF 的题号下拉框 value 就是 `A` / `B1` 这种短串；个别页面会在文字前加题号，
 * 所以 value 对不上时再按文字前缀找一次。
 */
function selectProblem(form: HTMLFormElement, index: string): boolean {
  const select = form.querySelector<HTMLSelectElement>('select[name="submittedProblemIndex"]');

  if (select === null) {
    return false;
  }

  const wanted = index.toUpperCase();
  const options = Array.from(select.options);
  const exact = options.find(option => option.value.toUpperCase() === wanted);

  if (exact !== undefined) {
    select.value = exact.value;
    enableSubmit(select);
    return true;
  }

  const byText = options.find(option => (option.textContent ?? '').trim().toUpperCase().startsWith(wanted));

  if (byText === undefined) {
    return false;
  }

  select.value = byText.value;
  enableSubmit(select);
  return true;
}

/**
 * CF 的提交按钮在题目没选时是禁用的，只有题目下拉框的 change 处理器会把它解禁：
 * 2026-10-23 那一版的页面脚本叫 updateSubmitButtonState，解禁是同步的；
 * 2026-11-03 实报的提交页（contest/2272）已改名为 updateProblemLockInfo ——
 * 它先 `$.post("/data/problemLock", …)`，**在回调里**才 removeAttr("disabled")。
 *
 * 所以派发 change 之后不能立刻点：那一刻按钮还是灰的，`click()` 是空操作，
 * 用户看到的就是「停在提交页、既不跳转也不报错」（本次实报）。只改 `.value` 不派发事件
 * 也不行，按钮一直是灰的（2026-10-23 实报同款症状）。解禁与否交给 waitForSubmitEnabled 盯。
 */
function enableSubmit(select: HTMLSelectElement): void {
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSubmitButton(form: HTMLFormElement): HTMLInputElement | HTMLButtonElement | null {
  return form.querySelector<HTMLInputElement | HTMLButtonElement>('input[type="submit"], button[type="submit"]');
}

/** 等页面自己把提交按钮解禁（见 enableSubmit 的注释）。找不到按钮时视为可提交，走 form.submit() 兜底 */
async function waitForSubmitEnabled(form: HTMLFormElement, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  for (;;) {
    const button = findSubmitButton(form);

    if (button === null || !button.disabled) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise(resolve => window.setTimeout(resolve, SUBMIT_ENABLE_POLL));
  }
}

/**
 * 选中语言。
 *
 * 不写死 programTypeId：那串数字与比赛年代绑定（新编译器只在较新的比赛里出现），写死一个
 * 就会在另一批比赛里被拒。改成按编译器显示名挑：同一编译器的新版本排在列表后面，取最后一个。
 * C++ 优先 GNU G++；那台机器上没有时就退回任意 C++ 项（Clang / MS C++），总比不交强。
 */
function selectLanguage(form: HTMLFormElement, language: string): boolean {
  const select = form.querySelector<HTMLSelectElement>('select[name="programTypeId"]');

  if (select === null) {
    return false;
  }

  const options = Array.from(select.options);
  let matches: HTMLOptionElement[];

  if (language === 'python') {
    // 排除 PyPy：网页递来的就是 CPython 代码，判题机换一个实现不是用户的意图
    matches = options.filter(
      option => /python/i.test(option.textContent ?? '') && !/pypy/i.test(option.textContent ?? ''),
    );
  } else {
    matches = options.filter(option => /g\+\+|clang\+\+|c\+\+/i.test(option.textContent ?? ''));

    const gnu = matches.filter(option => /gnu g\+\+/i.test(option.textContent ?? ''));

    if (gnu.length > 0) {
      matches = gnu;
    }
  }

  const chosen = matches[matches.length - 1];

  if (chosen === undefined) {
    return false;
  }

  select.value = chosen.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * 把源码写进提交框。真页面（2026-10-23 登录态实测）的文本域叫 `textarea[name="source"]`
 * （`#sourceCodeTextarea`，display:none）；`sourceFile` 是旁边那个**上传文件的 input**。
 * 早先按 `textarea[name="sourceFile"]` 找，真页面上永远落空，用户看到的就是「提交页认不出来」。
 * 可见的 Ace 编辑器与这个隐藏框双向绑定：写值再派发 input，Ace 里的内容会一起变（实测一致）。
 */
function fillSource(form: HTMLFormElement, source: string): boolean {
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="source"], textarea#sourceCodeTextarea');

  if (textarea === null) {
    return false;
  }

  textarea.value = source;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  return true;
}

/** 点页面自己的提交按钮（挂着校验 / CSRF 处理）；实在找不到才退回 form.submit() */
function submitForm(form: HTMLFormElement): void {
  const button = findSubmitButton(form);

  if (button !== null) {
    button.click();
    return;
  }

  form.submit();
}

function fill(payload: { source?: unknown; language?: unknown; index?: unknown }): {
  result: SubmitResult;
  form: HTMLFormElement | null;
} {
  if (hasLoginForm()) {
    return { result: { ok: false, reason: 'not-logged-in' }, form: null };
  }

  const source = typeof payload.source === 'string' ? payload.source : '';

  if (source.trim().length === 0) {
    return { result: { ok: false, reason: 'empty' }, form: null };
  }

  const form = findForm();

  if (form === null) {
    return { result: { ok: false, reason: isChallengePage() ? 'challenge' : 'page' }, form: null };
  }

  const language = typeof payload.language === 'string' ? payload.language : '';
  const index = typeof payload.index === 'string' ? payload.index : '';

  if (!selectProblem(form, index)) {
    return { result: { ok: false, reason: 'problem-missing' }, form: null };
  }

  if (!selectLanguage(form, language)) {
    return { result: { ok: false, reason: 'language-missing' }, form: null };
  }

  if (!fillSource(form, source)) {
    return { result: { ok: false, reason: 'page' }, form: null };
  }

  return { result: { ok: true, reason: '' }, form };
}

browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.action === MessageAction.SubmitCode) {
    const { result, form } = fill(message.payload ?? {});

    if (!result.ok || form === null) {
      sendResponse(result);

      return undefined;
    }

    // 等按钮解禁再回话，然后才点。旧的流程是「立刻回话 + 50ms 后点」，在 2026-11 的
    // 提交页（异步解禁）上就会点在灰按钮上：页面停住，后台白等 20 秒再报拒收
    void (async () => {
      if (!(await waitForSubmitEnabled(form, SUBMIT_ENABLE_TIMEOUT))) {
        // 页面会在题号旁自己挂红字（如「problem was locked」）；这里只回枚举，照常收尾
        sendResponse({ ok: false, reason: 'rejected' });

        return;
      }

      sendResponse(result);

      // 回话先走，提交后走：页面一跳转，消息通道就没了（见 SUBMIT_DELAY）
      window.setTimeout(() => submitForm(form), SUBMIT_DELAY);
    })();

    return true;
  }

  if (message?.action === MessageAction.ReadSubmission) {
    const submissionId = typeof message.payload?.submissionId === 'string' ? message.payload.submissionId : '';

    readSubmission(submissionId)
      .then(snapshot => sendResponse(snapshot))
      .catch(() => sendResponse({ found: false, submissionId, verdict: '' }));

    return true;
  }

  return undefined;
});

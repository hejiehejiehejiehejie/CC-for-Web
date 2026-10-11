/**
 * 代填验证码脚本：声明式注入到 Codeforces 的 Social 设置页
 * （`https://codeforces.com/settings/social`，注入点见 scripts/build/extension.ts）。
 *
 * 【它解决的问题】题目管理网站（998244353.best）用云同步存偏好，而证明「这个 handle 是我的」
 * 靠的是「能改它的公开资料」：网站发一枚码，用户要去 Codeforces 把这枚码填进 Last name 再保存，
 * 才验证得过。那一步得在**带着用户登录态**的 Codeforces 页面上做，网站自己做不到（跨源）。
 * 这个扩展本来就注入在 Codeforces 上、本来就带着用户的登录态，所以由它替用户跑这一趟。
 *
 * 【与「读 cookie」那条路的区别】脚本只往 Dom 里写一个字符串、点一次保存：
 *   - 不读 `document.cookie`，也不通过任何 API 取 cookie；
 *   - 不回传页面内容、不回传用户资料，只回一个原因枚举（见下）；
 *   - 服务端的信任模型一字不变 —— 它仍然只认 `user.info` 里读回来的那枚 Last name。
 * 唯一写进去的是用户自己在网站上要求的这枚码，与手工填写产生的效果完全相同。
 *
 * 【回话口径】只回 `{ ok, reason }`，reason 是**跨仓契约**（与网站侧
 * useCompanionBridge.js 的 `cp-fill-code-result` 一一对应）：
 *   - `not-logged-in`  这个浏览器没登录 Codeforces
 *   - `handle-mismatch` 登录的是别人，不替别人的账号写资料
 *   - `page`          页面认不出来（改版 / 表单没找到）
 * 其余原因（`no-tab`、`timeout`、`unsupported`）分别由后台与网站侧产生，不在这里。
 *
 * 【为什么不把 Last name 改回去】那枚码必须**留在** Codeforces 上等网站去读，读到才验证得过；
 * 恢复原值等于把刚做的这一步抹掉（与手工流程一字不差）。
 *
 * 【判据不在这里】「当前登录的是谁」由 src/cfIdentity.ts 提供 —— autoParse 那边捎带回报登录态
 * 用的是同一份，两处分开写必然走偏。
 */
import { currentHandle, hasLoginForm } from './cfIdentity';
import { MessageAction } from './models/messaging';
import { browser } from './utils/browser';

/** 与网站侧写死的链接一致：Last name 那一栏只在这一页上 */
const SOCIAL_PATH = '/settings/social';

/**
 * 提交按钮点下去之后页面会整页跳转，这一小段延迟是给 sendResponse 留出把消息发出去的时间。
 * 不能先提交再回话 —— 页面一走，消息通道就断了，后台只会看到「没有响应」。
 */
const SUBMIT_DELAY = 50;

type FillReason = 'not-logged-in' | 'handle-mismatch' | 'page';

interface FillResult {
  ok: boolean;
  reason: FillReason | '';
}

/**
 * 找 Last name 输入框。
 *
 * 首选 `name="lastName"`；找不到就按表头文字兜底 —— 这一栏的字面量多年来没变过，
 * 而 input 的 name 属性是可能被改的（改了我们不该整条链失灵，只是变成手动填写）。
 */
function findLastNameInput(): HTMLInputElement | null {
  const byName = document.querySelector<HTMLInputElement>('input[name="lastName"]');

  if (byName !== null) {
    return byName;
  }

  const labels = document.querySelectorAll<HTMLElement>('th, td, label, span');

  for (const label of Array.from(labels)) {
    if ((label.textContent ?? '').trim().toLowerCase() !== 'last name') {
      continue;
    }

    const input = label.closest('tr')?.querySelector<HTMLInputElement>('input');

    if (input !== undefined && input !== null && input.type !== 'hidden') {
      return input;
    }
  }

  return null;
}

/**
 * 把码写进输入框。
 *
 * 表单是普通 POST，改 `.value` 就够；但两个事件还是照发 —— 页面上有脚本监听的话，
 * 不发会让它看到的值与真实值不一致（Codeforces 目前没有，但这类脚本便宜且无副作用）。
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 提交这一栏。
 *
 * 优先点页面自己的提交按钮（按钮上可能挂着校验或 CSRF 处理）；实在找不到才退回
 * `form.submit()` —— 后者会跳过 `submit` 事件，是次优选，但总比什么都不做强。
 */
function submitForm(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');

  if (button !== null) {
    button.click();
    return;
  }

  form.submit();
}

/** 填一次。返回回给后台的结果；成功时把「提交」这半步交给调用方在回话之后做 */
function fill(handle: string, code: string): { result: FillResult; form: HTMLFormElement | null } {
  if (window.location.pathname !== SOCIAL_PATH) {
    return { result: { ok: false, reason: 'page' }, form: null };
  }

  const input = findLastNameInput();

  if (input === null) {
    return { result: { ok: false, reason: hasLoginForm() ? 'not-logged-in' : 'page' }, form: null };
  }

  // 登录的是别人就什么都不写：这一个 handle 的资料不该被另一个账号改掉，哪怕码是那个人的
  const loggedIn = currentHandle();

  if (handle.length > 0 && loggedIn.length > 0 && loggedIn.toLowerCase() !== handle.toLowerCase()) {
    return { result: { ok: false, reason: 'handle-mismatch' }, form: null };
  }

  const form = input.form ?? input.closest('form');

  if (form === null) {
    return { result: { ok: false, reason: 'page' }, form: null };
  }

  setInputValue(input, code);

  return { result: { ok: true, reason: '' }, form };
}

browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.action !== MessageAction.FillCode) {
    return undefined;
  }

  const handle = typeof message.payload?.handle === 'string' ? message.payload.handle : '';
  const code = typeof message.payload?.code === 'string' ? message.payload.code : '';

  if (code.length === 0) {
    sendResponse({ ok: false, reason: 'page' } as FillResult);
    return undefined;
  }

  const { result, form } = fill(handle, code);

  sendResponse(result);

  // 回话先走，提交后走：页面一跳转，消息通道就没了（见 SUBMIT_DELAY）
  if (result.ok && form !== null) {
    window.setTimeout(() => submitForm(form), SUBMIT_DELAY);
  }

  return undefined;
});

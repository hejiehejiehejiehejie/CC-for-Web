/**
 * 「这个浏览器在 Codeforces 上登录的是谁」的判据。
 *
 * 【为什么单独立一个文件】有两处要用，而且必须共用同一份：
 *   - src/fillCode.ts：代填之前核对当前登录的 handle（不一致就什么都不写）；
 *   - src/autoParse.ts：用户访问任意 Codeforces 页面时捎带回报一次登录态。
 * 各留一份必然走偏 —— 一边认得出、另一边认不出，用户就会看到「提示说已登录、点下去却说没登录」
 * 这种自相矛盾的界面。判据这种东西只能有一个出处。
 *
 * 【它读的是什么】页头右上角那个指向 `/profile/<handle>` 的链接 —— Codeforces 只对**已登录**
 * 用户渲染它。这是页面上公开可见的内容：不读 cookie、不走任何接口、不发任何请求。
 * 判据与「用户自己抬头看一眼是谁登着」完全等价，权限级别也一样。
 *
 * 【它不能用来做什么】这个值只够驱动界面提示。扩展是用户可替换的组件，伪造一个扩展就能让它
 * 回答任意 handle，所以**绝不能**拿它当身份凭据 —— 服务端证明身份的路子始终是
 * 「能改这个 handle 的公开资料」（user.info + Last name），与这里无关。详见项目交接文档。
 */

/** 页面上显示的当前登录 handle（读不到就回空串，当作「无从核对」而不是「不匹配」） */
export function currentHandle(): string {
  // 页头右上角那一栏是登录态最可靠的位置；退一步再认页面上任意一个 /profile/ 链接
  const link =
    document.querySelector<HTMLAnchorElement>('.lang-chooser a[href^="/profile/"]') ??
    document.querySelector<HTMLAnchorElement>('a[href^="/profile/"]');

  if (link === null) {
    return '';
  }

  const href = link.getAttribute('href') ?? '';
  const name = href.split('/')[2] ?? '';

  return name.trim();
}

/** 没登录时 Codeforces 会把登录表单摆上来，用它把「没登录」与「页面改版了」区分开 */
export function hasLoginForm(): boolean {
  return (
    document.querySelector('input[name="handleOrEmail"]') !== null ||
    document.querySelector('form[action$="/enter"]') !== null
  );
}

/**
 * 只有正牌 `codeforces.com` 才认。
 *
 * 镜像站（`codeforces.ml`、`codeforc.es` 等）是另一套会话，那边登着的未必就是本站绑定的那个
 * 账号；拿镜像上的登录态去回答「你是不是 he-jie」会答错。宁可回 unknown。
 */
const CF_HOST = /^(www\.)?codeforces\.com$/;

export function isCodeforcesSite(): boolean {
  return CF_HOST.test(window.location.hostname);
}

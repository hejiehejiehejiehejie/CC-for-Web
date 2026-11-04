import * as path from 'node:path';
import * as ChromeLauncher from 'chrome-launcher';
import * as puppeteer from 'puppeteer';
import { projectRoot } from '../utils';
import { waitForBuild } from './utils';

await waitForBuild('chrome');

/**
 * Chrome 137 起 `--load-extension` 被移除（136+ 稳定版起静默忽略这个参数），
 * 继续写在 chromeFlags 里只会「浏览器开起来了、扩展没装上」，而且不报错 —— 症状是
 * dev 站点一直显示「未检测到扩展」。
 *
 * 现在唯一可靠的路子是 CDP 的 `Extensions.loadUnpacked`，且必须带
 * `--enable-unsafe-extension-debugging`。chrome-launcher 已经替我们开好
 * `--remote-debugging-port` 与临时 user-data-dir，所以这里连上去装完就断开：
 * 断开不会关掉浏览器，Chrome 仍由 chrome-launcher 保持运行（与本脚本改之前一致）。
 */
const chrome = await ChromeLauncher.launch({
  startingUrl: 'https://codeforces.com/problemset/problem/954/G',
  ignoreDefaultFlags: true,
  chromeFlags: [
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--enable-unsafe-extension-debugging',
  ],
});

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${chrome.port}`,
  defaultViewport: null,
});

try {
  const session = await browser.target().createCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(projectRoot, 'build-chrome') });
} finally {
  await browser.disconnect();
}

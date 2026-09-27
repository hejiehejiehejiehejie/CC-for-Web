import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type * as puppeteer from 'puppeteer';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const projectRoot = path.dirname(__dirname);

/**
 * 本机 Chrome 可执行文件路径。
 *
 * puppeteer 默认要下载它自带的 Chrome，在无外网 / 内网环境下会直接报
 * `Could not find Chrome`。这里固定走系统已装的 Chrome，可用 CHROME_PATH 覆盖。
 */
export function chromeExecutablePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`找不到 Chrome，请设置环境变量 CHROME_PATH 指向可执行文件。已尝试：\n${candidates.join('\n')}`);
}

/** 供各生成脚本共用的 puppeteer 启动参数（一律用系统 Chrome）。 */
export function chromeLaunchOptions(): puppeteer.LaunchOptions {
  return {
    executablePath: chromeExecutablePath(),
    headless: true,
    args: ['--no-sandbox'],
  };
}

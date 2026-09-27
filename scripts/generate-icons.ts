import * as fs from 'node:fs';
import * as path from 'node:path';
import * as puppeteer from 'puppeteer';
import { chromeLaunchOptions, projectRoot } from './utils';

/**
 * 生成扩展图标 PNG。
 *
 * 图形规则（与原版 Competitive Companion 一致，逆向自原图标）：
 * - 主体是一个实心圆，圆内用「透明镂空」挖出一个十字（不是画白色十字）；
 * - 所有尺寸都按 96px 网格绘制，且从不放大：s = min(size, 96) / 96；
 *   - size ≤ 96：圆直径 = 画布边长，铺满；
 *   - size > 96（如 128）：圆直径仍是 96，居中，四周留白。
 * - 十字长 = 圆半径，十字粗细 = 圆半径 / 4。
 *
 * 之所以不放大：图标在 128 上只是「同一个 96px 图形居中」，不是等比放大。
 */

/** 网格边长：所有几何量都以它为基准。 */
const GRID = 96;
/** 圆半径（在 96 网格里）。 */
const RADIUS = GRID / 2;
/** 十字臂长 = 半径；粗细 = 半径 / 4。 */
const BAR_LENGTH = RADIUS;
const BAR_THICKNESS = RADIUS / 4;

/** 图标配色：与 CPH IDE 的 logo 一致的蓝色。 */
const ICON_COLOR = '#0e639c';

const SIZES = [16, 19, 20, 24, 32, 38, 48, 64, 96, 128];

/**
 * 生成单个尺寸的图标 SVG。
 * 用 mask 挖空十字，这样镂空处是真正的透明（而非填色），换背景不会露馅。
 */
function iconSvg(size: number): string {
  const scale = Math.min(size, GRID) / GRID;
  const center = size / 2;
  const radius = RADIUS * scale;
  const barLength = BAR_LENGTH * scale;
  const barThickness = BAR_THICKNESS * scale;

  const horizontalX = center - barLength / 2;
  const horizontalY = center - barThickness / 2;
  const verticalX = center - barThickness / 2;
  const verticalY = center - barLength / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <mask id="plus">
    <rect width="${size}" height="${size}" fill="#fff" />
    <rect x="${horizontalX}" y="${horizontalY}" width="${barLength}" height="${barThickness}" fill="#000" />
    <rect x="${verticalX}" y="${verticalY}" width="${barThickness}" height="${barLength}" fill="#000" />
  </mask>
  <circle cx="${center}" cy="${center}" r="${radius}" fill="${ICON_COLOR}" mask="url(#plus)" />
</svg>
`;
}

const browser = await puppeteer.launch(chromeLaunchOptions());
const page = await browser.newPage();

for (const size of SIZES) {
  console.log(`Generating icon ${size}x${size}`);

  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  // 正文去掉默认边距与滚动条，让截图区域恰好等于图标本身
  await page.setContent(
    `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
      svg { display: block; }
    </style>
  </head>
  <body>${iconSvg(size)}</body>
</html>`,
    { waitUntil: 'load' },
  );

  // puppeteer 的 path 是模板字面量类型，需要断言
  const pngPath = path.resolve(projectRoot, `media/icons/icon-${size}.png`) as `${string}.png`;
  fs.rmSync(pngPath, { force: true });
  await page.screenshot({ path: pngPath, omitBackground: true });
}

await browser.close();

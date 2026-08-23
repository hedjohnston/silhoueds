#!/usr/bin/env node
// Render the app icons used for the home-screen / PWA install.
//
//   node tools/make-icons.mjs [--out <dir>] [--source <image>]
//
// With --source, the silhouette is taken from an image — including a screenshot of the game's
// own stage: the pale panel is detected, the frame stepped past, and the figure inside it cropped
// out. Without it, a figure drawn here is used.
//
// The figure is drawn for the purpose and is not a player in rotation, so the icon can never
// spoil a puzzle. Re-run after changing the palette in public/styles.css.

import { chromium } from 'playwright-core'; // dev-only: npx playwright-core
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Output defaults to public/ next to this script, but --out lets the script be run from a copy
// elsewhere (it needs Playwright, which the project deliberately does not depend on).
const sourceFlag = process.argv.indexOf('--source');
const source = sourceFlag >= 0 ? path.resolve(process.argv[sourceFlag + 1]) : null;
const outFlag = process.argv.indexOf('--out');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = outFlag >= 0
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(root, 'public');
const BLUE = '#d5e8ff';
const INK = '#05080b';

const FIGURE = `<svg viewBox="0 0 400 600" xmlns="http://www.w3.org/2000/svg">
  <g fill="${INK}" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M168 140 L120 190 L96 250" fill="none" stroke-width="30"/>
    <path d="M232 140 L286 180 L316 140" fill="none" stroke-width="30"/>
    <circle cx="92" cy="258" r="17"/><circle cx="320" cy="134" r="17"/>
    <path d="M186 254 L150 350 L162 452" fill="none" stroke-width="40"/>
    <path d="M214 250 L262 330 L300 396" fill="none" stroke-width="40"/>
    <path d="M162 446 q-8 22 -4 30 l-54 4 q-9 -14 5 -22 l30 -16 z"/>
    <path d="M300 392 q20 10 22 22 l-28 20 q-14 -8 -8 -22 z"/>
    <path d="M164 126 q36 -14 72 0 l12 78 q-8 36 -15 52 l-64 0 q-8 -16 -16 -52 z"/>
    <ellipse cx="168" cy="134" rx="23" ry="19"/><ellipse cx="232" cy="134" rx="23" ry="19"/>
    <rect x="186" y="96" width="28" height="32" rx="12"/>
    <ellipse cx="200" cy="72" rx="31" ry="34"/>
  </g>
</svg>`;

// `inset` is the share of the canvas left as margin. Android masks icons to a circle or squircle,
// so a maskable icon needs its content well inside the edges.
const ICONS = [
  { file: 'icon-180.png', size: 180, inset: 0.14 },  // apple-touch-icon
  { file: 'icon-192.png', size: 192, inset: 0.14 },
  { file: 'icon-512.png', size: 512, inset: 0.14 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.26 },
  { file: 'favicon-64.png', size: 64, inset: 0.10 },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/**
 * Find the silhouette in a source image.
 *
 * Handles a screenshot of the game's own stage: locate the pale panel, step inside its black
 * frame (or the frame itself reads as the figure), then take the bounding box of the dark pixels
 * within. Falls back to scanning the whole image when there is no panel.
 */
async function findFigure(file) {
  const page = await browser.newPage();
  const dataUri = `data:image/${path.extname(file).slice(1)};base64,${fs.readFileSync(file).toString('base64')}`;

  const box = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    };
    const isPanel = ([r, g, b]) => b > 200 && b - r > 20 && r > 180 && g > 190;
    const isDark = ([r, g, b]) => r < 90 && g < 90 && b < 90;

    let px0 = Infinity, py0 = Infinity, px1 = -1, py1 = -1;
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        if (isPanel(at(x, y))) {
          if (x < px0) px0 = x; if (x > px1) px1 = x;
          if (y < py0) py0 = y; if (y > py1) py1 = y;
        }
      }
    }
    if (px1 < 0) { px0 = 0; py0 = 0; px1 = canvas.width - 1; py1 = canvas.height - 1; }

    const pad = Math.round(Math.min(px1 - px0, py1 - py0) * 0.035);
    let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1;
    for (let y = py0 + pad; y <= py1 - pad; y++) {
      for (let x = px0 + pad; x <= px1 - pad; x++) {
        if (isDark(at(x, y))) {
          if (x < fx0) fx0 = x; if (x > fx1) fx1 = x;
          if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
        }
      }
    }
    if (fx1 < 0) return null;
    return { x: fx0, y: fy0, w: fx1 - fx0 + 1, h: fy1 - fy0 + 1, imageW: img.width, imageH: img.height, src };
  }, dataUri);

  await page.close();
  if (!box) throw new Error(`no silhouette found in ${file}`);
  console.log(`  found figure ${box.w}x${box.h} at ${box.x},${box.y} in ${path.basename(file)}`);
  return box;
}

const figure = source ? await findFigure(source) : null;

/**
 * The cropped figure, anchored to the bottom of the icon.
 *
 * A torso-crop silhouette has a hard horizontal cut where the photo ended; running it off the
 * bottom edge reads as framing rather than as a figure sliced in half.
 */
function figureMarkup(size, inset) {
  const boxH = Math.round(size * (1 - inset * 1.15));
  const scale = boxH / figure.h;
  const boxW = Math.round(figure.w * scale);
  return `<div style="position:absolute;left:50%;bottom:0;transform:translateX(-50%);
      width:${boxW}px;height:${boxH}px;overflow:hidden">
    <img src="${figure.src}" style="position:absolute;
      width:${Math.round(figure.imageW * scale)}px;
      height:${Math.round(figure.imageH * scale)}px;
      left:${-Math.round(figure.x * scale)}px;
      top:${-Math.round(figure.y * scale)}px;
      max-width:none">
  </div>`;
}

for (const { file, size, inset } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const body = figure
    ? figureMarkup(size, inset)
    : FIGURE.replace('<svg', `<svg style="height:${Math.round(size * (1 - inset * 2))}px"`);
  await page.setContent(`<style>
    *{margin:0;box-sizing:border-box}
    body{width:${size}px;height:${size}px;background:${BLUE};display:grid;place-items:center;
         position:relative;overflow:hidden}
  </style>${body}`);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(outDir, file) });
  await page.close();
  console.log(`  ${file}  ${size}x${size}`);
}

await browser.close();
console.log(`icons written to ${outDir}`);

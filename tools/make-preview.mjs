#!/usr/bin/env node
// Render the link-preview images used when the site is shared.
//
//   node tools/make-preview.mjs [--source <image>] [--fonts <css>] [--out <dir>]
//
// Two are produced, because platforms crop differently:
//
//   preview.png         1200x630  — Twitter/X large card, Facebook, LinkedIn
//   preview-square.png  1200x1200 — og:image, which is what WhatsApp, iMessage and Slack use,
//                                   and they crop to a square, so a landscape card loses itself
//
// --fonts inlines a stylesheet instead of linking Google Fonts, for building offline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core'; // dev-only: npx playwright-core

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = arg('--out') ? path.resolve(arg('--out')) : path.join(root, 'public');
const source = arg('--source') ?? path.join(root, 'assets/icon-source.jpg');
const fontsFile = arg('--fonts');

const BLUE = '#d5e8ff';
const INK = '#000';
const GROUND = '#fcfcfc';

const fontCss = fontsFile
  ? fs.readFileSync(path.resolve(fontsFile), 'utf8')
  : '@import url("https://fonts.googleapis.com/css2?family=Sansita:wght@700;800&family=Mulish:wght@400;600;700;800&display=swap");';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/** Locate the silhouette inside the artwork, which may be a screenshot of the game's own stage. */
async function findFigure(file) {
  const page = await browser.newPage();
  const uri = `data:image/${path.extname(file).slice(1)};base64,${fs.readFileSync(file).toString('base64')}`;
  const box = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const isPanel = ([r, g, b]) => b > 200 && b - r > 20 && r > 180 && g > 190;
    const isDark = ([r, g, b]) => r < 90 && g < 90 && b < 90;

    let a0 = Infinity, b0 = Infinity, a1 = -1, b1 = -1;
    for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
      if (isPanel(at(x, y))) { if (x < a0) a0 = x; if (x > a1) a1 = x; if (y < b0) b0 = y; if (y > b1) b1 = y; }
    }
    if (a1 < 0) { a0 = 0; b0 = 0; a1 = canvas.width - 1; b1 = canvas.height - 1; }

    const pad = Math.round(Math.min(a1 - a0, b1 - b0) * 0.035);
    let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1;
    for (let y = b0 + pad; y <= b1 - pad; y++) for (let x = a0 + pad; x <= a1 - pad; x++) {
      if (isDark(at(x, y))) { if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; }
    }
    if (fx1 < 0) return null;
    return { x: fx0, y: fy0, w: fx1 - fx0 + 1, h: fy1 - fy0 + 1, imageW: img.width, imageH: img.height, src };
  }, uri);
  await page.close();
  if (!box) throw new Error(`no silhouette found in ${file}`);
  return box;
}

const figure = await findFigure(source);
console.log(`  figure ${figure.w}x${figure.h} from ${path.basename(source)}`);

/** The silhouette cropped out of the artwork, at a given rendered height. */
function figureAt(height, extraStyle = '') {
  const scale = height / figure.h;
  return `<div style="position:relative;overflow:hidden;flex:0 0 auto;
      width:${Math.round(figure.w * scale)}px;height:${Math.round(height)}px;${extraStyle}">
    <img src="${figure.src}" style="position:absolute;max-width:none;
      width:${Math.round(figure.imageW * scale)}px;height:${Math.round(figure.imageH * scale)}px;
      left:${-Math.round(figure.x * scale)}px;top:${-Math.round(figure.y * scale)}px">
  </div>`;
}

const base = `<style>${fontCss}
  *{margin:0;box-sizing:border-box}
  .pill{border:5px solid ${INK};border-radius:999px;padding:9px 22px;font-weight:800;
        box-shadow:5px 5px 0 0 ${INK};white-space:nowrap;font-family:Mulish,sans-serif}
  h1{font-family:Sansita,Georgia,serif;letter-spacing:-.02em;line-height:1}
  p{font-family:Mulish,sans-serif;color:#596170}
</style>`;

// Square, for og:image. The silhouette dominates so it still reads as a thumbnail.
const square = `${base}<body style="width:1200px;height:1200px;background:${GROUND};
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;padding:60px">
  <div style="background:${BLUE};border:10px solid ${INK};border-radius:44px;
       box-shadow:16px 16px 0 0 ${INK};padding:26px 60px;display:flex;align-items:flex-end">
    ${figureAt(600)}
  </div>
  <div style="text-align:center">
    <h1 style="font-size:118px">Silhoueds</h1>
    <p style="font-size:40px;margin-top:12px">Name the footballer from their shadow.</p>
  </div>
</body>`;

// Landscape, for Twitter/X and anything wanting 1.91:1.
const wide = `${base}<body style="width:1200px;height:630px;background:${GROUND};
    display:flex;align-items:center;gap:56px;padding:0 72px">
  <div style="background:${BLUE};border:6px solid ${INK};border-radius:28px;
       box-shadow:10px 10px 0 0 ${INK};padding:18px 40px;display:flex;align-items:flex-end;flex:0 0 auto">
    ${figureAt(400)}
  </div>
  <div style="flex:1;min-width:0">
    <h1 style="font-size:100px">Silhoueds</h1>
    <p style="font-size:34px;margin-top:14px">Name the footballer from their shadow.</p>
    <div style="display:flex;gap:14px;margin-top:34px;white-space:nowrap;font-size:22px">
      <span class="pill" style="background:#fff2b1">A hint every miss</span>
      <span class="pill" style="background:#f5d1fd">6 guesses</span>
      <span class="pill" style="background:#befac4">New one daily</span>
    </div>
  </div>
</body>`;

for (const [file, html, size] of [
  ['preview-square.png', square, { width: 1200, height: 1200 }],
  ['preview.png', wide, { width: 1200, height: 630 }],
]) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, file) });
  await page.close();
  const bytes = fs.statSync(path.join(outDir, file)).size;
  console.log(`  ${file}  ${size.width}x${size.height}  ${Math.round(bytes / 1024)}KB`);
}

await browser.close();
console.log(`previews written to ${outDir}`);

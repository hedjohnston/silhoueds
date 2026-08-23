#!/usr/bin/env node
// Render the app icons used for the home-screen / PWA install.
//
//   node tools/make-icons.mjs [--out <dir>]
//
// The figure is drawn for the purpose and is not a player in rotation, so the icon can never
// spoil a puzzle. Re-run after changing the palette in public/styles.css.

import { chromium } from 'playwright-core'; // dev-only: npx playwright-core
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Output defaults to public/ next to this script, but --out lets the script be run from a copy
// elsewhere (it needs Playwright, which the project deliberately does not depend on).
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

for (const { file, size, inset } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>
    *{margin:0;box-sizing:border-box}
    body{width:${size}px;height:${size}px;background:${BLUE};display:grid;place-items:center}
    svg{height:${Math.round(size * (1 - inset * 2))}px}
  </style>${FIGURE}`);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(outDir, file) });
  await page.close();
  console.log(`  ${file}  ${size}x${size}`);
}

await browser.close();
console.log(`icons written to ${outDir}`);

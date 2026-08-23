#!/usr/bin/env node
// Turn a source photo into a tracing page: the image scaled into the silhouette's 400x600
// viewBox, under a labelled coordinate grid, with a live cursor readout. Trace against it,
// then save the resulting path as public/silhouettes/<slug>.svg.
//
//   node tools/trace-helper.mjs assets/source/player.jpg
//   node tools/trace-helper.mjs assets/source/player.jpg --out /tmp/trace.html
//
// No dependencies: the contrast boost is a CSS filter and the image is inlined as a data URI,
// so the output is a single self-contained file you can open in any browser.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
if (!source) {
  console.error('usage: node tools/trace-helper.mjs <image> [--out trace.html]');
  process.exit(1);
}

const ext = path.extname(source).toLowerCase();
const mime = MIME[ext];
if (!mime) {
  console.error(`unsupported image type "${ext}" — use ${Object.keys(MIME).join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`no such file: ${source}`);
  process.exit(1);
}

const out = outFlag >= 0 ? args[outFlag + 1] : `${source.replace(/\.[^.]+$/, '')}.trace.html`;
const dataUri = `data:${mime};base64,${fs.readFileSync(source).toString('base64')}`;

const gridLines = () => {
  const lines = [];
  for (let x = 0; x <= 400; x += 20) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="600" class="${x % 100 ? 'minor' : 'major'}"/>`);
  }
  for (let y = 0; y <= 600; y += 20) {
    lines.push(`<line x1="0" y1="${y}" x2="400" y2="${y}" class="${y % 100 ? 'minor' : 'major'}"/>`);
  }
  for (let x = 100; x < 400; x += 100) lines.push(`<text x="${x + 3}" y="14">${x}</text>`);
  for (let y = 100; y <= 500; y += 100) lines.push(`<text x="3" y="${y - 4}">${y}</text>`);
  return lines.join('\n      ');
};

fs.writeFileSync(out, `<!doctype html>
<meta charset="utf-8">
<title>Trace — ${path.basename(source)}</title>
<style>
  body { margin: 0; background: #222; color: #eee; font: 14px system-ui, sans-serif;
         display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; }
  .frame { position: relative; width: 400px; height: 600px; background: #000; }
  .frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .frame.contrast img { filter: grayscale(1) contrast(2.6) brightness(0.85); }
  .frame.hide img { opacity: 0.15; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .minor { stroke: #0ff; stroke-opacity: 0.18; stroke-width: 0.5; }
  .major { stroke: #0ff; stroke-opacity: 0.5; stroke-width: 1; }
  text { fill: #0ff; font-size: 11px; }
  code { background: #111; padding: 4px 8px; border-radius: 4px; }
</style>
<div class="frame contrast" id="frame">
  <img src="${dataUri}" alt="source photo">
  <svg viewBox="0 0 400 600" id="grid">
      ${gridLines()}
  </svg>
</div>
<p>cursor: <code id="readout">—</code></p>
<p><button id="toggle-contrast">contrast</button> <button id="toggle-image">dim image</button></p>
<script>
  const frame = document.getElementById('frame');
  const readout = document.getElementById('readout');
  document.getElementById('grid').addEventListener('mousemove', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 400);
    const y = Math.round(((e.clientY - r.top) / r.height) * 600);
    readout.textContent = x + ' ' + y;
  });
  document.getElementById('toggle-contrast').onclick = () => frame.classList.toggle('contrast');
  document.getElementById('toggle-image').onclick = () => frame.classList.toggle('hide');
</script>
`);

console.log(`wrote ${out} — open it, trace the outline, save to public/silhouettes/`);

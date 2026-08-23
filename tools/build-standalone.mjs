#!/usr/bin/env node
// Bundle the game into one self-contained HTML file that runs from file:// — no server, no
// network. Useful for sharing a playable copy or just double-clicking to play.
//
//   node tools/build-standalone.mjs [--out dist/silhoueds.html]
//
// The data files and silhouettes are embedded and served to the unchanged game code by a small
// fetch shim, so there is only one copy of the game logic to maintain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const outFlag = process.argv.indexOf('--out');
const out = outFlag >= 0 ? process.argv[outFlag + 1] : 'dist/silhoueds.html';

// Everything the game fetches at runtime.
const assets = [
  'data/players.json',
  'data/roster.json',
  ...fs.readdirSync(path.join(root, 'public/silhouettes'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => `public/silhouettes/${f}`),
];
const embedded = Object.fromEntries(assets.map((rel) => [rel, read(rel)]));

// Module order matters: dependencies first. Import/export lines go, since it all shares one scope.
const modules = ['src/puzzle.js', 'src/autocomplete.js', 'src/game.js']
  .map((rel) =>
    read(rel)
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export (const|function|async function|class)/gm, '$1'),
  )
  .join('\n');

const html = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${read('styles.css')}\n</style>`)
  .replace(
    '<script type="module" src="src/game.js"></script>',
    `<script type="module">
const EMBEDDED = ${JSON.stringify(embedded)};
const realFetch = window.fetch.bind(window);
window.fetch = (resource, options) => {
  const key = String(resource).replace(/^\\.\\//, '');
  if (key in EMBEDDED) {
    return Promise.resolve(new Response(EMBEDDED[key], {
      status: 200,
      headers: { 'Content-Type': key.endsWith('.json') ? 'application/json' : 'image/svg+xml' },
    }));
  }
  return realFetch(resource, options);
};
${modules}
</script>`,
  );

fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
fs.writeFileSync(path.resolve(root, out), html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB) — open it directly in a browser`);

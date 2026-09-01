#!/usr/bin/env node
// Turn a cut-out photo into the black silhouette the game shows in hard mode.
//
//   node tools/make-silhouette.mjs <cut-out.png> [--out <file>] [--cut <0-255>]
//
// The admin does this by itself for anything uploaded through it — this is for working on a batch
// of images on your own machine before any of them go near the site, and for seeing what the
// server will produce from a given cut-out. Same code either way (server/silhouette.mjs), so what
// you see here is what the upload will store.
//
// --cut moves the edge: alpha at or above it becomes solid black. Lower keeps more of a soft or
// badly-cut edge, higher trims it away.

import fs from 'node:fs';
import path from 'node:path';
import { silhouetteFrom } from '../server/silhouette.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const source = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));

if (!source) {
  console.error('usage: node tools/make-silhouette.mjs <cut-out.png> [--out <file>] [--cut <0-255>]');
  process.exit(1);
}

const out = flag('--out') ?? path.join(
  path.dirname(source),
  `${path.basename(source, path.extname(source))}-silhouette.png`,
);
const cut = flag('--cut') === null ? undefined : Number(flag('--cut'));

const png = silhouetteFrom(fs.readFileSync(source), { cut });
if (!png) {
  console.error(
    `${source} gives no silhouette. It has to be an 8-bit PNG with the background already ` +
    'removed — the transparency is where the shape comes from.',
  );
  process.exit(1);
}

fs.writeFileSync(out, png);
console.log(out);

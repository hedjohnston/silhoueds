#!/usr/bin/env node
// Cut the player out of a photograph, ready to upload as their full photo.
//
//   node tools/make-cutout.mjs <photo…> [--out <dir>] [--all] [--whole]
//
// The site makes the silhouette out of the photo's alpha (server/silhouette.mjs), so a photo has
// to arrive already cut out. This is what does the cutting: the Mac's own Vision framework, the
// same thing behind "Remove Background" in Preview, driven by tools/cutout.swift.
//
// It runs here rather than on the server because that is where it can run — the container is
// Linux, and doing this server-side would mean carrying a segmentation model and its runtime in
// the image, which this project has turned down before for the easy-mode blur. So: cut out on
// your machine, upload the result, and the site takes it from there.
//
//   --all    keep every subject, not just the largest — for a photo where the player who matters
//            isn't the one filling the frame
//   --whole  keep the original framing instead of cropping to the player
//
// Swift is compiled on first use and cached in tools/.build, so only the first run is slow.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--') && a !== '--out');
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? args[outFlag + 1] : null;
const photos = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--out');

if (photos.length === 0) {
  console.error('usage: node tools/make-cutout.mjs <photo…> [--out <dir>] [--all] [--whole]');
  process.exit(1);
}
if (os.platform() !== 'darwin') {
  console.error(
    'This one only runs on a Mac: the cutting out is done by macOS\'s Vision framework. Cut the ' +
    'photos out however you like elsewhere — the site only cares that the background is gone.',
  );
  process.exit(1);
}

const source = path.join(here, 'cutout.swift');
const binary = path.join(here, '.build', 'cutout');

/** Compile the Swift once, and again whenever it has been edited since. */
function build() {
  const built = fs.statSync(binary, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (built > fs.statSync(source).mtimeMs) return;

  fs.mkdirSync(path.dirname(binary), { recursive: true });
  console.error('Compiling tools/cutout.swift (once — about a minute)…');
  try {
    execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error(
      '\nCompiling failed. This needs the Xcode command line tools: xcode-select --install',
    );
    process.exit(1);
  }
}

build();

let failed = 0;
for (const photo of photos) {
  const name = `${path.basename(photo, path.extname(photo))}-cutout.png`;
  const out = path.join(outDir ?? path.dirname(photo), name);
  try {
    execFileSync(binary, [photo, out, ...flags], { stdio: 'inherit' });
  } catch {
    failed++; // the Swift has already said what was wrong with this one; keep going through the rest
  }
}
process.exit(failed > 0 ? 1 : 0);

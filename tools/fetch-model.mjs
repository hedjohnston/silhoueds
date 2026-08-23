#!/usr/bin/env node
// Download the segmentation model used to cut players out of their photos.
//
//   npm run fetch-model
//
// U^2-Net (u2netp, the small variant), Apache-2.0 — https://github.com/xuebinqin/U-2-Net
// The ONNX export is the one distributed with rembg (MIT). 4.4 MB, verified by checksum.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEST = process.env.SILHOUEDS_MODEL_PATH ?? 'models/u2netp.onnx';
const SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const SOURCES = [
  'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx',
];

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

if (fs.existsSync(DEST) && digest(fs.readFileSync(DEST)) === SHA256) {
  console.log(`${DEST} is already present and verified.`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });

for (const url of SOURCES) {
  try {
    process.stdout.write(`Downloading ${url} … `);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const actual = digest(buffer);
    if (actual !== SHA256) throw new Error(`checksum mismatch (got ${actual})`);

    fs.writeFileSync(DEST, buffer);
    console.log(`ok\nSaved ${DEST} (${(buffer.length / 1e6).toFixed(1)} MB).`);
    process.exit(0);
  } catch (error) {
    console.log(`failed: ${error.message}`);
  }
}

console.error('\nCould not fetch the model from any source.');
console.error('Silhouettes can still be traced by hand in the admin.');
process.exit(1);

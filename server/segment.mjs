// Photo -> silhouette.
//
// Runs U^2-Net locally (onnxruntime-node) to separate the player from the background, cleans
// the resulting mask, and hands it to the vectoriser. Nothing leaves the machine.
//
// onnxruntime-node and sharp are optional dependencies: if either is missing, the admin falls
// back to tracing by hand and says so.

import fs from 'node:fs';
import { maskToSvg } from './vectorise.mjs';

const MODEL_PATH = process.env.SILHOUEDS_MODEL_PATH ?? 'models/u2netp.onnx';
const INPUT_SIZE = 320;         // what u2netp expects
const WORK_HEIGHT = 500;        // mask resolution we trace at
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let modules;
let session;

/** Load the optional native modules once, reporting cleanly if they aren't installed. */
async function load() {
  if (modules !== undefined) return modules;
  try {
    const [ort, sharp] = await Promise.all([import('onnxruntime-node'), import('sharp')]);
    modules = { ort: ort.default ?? ort, sharp: sharp.default ?? sharp };
  } catch {
    modules = null;
  }
  return modules;
}

export async function segmentationStatus() {
  const loaded = await load();
  return {
    available: Boolean(loaded) && fs.existsSync(MODEL_PATH),
    modulesInstalled: Boolean(loaded),
    modelPresent: fs.existsSync(MODEL_PATH),
    modelPath: MODEL_PATH,
  };
}

async function getSession(ort) {
  session ??= await ort.InferenceSession.create(MODEL_PATH);
  return session;
}

/**
 * Turn a photo into finished silhouette SVG markup.
 * `options.threshold` (0-1) shifts how much of the subject is kept; `options.smooth` softens
 * the outline before tracing.
 */
export async function photoToSilhouette(photoPath, { threshold = 0.5, smooth = 2 } = {}) {
  const loaded = await load();
  if (!loaded) throw new Error('Automatic silhouettes need onnxruntime-node and sharp installed.');
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(`Segmentation model missing at ${MODEL_PATH}. Run: npm run fetch-model`);
  }
  const { ort, sharp } = loaded;

  // 1. Run the network at its native input size.
  const { data } = await sharp(photoPath)
    .removeAlpha()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = INPUT_SIZE * INPUT_SIZE;
  let peak = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > peak) peak = data[i];
  peak = (peak || 255) / 255;

  const input = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * pixels + i] = (data[i * 3 + c] / 255 / peak - MEAN[c]) / STD[c];
    }
  }

  const net = await getSession(ort);
  const output = await net.run({
    [net.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });
  const prediction = output[net.outputNames[0]].data;

  // 2. Normalise the saliency map to 0-255.
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of prediction) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo || 1;
  const gray = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) gray[i] = Math.round(((prediction[i] - lo) / span) * 255);

  // 3. Scale the mask back to the photo's aspect ratio and blur away the jaggies.
  const meta = await sharp(photoPath).metadata();
  const workWidth = Math.max(2, Math.round((meta.width / meta.height) * WORK_HEIGHT));
  let mask = sharp(gray, { raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 } })
    .resize(workWidth, WORK_HEIGHT, { fit: 'fill' });
  if (smooth > 0) mask = mask.blur(smooth);

  // sharp promotes a 1-channel raw input to 3 channels on resize, so ask for greyscale back
  // and stride by whatever it actually returns rather than assuming one byte per pixel.
  const { data: cleaned, info } = await mask
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels;

  // 4. Threshold to a binary mask and vectorise.
  const cut = Math.round(Math.min(0.95, Math.max(0.05, threshold)) * 255);
  const binary = new Uint8Array(workWidth * WORK_HEIGHT);
  let foreground = 0;
  for (let i = 0; i < binary.length; i++) {
    if (cleaned[i * stride] >= cut) { binary[i] = 1; foreground++; }
  }

  const coverage = foreground / binary.length;
  if (coverage < 0.005) {
    throw new Error('Could not find a player in that photo — try one with a clearer subject.');
  }

  const svg = maskToSvg(binary, workWidth, WORK_HEIGHT);
  if (!svg) throw new Error('Could not trace an outline from that photo.');

  return { svg, coverage };
}

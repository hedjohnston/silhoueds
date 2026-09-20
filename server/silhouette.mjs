// Making the puzzle image out of the photo.
//
// The photos this game uses are cut-outs: the player against nothing, their own alpha channel
// already tracing the shape. That is the same shape the silhouette needs, so a silhouette is
// just the cut-out painted black — no tracing, no second upload, no image library.
//
// Deliberately dependency-free, like the rest of the server: PNG in, PNG out, using node:zlib.
// Anything it can't read (a JPEG, which has no alpha to work from; 16-bit; interlaced) returns
// null rather than throwing, so the caller can fall back to asking for a silhouette by hand.

import zlib from 'node:zlib';

/** Beyond this an upload would decode to hundreds of MB of RGBA on a 1 GB machine. */
const MAX_PIXELS = 8_000_000;

/**
 * Alpha at or above this becomes solid black, below it becomes nothing.
 *
 * Keeping the original alpha instead would carry the cut-out's soft edge through, which sounds
 * kinder but isn't: a background removed imperfectly leaves a grey halo, and at the size the
 * stage draws it that halo reads as a smudge rather than as a hand.
 */
const CUT = 140;

const crc32 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

/**
 * Decode an 8-bit non-interlaced PNG to flat RGBA.
 *
 * Returns null for anything outside that — those are rare enough among cut-outs saved by an
 * image editor that handling them isn't worth a dependency, and the caller has a fallback.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette = null, transparency = null;
  const parts = [];
  for (let i = 8; i + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(i);
    if (i + 12 + length > buffer.length) return null;
    const type = buffer.toString('ascii', i + 4, i + 8);
    const body = buffer.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') parts.push(body);
    i += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (depth !== 8 || interlace || !channels || !width || !height) return null;
  if (width * height > MAX_PIXELS || parts.length === 0) return null;
  if (colour === 3 && !palette) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-row filters (PNG spec 9.2). Each row is predicted from the one above and the
  // pixel to the left, so this has to run in order and can't be done a row at a time in parallel.
  const samples = Buffer.alloc(stride * height);
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return null;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prior[x];
      const c = x >= channels ? prior[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
    row.copy(samples, y * stride);
    prior = row;
  }

  // Flatten every colour type to RGBA, so nothing downstream has to know which one came in.
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    let r, g, b, a = 255;
    if (colour === 0) r = g = b = samples[s];
    else if (colour === 4) { r = g = b = samples[s]; a = samples[s + 1]; }
    else if (colour === 2) [r, g, b] = samples.subarray(s, s + 3);
    else if (colour === 6) [r, g, b, a] = samples.subarray(s, s + 4);
    else {
      const index = samples[s];
      [r, g, b] = palette.subarray(index * 3, index * 3 + 3);
      if (transparency && index < transparency.length) a = transparency[index];
    }
    rgba.set([r, g, b, a], p * 4);
  }
  return { width, height, rgba };
}

/** Encode flat RGBA as an 8-bit PNG. */
export function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter 0: the image is two colours, so deflate packs it anyway
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Used only when the neck can't be found below: how much of the figure's own height, from the
 * top, counts as "the head". An adult's head runs to roughly an eighth of standing height — this
 * is a bit more, to clear the chin — rather than the much bigger slice a plain "how tall is the
 * whole bounding box" guess needs, which a raised arm or a running stride inflates with height
 * that has nothing to do with the head, dragging the fallback down past the shoulders and into
 * the shirt itself.
 */
const FALLBACK_HEAD_FRACTION = 0.16;

/** Whatever the neck detection below finds, never trust it past this much of the figure. */
const MAX_HEAD_FRACTION = 0.3;

/** Only look for a neck this far into the figure — a waist or an armpit narrows too, further down. */
const NECK_SEARCH_FRACTION = 0.4;

/** A candidate neck has to be narrower than the head's own widest point by at least this much. */
const NECK_TAPER = 0.85;

/**
 * The widest unbroken run of solid pixels on one row.
 *
 * A run rather than the full left-to-right span: a raised or trailing arm sits off to one side as
 * a separate, disconnected blob on the same row, and the span would count the gap between it and
 * the body as if it were the body's own width. A run only ever measures one blob at a time.
 */
function rowSpan(rgba, width, y, cut) {
  let best = 0, run = 0;
  const base = y * width;
  for (let x = 0; x < width; x++) {
    if (rgba[(base + x) * 4 + 3] >= cut) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Where the head ends, found rather than guessed: a head widens from the crown to the ears, then
 * narrows again at the neck before the shoulders widen out for good. That dip is a real
 * anatomical landmark that holds regardless of how tall the figure's own bounding box happens to
 * be, which is exactly what a fixed fraction of it does not — see FALLBACK_HEAD_FRACTION above.
 *
 * Returns null rather than a guess wherever the shape doesn't cooperate: no narrowing found, or a
 * narrowing that never widens back out again to confirm it was a neck and not just noise. The
 * caller falls back to the fixed fraction in that case.
 */
function neckRow(rgba, width, top, limit, cut) {
  let peak = rowSpan(rgba, width, top, cut);
  let neckY = null;
  let neckWidth = Infinity;

  for (let y = top + 1; y < limit; y++) {
    const span = rowSpan(rgba, width, y, cut);
    if (span === 0) continue;

    if (span >= peak) {
      // Still widening (or a new, wider blob): the head's own widest point moves down with it,
      // and anything narrower seen before this wasn't the neck — a neck is only confirmed once
      // the width climbs back out past it, which by definition hasn't happened yet.
      peak = span;
      neckY = null;
      neckWidth = Infinity;
      continue;
    }

    if (span < neckWidth) {
      neckWidth = span;
      neckY = y;
    } else if (neckY !== null && span >= peak * 0.98) {
      // Back out near the head's own peak width — the shoulders. Whatever the narrowest row was
      // on the way here is the neck, provided it actually was narrower, not a wobble.
      return neckWidth <= peak * NECK_TAPER ? neckY : null;
    }
  }
  return null;
}

/**
 * The kit, not the face: the same photo with the head made transparent, or null if there is no
 * figure to find one in.
 *
 * Built off the alpha channel rather than any real detection — there is no face finder here, only
 * the cut-out's own shape — so this looks for the neck first (see neckRow above) and only falls
 * back to a fixed fraction of the figure's height where the shape doesn't give one up. Either way
 * the result is capped at MAX_HEAD_FRACTION, so a bad detection can never eat more than the top
 * third of the figure.
 */
export function kitCropFrom(buffer, { cut = CUT } = {}) {
  const image = decodePng(buffer);
  if (!image) return null;
  const { width, height, rgba } = image;

  let top = null, bottom = null;
  for (let y = 0; y < height; y++) {
    if (rowSpan(rgba, width, y, cut) > 0) {
      if (top === null) top = y;
      bottom = y;
    }
  }
  if (top === null) return null;

  const figureHeight = bottom - top + 1;
  const searchLimit = Math.min(height, top + Math.round(figureHeight * NECK_SEARCH_FRACTION));
  const neck = neckRow(rgba, width, top, searchLimit, cut);
  const fallback = top + Math.round(figureHeight * FALLBACK_HEAD_FRACTION);
  const cap = top + Math.round(figureHeight * MAX_HEAD_FRACTION);

  const hideBelow = Math.min(neck ?? fallback, cap, height);
  for (let y = top; y < hideBelow; y++) {
    for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 3] = 0;
  }

  return encodePng(image);
}

/**
 * The black silhouette of a cut-out photo, or null if this image can't give one.
 *
 * The null cases are all "there is no shape here to take": a format we don't decode, or a picture
 * with no transparency — a normal photo with its background still on would come back as a black
 * rectangle, which is not a puzzle.
 */
export function silhouetteFrom(buffer, { cut = CUT } = {}) {
  const image = decodePng(buffer);
  if (!image) return null;

  let ink = 0;
  for (let p = 0; p < image.width * image.height; p++) {
    const solid = image.rgba[p * 4 + 3] >= cut;
    if (solid) ink++;
    image.rgba.set([0, 0, 0, solid ? 255 : 0], p * 4);
  }

  const coverage = ink / (image.width * image.height);
  if (coverage > 0.98 || coverage < 0.01) return null;
  return encodePng(image);
}

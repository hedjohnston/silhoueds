// Making the puzzle image out of the photo, and the guardrails around doing it automatically.
//
// The risk in deriving a silhouette is not a crash — it is storing something that looks like a
// puzzle but isn't. A photo with its background still on has alpha everywhere, so it would come
// out as a solid black rectangle and go live as a round nobody could win. That case has to end as
// "no silhouette", which the admin already knows how to show.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const { silhouetteFrom, decodePng, encodePng } = await import('../server/silhouette.mjs');

/** An RGBA PNG built by hand, so a test can say exactly what alpha each pixel has. */
function png(width, height, alphaAt) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set([200, 30, 40, alphaAt(x, y)], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, rgba });
}

/** A disc of solid pixels in the middle of an otherwise empty image — a stand-in for a cut-out. */
const cutout = (size = 40) => png(size, size, (x, y) =>
  Math.hypot(x - size / 2, y - size / 2) < size / 4 ? 255 : 0);

test('a cut-out becomes black where it was solid and empty where it was not', () => {
  const result = silhouetteFrom(cutout());
  assert.ok(result, 'expected a silhouette');

  const image = decodePng(result);
  assert.equal(image.width, 40);
  assert.equal(image.height, 40);

  const at = (x, y) => [...image.rgba.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
  assert.deepEqual(at(20, 20), [0, 0, 0, 255], 'the middle of the shape');
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'the corner, outside the shape');
});

test('the colours of the photo are thrown away, not darkened', () => {
  // Painting black rather than dimming is what makes this a silhouette and not a filter: a pale
  // kit and a dark one have to come out identical, or the shirt gives the answer away.
  const pale = silhouetteFrom(png(20, 20, (x) => (x < 10 ? 255 : 0)));
  const dark = silhouetteFrom(
    encodePng({
      width: 20,
      height: 20,
      rgba: Buffer.concat(Array.from({ length: 400 }, (_, p) =>
        Buffer.from([10, 10, 10, p % 20 < 10 ? 255 : 0]))),
    }),
  );
  assert.deepEqual(decodePng(pale).rgba, decodePng(dark).rgba);
});

test('a photo with its background still on gives nothing', () => {
  assert.equal(silhouetteFrom(png(30, 30, () => 255)), null);
});

test('an empty image gives nothing', () => {
  assert.equal(silhouetteFrom(png(30, 30, () => 0)), null);
});

test('a soft edge is decided one way or the other, never left grey', () => {
  const image = decodePng(silhouetteFrom(png(10, 1, (x) => x * 28)));
  for (let x = 0; x < 10; x++) {
    const [r, g, b, a] = image.rgba.subarray(x * 4, x * 4 + 4);
    assert.equal(a === 0 || a === 255, true, `pixel ${x} has alpha ${a}`);
    assert.deepEqual([r, g, b], [0, 0, 0]);
  }
});

test('a file that is not a PNG is refused rather than throwing', () => {
  assert.equal(silhouetteFrom(Buffer.from('GIF89a and then some')), null);
  assert.equal(silhouetteFrom(Buffer.alloc(0)), null);
});

test('a truncated PNG is refused rather than throwing', () => {
  const whole = cutout();
  assert.equal(silhouetteFrom(whole.subarray(0, whole.length - 20)), null);
});

test('an interlaced PNG is refused, not decoded as if it were not', () => {
  // Adam7 stores the rows in seven passes; reading it as a plain raster would produce garbage.
  const interlaced = Buffer.from(cutout());
  interlaced[8 + 8 + 12] = 1; // IHDR's interlace byte
  assert.equal(silhouetteFrom(interlaced), null);
});

test('every PNG colour type a cut-out might be saved as is read the same way', () => {
  // Greyscale+alpha is what an editor writes when the cut-out has no colour left in it, and a
  // paletted PNG with tRNS is what a small one is often squeezed down to. Both carry the shape.
  const shape = (x) => (x >= 4 && x < 12 ? 255 : 0);

  const grey = Buffer.alloc(16 * 2);
  for (let x = 0; x < 16; x++) grey.set([120, shape(x)], x * 2);
  assert.ok(silhouetteFrom(rebuild(grey, 16, 1, 4)), 'greyscale + alpha');

  const indexed = Buffer.alloc(16);
  for (let x = 0; x < 16; x++) indexed[x] = shape(x) ? 1 : 0;
  assert.ok(
    silhouetteFrom(rebuild(indexed, 16, 1, 3, {
      PLTE: Buffer.from([255, 255, 255, 12, 34, 56]),
      tRNS: Buffer.from([0, 255]),
    })),
    'indexed + tRNS',
  );
});

/** Assemble a PNG around raw samples of a given colour type, which encodePng can't do. */
function rebuild(samples, width, height, colour, extra = {}) {
  const channels = { 3: 1, 4: 2 }[colour];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    samples.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    let c = -1;
    for (const b of Buffer.concat([head.subarray(4), body])) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ -1) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, colour, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...Object.entries(extra).map(([type, body]) => chunk(type, body)),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

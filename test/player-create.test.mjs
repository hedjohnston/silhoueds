// What creating a player fills in on its own.
//
// Two things the operator no longer types: the silhouette, taken from the cut-out photo, and the
// halves of the name as accepted answers. Both are ordinary stored values afterwards — editable,
// deletable — so what matters here is that they are only filled in when they are right, and that
// nothing already entered by hand is overwritten by them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-create-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { adminRouter } = await import('../server/routes-admin.mjs');
const { UPLOAD_DIR } = await import('../server/uploads.mjs');
const { encodePng, decodePng } = await import('../server/silhouette.mjs');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    }),
  );
  next();
});
app.use('/api/admin', adminRouter);
app.use((error, req, res, next) => {
  const status = error.status ?? 500;
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : error.message });
});

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'test-password' }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { cookie }, body });

/** A stand-in cut-out: a solid figure on nothing, which is what these photos are. */
function cutout(alphaAt = (x, y) => (x > 8 && x < 24 && y > 4 ? 255 : 0)) {
  const rgba = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) rgba.set([90, 140, 200, alphaAt(x, y)], (y * 32 + x) * 4);
  }
  return encodePng({ width: 32, height: 32, rgba });
}

function form({ name = 'David Ginola', photo = cutout(), silhouette = null } = {}) {
  const body = new FormData();
  if (name !== null) body.append('name', name);
  if (photo) body.append('photo', new Blob([photo], { type: 'image/png' }), 'photo.png');
  if (silhouette) {
    body.append('silhouette', new Blob([silhouette], { type: 'image/png' }), 'silhouette.png');
  }
  return body;
}

const create = async (options) => (await post('/api/admin/players', form(options))).json();

test('a cut-out photo makes the silhouette, without a second upload', async () => {
  const { player } = await create();

  assert.ok(player.silhouette_image, 'no silhouette was derived');
  assert.notEqual(player.silhouette_image, player.photo, 'the photo was reused as-is');

  const image = decodePng(fs.readFileSync(path.join(UPLOAD_DIR, player.silhouette_image)));
  const at = (x, y) => [...image.rgba.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.deepEqual(at(16, 16), [0, 0, 0, 255], 'inside the figure');
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'outside it');
});

test('an uploaded silhouette wins over the one the photo would give', async () => {
  const own = cutout((x) => (x < 4 ? 255 : 0));
  const { player } = await create({ silhouette: own });

  const stored = fs.readFileSync(path.join(UPLOAD_DIR, player.silhouette_image));
  assert.deepEqual(stored, own, 'the uploaded file should be stored untouched');
});

test('a photo that is not a cut-out leaves no silhouette at all', async () => {
  // Better an empty puzzle the admin flags than a solid black rectangle that goes live.
  const { player } = await create({ photo: cutout(() => 255) });
  assert.equal(player.silhouette_image, null);
});

test('a JPEG photo leaves no silhouette, rather than failing the save', async () => {
  const body = new FormData();
  body.append('name', 'Thierry Henry');
  body.append('photo', new Blob([Buffer.from('not really a jpeg')], { type: 'image/jpeg' }), 'p.jpg');
  const response = await post('/api/admin/players', body);

  assert.equal(response.status, 201);
  const { player } = await response.json();
  assert.ok(player.photo.endsWith('.jpg'));
  assert.equal(player.silhouette_image, null);
});

test('both halves of the name are accepted answers from the off', async () => {
  const { player } = await create({ name: 'David Ginola' });
  assert.deepEqual(player.aliases, ['David', 'Ginola']);
});

test('a one-word name adds nothing to the aliases', async () => {
  const { player } = await create({ name: 'Ronaldinho' });
  assert.deepEqual(player.aliases, []);
});

test('the filled-in aliases can be edited away like any other', async () => {
  const { player } = await create({ name: 'Roy Keane' });
  const response = await fetch(`${base}/api/admin/players/${player.id}`, {
    method: 'PATCH',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ aliases: ['Keane'] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).player.aliases, ['Keane']);
});

test('replacing the photo keeps a silhouette that was already there', async () => {
  const { player } = await create({ silhouette: cutout((x) => (x < 4 ? 255 : 0)) });
  const before = player.silhouette_image;

  const body = new FormData();
  body.append('photo', new Blob([cutout()], { type: 'image/png' }), 'photo.png');
  const updated = await (await post(`/api/admin/players/${player.id}/images`, body)).json();

  assert.equal(updated.player.silhouette_image, before, 'the hand-made silhouette was replaced');
});

test('a photo added to a player with no silhouette fills one in', async () => {
  const { player } = await create({ name: 'Sol Campbell', photo: null });
  assert.equal(player.silhouette_image, null);

  const body = new FormData();
  body.append('photo', new Blob([cutout()], { type: 'image/png' }), 'photo.png');
  const updated = await (await post(`/api/admin/players/${player.id}/images`, body)).json();

  assert.ok(updated.player.silhouette_image, 'no silhouette was derived');
});

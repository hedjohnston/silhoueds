// Upload handling: what gets stored, under what name, and what happens to files nobody wanted.
//
// The stored extension is the security-relevant part. Uploads are served straight back from disk
// by res.sendFile, which picks Content-Type from the extension — so an extension taken from the
// client's own filename meant an attacker could get a file served as HTML from this origin,
// unauthenticated, through /api/puzzle/silhouette.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-uploads-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { adminRouter } = await import('../server/routes-admin.mjs');
const { UPLOAD_DIR } = await import('../server/uploads.mjs');

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
// The real error handler, so a rejected upload surfaces the status it actually sets.
app.use((error, req, res, next) => {
  const status = error.status ?? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
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

// A one-pixel PNG, so the bytes are a real image even when we lie about the filename.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const storedFiles = () => fs.readdirSync(UPLOAD_DIR);

function form({ name = 'Test Player', filename = 'art.png', type = 'image/png', bytes = PNG } = {}) {
  const body = new FormData();
  if (name !== null) body.append('name', name);
  body.append('silhouette', new Blob([bytes], { type }), filename);
  return body;
}

const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { cookie }, body });

test('the stored extension comes from the validated type, not the filename', async () => {
  // The bytes are a PNG and the declared type is image/png; only the *name* is hostile.
  const response = await post('/api/admin/players', form({ filename: 'payload.html' }));
  assert.equal(response.status, 201);

  const stored = (await response.json()).player.silhouette_image;
  assert.ok(stored.endsWith('.png'), `stored as ${stored}`);
  assert.ok(!stored.includes('html'), `stored as ${stored}`);
});

test('a filename cannot walk out of the upload directory', async () => {
  const response = await post('/api/admin/players', form({ filename: '../../escape.png' }));
  assert.equal(response.status, 201);

  const stored = (await response.json()).player.silhouette_image;
  assert.ok(!stored.includes('/'), `stored as ${stored}`);
  assert.ok(!stored.includes('..'), `stored as ${stored}`);
  // And the file really is inside the directory.
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, stored)));
});

test('each mime type maps to its own extension', async () => {
  for (const [type, extension] of [
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/avif', '.avif'],
  ]) {
    const response = await post('/api/admin/players', form({ type, filename: 'x.bin' }));
    assert.equal(response.status, 201, type);
    assert.ok((await response.json()).player.silhouette_image.endsWith(extension), type);
  }
});

test('a disallowed type is refused as a 400, not a server error', async () => {
  const response = await post(
    '/api/admin/players',
    form({ type: 'text/html', filename: 'x.html', bytes: Buffer.from('<script>alert(1)</script>') }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JPEG, PNG, WebP or AVIF/);
});

test('an upload rejected for a missing name is not left on disk', async () => {
  const before = storedFiles().length;
  // Multer writes the file before the handler ever sees it, so the handler has to clean up.
  const response = await post('/api/admin/players', form({ name: null }));

  assert.equal(response.status, 400);
  assert.equal(storedFiles().length, before, 'orphaned upload left behind');
});

test('an upload for a player that does not exist is not left on disk', async () => {
  const before = storedFiles().length;
  const response = await post('/api/admin/players/999999/images', form());

  assert.equal(response.status, 404);
  assert.equal(storedFiles().length, before, 'orphaned upload left behind');
});

test('replacing an image deletes the file it replaced', async () => {
  const created = await (await post('/api/admin/players', form())).json();
  const original = created.player.silhouette_image;
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, original)));

  const replaced = await (await post(`/api/admin/players/${created.player.id}/images`, form())).json();
  assert.notEqual(replaced.player.silhouette_image, original);
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, original)), 'old file should be gone');
});

test('deleting a player takes its images with it', async () => {
  const created = await (await post('/api/admin/players', form())).json();
  const stored = created.player.silhouette_image;
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, stored)));

  const response = await fetch(`${base}/api/admin/players/${created.player.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, stored)));
});

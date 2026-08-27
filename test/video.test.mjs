// The admin pastes a YouTube link; only the 11-character video id is ever kept. Covers the URL
// shapes a real paste is likely to be (watch, share, shorts, embed, a bare id) and the reject
// path for anything that isn't one of those.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-video-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { adminRouter } = await import('../server/routes-admin.mjs');

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
  res.status(error.status ?? 500).json({ error: error.message ?? 'Something went wrong' });
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

const json = (url, options = {}) =>
  fetch(`${base}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', cookie, ...options.headers },
  });

async function newPlayer() {
  const body = new FormData();
  body.append('name', 'Test Player');
  const response = await fetch(`${base}/api/admin/players`, { method: 'POST', headers: { cookie }, body });
  return (await response.json()).player.id;
}

const ID = 'dQw4w9WgXcQ'; // 11 characters, the shape every real video id has

for (const [label, url] of [
  ['a watch URL', `https://www.youtube.com/watch?v=${ID}`],
  ['a watch URL with a timestamp after it', `https://www.youtube.com/watch?v=${ID}&t=42s`],
  ['a youtu.be share link', `https://youtu.be/${ID}`],
  ['a youtu.be share link with a query string', `https://youtu.be/${ID}?si=abc123`],
  ['a shorts URL', `https://www.youtube.com/shorts/${ID}`],
  ['an embed URL', `https://www.youtube-nocookie.com/embed/${ID}`],
  ['a bare id, no URL at all', ID],
]) {
  test(`accepts ${label}`, async () => {
    const id = await newPlayer();
    const response = await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ videoUrl: url }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).player.video_id, ID);
  });
}

test('rejects a link from somewhere that is not YouTube', async () => {
  const id = await newPlayer();
  const response = await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ videoUrl: 'https://vimeo.com/76979871' }),
  });
  assert.equal(response.status, 400);
});

test('rejects text that is not a link at all', async () => {
  const id = await newPlayer();
  const response = await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ videoUrl: 'great goal actually' }),
  });
  assert.equal(response.status, 400);
});

test('an empty string clears a video that was already set', async () => {
  const id = await newPlayer();
  await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ videoUrl: ID }) });

  const response = await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ videoUrl: '' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.video_id, null);
});

test('leaving videoUrl out of the request leaves the video untouched', async () => {
  const id = await newPlayer();
  await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ videoUrl: ID }) });

  const response = await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ category: 'international' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.video_id, ID);
});

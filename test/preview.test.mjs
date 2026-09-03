// The admin's preview of a saved round. Its whole value is that it comes from the game's own
// round state rather than from the stored row, so what is checked here is that the game's rules
// are visible in it: a hint the category drops is missing from the preview too, the answer and
// the video are present (a preview is a finished round), and a draft is previewable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-preview-'));
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

async function newPlayer(name, category) {
  const body = new FormData();
  body.append('name', name);
  body.append('category', category);
  const response = await fetch(`${base}/api/admin/players`, { method: 'POST', headers: { cookie }, body });
  return (await response.json()).player.id;
}

const preview = async (id) => (await json(`/api/admin/players/${id}/preview`)).json();

test('shows the hints in the order they are revealed, and the answer', async () => {
  const id = await newPlayer('Gabriel Batistuta', 'international');
  await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      hints: [{ label: 'Nickname', value: 'Batigol' }, { label: 'Best known at', value: 'Fiorentina' }],
      videoUrl: 'dQw4w9WgXcQ',
    }),
  });

  const state = await preview(id);
  assert.deepEqual(state.hints.map((h) => h.label), ['Nickname', 'Best known at']);
  assert.equal(state.answer, 'Gabriel Batistuta');
  assert.equal(state.videoId, 'dQw4w9WgXcQ');
  // The name was split into accepted answers on creation; the preview says what will be accepted.
  assert.ok(state.aliases.includes('Batistuta'));
});

test('drops a hint the category has no use for, exactly as the game would', async () => {
  const id = await newPlayer('Alan Shearer', 'premier-league');
  await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      hints: [{ label: 'League', value: 'Premier League' }, { label: 'Position', value: 'Striker' }],
    }),
  });

  const state = await preview(id);
  assert.deepEqual(state.hints.map((h) => h.label), ['Position']);
});

test('a draft previews, and says it is not published', async () => {
  const id = await newPlayer('Nobody Yet', 'international');
  const state = await preview(id);
  assert.equal(state.status, 'draft');
  assert.deepEqual(state.missing, ['silhouette', 'hints']);
  assert.deepEqual(state.hints, []);
});

test('image links address this player, not whoever is playing today', async () => {
  const id = await newPlayer('Art Haver', 'international');
  const state = await preview(id);
  // No uploads on this player, so both are null rather than pointing at the live round.
  assert.equal(state.silhouetteUrl, null);
  assert.equal(state.revealUrl, null);
});

test('there is no preview for a player who does not exist', async () => {
  const response = await json('/api/admin/players/9999/preview');
  assert.equal(response.status, 404);
});

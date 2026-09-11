// The admin's own call on how hard a footballer will be, 1 to 5. Covers the range, the two ways
// a rating can be absent (never set, and taken back off), the reject path for anything that is
// not a rung on the scale, and the two places the number has to arrive: beside the date in the
// player's round, and beside the result in the admin's insights panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-difficulty-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { adminRouter } = await import('../server/routes-admin.mjs');
const { gameRouter } = await import('../server/routes-game.mjs');
const { players, schedule } = await import('../server/db.mjs');

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
app.use('/api', gameRouter);
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
  body.append('name', `Test Player ${Math.random().toString(36).slice(2, 8)}`);
  const response = await fetch(`${base}/api/admin/players`, { method: 'POST', headers: { cookie }, body });
  return (await response.json()).player.id;
}

const rate = (id, difficulty) =>
  json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({ difficulty }) });

test('a new footballer starts unrated', async () => {
  const id = await newPlayer();
  const response = await json(`/api/admin/players/${id}`, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal((await response.json()).player.difficulty, null);
});

for (const rating of [1, 2, 3, 4, 5]) {
  test(`accepts ${rating}`, async () => {
    const id = await newPlayer();
    const response = await rate(id, rating);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).player.difficulty, rating);
  });
}

for (const [label, rating] of [
  ['zero', 0],
  ['six', 6],
  ['a negative', -1],
  ['a fraction', 3.5],
  ['a string', '4'],
  ['a boolean', true],
]) {
  test(`rejects ${label}`, async () => {
    const id = await newPlayer();
    const response = await rate(id, rating);
    assert.equal(response.status, 400);
    // A rejected rating must not have landed on the way to being rejected.
    assert.equal(players.get(id).difficulty, null);
  });
}

test('null takes a rating back off', async () => {
  const id = await newPlayer();
  await rate(id, 4);
  const response = await rate(id, null);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.difficulty, null);
});

test('leaving difficulty out of the request leaves the rating untouched', async () => {
  const id = await newPlayer();
  await rate(id, 5);

  const response = await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: 'international' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.difficulty, 5);
});

test('a rating survives an unrelated edit', async () => {
  const id = await newPlayer();
  await rate(id, 2);
  await json(`/api/admin/players/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ aliases: ['nickname'] }),
  });
  assert.equal(players.get(id).difficulty, 2);
});

/** A published, scheduled footballer, so the public round endpoint has something to serve. */
async function scheduled(date, category, difficulty) {
  const id = await newPlayer();
  if (difficulty !== undefined) await rate(id, difficulty);
  players.update(id, {
    hints: [{ label: 'Position', value: 'Striker' }],
    silhouette: '<svg></svg>',
    status: 'ready',
  });
  schedule.set(date, category, id);
  return id;
}

// The rating is context for the round, like the date — so it travels with the round from the
// start, rather than waiting for the reveal.
test('the rating reaches the player, before the round is over', async () => {
  await scheduled('2026-01-15', 'international', 5);

  const response = await fetch(`${base}/api/puzzle?category=international&date=2026-01-15`);
  assert.equal(response.status, 200);
  const round = await response.json();
  assert.equal(round.difficulty, 5);
  // Still an unplayed round: the rating is not something the reveal hands over.
  assert.equal(round.finished, false);
  assert.equal(round.answer, undefined);
});

test('an unrated footballer sends no rating rather than a low one', async () => {
  await scheduled('2026-01-17', 'international');

  const response = await fetch(`${base}/api/puzzle?category=international&date=2026-01-17`);
  const round = await response.json();
  assert.equal(round.difficulty, null);
});

// The rating says how hard the footballer is; it must never imply anything about the answer.
test('the rating does not vary with how the round is going', async () => {
  await scheduled('2026-01-18', 'premier-league', 3);
  const jar = [];
  const ask = async () => {
    const r = await fetch(`${base}/api/puzzle?category=premier-league&date=2026-01-18`, {
      headers: jar.length ? { cookie: jar.join('; ') } : {},
    });
    for (const c of r.headers.getSetCookie()) jar.push(c.split(';')[0]);
    return (await r.json()).difficulty;
  };
  const before = await ask();
  await fetch(`${base}/api/guess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: jar.join('; ') },
    body: JSON.stringify({ guess: 'Nobody', category: 'premier-league', date: '2026-01-18' }),
  });
  assert.equal(before, 3);
  assert.equal(await ask(), 3);
});

// The admin panel sets the call against what people actually managed, so it needs it back.
test('the insights panel gets the rating for the day it is looking at', async () => {
  const id = await newPlayer();
  await rate(id, 3);
  players.update(id, {
    hints: [{ label: 'Position', value: 'Winger' }],
    silhouette: '<svg></svg>',
    status: 'ready',
  });
  schedule.set('2026-01-16', 'premier-league', id);

  const response = await json('/api/admin/insights?category=premier-league&date=2026-01-16');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.difficulty, 3);
});

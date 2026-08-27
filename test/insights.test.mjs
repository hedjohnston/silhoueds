// The admin guess log must be read-only.
//
// Regression test for a bug where simply opening insights allocated a player to whatever date was
// asked for. The endpoint resolved the day's player with playerForDate(), which falls through to
// auto-assignment and writes a schedule row — and the schedule picker then excludes anyone already
// scheduled, so the player was gone from the pool for good. Reading a report must never spend one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-insights-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { players, schedule, db } = await import('../server/db.mjs');
const { adminRouter } = await import('../server/routes-admin.mjs');

// The same minimal cookie parsing index.mjs applies, so the admin cookie round-trips.
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

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Sign in once and reuse the cookie.
const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'test-password' }),
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const asAdmin = (url) => fetch(`${base}${url}`, { headers: { cookie } });
const scheduleCount = () => db.prepare('SELECT COUNT(*) AS n FROM schedule').get().n;

// A publishable player, so there is something for auto-assignment to reach for if it tries.
const player = players.create({
  slug: 'ready-one',
  name: 'Alan Shearer',
  hints: [{ label: 'Era', value: 'The 90s' }],
  silhouetteImage: 'art.png',
  category: 'international',
});
players.update(player.id, { status: 'ready' });

test('reading insights for an unplayed day does not schedule anyone', async () => {
  assert.equal(scheduleCount(), 0);

  const response = await asAdmin('/api/admin/insights?date=2026-08-20&category=international');
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.player, null, 'no player ran that day, so none should be reported');
  assert.equal(body.summary.players, 0);
  assert.equal(scheduleCount(), 0, 'reading the log must not consume a player');
});

test('reading insights for a future date does not schedule anyone', async () => {
  // The endpoint only format-checks the date, so a far-future one gets through. It must still
  // not allocate — that would burn a player onto a day years away.
  const response = await asAdmin('/api/admin/insights?date=2099-01-01&category=international');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).player, null);
  assert.equal(scheduleCount(), 0);
});

test('insights still reports the player on a day that actually ran', async () => {
  schedule.set('2026-08-21', 'international', player.id);

  const body = await (await asAdmin('/api/admin/insights?date=2026-08-21&category=international')).json();
  assert.equal(body.player?.name, 'Alan Shearer');
  assert.equal(scheduleCount(), 1, 'and still adds nothing of its own');
});

test('insights reads the category it was asked for', async () => {
  // The same date in the other game had no round, so it reports none rather than borrowing.
  const body = await (await asAdmin('/api/admin/insights?date=2026-08-21&category=premier-league')).json();
  assert.equal(body.player, null);
  assert.equal(scheduleCount(), 1);
});

test('the insights date list is unauthenticated-safe and read-only', async () => {
  const before = scheduleCount();
  const response = await asAdmin('/api/admin/insights/dates?category=international');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).dates));
  assert.equal(scheduleCount(), before);
});

test('insights refuses an anonymous caller', async () => {
  const response = await fetch(`${base}/api/admin/insights?date=2026-08-21`);
  assert.equal(response.status, 401);
});

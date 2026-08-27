// Archiving a spent footballer.
//
// A player is used once: the schedule picker excludes anyone ever scheduled, so a season's worth
// of them piles up in the admin with nothing left to decide. Archiving retires them in one go —
// out of the list, out of the auto-assignment pool, and still serving every round they ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-archive-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_UPLOADS = path.join(scratch, 'uploads');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.env.SILHOUEDS_TIMEZONE = 'UTC';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { players, schedule } = await import('../server/db.mjs');
const { adminRouter } = await import('../server/routes-admin.mjs');
const { todayKey } = await import('../server/game.mjs');

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

const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'test-password' }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const asAdmin = (url, options = {}) =>
  fetch(`${base}${url}`, {
    ...options,
    headers: { cookie, 'Content-Type': 'application/json', ...options.headers },
  });

const today = todayKey(new Date(), 'UTC');
const shift = (days) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** A publishable player, so archiving has something real to take out of the pool. */
function ready(slug, name) {
  const player = players.create({
    slug,
    name,
    hints: [{ label: 'Era', value: 'The 90s' }],
    silhouetteImage: 'art.png',
    category: 'international',
  });
  players.update(player.id, { status: 'ready' });
  return players.get(player.id);
}

const ran = ready('ran-already', 'Alan Shearer');
const booked = ready('booked-ahead', 'Thierry Henry');
const spare = ready('never-used', 'Dennis Bergkamp');

schedule.set(shift(-3), 'international', ran.id);
schedule.set(shift(4), 'international', booked.id);

test('the player list says when each footballer had their day', async () => {
  const body = await (await asAdmin('/api/admin/players')).json();
  const bySlug = Object.fromEntries(body.players.map((p) => [p.slug, p]));

  assert.equal(body.today, today);
  assert.equal(bySlug['ran-already'].lastScheduled, shift(-3));
  assert.equal(bySlug['booked-ahead'].lastScheduled, shift(4));
  assert.equal(bySlug['never-used'].lastScheduled, null);
  // Nobody is archived until someone says so.
  assert.ok(body.players.every((p) => p.archived === false));
});

test('archiving in bulk takes the played, and leaves the still-to-come alone', async () => {
  const response = await asAdmin('/api/admin/players/archive-played', { method: 'POST' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.archived, 1);
  assert.equal(players.get(ran.id).archived, true);
  // A player booked for next week is still waiting for their round.
  assert.equal(players.get(booked.id).archived, false);
  assert.equal(players.get(spare.id).archived, false);
});

test('a second sweep finds nothing left to do', async () => {
  const body = await (await asAdmin('/api/admin/players/archive-played', { method: 'POST' })).json();
  assert.equal(body.archived, 0);
});

test('an archived player is out of the pool a day can be filled from', () => {
  const pool = players.ready('international').map((p) => p.slug);
  assert.deepEqual(pool.sort(), ['booked-ahead', 'never-used']);
});

test('the round they already ran still resolves — archiving is not deleting', () => {
  const past = schedule.get(shift(-3), 'international');
  assert.equal(past.id, ran.id);
  assert.equal(past.archived, true);
});

test('archiving is reversible from the card, and puts them back in the pool', async () => {
  const response = await asAdmin(`/api/admin/players/${ran.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: false }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).player.archived, false);
  assert.ok(players.ready('international').some((p) => p.id === ran.id));
});

test('a Premier League player needs a hint that game actually reveals', async () => {
  const player = players.create({
    slug: 'league-only',
    name: 'Alan Smith',
    hints: [{ label: 'League', value: 'Premier League' }],
    silhouetteImage: 'art.png',
    category: 'premier-league',
  });

  const refused = await asAdmin(`/api/admin/players/${player.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /hints/);

  // A rung that game does play with is enough.
  const accepted = await asAdmin(`/api/admin/players/${player.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ hints: [{ label: 'Position', value: 'Striker' }], status: 'ready' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).player.status, 'ready');
});

test('the hint catalog carries a ladder per game, plus the categories invented so far', async () => {
  players.create({
    slug: 'has-custom-hint',
    name: 'Ian Wright',
    hints: [{ label: 'Trophy cabinet', value: 'An FA Cup' }],
    category: 'premier-league',
  });

  const { hints } = await (await asAdmin('/api/admin/players')).json();

  assert.deepEqual(hints.ladders['premier-league'], ['Era', 'Position', 'Nationality', 'Best known at']);
  assert.deepEqual(hints.ladders.international, hints.standard);
  assert.deepEqual(hints.custom, ['Trophy cabinet']);
});


test('the admin refuses a seventh hint rather than storing one nothing can reveal', async () => {
  const player = players.create({ slug: 'over-full', name: 'Les Ferdinand', category: 'international' });
  const hint = (n) => ({ label: `Category ${n}`, value: `value ${n}` });

  const refused = await asAdmin(`/api/admin/players/${player.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ hints: [1, 2, 3, 4, 5, 6, 7].map(hint) }),
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /6 hints/);
  // Refused outright: the seventh does not quietly take the other six down with it.
  assert.deepEqual(players.get(player.id).hints, []);

  const accepted = await asAdmin(`/api/admin/players/${player.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ hints: [1, 2, 3, 4, 5, 6].map(hint) }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).player.hints.length, 6);
});

test('the catalog states the cap, and shares invented categories across both games', async () => {
  const { hints } = await (await asAdmin('/api/admin/players')).json();
  assert.equal(hints.max, 6);
  // One list, whichever game a category was written on.
  assert.ok(hints.custom.includes('Trophy cabinet'));
  assert.ok(hints.custom.includes('Category 1'));
});

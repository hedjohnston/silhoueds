// Round logic: which day resolves, which hints are out, and what a visitor's record adds up to.
//
// These run against a real (temporary) SQLite file rather than a stub, so the schema and the
// migrations in db.mjs are exercised too — the queries and the code that reads them have to agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.mjs reads this at import time, so it has to be set before the dynamic import below.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-test-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_TIMEZONE = 'Australia/Sydney';

const { db, players, plays, schedule } = await import('../server/db.mjs');
const {
  todayKey, resolveRoundDate, statsFor, publicState, hasArtwork, normalizeCategory, MAX_GUESSES,
} = await import('../server/game.mjs');

process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const HINTS = [
  { label: 'Era', value: 'The 90s' },
  { label: 'Position', value: 'Striker' },
  { label: 'League', value: 'Premier League' },
];

function makePlayer(overrides = {}) {
  const slug = `p${Math.random().toString(36).slice(2, 10)}`;
  return players.create({ slug, name: 'Alan Shearer', hints: HINTS, ...overrides });
}

const guess = (name, correct = false) => ({ name, correct, skipped: false });
const skip = () => ({ name: '', correct: false, skipped: true });

// --- schema --------------------------------------------------------------

test('a fresh database is created at the current schema, not migrated up to it', () => {
  // This database was made moments ago by importing db.mjs. If the CREATE TABLE statements were
  // stale, the category migration would have had to rename and rebuild these tables on first
  // boot — a destructive operation no new install has any reason to run.
  const pk = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

  assert.deepEqual(pk('schedule'), ['date', 'category']);
  assert.deepEqual(pk('plays'), ['session_id', 'date', 'category']);

  for (const column of ['category', 'silhouette_image', 'reveal_image']) {
    assert.ok(
      db.prepare('PRAGMA table_info(players)').all().some((c) => c.name === column),
      `players.${column} missing`,
    );
  }
});

// --- todayKey ------------------------------------------------------------

test('todayKey formats as YYYY-MM-DD in the given zone', () => {
  // 2026-08-27T02:00Z is still the 26th in Los Angeles and already the 27th in Sydney.
  const noon = new Date('2026-08-27T02:00:00Z');
  assert.equal(todayKey(noon, 'Australia/Sydney'), '2026-08-27');
  assert.equal(todayKey(noon, 'America/Los_Angeles'), '2026-08-26');
  assert.equal(todayKey(noon, 'UTC'), '2026-08-27');
});

test('an unparseable zone falls back to the configured default, not to UTC', () => {
  // 20:00Z is already the 27th in Sydney but still the 26th in UTC, so the two disagree and the
  // fallback is observable. Falling back to UTC filed the round a day out from where a missing
  // zone would have put it.
  const now = new Date('2026-08-26T20:00:00Z');
  assert.equal(todayKey(now, 'Australia/Sydney'), '2026-08-27');
  assert.equal(todayKey(now, 'Mars/Phobos'), '2026-08-27');
  assert.equal(todayKey(now, ''), '2026-08-27');
});

test('every real timezone is honoured exactly — the clamp never touches one', () => {
  // The zone is caller-supplied, so the result is bounded; that bound must be wide enough that no
  // genuine visitor anywhere ever notices it.
  const now = new Date('2026-08-27T02:00:00Z');
  const unclamped = (zone) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);

  const zones = Intl.supportedValuesOf('timeZone');
  assert.ok(zones.length > 300, 'expected a full zone list to test against');
  for (const zone of zones) {
    assert.equal(todayKey(now, zone), unclamped(zone), `${zone} was altered`);
  }
});

test('a claimed zone cannot reach further than a day from the server', () => {
  // Intl accepts offsets out to ±18:00, beyond any real zone. Resolving a date also auto-assigns
  // that day's player, so an unbounded claim would spend players from the pool ahead of time.
  const now = new Date('2026-08-27T12:00:00Z');
  const server = todayKey(now, 'Australia/Sydney');
  const day = 86400000;
  const distance = (key) =>
    Math.abs(Date.parse(`${key}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`)) / day;

  for (const claim of ['+18:00', '-18:00', '+14:00', '-12:00', 'UTC']) {
    assert.ok(distance(todayKey(now, claim)) <= 1, `${claim} reached too far`);
  }
});

// --- resolveRoundDate ----------------------------------------------------

test('resolveRoundDate defaults to today and refuses the future', () => {
  assert.equal(resolveRoundDate(undefined, '2026-08-27', 'international'), '2026-08-27');
  assert.equal(resolveRoundDate('2026-08-27', '2026-08-27', 'international'), '2026-08-27');
  // Reading ahead would spoil tomorrow, so a future date never resolves.
  assert.equal(resolveRoundDate('2026-08-28', '2026-08-27', 'international'), null);
});

test('resolveRoundDate rejects anything that is not a date key', () => {
  for (const bad of ['not-a-date', '2026-8-7', '2026-08-27T00:00', '../../etc/passwd']) {
    assert.equal(resolveRoundDate(bad, '2026-08-27', 'international'), null, bad);
  }
});

test('a past date resolves only if that day actually ran', () => {
  const player = makePlayer();
  players.update(player.id, { status: 'ready' });
  schedule.set('2026-08-20', 'international', player.id);

  assert.equal(resolveRoundDate('2026-08-20', '2026-08-27', 'international'), '2026-08-20');
  // Never scheduled: refused rather than auto-assigned, which would burn a player from the pool.
  assert.equal(resolveRoundDate('2026-08-19', '2026-08-27', 'international'), null);
  // Scheduled, but in the other game.
  assert.equal(resolveRoundDate('2026-08-20', '2026-08-27', 'premier-league'), null);
});

// --- categories ----------------------------------------------------------

test('normalizeCategory keeps known categories and falls back otherwise', () => {
  assert.equal(normalizeCategory('premier-league'), 'premier-league');
  assert.equal(normalizeCategory('international'), 'international');
  assert.equal(normalizeCategory('nonsense'), 'international');
  assert.equal(normalizeCategory(undefined), 'international');
});

test('hasArtwork accepts either an upload or a traced outline', () => {
  assert.equal(hasArtwork({ silhouette_image: 'a.png', silhouette: null }), true);
  assert.equal(hasArtwork({ silhouette_image: null, silhouette: '<svg/>' }), true);
  assert.equal(hasArtwork({ silhouette_image: null, silhouette: null }), false);
  assert.equal(hasArtwork(null), false);
});

// --- publicState: what the browser is allowed to know --------------------

test('an unfinished round never carries the answer or the reveal photo', () => {
  const player = { name: 'Alan Shearer', hints: HINTS, reveal_image: 'r.png', silhouette: '<svg/>' };
  const state = publicState(player, { date: '2026-08-27', guesses: [guess('Wrong')], finished: false });

  assert.equal(state.answer, undefined);
  assert.equal(state.revealUrl, null);
  assert.equal(state.finished, false);
});

test('the answer arrives only once the round is over', () => {
  const player = { name: 'Alan Shearer', hints: HINTS, reveal_image: 'r.png', silhouette: '<svg/>' };
  const state = publicState(player, { date: '2026-08-27', guesses: [guess('Alan Shearer', true)], finished: true, won: true });

  assert.equal(state.answer, 'Alan Shearer');
  assert.equal(state.revealUrl, '/api/puzzle/reveal');
});

test('hard mode releases one hint per miss, and a skip counts as a miss', () => {
  const player = { name: 'X', hints: HINTS, silhouette: '<svg/>' };
  const at = (guesses) => publicState(player, { date: '2026-08-27', guesses, mode: 'hard' }).hints;

  assert.deepEqual(at([]), []);
  assert.deepEqual(at([guess('a')]).map((h) => h.label), ['Era']);
  assert.deepEqual(at([guess('a'), skip()]).map((h) => h.label), ['Era', 'Position']);
  // A correct guess is not a miss, so it earns nothing.
  assert.deepEqual(at([guess('a', true)]), []);
});

test('hard mode never releases more hints than exist', () => {
  const player = { name: 'X', hints: HINTS, silhouette: '<svg/>' };
  const guesses = Array.from({ length: MAX_GUESSES }, () => guess('wrong'));
  assert.equal(publicState(player, { date: '2026-08-27', guesses, mode: 'hard' }).hints.length, HINTS.length);
});

test('a finished round shows every hint, even one solved on the very first guess', () => {
  // A win this fast earned nothing under the usual "one hint per miss" rule — but the round is
  // over, so there is nothing left to gate: the panel should show what the other hints would have
  // given away, not sit there looking like the puzzle had no hints at all.
  const player = { name: 'X', hints: HINTS, silhouette: '<svg/>' };
  const state = publicState(player, {
    date: '2026-08-27', guesses: [guess('X', true)], mode: 'hard', finished: true, won: true,
  });
  assert.deepEqual(state.hints.map((h) => h.label), HINTS.map((h) => h.label));
});

test('a finished round shows every hint after a loss too, not just the ones the misses earned', () => {
  // A skip earns no answer but still counts as a miss, so a player can lose with fewer text hints
  // shown than exist — a round finished by skips should still hand over the whole ladder.
  const player = { name: 'X', hints: HINTS, silhouette: '<svg/>' };
  const guesses = [guess('wrong')];
  const unfinished = publicState(player, { date: '2026-08-27', guesses, mode: 'hard', finished: false });
  const finished = publicState(player, { date: '2026-08-27', guesses, mode: 'hard', finished: true, won: false });

  assert.equal(unfinished.hints.length, 1);
  assert.deepEqual(finished.hints.map((h) => h.label), HINTS.map((h) => h.label));
});

test('easy mode earns its hints on the same ladder as hard', () => {
  // Easy mode used to hand over the whole ladder at once. That made it two assists rather than
  // one and left hard mode strictly worse off, so the modes now differ only in whether the
  // silhouette fills in.
  const player = { name: 'X', hints: HINTS, reveal_image: 'r.png', silhouette: '<svg/>' };
  const at = (guesses) =>
    publicState(player, { date: '2026-08-27', guesses, mode: 'easy' }).hints.map((h) => h.label);

  assert.deepEqual(at([]), []);
  assert.deepEqual(at([guess('a')]), ['Era']);
  assert.deepEqual(at([guess('a'), skip()]), ['Era', 'Position']);
});

test('easy mode falls back to hard when there is no photo to reveal', () => {
  const player = { name: 'X', hints: HINTS, reveal_image: null, silhouette: '<svg/>' };
  const state = publicState(player, { date: '2026-08-27', guesses: [], mode: 'easy' });

  assert.equal(state.easyAvailable, false);
  assert.equal(state.mode, 'hard');
  assert.deepEqual(state.hints, []); // hints are earned in both modes, so none yet
});

test('hints come out in the order the slots were arranged, not sorted', () => {
  // The admin arranges six slots and stored order is the running order, so a League hint put
  // first is revealed first. Nothing re-sorts it on the way out.
  const arranged = [HINTS[2], HINTS[0], HINTS[1]];
  const player = { name: 'X', hints: arranged, reveal_image: 'r.png', silhouette: '<svg/>' };
  // A finished round holds the whole ladder, which is where the order is visible in one go.
  const state = publicState(player, { date: '2026-08-27', guesses: [], mode: 'easy', finished: true });
  assert.deepEqual(state.hints.map((h) => h.label), ['League', 'Era', 'Position']);
});

/** The easy-mode fill after `misses` wrong guesses, for a player carrying `hintCount` hints. */
const fillAfter = (misses, hintCount = HINTS.length, finished = false) =>
  publicState(
    { name: 'X', hints: HINTS.slice(0, hintCount), reveal_image: 'r.png', silhouette: '<svg/>' },
    {
      date: '2026-08-27',
      guesses: Array.from({ length: misses }, () => guess('wrong')),
      mode: 'easy',
      finished,
    },
  ).fill;

test('the fill starts as a flat ink silhouette', () => {
  // brightness(0) on a background-removed photo is exactly the shape hard mode shows, which is
  // the whole point: easy mode opens looking identical and diverges from there.
  assert.equal(fillAfter(0).brightness, 0);
  assert.equal(fillAfter(0).saturate, 0);
});

test('the fill resolves as guesses are spent, and is complete once the round ends', () => {
  assert.ok(fillAfter(1).brightness > fillAfter(0).brightness);
  assert.ok(fillAfter(2).brightness > fillAfter(1).brightness);
  assert.deepEqual(fillAfter(1, HINTS.length, true), { brightness: 1, contrast: 1, saturate: 1 });
});

test('colour arrives later than light, so the kit is never a free clue', () => {
  // Saturation trails brightness at every live step: shape first, then detail, then colour.
  for (let misses = 1; misses < MAX_GUESSES; misses++) {
    const { brightness, saturate } = fillAfter(misses);
    assert.ok(saturate < brightness, `saturate should trail brightness at ${misses} misses`);
  }
});

test('a live round never fully resolves, at any hint count', () => {
  // The regression this replaces: the old blur divided by the number of hints rather than by
  // MAX_GUESSES, so a player carrying four or fewer went completely sharp with guesses still in
  // hand — handing over the answer for free.
  for (let hintCount = 0; hintCount <= HINTS.length; hintCount++) {
    for (let misses = 0; misses <= MAX_GUESSES; misses++) {
      const fill = fillAfter(misses, hintCount);
      assert.ok(
        fill.brightness < 1,
        `a live round with ${hintCount} hints resolved after ${misses} misses`,
      );
    }
  }
});

test('hard mode is never given a fill at all', () => {
  const player = { name: 'X', hints: HINTS, reveal_image: 'r.png', silhouette: '<svg/>' };
  const state = publicState(player, { date: '2026-08-27', guesses: [guess('a')], mode: 'hard' });
  assert.equal(state.fill, null);
  assert.equal(state.photoUrl, null);
});

// --- statsFor ------------------------------------------------------------

/** Record a finished round for `session` on `date`, won or lost, using `used` guesses. */
function record(session, date, { won, used = 1, category = 'international', mode = 'hard' }) {
  const guesses = Array.from({ length: used }, (_, i) =>
    guess('g', won && i === used - 1));
  plays.save(session, date, category, { guesses, finished: true, won, mode });
}

test('the record splits by mode, but the streak spans both', () => {
  // Splitting the streak too would punish the player who sizes up the silhouette and picks a mode
  // to suit it. The difficulty shows up in byMode and hardWins instead, so taking hard on is worth
  // something without an easy day costing a run.
  const session = 'mode-split';
  record(session, '2026-08-24', { won: true, used: 2, mode: 'hard' });
  record(session, '2026-08-25', { won: true, used: 3, mode: 'easy' });
  record(session, '2026-08-26', { won: false, used: 6, mode: 'easy' });
  record(session, '2026-08-27', { won: true, used: 1, mode: 'hard' });

  const stats = statsFor(session, '2026-08-27', 'international');

  assert.equal(stats.played, 4);
  assert.equal(stats.won, 3);
  assert.equal(stats.currentStreak, 1); // 26th was lost, so only today survives
  assert.equal(stats.bestStreak, 2); // 24th and 25th, spanning a hard day and an easy one

  assert.equal(stats.byMode.hard.played, 2);
  assert.equal(stats.byMode.hard.won, 2);
  assert.equal(stats.byMode.hard.winRate, 100);
  assert.equal(stats.byMode.easy.played, 2);
  assert.equal(stats.byMode.easy.won, 1);
  assert.equal(stats.byMode.easy.winRate, 50);
  assert.equal(stats.hardWins, 2);

  // The distributions are per mode too, not the overall one repeated.
  assert.equal(stats.byMode.hard.distribution[1], 1);
  assert.equal(stats.byMode.easy.distribution[3], 1);
});

test('a fresh visitor has an empty record rather than NaN', () => {
  const stats = statsFor('nobody', '2026-08-27', 'international');
  assert.equal(stats.played, 0);
  assert.equal(stats.won, 0);
  assert.equal(stats.winRate, 0);
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.bestStreak, 0);
});

test('consecutive wins build a streak, and a gap ends it', () => {
  const s = 'streak-basic';
  record(s, '2026-08-25', { won: true });
  record(s, '2026-08-26', { won: true });
  record(s, '2026-08-27', { won: true });

  const stats = statsFor(s, '2026-08-27', 'international');
  assert.equal(stats.played, 3);
  assert.equal(stats.won, 3);
  assert.equal(stats.winRate, 100);
  assert.equal(stats.currentStreak, 3);
  assert.equal(stats.bestStreak, 3);
});

test('today being unplayed does not break the streak', () => {
  const s = 'streak-pending';
  record(s, '2026-08-25', { won: true });
  record(s, '2026-08-26', { won: true });

  // Today has not been played at all — yesterday's win should still stand.
  const stats = statsFor(s, '2026-08-27', 'international');
  assert.equal(stats.currentStreak, 2);
});

test('losing today breaks the streak', () => {
  const s = 'streak-lost-today';
  record(s, '2026-08-26', { won: true });
  record(s, '2026-08-27', { won: false, used: MAX_GUESSES });

  const stats = statsFor(s, '2026-08-27', 'international');
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.bestStreak, 1);
});

test('best streak remembers a longer earlier run', () => {
  const s = 'streak-best';
  for (const d of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) record(s, d, { won: true });
  record(s, '2026-08-05', { won: false, used: MAX_GUESSES });
  record(s, '2026-08-27', { won: true });

  const stats = statsFor(s, '2026-08-27', 'international');
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.bestStreak, 4);
});

test('the distribution counts wins by guesses used', () => {
  const s = 'distribution';
  record(s, '2026-08-20', { won: true, used: 1 });
  record(s, '2026-08-21', { won: true, used: 3 });
  record(s, '2026-08-22', { won: true, used: 3 });
  record(s, '2026-08-23', { won: false, used: MAX_GUESSES });

  const stats = statsFor(s, '2026-08-27', 'international');
  assert.equal(stats.distribution[1], 1);
  assert.equal(stats.distribution[3], 2);
  // A loss is played but is not in the distribution, which only counts wins.
  assert.equal(stats.played, 4);
  assert.equal(stats.won, 3);
  assert.equal(stats.winRate, 75);
});

test('the two games keep separate records for the same visitor', () => {
  const s = 'two-games';
  record(s, '2026-08-26', { won: true, category: 'international' });
  record(s, '2026-08-27', { won: true, category: 'international' });
  record(s, '2026-08-27', { won: false, used: MAX_GUESSES, category: 'premier-league' });

  const intl = statsFor(s, '2026-08-27', 'international');
  const pl = statsFor(s, '2026-08-27', 'premier-league');

  assert.equal(intl.played, 2);
  assert.equal(intl.currentStreak, 2);
  assert.equal(pl.played, 1);
  assert.equal(pl.currentStreak, 0);
});

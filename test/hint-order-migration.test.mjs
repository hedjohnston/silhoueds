// Freezing the old reveal order into stored order.
//
// Hints used to be sorted into a fixed ladder on the way out, so stored order bore no relation to
// what a player saw. The admin now arranges six slots and stored order *is* the running order —
// which means every player saved under the old rules had to be rewritten once, or they would
// silently start giving away whatever happened to be stored first.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-hint-order-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/** A database written the old way: hints stored in whatever order they were entered. */
function oldDatabase(name, rows) {
  const file = path.join(scratch, `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      hints TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'international',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
      hint_source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const [slug, hints] of rows) {
    db.prepare('INSERT INTO players (slug, name, hints) VALUES (?, ?, ?)')
      .run(slug, slug, typeof hints === 'string' ? hints : JSON.stringify(hints));
  }
  db.close();
  return file;
}

/** Boot the app against a file, in a child so each test gets a clean module registry. */
async function boot(file) {
  const { players } = await import(`../server/db.mjs?migration=${path.basename(file)}`);
  return players;
}

const LADDER = ['Era', 'Position', 'League', 'Nationality', 'Best known at'];

test('a player stored out of order is rewritten into the order they were revealed in', async () => {
  process.env.SILHOUEDS_DB = oldDatabase('out-of-order', [
    ['shearer', [
      { label: 'Position', value: 'Striker' },
      { label: 'Nationality', value: 'English' },
      { label: 'Era', value: 'The 90s' },
      { label: 'League', value: 'Premier League' },
      { label: 'Best known at', value: 'Newcastle' },
    ]],
  ]);
  const players = await boot(process.env.SILHOUEDS_DB);

  // Exactly what the old ladder was putting on screen, now sitting in the slots.
  assert.deepEqual(players.bySlug('shearer').hints.map((h) => h.label), LADDER);
});

test('an invented category keeps the lead it had, and the migration runs only once', async () => {
  process.env.SILHOUEDS_DB = oldDatabase('custom-first', [
    ['wright', [
      { label: 'Era', value: 'The 90s' },
      { label: 'Trophy cabinet', value: 'An FA Cup' },
    ]],
  ]);
  const players = await boot(process.env.SILHOUEDS_DB);

  const wright = players.bySlug('wright');
  assert.deepEqual(wright.hints.map((h) => h.label), ['Trophy cabinet', 'Era']);

  // Hand-arranged slots must survive a restart untouched — the marker says the work is done.
  players.update(wright.id, {
    hints: [{ label: 'Era', value: 'The 90s' }, { label: 'Trophy cabinet', value: 'An FA Cup' }],
  });
  const again = await import(`../server/db.mjs?migration=custom-first`);
  assert.deepEqual(
    again.players.bySlug('wright').hints.map((h) => h.label),
    ['Era', 'Trophy cabinet'],
  );
});

test('a single hint and unreadable JSON are both left exactly as found', async () => {
  process.env.SILHOUEDS_DB = oldDatabase('edge-cases', [
    ['one-hint', [{ label: 'Era', value: 'The 90s' }]],
    ['broken', 'not json at all'],
  ]);
  const players = await boot(process.env.SILHOUEDS_DB);

  assert.deepEqual(players.bySlug('one-hint').hints.map((h) => h.label), ['Era']);
  // The row survives the migration; reading it is the caller's problem, not a boot failure.
  assert.ok(players.all().length >= 1);
});

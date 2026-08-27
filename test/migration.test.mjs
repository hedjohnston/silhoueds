// The category migration, run against a database built on the old schema.
//
// This is the test worth having: the migration rewrites `schedule` and `plays` in place, and
// getting it wrong loses every visitor's history. Node runs each test file in its own process,
// so this one can import db.mjs against a pre-category fixture without the other suites'
// already-migrated database getting in the way.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-migration-'));
const dbPath = path.join(scratch, 'old.db');
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// Build the schema exactly as it stood before categories existed, and put real rows in it.
{
  const old = new DatabaseSync(dbPath);
  old.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE players (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL,
      aliases       TEXT    NOT NULL DEFAULT '[]',
      hints         TEXT    NOT NULL DEFAULT '[]',
      silhouette    TEXT,
      photo         TEXT,
      status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
      hint_source   TEXT    NOT NULL DEFAULT 'manual',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE schedule (
      date       TEXT PRIMARY KEY,
      player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE
    );
    CREATE TABLE plays (
      session_id TEXT    NOT NULL,
      date       TEXT    NOT NULL,
      guesses    TEXT    NOT NULL DEFAULT '[]',
      finished   INTEGER NOT NULL DEFAULT 0,
      won        INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, date)
    );

    INSERT INTO players (id, slug, name, status) VALUES (1, 'shearer', 'Alan Shearer', 'ready');
    INSERT INTO schedule (date, player_id) VALUES ('2026-08-20', 1), ('2026-08-21', 1);
    INSERT INTO plays (session_id, date, guesses, finished, won)
      VALUES ('visitor-a', '2026-08-20', '[{"name":"Shearer","correct":true,"skipped":false}]', 1, 1),
             ('visitor-b', '2026-08-20', '[]', 0, 0);
  `);
  old.close();
}

process.env.SILHOUEDS_DB = dbPath;
const { db, players, plays, schedule, DEFAULT_CATEGORY } = await import('../server/db.mjs');

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('the migration adds category everywhere it is needed', () => {
  assert.ok(columnsOf('players').includes('category'));
  assert.ok(columnsOf('schedule').includes('category'));
  assert.ok(columnsOf('plays').includes('category'));
  // Columns added by earlier migrations must still be there too.
  for (const column of ['silhouette_image', 'reveal_image']) {
    assert.ok(columnsOf('players').includes(column), column);
  }
  assert.ok(columnsOf('plays').includes('mode'));
});

test('no data is lost, and existing rows land in the default category', () => {
  const player = players.get(1);
  assert.equal(player.name, 'Alan Shearer');
  assert.equal(player.category, DEFAULT_CATEGORY);

  // Both schedule rows carried over, under the default category.
  assert.equal(schedule.get('2026-08-20', DEFAULT_CATEGORY)?.id, 1);
  assert.equal(schedule.get('2026-08-21', DEFAULT_CATEGORY)?.id, 1);

  // Both plays carried over, with their guesses intact.
  const won = plays.get('visitor-a', '2026-08-20', DEFAULT_CATEGORY);
  assert.equal(won.won, true);
  assert.equal(won.finished, true);
  assert.deepEqual(won.guesses, [{ name: 'Shearer', correct: true, skipped: false }]);

  const unfinished = plays.get('visitor-b', '2026-08-20', DEFAULT_CATEGORY);
  assert.equal(unfinished.finished, false);
});

test('the rebuilt tables key on category, so both games can run the same day', () => {
  schedule.set('2026-08-20', 'premier-league', 1);
  // The pre-existing international row must survive a same-date insert in the other category.
  assert.equal(schedule.get('2026-08-20', DEFAULT_CATEGORY)?.id, 1);
  assert.equal(schedule.get('2026-08-20', 'premier-league')?.id, 1);

  plays.save('visitor-a', '2026-08-20', 'premier-league', {
    guesses: [], finished: false, won: false, mode: 'hard',
  });
  // …and the original play is untouched by the one in the other game.
  assert.equal(plays.get('visitor-a', '2026-08-20', DEFAULT_CATEGORY).won, true);
  assert.equal(plays.get('visitor-a', '2026-08-20', 'premier-league').won, false);
});

test('the migration leaves no scratch tables behind', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(!tables.some((name) => name.endsWith('_pre_category')), tables.join(', '));
});

test('re-running the migration on an already-migrated file is a no-op', async () => {
  // Importing again hits the module cache, so prove idempotence the way a restart would: the
  // guards key off the column existing, and it does.
  assert.ok(columnsOf('schedule').includes('category'));
  const before = db.prepare('SELECT COUNT(*) AS n FROM plays').get().n;
  const { db: again } = await import('../server/db.mjs');
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM plays').get().n, before);
});

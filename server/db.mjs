// SQLite storage. Uses node:sqlite (built into Node 22.5+) so there is no native module to
// compile — the whole app installs with plain `npm install`.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { inLadderOrder } from './hints.mjs';

export const DB_PATH = process.env.SILHOUEDS_DB ?? 'data/silhoueds.db';

// Two independent daily games share this database, distinguished only by this tag. `international`
// is shown as "The Rest" — a display label only, so the rename cost no migration.
export const CATEGORIES = ['premier-league', 'international'];
export const DEFAULT_CATEGORY = 'international';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS players (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    slug             TEXT    NOT NULL UNIQUE,
    name             TEXT    NOT NULL,
    aliases          TEXT    NOT NULL DEFAULT '[]',   -- JSON array of accepted spellings
    hints            TEXT    NOT NULL DEFAULT '[]',   -- JSON array of {label, value}
    silhouette       TEXT,                            -- SVG markup, when traced by hand
    silhouette_image TEXT,                            -- uploaded silhouette artwork filename
    photo            TEXT,                            -- uploaded reference photo filename
    reveal_image     TEXT,                            -- full photo, shown once the round is over
    video_id         TEXT,                            -- YouTube video id, shown once the round is over
    category         TEXT    NOT NULL DEFAULT '${DEFAULT_CATEGORY}',
    status           TEXT    NOT NULL DEFAULT 'draft' -- draft | ready
                             CHECK (status IN ('draft', 'ready')),
    hint_source      TEXT    NOT NULL DEFAULT 'manual',
    -- Retired from the pool: kept for the archive of past rounds, out of the way everywhere else.
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Which player runs on which date, in which game. Filled ahead of time by the admin, or
  -- auto-assigned on demand from the pool of ready players. The date is in SILHOUEDS_TIMEZONE
  -- (or the visitor's own zone), not UTC.
  CREATE TABLE IF NOT EXISTS schedule (
    date       TEXT    NOT NULL,          -- YYYY-MM-DD
    category   TEXT    NOT NULL DEFAULT '${DEFAULT_CATEGORY}',
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    PRIMARY KEY (date, category)
  );

  -- One row per visitor per day per game. Progress lives server-side so the client never holds
  -- the answer.
  CREATE TABLE IF NOT EXISTS plays (
    session_id TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT '${DEFAULT_CATEGORY}',
    guesses    TEXT    NOT NULL DEFAULT '[]',  -- JSON array of {name, correct, skipped}
    finished   INTEGER NOT NULL DEFAULT 0,
    won        INTEGER NOT NULL DEFAULT 0,
    mode       TEXT    NOT NULL DEFAULT 'hard',
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, date, category)
  );

  CREATE INDEX IF NOT EXISTS plays_by_date ON plays(date);

  -- A Google account, linked the first time someone signs in. Anonymous play never touches this
  -- table — session_id in \`plays\` stays a bare opaque string either way; a signed-in player is
  -- just one whose session_id happens to be "user:<id>" instead of a random uuid.
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT    NOT NULL UNIQUE,
    email      TEXT    NOT NULL DEFAULT '',
    name       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

// Additive migrations: new columns are appended to existing databases in place. A fresh install
// already has these from the CREATE TABLE above, so none of the migrations below run for it.
for (const [name, definition] of [
  ['silhouette_image', 'TEXT'],  // uploaded silhouette artwork filename
  ['reveal_image', 'TEXT'],      // full photo, shown once the round is over
  // Everyone seeded before categories existed played as international stars, not Premier
  // League specialists, so that is the default the migration gives them.
  ['category', `TEXT NOT NULL DEFAULT '${DEFAULT_CATEGORY}'`],
  // Nobody is archived until someone says so, so every existing player carries forward live.
  ['archived', 'INTEGER NOT NULL DEFAULT 0'],
  ['video_id', 'TEXT'],          // YouTube video id, shown once the round is over
]) {
  if (!hasColumn('players', name)) db.exec(`ALTER TABLE players ADD COLUMN ${name} ${definition}`);
}

// Difficulty belongs to the round, not the browser, so it lives on the play.
if (!hasColumn('plays', 'mode')) {
  db.exec("ALTER TABLE plays ADD COLUMN mode TEXT NOT NULL DEFAULT 'hard'");
}

/**
 * Run a table rebuild as one unit, so a crash can't leave the database half-migrated.
 *
 * Each of these renames the old table aside, creates the new shape, copies the rows across and
 * drops the original. Without a transaction every statement autocommits: a machine killed partway
 * through would come back with the new empty table in place — which satisfies the guard above, so
 * the next boot skips the migration and the copied-aside rows are stranded for good. Losing the
 * `plays` table that way costs every visitor their history, so it is worth the extra care.
 *
 * A failure rolls back to the original table and rethrows, which stops the server from booting on
 * a database it could not migrate — far better than serving a half-built one.
 */
function migrate(name, statements) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(statements);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Migration "${name}" failed and was rolled back: ${error.message}`, { cause: error });
  }
}

// Premier League and The Rest are separate daily games, so `schedule` and `plays` both need
// `category` folded into their primary key. SQLite can't alter a primary key in place, hence the
// rebuild. Only databases created before categories existed reach these — a fresh install already
// has the right shape from the CREATE TABLE above. Existing rows carry forward as
// DEFAULT_CATEGORY, which is exactly what already-playing visitors were doing.
if (!hasColumn('schedule', 'category')) {
  migrate('schedule.category', `
    ALTER TABLE schedule RENAME TO schedule_pre_category;
    CREATE TABLE schedule (
      date       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT '${DEFAULT_CATEGORY}',
      player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      PRIMARY KEY (date, category)
    );
    INSERT INTO schedule (date, category, player_id)
      SELECT date, '${DEFAULT_CATEGORY}', player_id FROM schedule_pre_category;
    DROP TABLE schedule_pre_category;
  `);
}

if (!hasColumn('plays', 'category')) {
  migrate('plays.category', `
    ALTER TABLE plays RENAME TO plays_pre_category;
    CREATE TABLE plays (
      session_id TEXT    NOT NULL,
      date       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT '${DEFAULT_CATEGORY}',
      guesses    TEXT    NOT NULL DEFAULT '[]',
      finished   INTEGER NOT NULL DEFAULT 0,
      won        INTEGER NOT NULL DEFAULT 0,
      mode       TEXT    NOT NULL DEFAULT 'hard',
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, date, category)
    );
    INSERT INTO plays (session_id, date, category, guesses, finished, won, mode, updated_at)
      SELECT session_id, date, '${DEFAULT_CATEGORY}', guesses, finished, won, mode, updated_at
      FROM plays_pre_category;
    DROP TABLE plays_pre_category;
    CREATE INDEX IF NOT EXISTS plays_by_date ON plays(date);
  `);
}

/**
 * Freeze the old reveal order into stored order, once.
 *
 * Hints used to be sorted into a fixed ladder on the way out, so what was stored bore no relation
 * to what a player saw — a footballer saved as "Position, Nationality, Era" was revealed as "Era,
 * Position, Nationality". The admin now arranges six slots and stored order *is* the running
 * order, so without this every existing player would silently start giving their nationality away
 * on the first wrong guess.
 *
 * `user_version` marks it done, so it runs once and never touches hand-arranged slots afterwards.
 */
const HINT_ORDER_VERSION = 1;

function freezeHintOrder() {
  const rows = db.prepare('SELECT id, hints FROM players').all();
  const update = db.prepare('UPDATE players SET hints = ? WHERE id = ?');
  for (const row of rows) {
    let hints;
    try {
      hints = JSON.parse(row.hints);
    } catch {
      continue;  // Unreadable JSON is left exactly as found rather than replaced with a guess.
    }
    if (!Array.isArray(hints) || hints.length < 2) continue;
    const ordered = inLadderOrder(hints);
    if (ordered.some((hint, i) => hint !== hints[i])) update.run(JSON.stringify(ordered), row.id);
  }
  db.exec(`PRAGMA user_version = ${HINT_ORDER_VERSION}`);
}

// Row-by-row JSON work rather than one statement, so it runs inside the transaction by hand.
if (db.prepare('PRAGMA user_version').get().user_version < HINT_ORDER_VERSION) {
  db.exec('BEGIN IMMEDIATE');
  try {
    freezeHintOrder();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Migration "hints.storedOrder" failed and was rolled back: ${error.message}`, { cause: error });
  }
}

/**
 * These two columns hold JSON we wrote ourselves, so they parse — until one doesn't, through a
 * hand-edited database or a bad disk. Unguarded, a single unreadable row took the whole admin
 * player list down with a 500, leaving no way in to fix it. Degrading to empty shows the player as
 * a draft needing hints, which is visible, editable, and recoverable.
 */
const readJson = (text, fallback) => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

const parse = (row) =>
  row && {
    ...row,
    aliases: readJson(row.aliases, []),
    hints: readJson(row.hints, []),
    status: row.status,
    archived: !!row.archived,
  };

export const players = {
  all() {
    return db.prepare('SELECT * FROM players ORDER BY created_at DESC').all().map(parse);
  },
  get(id) {
    return parse(db.prepare('SELECT * FROM players WHERE id = ?').get(id));
  },
  bySlug(slug) {
    return parse(db.prepare('SELECT * FROM players WHERE slug = ?').get(slug));
  },
  /**
   * The pool a day can be filled from. Archived players are excluded: they have had their run,
   * and the whole point of archiving is that auto-assignment stops coming back to them.
   */
  ready(category) {
    return category
      ? db
          .prepare("SELECT * FROM players WHERE status = 'ready' AND archived = 0 AND category = ? ORDER BY id")
          .all(category)
          .map(parse)
      : db
          .prepare("SELECT * FROM players WHERE status = 'ready' AND archived = 0 ORDER BY id")
          .all()
          .map(parse);
  },
  /** Every image filename a player owns, for cleaning up on delete or replace. */
  images(player) {
    return [player.photo, player.silhouette_image, player.reveal_image].filter(Boolean);
  },
  create({
    slug, name, aliases = [], hints = [], silhouette = null, photo = null,
    silhouetteImage = null, revealImage = null, hintSource = 'manual', category = DEFAULT_CATEGORY,
  }) {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO players
           (slug, name, aliases, hints, silhouette, photo, silhouette_image, reveal_image, hint_source, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug, name, JSON.stringify(aliases), JSON.stringify(hints), silhouette, photo,
        silhouetteImage, revealImage, hintSource, category,
      );
    return this.get(lastInsertRowid);
  },
  update(id, fields) {
    const columns = {
      name: (v) => v,
      aliases: JSON.stringify,
      hints: JSON.stringify,
      silhouette: (v) => v,
      photo: (v) => v,
      silhouette_image: (v) => v,
      reveal_image: (v) => v,
      video_id: (v) => v,
      status: (v) => v,
      hint_source: (v) => v,
      category: (v) => v,
      archived: (v) => (v ? 1 : 0),
    };
    const sets = [];
    const values = [];
    for (const [key, encode] of Object.entries(columns)) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        values.push(encode(fields[key]));
      }
    }
    if (sets.length === 0) return this.get(id);
    db.prepare(`UPDATE players SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, id);
    return this.get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
  },
};

export const schedule = {
  get(date, category) {
    const row = db
      .prepare(
        'SELECT p.* FROM schedule s JOIN players p ON p.id = s.player_id WHERE s.date = ? AND s.category = ?',
      )
      .get(date, category);
    return parse(row);
  },
  set(date, category, playerId) {
    db.prepare(
      `INSERT INTO schedule (date, category, player_id) VALUES (?, ?, ?)
       ON CONFLICT(date, category) DO UPDATE SET player_id = excluded.player_id`,
    ).run(date, category, playerId);
  },
  clear(date, category) {
    db.prepare('DELETE FROM schedule WHERE date = ? AND category = ?').run(date, category);
  },
  /** Today onwards. `today` is passed in: SQLite's date('now') is always UTC. */
  upcoming(today, category, limit = 30) {
    return db
      .prepare(
        `SELECT s.date, p.id, p.name, p.slug FROM schedule s
         JOIN players p ON p.id = s.player_id
         WHERE s.date >= ? AND s.category = ? ORDER BY s.date LIMIT ?`,
      )
      .all(today, category, limit);
  },
  /** Past puzzles that actually ran, newest first — the archive. */
  past(today, category, limit = 60) {
    return db
      .prepare(
        `SELECT s.date FROM schedule s
         JOIN players p ON p.id = s.player_id
         WHERE s.date <= ? AND s.category = ? ORDER BY s.date DESC LIMIT ?`,
      )
      .all(today, category, limit)
      .map((row) => row.date);
  },
  /**
   * Dates already spoken for, so auto-assignment doesn't reuse a player still queued up.
   * The cutoff is passed in for the same reason as above.
   */
  scheduledPlayerIds(since, category) {
    return db
      .prepare('SELECT player_id FROM schedule WHERE date >= ? AND category = ?')
      .all(since, category)
      .map((r) => r.player_id);
  },
  /**
   * The last date each player is booked for, as `{ player_id, date }`. The admin shows it, and
   * uses it to tell a footballer who has already run from one still queued up ahead.
   */
  lastScheduled() {
    return db.prepare('SELECT player_id, MAX(date) AS date FROM schedule GROUP BY player_id').all();
  },
  /** Everyone whose day has already come and gone — the ones worth archiving in one go. */
  playedPlayerIds(today) {
    return db
      .prepare('SELECT DISTINCT player_id FROM schedule WHERE date <= ?')
      .all(today)
      .map((r) => r.player_id);
  },
  /** Every player ever scheduled, any date — the picker excludes these; a player is used once. */
  allScheduledPlayerIds() {
    return db
      .prepare('SELECT DISTINCT player_id FROM schedule')
      .all()
      .map((r) => r.player_id);
  },
};

export const plays = {
  get(sessionId, date, category) {
    const row = db
      .prepare('SELECT * FROM plays WHERE session_id = ? AND date = ? AND category = ?')
      .get(sessionId, date, category);
    return (
      row && {
        ...row,
        guesses: JSON.parse(row.guesses),
        finished: !!row.finished,
        won: !!row.won,
        mode: row.mode ?? 'hard',
      }
    );
  },
  save(sessionId, date, category, { guesses, finished, won, mode = 'hard' }) {
    db.prepare(
      `INSERT INTO plays (session_id, date, category, guesses, finished, won, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, date, category) DO UPDATE SET
         guesses = excluded.guesses, finished = excluded.finished,
         won = excluded.won, mode = excluded.mode, updated_at = datetime('now')`,
    ).run(sessionId, date, category, JSON.stringify(guesses), finished ? 1 : 0, won ? 1 : 0, mode);
  },
  /** Every finished round for one visitor, newest first — the raw material for stats. */
  history(sessionId, category) {
    return db
      .prepare(
        `SELECT date, won, guesses, mode FROM plays
         WHERE session_id = ? AND category = ? AND finished = 1
         ORDER BY date DESC`,
      )
      .all(sessionId, category)
      .map((row) => ({
        date: row.date,
        won: !!row.won,
        guesses: JSON.parse(row.guesses),
        mode: row.mode ?? 'hard',
      }));
  },
  /** Every round played on a date, for the admin's guess log. */
  forDate(date, category) {
    return db
      .prepare('SELECT * FROM plays WHERE date = ? AND category = ? ORDER BY updated_at')
      .all(date, category)
      .map((row) => ({
        session: row.session_id,
        guesses: JSON.parse(row.guesses),
        finished: !!row.finished,
        won: !!row.won,
        mode: row.mode ?? 'hard',
        updatedAt: row.updated_at,
      }));
  },
  /** Dates anyone has actually played, newest first. */
  playedDates(category, limit = 60) {
    return db
      .prepare(
        'SELECT date, COUNT(*) AS players FROM plays WHERE category = ? GROUP BY date ORDER BY date DESC LIMIT ?',
      )
      .all(category, limit);
  },
  stats(date, category) {
    return db
      .prepare(
        `SELECT COUNT(*) AS plays,
                SUM(won) AS wins,
                SUM(finished) AS finished
         FROM plays WHERE date = ? AND category = ?`,
      )
      .get(date, category);
  },
  /**
   * Re-key one visitor's history onto another session id — used when a browser signs in for the
   * first time and its anonymous history needs to move under the account.
   *
   * On a (date, category) the account already has a row for, the account's row wins and the
   * anonymous duplicate is dropped: that only happens when the same puzzle was played on two
   * different anonymous browsers before either ever signed in, which is rare enough that "which
   * one is more complete" isn't worth deciding.
   */
  claim(fromSessionId, toSessionId) {
    if (fromSessionId === toSessionId) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE plays SET session_id = ?
         WHERE session_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM plays p2
             WHERE p2.session_id = ? AND p2.date = plays.date AND p2.category = plays.category
           )`,
      ).run(toSessionId, fromSessionId, toSessionId);
      // Whatever's left under the old id collided with a row the account already had.
      db.prepare('DELETE FROM plays WHERE session_id = ?').run(fromSessionId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Claim from ${fromSessionId} to ${toSessionId} failed and was rolled back: ${error.message}`,
        { cause: error },
      );
    }
  },
  /** Every play a session owns, gone — the counterpart to deleting the account itself. */
  deleteForSession(sessionId) {
    db.prepare('DELETE FROM plays WHERE session_id = ?').run(sessionId);
  },
};

export const users = {
  get(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  },
  byGoogleSub(sub) {
    return db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) ?? null;
  },
  /** Creates the account on first sign-in, or refreshes the profile fields on every one after. */
  upsert({ sub, email, name }) {
    db.prepare(
      `INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET
         email = excluded.email, name = excluded.name, updated_at = datetime('now')`,
    ).run(sub, email ?? '', name ?? '');
    return this.byGoogleSub(sub);
  },
  all() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },
  remove(id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

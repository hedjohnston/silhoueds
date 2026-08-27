// SQLite storage. Uses node:sqlite (built into Node 22.5+) so there is no native module to
// compile — the whole app installs with plain `npm install`.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DB_PATH = process.env.SILHOUEDS_DB ?? 'data/silhoueds.db';

// Two independent daily games share this database, distinguished only by this tag.
export const CATEGORIES = ['premier-league', 'international'];
export const DEFAULT_CATEGORY = 'international';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS players (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    aliases       TEXT    NOT NULL DEFAULT '[]',   -- JSON array of accepted spellings
    hints         TEXT    NOT NULL DEFAULT '[]',   -- JSON array of {label, value}
    silhouette    TEXT,                            -- SVG markup, when traced or auto-generated
    photo         TEXT,                            -- uploaded reference photo filename
    status        TEXT    NOT NULL DEFAULT 'draft' -- draft | ready
                          CHECK (status IN ('draft', 'ready')),
    hint_source   TEXT    NOT NULL DEFAULT 'manual', -- manual | claude
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Which player runs on which date. Filled ahead of time by the admin, or auto-assigned
  -- on demand from the pool of ready players.
  CREATE TABLE IF NOT EXISTS schedule (
    date       TEXT PRIMARY KEY,          -- YYYY-MM-DD, UTC
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE
  );

  -- One row per visitor per day. Progress lives server-side so the client never holds the answer.
  CREATE TABLE IF NOT EXISTS plays (
    session_id TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    guesses    TEXT    NOT NULL DEFAULT '[]',  -- JSON array of {name, correct, skipped}
    finished   INTEGER NOT NULL DEFAULT 0,
    won        INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, date)
  );

  CREATE INDEX IF NOT EXISTS plays_by_date ON plays(date);
`);

// Additive migrations: new columns are appended to existing databases in place.
const columns = new Set(db.prepare('PRAGMA table_info(players)').all().map((c) => c.name));
for (const [name, definition] of [
  ['silhouette_image', 'TEXT'],  // uploaded silhouette artwork filename
  ['reveal_image', 'TEXT'],      // full photo, shown once the round is over
  // Everyone seeded before categories existed played as international stars, not Premier
  // League specialists, so that is the default the migration gives them.
  ['category', `TEXT NOT NULL DEFAULT '${DEFAULT_CATEGORY}'`],
]) {
  if (!columns.has(name)) db.exec(`ALTER TABLE players ADD COLUMN ${name} ${definition}`);
}

// Difficulty belongs to the round, not the browser, so it lives on the play.
const playColumns = new Set(db.prepare('PRAGMA table_info(plays)').all().map((c) => c.name));
if (!playColumns.has('mode')) {
  db.exec("ALTER TABLE plays ADD COLUMN mode TEXT NOT NULL DEFAULT 'hard'");
}

// Premier League and International are separate daily games, so `schedule` and `plays` both
// need `category` folded into their primary key. Sqlite can't alter a primary key in place, so
// this rebuilds each table the first time it finds one without the column — existing rows carry
// forward as DEFAULT_CATEGORY, which is exactly what already-playing visitors were doing.
if (!db.prepare('PRAGMA table_info(schedule)').all().some((c) => c.name === 'category')) {
  db.exec(`
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

if (!db.prepare('PRAGMA table_info(plays)').all().some((c) => c.name === 'category')) {
  db.exec(`
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

const parse = (row) =>
  row && {
    ...row,
    aliases: JSON.parse(row.aliases),
    hints: JSON.parse(row.hints),
    status: row.status,
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
  ready(category) {
    return category
      ? db
          .prepare("SELECT * FROM players WHERE status = 'ready' AND category = ? ORDER BY id")
          .all(category)
          .map(parse)
      : db.prepare("SELECT * FROM players WHERE status = 'ready' ORDER BY id").all().map(parse);
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
      status: (v) => v,
      hint_source: (v) => v,
      category: (v) => v,
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
};

// Server-side round logic. The client is told the silhouette, the hints it has earned, and
// whether each guess was right — never the answer, until the round is over.

import { players, schedule, plays } from './db.mjs';
import { matchesPlayer } from './matching.mjs';

export const MAX_GUESSES = 6;

export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Deterministic pick, so an unscheduled day still resolves the same way on every request. */
function autoAssign(date) {
  const pool = players.ready().filter((p) => p.silhouette);
  if (pool.length === 0) return null;

  // Prefer players not already queued on another date, so the schedule isn't undercut.
  const spoken = new Set(schedule.scheduledPlayerIds());
  const fresh = pool.filter((p) => !spoken.has(p.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const chosen = candidates[((day % candidates.length) + candidates.length) % candidates.length];
  schedule.set(date, chosen.id);
  return chosen;
}

export function playerForDate(date) {
  return schedule.get(date) ?? autoAssign(date);
}

/** Hints earned so far — one per wrong guess or skip. */
function revealedHints(player, guesses) {
  const misses = guesses.filter((g) => !g.correct).length;
  return player.hints.slice(0, Math.min(misses, player.hints.length));
}

/** What the browser is allowed to know about the current round. */
export function publicState(player, play) {
  const guesses = play?.guesses ?? [];
  const finished = play?.finished ?? false;
  return {
    date: play?.date,
    silhouette: player.silhouette,
    hints: revealedHints(player, guesses),
    guesses: guesses.map((g) => ({ name: g.name, correct: g.correct, skipped: g.skipped })),
    guessesLeft: MAX_GUESSES - guesses.length,
    maxGuesses: MAX_GUESSES,
    finished,
    won: play?.won ?? false,
    // The answer crosses the wire only once the round is over.
    answer: finished ? player.name : undefined,
  };
}

export function loadRound(sessionId, date = todayKey()) {
  const player = playerForDate(date);
  if (!player) return null;
  const play = plays.get(sessionId, date) ?? { date, guesses: [], finished: false, won: false };
  return { player, play };
}

/**
 * Apply one guess (or a skip) and persist it. Returns the new public state plus `spelling`,
 * which flags a match that only got through on fuzzy tolerance.
 */
export function submitGuess(sessionId, rawGuess, { skipped = false } = {}) {
  const date = todayKey();
  const round = loadRound(sessionId, date);
  if (!round) return null;

  const { player, play } = round;
  if (play.finished) return { ...publicState(player, play), unchanged: true };

  const name = String(rawGuess ?? '').trim().slice(0, 100);
  if (!skipped && !name) return { ...publicState(player, play), unchanged: true };

  const { matched, exact } = skipped ? { matched: false, exact: false } : matchesPlayer(name, player);
  play.guesses.push({ name: skipped ? '' : name, correct: matched, skipped });

  if (matched) {
    play.finished = true;
    play.won = true;
  } else if (play.guesses.length >= MAX_GUESSES) {
    play.finished = true;
    play.won = false;
  }

  plays.save(sessionId, date, play);
  return { ...publicState(player, { ...play, date }), spelling: matched && !exact };
}

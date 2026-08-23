// Server-side round logic. The client is told the silhouette, the hints it has earned, and
// whether each guess was right — never the answer, until the round is over.

import { players, schedule, plays } from './db.mjs';
import { matchesPlayer } from './matching.mjs';

export const MAX_GUESSES = 6;

// Fallback zone: used for the admin's own "today" and whenever a visitor's zone is unknown.
const DEFAULT_TIMEZONE = process.env.SILHOUEDS_TIMEZONE ?? 'UTC';

/**
 * The date key a puzzle is filed under, in the given zone.
 *
 * Players roll over at their own local midnight, so the zone comes from the browser. An unknown
 * or malformed zone falls back rather than throwing.
 */
export function todayKey(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  try {
    // en-CA formats as YYYY-MM-DD, which is the key format we want.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Does this player have artwork to show?
 *
 * Publishing and the day-picker both need this answer, and when they disagreed, players with
 * uploaded artwork were publishable but never selected. One definition, used by both.
 */
export function hasArtwork(player) {
  return Boolean(player?.silhouette_image || player?.silhouette);
}

/** Deterministic pick, so an unscheduled day still resolves the same way on every request. */
function autoAssign(date) {
  const pool = players.ready().filter(hasArtwork);
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

/**
 * Which day a request is allowed to play.
 *
 * Today always resolves. An earlier day resolves only if it actually ran — a past date is never
 * auto-assigned, or requesting arbitrary dates would quietly burn through the pool of players.
 * A future date never resolves, so the archive can't be used to read ahead.
 */
export function resolveRoundDate(requested, today) {
  if (!requested) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  if (requested > today) return null;
  if (requested === today) return today;
  return schedule.get(requested) ? requested : null;
}

export function playerForDate(date) {
  return schedule.get(date) ?? autoAssign(date);
}

/** The calendar day before `date` ("YYYY-MM-DD"), for walking a streak backwards. */
function previousDay(date) {
  const stamp = Date.parse(`${date}T00:00:00Z`) - 86400000;
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * A visitor's record, from their own finished rounds.
 *
 * The streak walks back a day at a time from today, so it stays consistent with the per-player
 * rollover: a day you didn't play breaks it, and today not being played yet does not.
 */
export function statsFor(sessionId, today) {
  const history = plays.history(sessionId);
  const played = history.length;
  const wins = history.filter((round) => round.won);

  const distribution = {};
  for (let n = 1; n <= MAX_GUESSES; n++) distribution[n] = 0;
  for (const round of wins) {
    const used = round.guesses.length;
    if (distribution[used] !== undefined) distribution[used]++;
  }

  const wonDates = new Set(wins.map((round) => round.date));
  const playedDates = new Set(history.map((round) => round.date));

  // Today only breaks the streak once it has actually been played and lost.
  let cursor = playedDates.has(today) ? today : previousDay(today);
  let currentStreak = 0;
  while (wonDates.has(cursor)) {
    currentStreak++;
    cursor = previousDay(cursor);
  }

  let bestStreak = 0;
  let run = 0;
  const ascending = [...wonDates].sort();
  let expected = null;
  for (const date of ascending) {
    run = expected === date ? run + 1 : 1;
    if (run > bestStreak) bestStreak = run;
    expected = nextDay(date);
  }

  return {
    played,
    won: wins.length,
    winRate: played === 0 ? 0 : Math.round((wins.length / played) * 100),
    currentStreak,
    bestStreak,
    distribution,
    maxGuesses: MAX_GUESSES,
  };
}

function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
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
    // Uploaded artwork is served through the API; a traced outline is inlined as SVG.
    silhouetteUrl: player.silhouette_image ? '/api/puzzle/silhouette' : null,
    silhouette: player.silhouette_image ? null : player.silhouette,
    // The reveal photo only becomes reachable once the round is over.
    revealUrl: finished && player.reveal_image ? '/api/puzzle/reveal' : null,
    hints: revealedHints(player, guesses),
    // How many exist in total, so the panel can show how much help is left.
    hintsTotal: player.hints.length,
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
export function submitGuess(sessionId, rawGuess, { skipped = false, timeZone, date: requested } = {}) {
  const date = resolveRoundDate(requested, todayKey(new Date(), timeZone));
  if (!date) return null;
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

// Server-side round logic. The client is told the silhouette, the hints it has earned, and
// whether each guess was right — never the answer, until the round is over.

import { players, schedule, plays, CATEGORIES, DEFAULT_CATEGORY } from './db.mjs';
import { matchesPlayer } from './matching.mjs';
import { playableHints } from './hints.mjs';

export { CATEGORIES, DEFAULT_CATEGORY };

/** A requested category, falling back to the default rather than throwing on anything unknown. */
export function normalizeCategory(requested) {
  return CATEGORIES.includes(requested) ? requested : DEFAULT_CATEGORY;
}

export const MAX_GUESSES = 6;

// Easy mode fills the silhouette in rather than sharpening a blur: the shape never changes, only
// what is inside it resolves. Step 0 is `brightness(0)`, which on an alpha cut-out photo is an
// exact ink silhouette — so easy mode opens looking identical to hard mode and diverges from
// there. Colour arrives late, because the kit is a real clue and should not be free.
//
// Indexed by misses, so the ladder is keyed to MAX_GUESSES rather than to how many hints the
// player happens to carry. The blur this replaced divided by the hint count, which meant anyone
// with four or fewer hints went fully sharp with guesses still in hand.
const FILL_STEPS = [
  { brightness: 0.0, contrast: 1.0, saturate: 0.0 },
  { brightness: 0.3, contrast: 2.2, saturate: 0.05 },
  { brightness: 0.46, contrast: 1.8, saturate: 0.15 },
  { brightness: 0.6, contrast: 1.5, saturate: 0.3 },
  { brightness: 0.72, contrast: 1.3, saturate: 0.5 },
  { brightness: 0.86, contrast: 1.12, saturate: 0.75 },
];

/** The unfiltered photograph, once there is nothing left to hold back. */
const FULL_FILL = { brightness: 1, contrast: 1, saturate: 1 };

export const MODES = ['hard', 'easy'];

// Fallback zone: used for the admin's own "today" and whenever a visitor's zone is unknown.
// Australian rather than UTC because that is where this is run from — with UTC the admin spent
// the ten hours Sydney is ahead reporting on yesterday's puzzle. An IANA name, not an offset,
// so daylight saving is handled for us. Override with SILHOUEDS_TIMEZONE.
const DEFAULT_TIMEZONE = process.env.SILHOUEDS_TIMEZONE ?? 'Australia/Sydney';

/** The calendar date in one zone. Throws on a zone Intl doesn't recognise. */
function keyIn(now, timeZone) {
  // en-CA formats as YYYY-MM-DD, which is the key format we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DAY_MS = 86400000;
const shiftKey = (key, days) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The date key a puzzle is filed under, in the given zone.
 *
 * Players roll over at their own local midnight, so the zone comes from the browser — which means
 * it is caller-controlled and has to be treated as a claim rather than a fact.
 *
 * Two guards:
 *
 * A zone Intl can't parse falls back to the configured default, not to UTC. The old fallback
 * meant a garbled zone quietly filed the round a day out from where a missing one would.
 *
 * The result is then clamped to within a day of the server's own date. Real zones span UTC-12 to
 * UTC+14, so no genuine visitor is ever more than one calendar day from the server and none of
 * them notice this. What it stops is a caller naming an extreme offset — Intl accepts them up to
 * ±18:00 — to reach a date no real zone is on yet. That matters because resolving a date also
 * auto-assigns its player, so reading ahead would both spoil the puzzle and permanently spend
 * someone out of the pool.
 */
export function todayKey(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  let server;
  try {
    server = keyIn(now, DEFAULT_TIMEZONE);
  } catch {
    // A misconfigured SILHOUEDS_TIMEZONE shouldn't take the game down.
    server = now.toISOString().slice(0, 10);
  }

  let key;
  try {
    key = keyIn(now, timeZone);
  } catch {
    return server;
  }

  if (key > shiftKey(server, 1)) return shiftKey(server, 1);
  if (key < shiftKey(server, -1)) return shiftKey(server, -1);
  return key;
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
function autoAssign(date, category) {
  const pool = players.ready(category).filter(hasArtwork);
  if (pool.length === 0) return null;

  // Prefer players not already queued on another date, so the schedule isn't undercut.
  const yearAgo = new Date(Date.parse(`${date}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  const spoken = new Set(schedule.scheduledPlayerIds(yearAgo, category));
  const fresh = pool.filter((p) => !spoken.has(p.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const chosen = candidates[((day % candidates.length) + candidates.length) % candidates.length];
  schedule.set(date, category, chosen.id);
  return chosen;
}

/**
 * Which day a request is allowed to play.
 *
 * Today always resolves. An earlier day resolves only if it actually ran — a past date is never
 * auto-assigned, or requesting arbitrary dates would quietly burn through the pool of players.
 * A future date never resolves, so the archive can't be used to read ahead.
 */
export function resolveRoundDate(requested, today, category) {
  if (!requested) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  if (requested > today) return null;
  if (requested === today) return today;
  return schedule.get(requested, category) ? requested : null;
}

export function playerForDate(date, category) {
  return schedule.get(date, category) ?? autoAssign(date, category);
}

/** The calendar day before `date` ("YYYY-MM-DD"), for walking a streak backwards. */
function previousDay(date) {
  const stamp = Date.parse(`${date}T00:00:00Z`) - 86400000;
  return new Date(stamp).toISOString().slice(0, 10);
}

/** Played, won, win rate and the guess distribution over one set of finished rounds. */
function tally(rounds) {
  const wins = rounds.filter((round) => round.won);

  const distribution = {};
  for (let n = 1; n <= MAX_GUESSES; n++) distribution[n] = 0;
  for (const round of wins) {
    const used = round.guesses.length;
    if (distribution[used] !== undefined) distribution[used]++;
  }

  return {
    played: rounds.length,
    won: wins.length,
    winRate: rounds.length === 0 ? 0 : Math.round((wins.length / rounds.length) * 100),
    distribution,
  };
}

/**
 * A visitor's record, from their own finished rounds.
 *
 * The streak walks back a day at a time from today, so it stays consistent with the per-player
 * rollover: a day you didn't play breaks it, and today not being played yet does not.
 *
 * The streak deliberately spans both modes. Splitting it would punish the player who sizes up
 * today's silhouette and picks a mode accordingly, which is exactly the engagement worth having —
 * so the difficulty shows up in `byMode` and `hardWins` instead, where choosing hard is visibly
 * worth something without the easy day costing you a run.
 */
export function statsFor(sessionId, today, category) {
  const history = plays.history(sessionId, category);
  const overall = tally(history);
  const wins = history.filter((round) => round.won);

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
    ...overall,
    currentStreak,
    bestStreak,
    maxGuesses: MAX_GUESSES,
    byMode: {
      hard: tally(history.filter((round) => round.mode !== 'easy')),
      easy: tally(history.filter((round) => round.mode === 'easy')),
    },
    hardWins: wins.filter((round) => round.mode !== 'easy').length,
  };
}

function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/**
 * Hints earned so far — one per wrong guess or skip, in both modes. Easy mode used to hand over
 * the whole ladder at once on the grounds that the photo was already revealing progressively; that
 * made easy mode two assists rather than one, and left hard mode offering the same reward for
 * strictly less information. The modes now differ on one axis only — whether the silhouette fills
 * in — and share this ladder. Once the round is over, hidden hints have nothing left to protect: a
 * win on the second guess should still show what the other four would have given away, not leave
 * the panel looking unfinished.
 *
 * `playableHints` rather than the stored order: players saved before the ladder changed still hold
 * the old sequence, the admin allows hand editing, and a category the player's game has no use for
 * (the league of a Premier League player) is dropped rather than revealed.
 */
function revealedHints(player, guesses, finished) {
  const ordered = playableHints(player);
  if (finished) return ordered;
  const misses = guesses.filter((g) => !g.correct).length;
  return ordered.slice(0, Math.min(misses, ordered.length));
}

/**
 * How far the silhouette has filled in, given how many guesses (or skips) have been spent.
 *
 * A sixth miss ends the round, so a live round never reaches past the last step — the figure is
 * never fully resolved while there is still something to guess at.
 */
function fillFor(guesses, finished) {
  if (finished) return FULL_FILL;
  const misses = guesses.filter((g) => !g.correct).length;
  return FILL_STEPS[Math.min(misses, FILL_STEPS.length - 1)];
}

/** What the browser is allowed to know about the current round. */
export function publicState(player, play) {
  const guesses = play?.guesses ?? [];
  const finished = play?.finished ?? false;
  const mode = play?.mode ?? 'hard';
  // Easy mode needs the full photo; the admin makes it optional, so it may not exist.
  const easyAvailable = Boolean(player.reveal_image);
  const easy = mode === 'easy' && easyAvailable;
  return {
    mode: easy ? 'easy' : 'hard',
    easyAvailable,
    // In easy mode the photo stands in for the silhouette from the start, filtered down to a
    // flat ink shape and resolving from there.
    photoUrl: easy && !finished ? '/api/puzzle/reveal' : null,
    fill: easy ? fillFor(guesses, finished) : null,
    date: play?.date,
    category: player.category,
    // Uploaded artwork is served through the API; a traced outline is inlined as SVG.
    silhouetteUrl: player.silhouette_image ? '/api/puzzle/silhouette' : null,
    silhouette: player.silhouette_image ? null : player.silhouette,
    // The reveal photo only becomes reachable once the round is over.
    revealUrl: finished && player.reveal_image ? '/api/puzzle/reveal' : null,
    hints: revealedHints(player, guesses, finished),
    // How many exist in total, so the panel can show how much help is left.
    hintsTotal: playableHints(player).length,
    guesses: guesses.map((g) => ({ name: g.name, correct: g.correct, skipped: g.skipped })),
    guessesLeft: MAX_GUESSES - guesses.length,
    maxGuesses: MAX_GUESSES,
    finished,
    won: play?.won ?? false,
    // The answer crosses the wire only once the round is over.
    answer: finished ? player.name : undefined,
  };
}

export function loadRound(sessionId, date = todayKey(), category = DEFAULT_CATEGORY) {
  const player = playerForDate(date, category);
  if (!player) return null;
  const play = plays.get(sessionId, date, category) ?? {
    date,
    guesses: [],
    finished: false,
    won: false,
    mode: 'hard',
  };
  return { player, play };
}

/**
 * Choose the difficulty for a round.
 *
 * Refused once a guess exists: a round started hard and finished easy would quietly make scores
 * mean different things. Easy also needs a full photo to reveal, so it is refused without one.
 */
export function setMode(sessionId, date, category, requested) {
  const round = loadRound(sessionId, date, category);
  if (!round) return null;

  const { player, play } = round;
  const wanted = MODES.includes(requested) ? requested : 'hard';
  const allowed =
    play.guesses.length === 0 && !play.finished && (wanted === 'hard' || player.reveal_image);

  if (allowed && wanted !== play.mode) {
    play.mode = wanted;
    plays.save(sessionId, date, category, play);
  }
  return { ...publicState(player, { ...play, date }), locked: play.guesses.length > 0 };
}

/**
 * Apply one guess (or a skip) and persist it. Returns the new public state plus `spelling`,
 * which flags a match that only got through on fuzzy tolerance.
 */
export function submitGuess(
  sessionId,
  rawGuess,
  { skipped = false, timeZone, date: requested, category = DEFAULT_CATEGORY } = {},
) {
  const date = resolveRoundDate(requested, todayKey(new Date(), timeZone), category);
  if (!date) return null;
  const round = loadRound(sessionId, date, category);
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

  plays.save(sessionId, date, category, play);
  return { ...publicState(player, { ...play, date }), spelling: matched && !exact };
}

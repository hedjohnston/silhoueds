// Date-seeded puzzle selection and per-day progress persistence.

const STORAGE_KEY = 'silhoueds:v1';
const MS_PER_DAY = 86400000;

/** The date key ("YYYY-MM-DD") a puzzle is keyed by. UTC, so the day flips everywhere at once. */
export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Whole days since the epoch for a "YYYY-MM-DD" key. */
function dayNumber(dateKey) {
  return Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / MS_PER_DAY);
}

/** Small deterministic PRNG, so a given seed always yields the same sequence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over [0..size), driven by `seed`. */
function shuffledIndices(size, seed) {
  const order = Array.from({ length: size }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Which player index a date maps to.
 *
 * Days are grouped into cycles of `poolSize`; each cycle is a fresh shuffle of the whole pool.
 * So the same date always gives the same player, and no player repeats until every other one
 * has been used.
 */
export function puzzleIndexForDate(dateKey, poolSize) {
  if (poolSize <= 0) throw new RangeError('poolSize must be positive');
  const day = dayNumber(dateKey);
  const cycle = Math.floor(day / poolSize);
  const offset = ((day % poolSize) + poolSize) % poolSize;
  return shuffledIndices(poolSize, cycle + 1)[offset];
}

/** The stored progress for `dateKey`, or a fresh blank state if there is none. */
export function loadProgress(dateKey) {
  const blank = { date: dateKey, guesses: [], finished: false, won: false };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || saved.date !== dateKey || !Array.isArray(saved.guesses)) return blank;
    return { ...blank, ...saved, guesses: saved.guesses };
  } catch {
    // Corrupt entry, or storage blocked (private window, cookies off) — start clean.
    return blank;
  }
}

export function saveProgress(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable; the game still plays, it just won't survive a reload.
  }
}

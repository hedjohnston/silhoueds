// Guess matching. With no dropdown, players type names freely — so matching has to forgive
// accents, punctuation, casing and small misspellings.

/** Fold a name to a comparable key: lowercase, accent-free, alphanumerics only. */
export function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Particles that belong to the surname rather than standing on their own.
 *
 * "de Gea" and "van Nistelrooy" are the names people type; "Gea" and "Nistelrooy" are not, and
 * offering them as accepted answers would be accepting something nobody would write.
 */
const PARTICLES = new Set([
  'de', 'del', 'della', 'di', 'da', 'das', 'dos', 'du', 'van', 'von', 'der', 'den', 'ter',
  'la', 'le', 'el', 'al', 'bin', 'ben', 'mc', 'mac', "o'", 'st',
]);

/**
 * The first and last name inside a full name, as answers to accept on their own.
 *
 * Filled into a new player's aliases so a guess of either half counts without anyone typing them
 * in. They are ordinary aliases once stored — editable and deletable in the admin, because the
 * right answer isn't always both: a first name shared by half the league is worth removing, and a
 * player known by one name only ("Ronaldinho") gets nothing here to remove in the first place.
 */
export function nameParts(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];

  // Walk back over any particles so the surname keeps them.
  let start = words.length - 1;
  while (start > 1 && PARTICLES.has(words[start - 1].toLowerCase().replace(/[^a-z']/g, ''))) {
    start--;
  }

  const parts = [words[0], words.slice(start).join(' ')];
  const full = normalize(name);
  const seen = new Set();
  return parts.filter((part) => {
    const key = normalize(part);
    if (!key || key === full || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Levenshtein distance, capped — we only care about small edit distances. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 4;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** How far off a guess may be before it stops counting — longer names earn more slack. */
function tolerance(length) {
  if (length <= 5) return 0;
  if (length <= 9) return 1;
  if (length <= 14) return 2;
  return 3;
}

/**
 * Does `guess` name this player? Compares against the full name and every alias, exactly first
 * and then within a length-scaled edit distance.
 *
 * Returns { matched, exact } — `exact` distinguishes a clean hit from a forgiven typo, so the
 * caller can tell the player their spelling was off.
 */
export function matchesPlayer(guess, { name, aliases = [] }) {
  const key = normalize(guess);
  if (!key) return { matched: false, exact: false };

  const candidates = [name, ...aliases].map(normalize).filter(Boolean);
  if (candidates.includes(key)) return { matched: true, exact: true };

  for (const candidate of candidates) {
    const allowed = tolerance(Math.max(key.length, candidate.length));
    if (allowed > 0 && editDistance(key, candidate) <= allowed) {
      return { matched: true, exact: false };
    }
  }
  return { matched: false, exact: false };
}

/**
 * How close a guess came, without the yes/no verdict.
 *
 * Used by the admin's guess log to spot near-misses: names that fell just outside the tolerance
 * and so cost someone the puzzle, which usually means an alias is missing. Shares `tolerance()`
 * with the matcher, so "just outside" always means the same thing in both places.
 */
export function closeness(guess, { name, aliases = [] }) {
  const key = normalize(guess);
  if (!key) return { matched: false, distance: Infinity, tolerance: 0 };

  const candidates = [name, ...aliases].map(normalize).filter(Boolean);
  let best = Infinity;
  let allowed = 0;
  let span = key.length;

  for (const candidate of candidates) {
    const distance = candidate === key ? 0 : editDistance(key, candidate);
    if (distance < best) {
      best = distance;
      span = Math.max(key.length, candidate.length);
      allowed = tolerance(span);
    }
  }

  return { matched: best <= allowed, distance: best, tolerance: allowed, length: span };
}

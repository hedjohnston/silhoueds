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

/**
 * Fold a name to how it sounds, roughly — the key that lets a bad speller through.
 *
 * Edit distance alone can't help the short names, because their tolerance is zero and has to be:
 * one edit is all that separates Pepe from Pele. But "Raoul" for Raul is not one letter of noise,
 * it is the same name written the way it sounds, and no amount of tolerance-widening tells those
 * two cases apart — the difference isn't how far the guess is, it's whether the distance lands on
 * a letter that changes the sound.
 *
 * So this throws away the spelling and keeps the sound: the letters people swap for each other
 * (ph/f, ck/k, z/s, w/v, y/i, hard and soft c), then runs of vowels down to their first — which
 * is what makes "raoul" and "raul" the same word — then doubled letters down to one, for
 * "Zidanne" and "Mohammed".
 *
 * Deliberately not a full phonetic algorithm. Every rule here is one that collapses a spelling
 * people actually produce; anything cleverer starts merging names that are merely similar, and
 * this game is full of those.
 */
export function soundKey(value) {
  let key = normalize(value);
  if (!key) return '';

  key = key
    .replace(/sch/g, 'sk')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/c([eiy])/g, 's$1')  // soft c, before the hard-c rule claims it
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i');

  return key
    .replace(/([aeiou])[aeiou]+/g, '$1')  // a run of vowels is one vowel sound
    .replace(/(.)\1+/g, '$1');            // and nobody hears a doubled letter
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
 * Do two names sound the same, allowing the usual slack on top?
 *
 * Sound keys are shorter than the names they come from — the vowel runs are gone — so the same
 * `tolerance()` is stricter here than it is on the spelling, which is the right way round: a
 * guess that has already been forgiven its vowels should not also be forgiven three consonants.
 * Identical keys pass at any length, since a distance of zero is inside a tolerance of zero.
 */
function soundsLike(a, b) {
  if (!a || !b) return false;
  const distance = a === b ? 0 : editDistance(a, b);
  return distance <= tolerance(Math.max(a.length, b.length));
}

/**
 * Does `guess` name this player? Compares against the full name and every alias, exactly first,
 * then within a length-scaled edit distance, then by sound.
 *
 * Returns { matched, exact } — `exact` distinguishes a clean hit from a forgiven typo, so the
 * caller can tell the player their spelling was off.
 */
export function matchesPlayer(guess, { name, aliases = [] }) {
  const key = normalize(guess);
  if (!key) return { matched: false, exact: false };

  const candidates = [name, ...aliases].map(normalize).filter(Boolean);
  if (candidates.includes(key)) return { matched: true, exact: true };

  const sound = soundKey(guess);
  for (const candidate of candidates) {
    const allowed = tolerance(Math.max(key.length, candidate.length));
    if (allowed > 0 && editDistance(key, candidate) <= allowed) {
      return { matched: true, exact: false };
    }
    if (soundsLike(sound, soundKey(candidate))) return { matched: true, exact: false };
  }
  return { matched: false, exact: false };
}

/**
 * How close a guess came, without the yes/no verdict.
 *
 * Used by the admin's guess log to spot near-misses: names that fell just outside the tolerance
 * and so cost someone the puzzle, which usually means an alias is missing. Shares `tolerance()`
 * and the sound test with the matcher, so "just outside" always means the same thing in both
 * places — anything the matcher now hears through is not a near miss, it is a win.
 *
 * `distance` stays the distance between the spellings. It is what the admin shows, and a guess
 * accepted by sound can still be a long way from the name as written.
 */
export function closeness(guess, { name, aliases = [] }) {
  const key = normalize(guess);
  if (!key) return { matched: false, distance: Infinity, tolerance: 0 };

  const candidates = [name, ...aliases].map(normalize).filter(Boolean);
  const sound = soundKey(guess);
  let best = Infinity;
  let allowed = 0;
  let span = key.length;
  let heard = false;

  for (const candidate of candidates) {
    const distance = candidate === key ? 0 : editDistance(key, candidate);
    if (distance < best) {
      best = distance;
      span = Math.max(key.length, candidate.length);
      allowed = tolerance(span);
    }
    if (soundsLike(sound, soundKey(candidate))) heard = true;
  }

  return { matched: heard || best <= allowed, distance: best, tolerance: allowed, length: span };
}

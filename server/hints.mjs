// The standard hint categories, offered in every slot in the admin alongside any invented there.
//
// This is a menu, not a running order: the admin arranges the six slots, and the order they are
// left in is the order they are revealed in. It was a fixed ladder until the slots became free
// choice, which is why `inLadderOrder` below still exists — see the note on it.
export const HINT_LABELS = ['Era', 'Position', 'League', 'Nationality', 'Best known at'];

/**
 * The most hints one player can carry.
 *
 * Hard mode releases one per wrong guess, and there are only MAX_GUESSES of those, so a seventh
 * could never be reached however the round went. Worse than useless: the panel counts hints off as
 * "2 of 9", advertising help that does not exist. `game.mjs` owns MAX_GUESSES and already imports
 * this module, so the number is stated here rather than imported back — a test holds the two
 * together so they cannot drift apart.
 */
export const MAX_HINTS = 6;

/**
 * Rungs a category has no use for.
 *
 * Every player in the Premier League game plays in the Premier League, so that hint tells you
 * nothing you didn't know from the tab you're on — it would burn a guess for free. It is dropped
 * from the ladder rather than left blank, and the admin offers a hint category of your own in its
 * place.
 */
const IRRELEVANT_LABELS = { 'premier-league': ['League'] };

const irrelevantTo = (category) => IRRELEVANT_LABELS[category] ?? [];

/** The ladder one category actually plays with. */
export function hintLabelsFor(category) {
  const dropped = irrelevantTo(category);
  return HINT_LABELS.filter((label) => !dropped.includes(label));
}

/**
 * The order hints used to be revealed in, before the admin got six free slots.
 *
 * This is history, kept for exactly one caller: the migration in `db.mjs` that rewrites stored
 * hints into this order once, so players saved under the old rules keep revealing what they always
 * revealed. Stored order is the running order now — nothing else should sort.
 */
export function inLadderOrder(hints = []) {
  const rank = (hint) => {
    const index = HINT_LABELS.indexOf(hint?.label);
    return index === -1 ? -1 : index;
  };
  return [...hints].sort((a, b) => rank(a) - rank(b));
}

/**
 * The hints a player actually plays with, in the order the admin arranged their slots.
 *
 * Stored order is the running order — the first one is released by the first wrong guess. Three
 * things are enforced here rather than trusted, because the database holds whatever was written
 * before today's rules existed: a category this game has no use for is dropped (a Premier League
 * player's league), a label repeated across two slots counts once, and the list stops at MAX_HINTS
 * since nothing past that can ever be reached.
 */
export function playableHints(player) {
  const dropped = irrelevantTo(player?.category);
  const seen = new Set();
  const hints = [];
  for (const hint of player?.hints ?? []) {
    if (!hint?.label || dropped.includes(hint.label) || seen.has(hint.label)) continue;
    seen.add(hint.label);
    hints.push(hint);
    if (hints.length === MAX_HINTS) break;
  }
  return hints;
}

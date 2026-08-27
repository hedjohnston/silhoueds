// The hint ladder, vaguest first — the sequence hints are revealed in.
//
// Era sits first because a span of years barely narrows the field, while a position splits it
// into a handful of groups. League then sits above Nationality for the same reason — a league
// spans many countries, while a nationality cuts the field to a short list and ends the puzzle
// too early.
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
 * Put a player's hints in ladder order.
 *
 * Players saved before the order changed still hold their hints in the old sequence, and the
 * admin lets them be edited by hand into any order at all, so the reveal sorts rather than
 * trusting what is stored.
 *
 * A hint category invented in the admin leads the ladder. It is written for one player rather
 * than drawn from a list every footballer answers, so it is the vaguest thing on offer to anyone
 * who doesn't already know the answer — which is exactly what the first rung is for. Several of
 * them keep the order they were entered in, since `sort` is stable and they all rank alike.
 */
export function inLadderOrder(hints = []) {
  const rank = (hint) => {
    const index = HINT_LABELS.indexOf(hint?.label);
    return index === -1 ? -1 : index;
  };
  return [...hints].sort((a, b) => rank(a) - rank(b));
}

/**
 * The hints a player actually plays with: their own, in ladder order, minus any rung their
 * category has no use for.
 *
 * The filter runs at reveal time rather than on save so a player who changes category — or one
 * stored before their category dropped a rung — is right immediately, without an edit.
 */
export function playableHints(player) {
  const dropped = irrelevantTo(player?.category);
  return inLadderOrder((player?.hints ?? []).filter((hint) => !dropped.includes(hint?.label)));
}

// The hint ladder, vaguest first.
//
// Order matters twice over: it is the sequence hints are revealed in, and the sequence Claude is
// asked to draft them in. It lives here rather than in claude.mjs so the game logic can know the
// order without pulling in the Anthropic SDK.
//
// Era sits first because a span of years barely narrows the field, while a position splits it
// into a handful of groups. League then sits above Nationality for the same reason — a league
// spans many countries, while a nationality cuts the field to a short list and ends the puzzle
// too early.
export const HINT_LABELS = ['Era', 'Position', 'League', 'Nationality', 'Best known at'];

/**
 * Put a player's hints in ladder order.
 *
 * Players saved before the order changed still hold their hints in the old sequence, and the
 * admin lets them be edited by hand into any order at all, so the reveal sorts rather than
 * trusting what is stored. Anything with an unrecognised label sorts to the end rather than
 * being dropped.
 */
export function inLadderOrder(hints = []) {
  const rank = (hint) => {
    const index = HINT_LABELS.indexOf(hint?.label);
    return index === -1 ? HINT_LABELS.length : index;
  };
  return [...hints].sort((a, b) => rank(a) - rank(b));
}

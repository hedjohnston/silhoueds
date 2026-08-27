// The hint ladder. Order is the whole point: it is the sequence hints are revealed in, and the
// reveal sorts by it rather than trusting stored order, because players saved before the ladder
// changed still hold the old sequence and the admin allows hand editing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_LABELS, MAX_HINTS, hintLabelsFor, inLadderOrder, playableHints } from '../server/hints.mjs';
import { MAX_GUESSES } from '../server/game.mjs';

const labelsOf = (hints) => inLadderOrder(hints).map((h) => h.label);

test('the standard categories are the menu every slot offers', () => {
  assert.deepEqual(HINT_LABELS, ['Era', 'Position', 'League', 'Nationality', 'Best known at']);
});

test('inLadderOrder still sorts, for the one migration that needs the old order', () => {
  const shuffled = [
    { label: 'Best known at', value: 'Newcastle' },
    { label: 'Era', value: 'The 90s' },
    { label: 'Nationality', value: 'English' },
    { label: 'Position', value: 'Striker' },
    { label: 'League', value: 'Premier League' },
  ];
  assert.deepEqual(labelsOf(shuffled), HINT_LABELS);
});

test('the slots are revealed in the order they were arranged, not sorted', () => {
  // The whole point of free slots: put nationality first and it goes first.
  const player = {
    category: 'international',
    hints: [
      { label: 'Nationality', value: 'English' },
      { label: 'Trophy cabinet', value: 'Two titles' },
      { label: 'Era', value: 'The 90s' },
    ],
  };
  assert.deepEqual(
    playableHints(player).map((h) => h.label),
    ['Nationality', 'Trophy cabinet', 'Era'],
  );
});

test('a category filled into two slots is revealed once, not twice', () => {
  const player = {
    category: 'international',
    hints: [
      { label: 'Era', value: 'The 90s' },
      { label: 'Era', value: 'The 80s' },
      { label: 'Position', value: 'Striker' },
    ],
  };
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Era', 'Position']);
});

test('nothing past the cap is revealed, however much is stored', () => {
  const hints = Array.from({ length: 9 }, (_, i) => ({ label: `Category ${i}`, value: `v${i}` }));
  assert.equal(playableHints({ category: 'international', hints }).length, MAX_HINTS);
});

test('sorting does not mutate the array it was given', () => {
  const hints = [{ label: 'Position', value: 'Striker' }, { label: 'Era', value: 'The 90s' }];
  const before = hints.map((h) => h.label);
  inLadderOrder(hints);
  assert.deepEqual(hints.map((h) => h.label), before);
});

test('empty and missing inputs are handled without throwing', () => {
  assert.deepEqual(inLadderOrder([]), []);
  assert.deepEqual(inLadderOrder(), []);
});

// --- category ladders ----------------------------------------------------

test('the Premier League ladder drops the League rung', () => {
  // Every player in that game is in that league, so the hint would cost a guess for nothing.
  assert.deepEqual(hintLabelsFor('premier-league'), ['Era', 'Position', 'Nationality', 'Best known at']);
});

test('the other game keeps the full ladder', () => {
  assert.deepEqual(hintLabelsFor('international'), HINT_LABELS);
  // An unknown category is given everything rather than silently losing rungs.
  assert.deepEqual(hintLabelsFor(undefined), HINT_LABELS);
});

test('a Premier League player never plays their stored League hint', () => {
  const player = {
    category: 'premier-league',
    hints: [
      { label: 'League', value: 'Premier League' },
      { label: 'Position', value: 'Striker' },
      { label: 'Era', value: 'The 90s' },
    ],
  };
  // Dropped at reveal time, so a player stored before the split is right without being re-saved.
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Position', 'Era']);
});

test('the same hints in the other game keep their League slot, where it was put', () => {
  const player = {
    category: 'international',
    hints: [
      { label: 'League', value: 'Serie A' },
      { label: 'Position', value: 'Striker' },
      { label: 'Era', value: 'The 90s' },
    ],
  };
  assert.deepEqual(playableHints(player).map((h) => h.label), ['League', 'Position', 'Era']);
});

test('a hint category of your own sits wherever it was slotted', () => {
  const player = {
    category: 'premier-league',
    hints: [
      { label: 'Era', value: 'The 90s' },
      { label: 'League', value: 'Premier League' },
      { label: 'Trophy cabinet', value: 'Two league titles' },
    ],
  };
  // The League slot is still dropped: that game has no use for it.
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Era', 'Trophy cabinet']);
});

test('a player with no hints or no category is handled without throwing', () => {
  assert.deepEqual(playableHints({ category: 'premier-league' }), []);
  assert.deepEqual(playableHints(null), []);
});


test('the hint cap matches the guess count, so no hint is unreachable', () => {
  // Hard mode releases one hint per wrong guess. If these drift apart, a player either carries
  // hints no round can reach or the ladder runs dry before the guesses do.
  assert.equal(MAX_HINTS, MAX_GUESSES);
});

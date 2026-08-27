// The hint ladder. Order is the whole point: it is the sequence hints are revealed in, and the
// reveal sorts by it rather than trusting stored order, because players saved before the ladder
// changed still hold the old sequence and the admin allows hand editing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_LABELS, hintLabelsFor, inLadderOrder, playableHints } from '../server/hints.mjs';

const labelsOf = (hints) => inLadderOrder(hints).map((h) => h.label);

test('the ladder runs vaguest first', () => {
  // Era barely narrows the field; nationality cuts it to a short list and ends the puzzle early.
  assert.deepEqual(HINT_LABELS, ['Era', 'Position', 'League', 'Nationality', 'Best known at']);
});

test('a shuffled set is sorted back into ladder order', () => {
  const shuffled = [
    { label: 'Best known at', value: 'Newcastle' },
    { label: 'Era', value: 'The 90s' },
    { label: 'Nationality', value: 'English' },
    { label: 'Position', value: 'Striker' },
    { label: 'League', value: 'Premier League' },
  ];
  assert.deepEqual(labelsOf(shuffled), HINT_LABELS);
});

test('an unrecognised label sorts to the end rather than being dropped', () => {
  const hints = [
    { label: 'Trophy cabinet', value: 'Premier League 1995' },
    { label: 'Era', value: 'The 90s' },
  ];
  assert.deepEqual(labelsOf(hints), ['Era', 'Trophy cabinet']);
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
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Era', 'Position']);
});

test('the same hints in the other game keep their League rung, in ladder order', () => {
  const player = {
    category: 'international',
    hints: [
      { label: 'League', value: 'Serie A' },
      { label: 'Position', value: 'Striker' },
      { label: 'Era', value: 'The 90s' },
    ],
  };
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Era', 'Position', 'League']);
});

test('a hint category of your own survives, and reveals last', () => {
  const player = {
    category: 'premier-league',
    hints: [
      { label: 'Trophy cabinet', value: 'Two league titles' },
      { label: 'League', value: 'Premier League' },
      { label: 'Era', value: 'The 90s' },
    ],
  };
  assert.deepEqual(playableHints(player).map((h) => h.label), ['Era', 'Trophy cabinet']);
});

test('a player with no hints or no category is handled without throwing', () => {
  assert.deepEqual(playableHints({ category: 'premier-league' }), []);
  assert.deepEqual(playableHints(null), []);
});

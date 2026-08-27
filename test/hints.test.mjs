// The hint ladder. Order is the whole point: it is the sequence hints are revealed in, and the
// reveal sorts by it rather than trusting stored order, because players saved before the ladder
// changed still hold the old sequence and the admin allows hand editing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_LABELS, inLadderOrder } from '../server/hints.mjs';

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

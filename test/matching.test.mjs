// Guess matching: the rules that decide whether someone got the puzzle right.
//
// These are the assertions the README makes about the matcher, plus the boundaries of the
// length-scaled tolerance — the place where "forgiving a typo" turns into "accepting a
// different player", which is the failure that actually costs someone a round.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, editDistance, matchesPlayer, closeness, nameParts, soundKey } from '../server/matching.mjs';

test('normalize folds accents, case and punctuation', () => {
  assert.equal(normalize('Zlatan Ibrahimović'), 'zlatanibrahimovic');
  assert.equal(normalize("N'Golo Kanté"), 'ngolokante');
  assert.equal(normalize('  Pelé  '), 'pele');
  assert.equal(normalize('Ødegaard'), 'degaard'); // Ø has no combining form to strip
  assert.equal(normalize(''), '');
  assert.equal(normalize('!!!'), '');
});

test('editDistance counts single edits', () => {
  assert.equal(editDistance('pele', 'pele'), 0);
  assert.equal(editDistance('pele', 'pel'), 1);   // deletion
  assert.equal(editDistance('pele', 'pelee'), 1); // insertion
  assert.equal(editDistance('pepe', 'pele'), 1);  // substitution
});

test('editDistance caps out at 4 rather than measuring far-apart strings', () => {
  // The cap is load-bearing: the admin near-miss heuristic treats 4 as "not close".
  assert.equal(editDistance('a', 'abcde'), 4);
  assert.equal(editDistance('ronaldo', 'x'), 4);
});

test('a name under six characters gets no tolerance at all', () => {
  // Pepe and Pele are one edit apart and both real players — forgiving that would hand out
  // wins for the wrong man. This is the README's own worked example.
  const pele = { name: 'Pele', aliases: [] };
  assert.deepEqual(matchesPlayer('Pepe', pele), { matched: false, exact: false });
  assert.deepEqual(matchesPlayer('Pele', pele), { matched: true, exact: true });
});

test('a long name forgives a small misspelling, and says it was forgiven', () => {
  const zlatan = { name: 'Zlatan Ibrahimovic', aliases: [] };
  assert.deepEqual(matchesPlayer('Zlatan Ibrahimovic', zlatan), { matched: true, exact: true });
  // Accent-only difference folds away in normalize, so it still counts as exact.
  assert.deepEqual(matchesPlayer('Zlatan Ibrahimović', zlatan), { matched: true, exact: true });
  // A real typo matches, but is flagged so the player can be told.
  assert.deepEqual(matchesPlayer('Zlatan Ibrahimovix', zlatan), { matched: true, exact: false });
});

test('tolerance widens at the documented length boundaries', () => {
  // <=5 → 0, <=9 → 1, <=14 → 2, else 3. Probed through the public matcher.
  const six = { name: 'abcdef', aliases: [] };           // length 6 → tolerance 1
  assert.equal(matchesPlayer('abcdeX', six).matched, true);
  assert.equal(matchesPlayer('abcXeX', six).matched, false);

  const ten = { name: 'abcdefghij', aliases: [] };       // length 10 → tolerance 2
  assert.equal(matchesPlayer('abcdefghXX', ten).matched, true);
  assert.equal(matchesPlayer('abcdefgXXX', ten).matched, false);

  const fifteen = { name: 'abcdefghijklmno', aliases: [] }; // length 15 → tolerance 3
  assert.equal(matchesPlayer('abcdefghijklXXX', fifteen).matched, true);
  assert.equal(matchesPlayer('abcdefghijkXXXX', fifteen).matched, false);
});

test('aliases match on their own terms, not the full name', () => {
  const player = { name: 'Cristiano Ronaldo', aliases: ['ronaldo', 'cr7'] };
  assert.deepEqual(matchesPlayer('CR7', player), { matched: true, exact: true });
  assert.deepEqual(matchesPlayer('Ronaldo', player), { matched: true, exact: true });
  // "cr7" is three characters, so it earns no slack — a near-miss on it must not pass.
  assert.equal(matchesPlayer('cr8', player).matched, false);
});

test('an empty or punctuation-only guess never matches', () => {
  const player = { name: 'Pele', aliases: [] };
  assert.deepEqual(matchesPlayer('', player), { matched: false, exact: false });
  assert.deepEqual(matchesPlayer('   ', player), { matched: false, exact: false });
  assert.deepEqual(matchesPlayer('???', player), { matched: false, exact: false });
});

test('a player with no aliases field still matches', () => {
  // db rows always carry aliases, but the default parameter is the contract.
  assert.equal(matchesPlayer('Pele', { name: 'Pele' }).matched, true);
});

test('closeness agrees with matchesPlayer about what counts', () => {
  const player = { name: 'Zlatan Ibrahimovic', aliases: [] };
  for (const guess of ['Zlatan Ibrahimovic', 'Zlatan Ibrahimovix', 'Lionel Messi', '']) {
    assert.equal(
      closeness(guess, player).matched,
      matchesPlayer(guess, player).matched,
      `disagreed about "${guess}"`,
    );
  }
});

test('closeness reports the distance to the nearest candidate', () => {
  const player = { name: 'Cristiano Ronaldo', aliases: ['ronaldo'] };
  const how = closeness('ronalda', player);
  assert.equal(how.distance, 1);   // one edit from the alias, not from the full name
  assert.equal(how.length, 7);     // span comes from the candidate it got closest to
});

test('closeness on an empty guess is infinitely far, not zero', () => {
  const how = closeness('', { name: 'Pele', aliases: [] });
  assert.equal(how.matched, false);
  assert.equal(how.distance, Infinity);
});

// --- the halves of a name, filled in as aliases when a player is created ---

test('a two-part name gives both halves', () => {
  assert.deepEqual(nameParts('David Ginola'), ['David', 'Ginola']);
});

test('a one-word name gives nothing to add', () => {
  // The name already matches itself; an alias repeating it would just be noise in the field.
  assert.deepEqual(nameParts('Ronaldinho'), []);
  assert.deepEqual(nameParts('  Pele  '), []);
});

test('a particle stays with the surname it belongs to', () => {
  assert.deepEqual(nameParts('David de Gea'), ['David', 'de Gea']);
  assert.deepEqual(nameParts('Ruud van Nistelrooy'), ['Ruud', 'van Nistelrooy']);
});

test('a long name gives the first word and the last, not the middle', () => {
  assert.deepEqual(nameParts('Carlos Alberto Torres'), ['Carlos', 'Torres']);
});

test('a half that is the whole name is not offered twice', () => {
  assert.deepEqual(nameParts('Ronaldo  Ronaldo'), ['Ronaldo']);
});

test('the halves are answers the matcher then accepts', () => {
  // The point of filling these in: neither guess matches the full name on its own, and both
  // should count once stored.
  const player = { name: 'David Ginola', aliases: nameParts('David Ginola') };
  assert.equal(matchesPlayer('Ginola', player).matched, true);
  assert.equal(matchesPlayer('David', player).matched, true);
  assert.equal(matchesPlayer('Ginolla', player).matched, true, 'typos are still forgiven');
});

test('soundKey keeps the sound and throws the spelling away', () => {
  // A run of vowels is one sound, which is the whole reason RAOUL is Raul.
  assert.equal(soundKey('Raoul'), soundKey('Raul'));
  // Doubled letters are nobody's idea of a second sound.
  assert.equal(soundKey('Zidanne'), soundKey('Zidane'));
  assert.equal(soundKey('Mohammed'), soundKey('Mohamed'));
  // The letters people swap for one another.
  assert.equal(soundKey('Sucker'), soundKey('Suker'));   // ck / k
  assert.equal(soundKey('Filipe'), soundKey('Philipe')); // ph / f
  assert.equal(soundKey('Tiago'), soundKey('Thiago'));   // th / t
  assert.equal(soundKey(''), '');
});

test('a short name that is spelled by ear still counts', () => {
  // The case from the admin's near-miss list: RAOUL is five letters, so edit distance gives it
  // no slack at all, and yet it is plainly the same name.
  const raul = { name: 'Raul', aliases: [] };
  assert.deepEqual(matchesPlayer('RAOUL', raul), { matched: true, exact: false });
  assert.deepEqual(matchesPlayer('Raul', raul), { matched: true, exact: true });
});

test('sounding alike does not make two different players the same one', () => {
  // The whole risk of matching by sound. These pairs are near-neighbours in spelling, and each
  // is a real player who must not win the other's round.
  assert.equal(matchesPlayer('Pepe', { name: 'Pele', aliases: [] }).matched, false);
  assert.equal(matchesPlayer('Kanu', { name: 'Kane', aliases: [] }).matched, false);
  assert.equal(matchesPlayer('Vieri', { name: 'Vieira', aliases: [] }).matched, false);
  assert.equal(matchesPlayer('Cole', { name: 'Kolo', aliases: [] }).matched, false);
  assert.equal(matchesPlayer('Sala', { name: 'Salah', aliases: [] }).matched, false);
  assert.equal(matchesPlayer('Kaka', { name: 'Kaku', aliases: [] }).matched, false);
});

test('a guess heard through by sound is a win, not a near miss', () => {
  // closeness() feeds the admin's "probably should have counted" list. Anything the matcher now
  // accepts has to report matched, or the admin is offered an alias it already does not need.
  const raul = { name: 'Raul', aliases: [] };
  assert.equal(closeness('RAOUL', raul).matched, true);
  assert.equal(matchesPlayer('RAOUL', raul).matched, true);
  // ...and the distance it reports is still the distance between the spellings.
  assert.equal(closeness('RAOUL', raul).distance, 1);
});

test('an alias is matched by sound too, not just the full name', () => {
  const player = { name: 'Zinedine Zidane', aliases: ['Zidane'] };
  assert.equal(matchesPlayer('Zidanne', player).matched, true);
  assert.equal(matchesPlayer('Zinedine Zidanne', player).matched, true);
});

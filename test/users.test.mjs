// Accounts and the claim step: linking a Google identity to a local user row, and moving a
// browser's anonymous play history onto it the first time it signs in.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-users-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const { plays, users } = await import('../server/db.mjs');

const guesses = () => [{ name: 'Alan Shearer', correct: true, skipped: false }];

test('upsert creates an account on first sign-in', () => {
  const user = users.upsert({ sub: 'g-1', email: 'a@example.com', name: 'Alex' });
  assert.equal(user.google_sub, 'g-1');
  assert.equal(user.email, 'a@example.com');
  assert.equal(user.name, 'Alex');
  assert.equal(users.byGoogleSub('g-1').id, user.id);
});

test('upsert on a repeat sub updates the same row rather than creating another', () => {
  const first = users.upsert({ sub: 'g-2', email: 'old@example.com', name: 'Old Name' });
  const second = users.upsert({ sub: 'g-2', email: 'new@example.com', name: 'New Name' });

  assert.equal(second.id, first.id);
  assert.equal(second.email, 'new@example.com');
  assert.equal(second.name, 'New Name');
  assert.equal(users.all().filter((u) => u.google_sub === 'g-2').length, 1);
});

test('get and remove work by id', () => {
  const user = users.upsert({ sub: 'g-3', email: '', name: '' });
  assert.equal(users.get(user.id).google_sub, 'g-3');
  users.remove(user.id);
  assert.equal(users.get(user.id), null);
  assert.equal(users.byGoogleSub('g-3'), null);
});

test('claim moves every anonymous row that has no colliding date/category on the account', () => {
  plays.save('anon-1', '2026-08-01', 'international', { guesses: guesses(), finished: true, won: true });
  plays.save('anon-1', '2026-08-02', 'premier-league', { guesses: guesses(), finished: true, won: true });

  plays.claim('anon-1', 'user:1');

  assert.equal(plays.get('anon-1', '2026-08-01', 'international'), undefined);
  assert.ok(plays.get('user:1', '2026-08-01', 'international').won);
  assert.ok(plays.get('user:1', '2026-08-02', 'premier-league').won);
});

test('claim keeps the account\'s row and drops the anonymous duplicate on a collision', () => {
  plays.save('user:2', '2026-08-03', 'international', { guesses: guesses(), finished: true, won: false });
  plays.save('anon-2', '2026-08-03', 'international', { guesses: guesses(), finished: true, won: true });

  plays.claim('anon-2', 'user:2');

  const row = plays.get('user:2', '2026-08-03', 'international');
  assert.equal(row.won, false); // the account's own row survived, not the anonymous one
  assert.equal(plays.get('anon-2', '2026-08-03', 'international'), undefined);
});

test('claim(a, a) is a safe no-op', () => {
  plays.save('user:3', '2026-08-04', 'international', { guesses: guesses(), finished: true, won: true });
  plays.claim('user:3', 'user:3');
  assert.ok(plays.get('user:3', '2026-08-04', 'international').won);
});

test('claim with no rows under the anonymous id at all is a safe no-op', () => {
  assert.doesNotThrow(() => plays.claim('never-played', 'user:4'));
});

test('deleteForSession removes every play a session owns', () => {
  plays.save('user:5', '2026-08-05', 'international', { guesses: guesses(), finished: true, won: true });
  plays.deleteForSession('user:5');
  assert.equal(plays.get('user:5', '2026-08-05', 'international'), undefined);
});

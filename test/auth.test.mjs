// Admin auth: the signed-cookie scheme, and the throttle in front of the password.
//
// A single human-chosen password is the only thing protecting /admin, and a constant-time
// comparison does nothing about someone simply trying a lot of them. These cover both that the
// throttle bites and that it never strands the real operator.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'correct horse battery staple';

const {
  checkPassword, loginDelay, recordFailedLogin, clearFailedLogins, isAdmin,
  issueAdminCookie, clearAdminCookie,
} = await import('../server/auth.mjs');

test('the password check accepts only the real password', () => {
  assert.equal(checkPassword('correct horse battery staple'), true);
  assert.equal(checkPassword('wrong'), false);
  assert.equal(checkPassword(''), false);
  // Must not throw on non-strings — the body is whatever was posted.
  assert.equal(checkPassword(undefined), false);
  assert.equal(checkPassword({ toString: () => 'nope' }), false);
});

test('a few wrong attempts cost nothing', () => {
  const ip = 'ip-a-few';
  for (let i = 0; i < 5; i++) {
    assert.equal(loginDelay(ip), 0, `attempt ${i + 1} should be free`);
    recordFailedLogin(ip);
  }
  assert.equal(loginDelay(ip), 0, 'the allowance itself should still be free');
});

test('sustained guessing backs off, and the delay grows', () => {
  const ip = 'ip-sustained';
  for (let i = 0; i < 8; i++) recordFailedLogin(ip);

  const first = loginDelay(ip);
  assert.ok(first > 0, 'should be throttled past the allowance');

  recordFailedLogin(ip);
  assert.ok(loginDelay(ip) > first, 'each further failure should cost more');
});

test('the delay is capped, so a long run never locks the door forever', () => {
  const ip = 'ip-capped';
  for (let i = 0; i < 40; i++) recordFailedLogin(ip);
  assert.ok(loginDelay(ip) <= 30_000, `capped, got ${loginDelay(ip)}`);
});

test('waiting it out clears the delay', () => {
  const ip = 'ip-waited';
  const start = Date.now();
  for (let i = 0; i < 8; i++) recordFailedLogin(ip, start);

  assert.ok(loginDelay(ip, start) > 0);
  // Far enough past the window that the record has aged out entirely.
  assert.equal(loginDelay(ip, start + 16 * 60 * 1000), 0);
});

test('a correct password clears the record, so the operator is never stuck', () => {
  const ip = 'ip-recovers';
  for (let i = 0; i < 10; i++) recordFailedLogin(ip);
  assert.ok(loginDelay(ip) > 0);

  clearFailedLogins(ip);
  assert.equal(loginDelay(ip), 0);
});

test('one caller being throttled does not affect another', () => {
  const noisy = 'ip-noisy';
  for (let i = 0; i < 10; i++) recordFailedLogin(noisy);
  assert.ok(loginDelay(noisy) > 0);
  assert.equal(loginDelay('ip-innocent'), 0);
});

// --- the signed cookie ---------------------------------------------------

/** Collect what res.cookie/clearCookie were called with, without pulling in Express. */
function fakeRes() {
  const jar = {};
  return {
    jar,
    cookie: (name, value) => { jar[name] = value; },
    clearCookie: (name, options) => { jar[name] = { cleared: true, options }; },
  };
}

test('a freshly issued cookie authenticates, and a tampered one does not', () => {
  const res = fakeRes();
  issueAdminCookie(res);
  const value = res.jar.silhoueds_admin;

  assert.equal(isAdmin({ cookies: { silhoueds_admin: value } }), true);

  // Flipping any part of it breaks the signature.
  assert.equal(isAdmin({ cookies: { silhoueds_admin: `${value}x` } }), false);
  assert.equal(isAdmin({ cookies: { silhoueds_admin: value.replace('.', 'x') } }), false);
  // An unsigned expiry far in the future must not be accepted.
  assert.equal(isAdmin({ cookies: { silhoueds_admin: String(Date.now() + 1e9) } }), false);
});

test('no cookie, or a junk one, is simply not signed in', () => {
  assert.equal(isAdmin({ cookies: {} }), false);
  assert.equal(isAdmin({}), false);
  assert.equal(isAdmin({ cookies: { silhoueds_admin: '' } }), false);
  assert.equal(isAdmin({ cookies: { silhoueds_admin: 'nonsense' } }), false);
  assert.equal(isAdmin({ cookies: { silhoueds_admin: '.' } }), false);
});

test('clearing repeats the attributes the cookie was set with', () => {
  // Browsers match a removal on attributes too, so a bare clearCookie can leave it in place.
  const res = fakeRes();
  clearAdminCookie(res);
  const { options } = res.jar.silhoueds_admin;

  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
});

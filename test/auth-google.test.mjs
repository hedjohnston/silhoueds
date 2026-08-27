// Google sign-in, end to end, with zero real Google credentials or network access: a tiny
// node:http server stands in for Google's token and userinfo endpoints, wired in via the same
// GOOGLE_TOKEN_URL/GOOGLE_USERINFO_URL overrides routes-auth.mjs already reads for production.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-auth-google-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// The fake Google: /token always succeeds, /userinfo returns whatever sub the test asked for.
let nextSub = 'g-fixed';
const google = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && url.pathname === '/token') {
    res.end(JSON.stringify({ access_token: 'fake-access-token' }));
  } else if (req.method === 'GET' && url.pathname === '/userinfo') {
    res.end(JSON.stringify({ sub: nextSub, email: 'test@example.com', name: 'Test User' }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
google.listen(0);
await new Promise((resolve) => google.once('listening', resolve));
const googleBase = `http://127.0.0.1:${google.address().port}`;
test.after(() => google.close());

// routes-auth.mjs reads these at import time, so the fake server has to be listening first.
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_TOKEN_URL = `${googleBase}/token`;
process.env.GOOGLE_USERINFO_URL = `${googleBase}/userinfo`;

const { authRouter } = await import('../server/routes-auth.mjs');
const { peekPlaySession, switchPlaySession } = await import('../server/auth.mjs');

/** A real signed session cookie for an arbitrary id — for setting up "this browser already had
 *  anonymous history" before a sign-in, without needing a route that mints one to a chosen value. */
function signedSessionCookie(id) {
  let captured;
  switchPlaySession({ cookie: (name, value) => { captured = value; } }, id);
  return captured;
}
const { users, plays } = await import('../server/db.mjs');

const app = express();
app.use(express.json());
// The same hand-rolled parser server/index.mjs uses — the only cookies this app sets are its own
// signed ones, so nothing fancier is needed.
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      if (i < 1) return [p, ''];
      try {
        return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
      } catch {
        return [p.slice(0, i), p.slice(i + 1)];
      }
    }),
  );
  next();
});
app.use('/api/auth', authRouter);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/** `name=rawValue` pairs from a response's Set-Cookie headers, still percent-encoded. */
function setCookies(response) {
  return Object.fromEntries(
    response.headers.getSetCookie().map((c) => {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
}

const cookieHeader = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');

/** Decodes one of this app's own signed cookies, the same way a real request would carry it. */
function sessionIdIn(pairs) {
  const raw = pairs.silhoueds_session;
  if (!raw) return null;
  return peekPlaySession({ cookies: { silhoueds_session: decodeURIComponent(raw) } });
}

/** Runs /start then /callback with a fresh fake Google identity, optionally starting from an
 *  existing (e.g. anonymous) session cookie. Returns the callback response and its cookies. */
async function signIn({ sub, existingCookies = {} } = {}) {
  if (sub) nextSub = sub;

  const start = await fetch(`${base}/api/auth/google/start`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(existingCookies) },
  });
  const stateCookie = setCookies(start).silhoueds_oauth_state;
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const callback = await fetch(
    `${base}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
    {
      redirect: 'manual',
      headers: { cookie: cookieHeader({ ...existingCookies, silhoueds_oauth_state: stateCookie }) },
    },
  );
  return { response: callback, cookies: setCookies(callback) };
}

test('a fresh visitor is not signed in', async () => {
  const response = await fetch(`${base}/api/auth/session`);
  const body = await response.json();
  assert.deepEqual(body, { signedIn: false, name: null, googleEnabled: true });
});

test('signing in creates an account and links this browser to it', async () => {
  const { response, cookies } = await signIn({ sub: 'g-new' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');

  const account = users.byGoogleSub('g-new');
  assert.ok(account, 'expected a users row for the new Google sub');

  assert.equal(sessionIdIn(cookies), `user:${account.id}`);
});

test('signing in again with the same Google account reuses the same local user', async () => {
  const first = await signIn({ sub: 'g-repeat' });
  const secondSub = users.byGoogleSub('g-repeat').id;

  const second = await signIn({ sub: 'g-repeat' });
  assert.equal(sessionIdIn(second.cookies), sessionIdIn(first.cookies));
  assert.equal(users.all().filter((u) => u.google_sub === 'g-repeat').length, 1);
  assert.equal(secondSub, users.byGoogleSub('g-repeat').id);
});

test('anonymous history on this browser moves to the account on first sign-in', async () => {
  plays.save('anon-claim-test', '2026-08-10', 'international', {
    guesses: [{ name: 'Alan Shearer', correct: true, skipped: false }],
    finished: true,
    won: true,
  });

  const { cookies } = await signIn({
    sub: 'g-claims',
    existingCookies: { silhoueds_session: encodeURIComponent(signedSessionCookie('anon-claim-test')) },
  });

  const accountSessionId = sessionIdIn(cookies);
  assert.equal(accountSessionId, `user:${users.byGoogleSub('g-claims').id}`);
  assert.ok(plays.get(accountSessionId, '2026-08-10', 'international').won);
  assert.equal(plays.get('anon-claim-test', '2026-08-10', 'international'), undefined);
});

test('a missing or mismatched state is rejected without creating an account', async () => {
  const before = users.all().length;
  const response = await fetch(`${base}/api/auth/google/callback?code=x&state=not-the-real-one`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth=error');
  assert.equal(users.all().length, before);
});

test('Google reporting an error (consent declined) redirects with auth=cancelled', async () => {
  const response = await fetch(`${base}/api/auth/google/callback?error=access_denied`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth=cancelled');
});

test('logout clears the session cookie', async () => {
  const response = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal((await response.json()).ok, true);

  const cleared = response.headers.getSetCookie().find((c) => c.startsWith('silhoueds_session='));
  assert.ok(cleared, 'expected logout to clear silhoueds_session');
  assert.match(cleared, /silhoueds_session=;/); // cleared, not re-issued with a value
  assert.match(cleared, /HttpOnly/i);
  assert.match(cleared, /SameSite=Lax/i);
});

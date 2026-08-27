// Admin auth and anonymous play sessions.
//
// Both are signed cookies — no session store, so the server stays a single process with no
// dependencies beyond SQLite. The signing secret and admin password come from the environment.

import crypto from 'node:crypto';

const SECRET = process.env.SILHOUEDS_SECRET;
const ADMIN_PASSWORD = process.env.SILHOUEDS_ADMIN_PASSWORD;
const ADMIN_COOKIE = 'silhoueds_admin';
const PLAY_COOKIE = 'silhoueds_session';
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

if (!SECRET) {
  throw new Error(
    'SILHOUEDS_SECRET is not set. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}
if (!ADMIN_PASSWORD) {
  throw new Error('SILHOUEDS_ADMIN_PASSWORD is not set — the admin would be unprotected.');
}

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

/** `value.signature`, so a cookie can't be forged or edited by the client. */
function stamp(value) {
  return `${value}.${sign(value)}`;
}

function unstamp(cookie) {
  if (typeof cookie !== 'string') return null;
  const index = cookie.lastIndexOf('.');
  if (index < 1) return null;
  const value = cookie.slice(0, index);
  const signature = cookie.slice(index + 1);
  const expected = sign(value);
  // Same-length buffers required, hence the length check before the constant-time compare.
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return value;
}

/** Constant-time password check, so a wrong password leaks nothing through timing. */
export function checkPassword(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// --- login throttling ----------------------------------------------------
//
// A single human-chosen password is the only thing standing in front of /admin, and a
// constant-time comparison does nothing about someone simply trying a lot of them. This costs an
// attacker time without ever locking the real operator out for long.
//
// In memory on purpose: the app is one process on one machine by design (a second would serve a
// diverging copy of the SQLite file), so there is nowhere better to put it, and losing the counts
// on restart is an acceptable trade for having no new dependency.

const ATTEMPT_LIMIT = 5;          // failures before the delay starts biting
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_DELAY_MS = 30 * 1000;

const attempts = new Map();

/** Sweep entries that have aged out, so the map can't grow without bound. */
function forget(now) {
  for (const [key, entry] of attempts) {
    if (now - entry.last > ATTEMPT_WINDOW_MS) attempts.delete(key);
  }
}

/**
 * How long this caller must wait before another attempt is worth making, in ms.
 *
 * Backs off exponentially past the free allowance and caps out, so a sustained guessing run is
 * throttled to a crawl while a typo or two costs nothing.
 */
export function loginDelay(ip, now = Date.now()) {
  const entry = attempts.get(ip);
  if (!entry || now - entry.last > ATTEMPT_WINDOW_MS) return 0;
  if (entry.count <= ATTEMPT_LIMIT) return 0;

  const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** (entry.count - ATTEMPT_LIMIT - 1));
  const waited = now - entry.last;
  return Math.max(0, delay - waited);
}

export function recordFailedLogin(ip, now = Date.now()) {
  forget(now);
  const entry = attempts.get(ip);
  const count = entry && now - entry.last <= ATTEMPT_WINDOW_MS ? entry.count + 1 : 1;
  attempts.set(ip, { count, last: now });
}

/** A correct password clears the record, so the operator is never left throttled. */
export function clearFailedLogins(ip) {
  attempts.delete(ip);
}

export function issueAdminCookie(res) {
  res.cookie(ADMIN_COOKIE, stamp(String(Date.now() + ADMIN_TTL_MS)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_TTL_MS,
  });
}

/**
 * Browsers match a removal against the cookie's attributes, not just its name, so clearing has to
 * repeat the ones it was set with — otherwise signing out can silently leave the cookie in place.
 */
export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function isAdmin(req) {
  const expiry = unstamp(req.cookies?.[ADMIN_COOKIE]);
  return Boolean(expiry) && Number(expiry) > Date.now();
}

/** Express guard for every /api/admin route except login. */
export function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
}

const PLAY_COOKIE_TTL_MS = 400 * 24 * 60 * 60 * 1000;

function playCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: PLAY_COOKIE_TTL_MS,
  };
}

function setPlaySession(res, id) {
  res.cookie(PLAY_COOKIE, stamp(id), playCookieOptions());
}

/**
 * A stable anonymous id for one browser, so the server can hold that visitor's progress.
 * Issued on first contact and carried in a signed cookie.
 *
 * A signed-in visitor's id looks exactly the same to everything downstream — it is just a
 * `"user:<id>"` string rather than a random uuid, stamped in by switchPlaySession on sign-in
 * rather than minted here. Nothing that reads session_id (loadRound, submitGuess, statsFor, the
 * `plays` table) needs to know or care which kind it is.
 */
export function playSession(req, res) {
  const existing = unstamp(req.cookies?.[PLAY_COOKIE]);
  if (existing) return existing;

  const id = crypto.randomUUID();
  setPlaySession(res, id);
  return id;
}

/** Reads the play session without minting one — for checks that shouldn't cookie a new visitor. */
export function peekPlaySession(req) {
  return unstamp(req.cookies?.[PLAY_COOKIE]);
}

/** Re-stamps the play cookie to a new id — how a browser links itself to an account on sign-in. */
export function switchPlaySession(res, id) {
  setPlaySession(res, id);
}

/** Signing out: the next request mints a fresh anonymous id, same as a first-ever visitor. */
export function clearPlaySession(res) {
  res.clearCookie(PLAY_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

// --- Google OAuth state -----------------------------------------------------
//
// A short-lived signed cookie standing in for server-side session storage, the same trade this
// file already makes everywhere else. Set on /start, checked and consumed on /callback — good
// for exactly one round trip, so a captured callback URL can't be replayed.

const OAUTH_STATE_COOKIE = 'silhoueds_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function issueOAuthState(res) {
  const state = crypto.randomUUID();
  res.cookie(OAUTH_STATE_COOKIE, stamp(state), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: OAUTH_STATE_TTL_MS,
  });
  return state;
}

/** Verifies `candidate` against the state cookie and clears it either way — one use only. */
export function consumeOAuthState(req, res, candidate) {
  const expected = unstamp(req.cookies?.[OAUTH_STATE_COOKIE]);
  res.clearCookie(OAUTH_STATE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  return Boolean(expected) && typeof candidate === 'string' && expected === candidate;
}

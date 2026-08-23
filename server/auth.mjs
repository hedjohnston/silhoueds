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

export function issueAdminCookie(res) {
  res.cookie(ADMIN_COOKIE, stamp(String(Date.now() + ADMIN_TTL_MS)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_TTL_MS,
  });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
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

/**
 * A stable anonymous id for one browser, so the server can hold that visitor's progress.
 * Issued on first contact and carried in a signed cookie.
 */
export function playSession(req, res) {
  const existing = unstamp(req.cookies?.[PLAY_COOKIE]);
  if (existing) return existing;

  const id = crypto.randomUUID();
  res.cookie(PLAY_COOKIE, stamp(id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 400 * 24 * 60 * 60 * 1000,
  });
  return id;
}

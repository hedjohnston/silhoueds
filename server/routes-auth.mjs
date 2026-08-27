// Google sign-in. Entirely optional: with GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset, every
// route here just says so rather than the server refusing to boot — anonymous play never
// depends on any of this.
//
// No token-verification library: the authorization-code exchange and the userinfo fetch both go
// straight to Google over HTTPS, which is the trust boundary. That sidesteps having to verify an
// ID token's JWT signature by hand (JWKS fetching/caching, algorithm checks) or add a dependency
// for it.

import express from 'express';
import { plays, users } from './db.mjs';
import {
  peekPlaySession, switchPlaySession, clearPlaySession, issueOAuthState, consumeOAuthState,
} from './auth.mjs';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_ENABLED = Boolean(CLIENT_ID && CLIENT_SECRET);

// Overridable so a test can stand in for Google without any real network access or credentials.
const AUTH_URL = process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const USERINFO_URL = process.env.GOOGLE_USERINFO_URL ?? 'https://www.googleapis.com/oauth2/v3/userinfo';

/** The origin this server is reachable at, for building a redirect_uri that matches every time. */
function originOf(req) {
  return (process.env.SILHOUEDS_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function redirectUriFor(req) {
  return `${originOf(req)}/api/auth/google/callback`;
}

/** Which local account a signed-in session belongs to, or null for an anonymous one. */
function accountFor(sessionId) {
  const match = typeof sessionId === 'string' && sessionId.match(/^user:(\d+)$/);
  return match ? users.get(Number(match[1])) : null;
}

export const authRouter = express.Router();

authRouter.get('/session', (req, res) => {
  const user = accountFor(peekPlaySession(req));
  res.json({ signedIn: Boolean(user), name: user?.name || null, googleEnabled: GOOGLE_ENABLED });
});

authRouter.get('/google/start', (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).json({ error: 'Google sign-in is not configured.' });

  const state = issueOAuthState(res);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // No refresh token wanted — this only ever needs a one-off profile fetch, right now.
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`${AUTH_URL}?${params}`);
});

authRouter.get('/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return res.redirect('/?auth=error');
  // The user declined consent on Google's screen, or Google reported some other problem.
  if (req.query.error) return res.redirect('/?auth=cancelled');
  if (!consumeOAuthState(req, res, req.query.state)) return res.redirect('/?auth=error');

  const code = req.query.code;
  if (typeof code !== 'string' || !code) return res.redirect('/?auth=error');

  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUriFor(req),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) throw new Error(`token exchange failed (${tokenResponse.status})`);
    const { access_token: accessToken } = await tokenResponse.json();
    if (!accessToken) throw new Error('no access_token in token response');

    const profileResponse = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) throw new Error(`userinfo failed (${profileResponse.status})`);
    const profile = await profileResponse.json();
    if (!profile.sub) throw new Error('no sub in userinfo response');

    const account = users.upsert({ sub: profile.sub, email: profile.email, name: profile.name });
    const accountSessionId = `user:${account.id}`;

    // Read before switchPlaySession overwrites it — this is the anonymous history, if any, that
    // this browser is about to hand over to the account.
    const previousSessionId = peekPlaySession(req);
    if (previousSessionId && previousSessionId !== accountSessionId) {
      plays.claim(previousSessionId, accountSessionId);
    }

    switchPlaySession(res, accountSessionId);
    res.redirect('/');
  } catch (error) {
    console.error('Google sign-in failed:', error);
    res.redirect('/?auth=error');
  }
});

authRouter.post('/logout', (req, res) => {
  clearPlaySession(res);
  res.json({ ok: true });
});

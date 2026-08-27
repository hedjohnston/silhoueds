// Google sign-in is optional infrastructure: with the client id/secret unset (the default —
// nothing else in the suite sets them), the app has to keep working, not refuse to boot.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'silhoueds-auth-disabled-'));
process.env.SILHOUEDS_DB = path.join(scratch, 'test.db');
process.env.SILHOUEDS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SILHOUEDS_ADMIN_PASSWORD = 'test-password';
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { authRouter } = await import('../server/routes-auth.mjs');

const app = express();
app.use((req, res, next) => { req.cookies = {}; next(); });
app.use('/api/auth', authRouter);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('session reports Google sign-in as unavailable', async () => {
  const response = await fetch(`${base}/api/auth/session`);
  assert.deepEqual(await response.json(), { signedIn: false, name: null, googleEnabled: false });
});

test('start refuses with a clear error instead of redirecting anywhere', async () => {
  const response = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Google sign-in is not configured.');
});

test('callback fails closed rather than attempting a token exchange', async () => {
  const response = await fetch(`${base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth=error');
});

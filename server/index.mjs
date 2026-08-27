// Silhoueds server: serves the game, the admin, and the JSON API from one process.

import './env.mjs';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameRouter } from './routes-game.mjs';
import { adminRouter } from './routes-admin.mjs';
import { authRouter } from './routes-auth.mjs';
import { warnIfEphemeral } from './storage.mjs';
import { db } from './db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.disable('x-powered-by');

// Behind a platform's TLS terminator (Fly, Railway, a reverse proxy), so req.protocol and
// req.ip reflect the original request rather than the hop from the proxy.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// nosniff matters most for the uploads: those are served straight back from disk, and without it
// a browser may sniff a file's contents and decide to run it as something other than the image
// type it was stored as. The frame headers keep the game out of someone else's page.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));

/**
 * Minimal cookie parsing — the only cookies we set are our own two signed ones.
 *
 * decodeURIComponent throws on malformed percent-encoding, and a cookie is attacker-supplied on
 * every request. Left unguarded, one bad cookie (`Cookie: x=%`) turned every single request from
 * that browser into a 500 — including the page itself, so the visitor could not reach the app to
 * clear it. An undecodable value falls back to its raw form instead; our own cookies are
 * signature-checked downstream, so a junk value simply fails to verify.
 */
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        // A cookie with no '=' is malformed; keep it whole rather than slicing to a junk key.
        if (index < 1) return [part, ''];
        const name = part.slice(0, index);
        const raw = part.slice(index + 1);
        try {
          return [name, decodeURIComponent(raw)];
        } catch {
          return [name, raw];
        }
      }),
  );
  next();
});

// Platform health checks. Touches the database, because the app is worthless without it and
// Fly would otherwise keep a machine in rotation whose disk had gone.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ ok: false });
  }
});

app.use('/api', gameRouter);
app.use('/api/admin', adminRouter);
app.use('/api/auth', authRouter);

// The link-preview tags need an absolute URL, and scrapers don't run JavaScript, so the page is
// served through a substitution rather than as a plain static file. Configure
// SILHOUEDS_PUBLIC_URL behind a proxy that rewrites the host; otherwise the request's own
// protocol and host are correct and nothing needs setting.
const INDEX = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function sendIndex(req, res) {
  const base = (process.env.SILHOUEDS_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '');
  res.type('html').send(INDEX.replaceAll('%PUBLIC_URL%', base));
}

// Both paths, so a link shared as /index.html previews the same as one shared as /.
app.get('/', sendIndex);
app.get('/index.html', sendIndex);

// Serve only the two web roots. The repo root is never served — it holds the database,
// the uploaded photos and node_modules.
app.use('/admin', express.static(path.join(root, 'admin')));
app.use(express.static(path.join(root, 'public'), { index: false }));

// Multer and JSON parse failures arrive here; without this they'd surface as HTML error pages.
app.use((error, req, res, next) => {
  const status = error.status ?? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  // A 4xx message is written for the person who caused it, so it goes back. A 5xx message is
  // whatever SQLite or the filesystem said, which can carry paths and schema detail — log it and
  // hand back something generic.
  if (status >= 500) {
    console.error(error);
    return res.status(status).json({ error: 'Something went wrong' });
  }
  res.status(status).json({ error: error.message ?? 'Something went wrong' });
});

app.listen(PORT, () => {
  warnIfEphemeral();
  console.log(`Silhoueds running at http://localhost:${PORT}`);
  console.log(`Admin at            http://localhost:${PORT}/admin`);
});

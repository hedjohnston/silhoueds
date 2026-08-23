// Silhoueds server: serves the game, the admin, and the JSON API from one process.

import './env.mjs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameRouter } from './routes-game.mjs';
import { adminRouter } from './routes-admin.mjs';
import { warnIfEphemeral } from './storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.disable('x-powered-by');

// Behind a platform's TLS terminator (Fly, Railway, a reverse proxy), so req.protocol and
// req.ip reflect the original request rather than the hop from the proxy.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Minimal cookie parsing — the only cookies we set are our own two signed ones.
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
  next();
});

// Platform health checks.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', gameRouter);
app.use('/api/admin', adminRouter);

// Serve only the two web roots. The repo root is never served — it holds the database,
// the uploaded photos and node_modules.
app.use('/admin', express.static(path.join(root, 'admin')));
app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));

// Multer and JSON parse failures arrive here; without this they'd surface as HTML error pages.
app.use((error, req, res, next) => {
  const status = error.status ?? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message ?? 'Something went wrong' });
});

app.listen(PORT, () => {
  warnIfEphemeral();
  console.log(`Silhoueds running at http://localhost:${PORT}`);
  console.log(`Admin at            http://localhost:${PORT}/admin`);
});

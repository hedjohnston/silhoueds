// Admin API. Everything past /login sits behind requireAdmin.

import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { players, schedule, plays, CATEGORIES } from './db.mjs';
import {
  checkPassword, issueAdminCookie, clearAdminCookie, isAdmin, requireAdmin,
  loginDelay, recordFailedLogin, clearFailedLogins,
} from './auth.mjs';
import { HINT_LABELS } from './hints.mjs';
import { storageStatus } from './storage.mjs';
import { zoneOf } from './request.mjs';
import { todayKey, hasArtwork, normalizeCategory } from './game.mjs';
import { closeness } from './matching.mjs';
import { UPLOAD_DIR, sendUpload, discard } from './uploads.mjs';

/** Which of the two daily games this request concerns. */
function categoryOf(req) {
  return normalizeCategory(req.query?.category ?? req.body?.category);
}

/**
 * The only types we accept, and the extension each is stored under.
 *
 * The extension comes from this map rather than from the uploaded filename. `originalname` is
 * attacker-controlled, and the stored file is later served back by `res.sendFile`, which picks
 * its Content-Type from the extension — so a file named `x.html` would be served as HTML from
 * our own origin, reachable unauthenticated through /api/puzzle/silhouette. Deriving the
 * extension from the type we validated keeps that door shut.
 */
const ALLOWED_IMAGES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
]);

/** A 400, not a 500: a wrong file type is the operator's mistake, not the server falling over. */
function rejectType() {
  const error = new Error('Photos must be JPEG, PNG, WebP or AVIF.');
  error.status = 400;
  return error;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${ALLOWED_IMAGES.get(file.mimetype) ?? ''}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ALLOWED_IMAGES.has(file.mimetype) ? cb(null, true) : cb(rejectType()),
});

/**
 * Delete whatever multer already wrote for this request.
 *
 * Multer streams to disk before the handler runs, so every early return below would otherwise
 * strand its uploads — up to 12 MB a time on a 1 GB volume, with nothing referencing them.
 */
function discardUploads(req) {
  for (const file of Object.values(req.files ?? {}).flat()) {
    fs.rmSync(file.path, { force: true });
  }
}

const slugify = (name) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'player';

/** Slugs are unique in the schema, so suffix until one is free. */
function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (players.bySlug(slug)) slug = `${base}-${n++}`;
  return slug;
}

/** A player is only playable with artwork and at least one hint. */
function readiness(player) {
  const missing = [];
  if (!hasArtwork(player)) missing.push('silhouette');
  if (!player.hints?.length) missing.push('hints');
  return missing;
}

export const adminRouter = express.Router();

adminRouter.post('/login', (req, res) => {
  // req.ip honours trust proxy in production, so this is the visitor rather than Fly's edge.
  const caller = req.ip ?? 'unknown';

  const wait = loginDelay(caller);
  if (wait > 0) {
    res.set('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`,
    });
  }

  if (!checkPassword(req.body?.password ?? '')) {
    recordFailedLogin(caller);
    return res.status(401).json({ error: 'Wrong password' });
  }

  clearFailedLogins(caller);
  issueAdminCookie(res);
  res.json({ ok: true });
});

adminRouter.post('/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

adminRouter.get('/session', (req, res) => {
  res.json({
    signedIn: isAdmin(req),
    storage: storageStatus(),
    hintLabels: HINT_LABELS,
    categories: CATEGORIES,
  });
});

adminRouter.use(requireAdmin);

adminRouter.get('/players', (req, res) => {
  res.json({
    players: players.all().map((p) => ({ ...p, missing: readiness(p) })),
    hintLabels: HINT_LABELS,
  });
});

/** Create a player from a typed name plus their two images. Hints are entered by hand. */
const uploads = upload.fields([
  { name: 'silhouette', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
]);

adminRouter.post('/players', uploads, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    discardUploads(req);
    return res.status(400).json({ error: 'A name is required.' });
  }

  const silhouetteFile = req.files?.silhouette?.[0]?.filename ?? null;
  const photoFile = req.files?.photo?.[0]?.filename ?? null;

  const player = players.create({
    slug: uniqueSlug(name),
    name,
    photo: photoFile,
    silhouetteImage: silhouetteFile,
    revealImage: photoFile,
    category: categoryOf(req),
  });

  res.status(201).json({ player: { ...player, missing: readiness(player) } });
});

// Replace either image on an existing player.
adminRouter.post('/players/:id/images', uploads, (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player) {
    discardUploads(req);
    return res.status(404).json({ error: 'No such player' });
  }

  const fields = {};
  const silhouetteFile = req.files?.silhouette?.[0]?.filename;
  const photoFile = req.files?.photo?.[0]?.filename;

  if (silhouetteFile) {
    discard(player.silhouette_image);
    fields.silhouette_image = silhouetteFile;
    // An uploaded silhouette supersedes anything previously traced.
    fields.silhouette = null;
  }
  if (photoFile) {
    discard(player.photo);
    fields.photo = photoFile;
    fields.reveal_image = photoFile;
  }
  if (Object.keys(fields).length === 0) {
    discardUploads(req);
    return res.status(400).json({ error: 'Choose at least one image.' });
  }

  const updated = players.update(player.id, fields);
  res.json({ player: { ...updated, missing: readiness(updated) } });
});


adminRouter.patch('/players/:id', (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player) return res.status(404).json({ error: 'No such player' });

  const fields = {};
  if (typeof req.body.name === 'string' && req.body.name.trim()) fields.name = req.body.name.trim();
  if (Array.isArray(req.body.aliases)) fields.aliases = req.body.aliases.map(String);
  if (Array.isArray(req.body.hints)) {
    fields.hints = req.body.hints
      .filter((h) => h && h.label && h.value)
      .map((h) => ({ label: String(h.label), value: String(h.value) }));
    fields.hint_source = 'manual';
  }
  if (typeof req.body.silhouette === 'string') fields.silhouette = req.body.silhouette;
  if (typeof req.body.category === 'string' && CATEGORIES.includes(req.body.category)) {
    fields.category = req.body.category;
  }

  if (req.body.status === 'ready' || req.body.status === 'draft') {
    const candidate = { ...player, ...fields };
    const missing = readiness(candidate);
    if (req.body.status === 'ready' && missing.length > 0) {
      return res.status(400).json({ error: `Still missing: ${missing.join(' and ')}.` });
    }
    fields.status = req.body.status;
  }

  const updated = players.update(player.id, fields);
  res.json({ player: { ...updated, missing: readiness(updated) } });
});

adminRouter.delete('/players/:id', (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player) return res.status(404).json({ error: 'No such player' });
  for (const filename of new Set(players.images(player))) discard(filename);
  players.remove(player.id);
  res.json({ ok: true });
});

// The uploaded images, for review in the admin.
adminRouter.get('/players/:id/photo', (req, res) => {
  sendUpload(res, players.get(Number(req.params.id))?.photo);
});

adminRouter.get('/players/:id/silhouette-image', (req, res) => {
  sendUpload(res, players.get(Number(req.params.id))?.silhouette_image);
});

adminRouter.get('/schedule', (req, res) => {
  // The operator's own day, not the server's.
  const today = todayKey(new Date(), zoneOf(req));
  const category = categoryOf(req);
  res.json({
    today,
    upcoming: schedule.upcoming(today, category),
    stats: plays.stats(today, category),
    // A player is single-category, so this never wrongly excludes one from the other game.
    usedPlayerIds: schedule.allScheduledPlayerIds(),
  });
});

adminRouter.put('/schedule/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  const category = categoryOf(req);

  const player = players.get(Number(req.body?.playerId));
  if (!player) return res.status(404).json({ error: 'No such player' });
  if (readiness(player).length > 0) {
    return res.status(400).json({ error: 'That player is still a draft.' });
  }
  if (player.category !== category) {
    return res.status(400).json({ error: `That player is tagged ${player.category}, not ${category}.` });
  }
  schedule.set(date, category, player.id);
  res.json({ ok: true, upcoming: schedule.upcoming(todayKey(new Date(), zoneOf(req)), category) });
});

adminRouter.delete('/schedule/:date', (req, res) => {
  const category = categoryOf(req);
  schedule.clear(req.params.date, category);
  res.json({ ok: true, upcoming: schedule.upcoming(todayKey(new Date(), zoneOf(req)), category) });
});

/**
 * What people guessed on a given day.
 *
 * Every guess is already stored against an anonymous session id — no names, emails or addresses
 * are kept, so this shows what was guessed but never who guessed it.
 */
adminRouter.get('/insights', (req, res) => {
  const category = categoryOf(req);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.date ?? '')
    ? req.query.date
    : todayKey(new Date(), zoneOf(req));
  // schedule.get, never playerForDate: the latter falls through to auto-assignment, which writes
  // a schedule row. Reading the guess log for a day nobody played — or for a future date, which
  // the format check alone allows — would then allocate a ready player to it permanently, and the
  // schedule picker excludes anyone already scheduled. Simply looking would eat the pool.
  const player = schedule.get(date, category);
  const rounds = plays.forDate(date, category);

  let solved = 0;
  let totalGuesses = 0;
  const modes = { easy: 0, hard: 0 };
  const wrong = new Map();
  const near = new Map();

  for (const round of rounds) {
    if (round.won) solved++;
    totalGuesses += round.guesses.length;
    modes[round.mode] = (modes[round.mode] ?? 0) + 1;

    for (const guess of round.guesses) {
      if (guess.correct || guess.skipped || !guess.name) continue;
      const key = guess.name.trim();
      if (!key) continue;
      wrong.set(key.toLowerCase(), (wrong.get(key.toLowerCase()) ?? 0) + 1);

      if (!player) continue;
      // A typo that just missed, not a different player. Two tests, because either alone is
      // wrong: an absolute cap (editDistance returns 4 when strings are far apart) and a
      // proportional one, since 2 edits is a typo in a long name but a different word in a
      // four-letter one — without it, an alias like "zizo" makes "figo" look like a near miss.
      const how = closeness(key, player);
      const isNearMiss =
        !how.matched &&
        how.distance <= Math.min(3, how.tolerance + 2) &&
        how.distance / Math.max(1, how.length) <= 1 / 3;
      if (isNearMiss) {
        const entry = near.get(key.toLowerCase()) ?? { name: key, count: 0, distance: how.distance };
        entry.count++;
        near.set(key.toLowerCase(), entry);
      }
    }
  }

  const byCount = (a, b) => b.count - a.count;

  res.json({
    date,
    player: player ? { id: player.id, name: player.name, aliases: player.aliases } : null,
    summary: {
      players: rounds.length,
      solved,
      solveRate: rounds.length ? Math.round((solved / rounds.length) * 100) : 0,
      averageGuesses: rounds.length ? Number((totalGuesses / rounds.length).toFixed(1)) : 0,
      modes,
    },
    wrongGuesses: [...wrong.entries()].map(([name, count]) => ({ name, count })).sort(byCount).slice(0, 15),
    nearMisses: [...near.values()].sort(byCount),
    log: rounds.map((round) => ({
      // Enough to tell rounds apart, not enough to identify anyone.
      session: round.session.slice(0, 6),
      won: round.won,
      finished: round.finished,
      mode: round.mode,
      updatedAt: round.updatedAt,
      guesses: round.guesses.map((g) => (g.skipped ? '(skipped)' : g.name)),
    })),
  });
});

adminRouter.get('/insights/dates', (req, res) => {
  res.json({ dates: plays.playedDates(categoryOf(req)) });
});

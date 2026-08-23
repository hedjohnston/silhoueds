// Admin API. Everything past /login sits behind requireAdmin.

import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { players, schedule, plays } from './db.mjs';
import { checkPassword, issueAdminCookie, clearAdminCookie, isAdmin, requireAdmin } from './auth.mjs';
import { generateHints, hasApiKey, HINT_LABELS } from './claude.mjs';
import { storageStatus } from './storage.mjs';
import { todayKey, hasArtwork, playerForDate } from './game.mjs';
import { closeness } from './matching.mjs';

const UPLOAD_DIR = process.env.SILHOUEDS_UPLOADS ?? 'data/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ALLOWED_IMAGES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Photos must be JPEG, PNG, WebP or AVIF.')),
});

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

/** Remove an image file that is no longer referenced. */
function discard(filename) {
  if (filename) fs.rmSync(path.join(UPLOAD_DIR, filename), { force: true });
}

export const adminRouter = express.Router();

adminRouter.post('/login', (req, res) => {
  if (!checkPassword(req.body?.password ?? '')) {
    return res.status(401).json({ error: 'Wrong password' });
  }
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
    claudeConfigured: hasApiKey(),
    storage: storageStatus(),
    hintLabels: HINT_LABELS,
  });
});

adminRouter.use(requireAdmin);

adminRouter.get('/players', (req, res) => {
  res.json({
    players: players.all().map((p) => ({ ...p, missing: readiness(p) })),
    hintLabels: HINT_LABELS,
  });
});

/**
 * Create a player from a typed name plus their two images, and — unless asked not to — draft
 * the hints with Claude straight away. That step is best-effort; a failure is reported and can
 * be retried from the player's card.
 */
const uploads = upload.fields([
  { name: 'silhouette', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
]);

adminRouter.post('/players', uploads, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'A name is required.' });

  const silhouetteFile = req.files?.silhouette?.[0]?.filename ?? null;
  const photoFile = req.files?.photo?.[0]?.filename ?? null;

  let player = players.create({
    slug: uniqueSlug(name),
    name,
    photo: photoFile,
    silhouetteImage: silhouetteFile,
    revealImage: photoFile,
  });

  const steps = {};
  if (req.body?.auto !== 'false') {
    if (hasApiKey()) {
      try {
        const result = await generateHints(player.name);
        if (result.known) {
          player = players.update(player.id, {
            hints: result.hints,
            aliases: [...new Set([...player.aliases, ...result.aliases])],
            hint_source: 'claude',
          });
          steps.hints = 'done';
        } else {
          steps.hints = `Claude does not recognise "${player.name}" — check the spelling.`;
        }
      } catch (error) {
        steps.hints = error.message;
      }
    }
  }

  res.status(201).json({ player: { ...player, missing: readiness(player) }, steps });
});

// Replace either image on an existing player.
adminRouter.post('/players/:id/images', uploads, (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player) return res.status(404).json({ error: 'No such player' });

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
    return res.status(400).json({ error: 'Choose at least one image.' });
  }

  const updated = players.update(player.id, fields);
  res.json({ player: { ...updated, missing: readiness(updated) } });
});

// Ask Claude for hints and aliases. Saves them as a draft for review — never publishes.
adminRouter.post('/players/:id/hints', async (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player) return res.status(404).json({ error: 'No such player' });
  if (!hasApiKey()) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not set on the server, so hints cannot be generated.',
    });
  }

  try {
    const result = await generateHints(player.name);
    if (!result.known) {
      return res.status(422).json({
        error: `Claude does not recognise "${player.name}" as a footballer. Check the spelling.`,
        note: result.note,
      });
    }
    const updated = players.update(player.id, {
      hints: result.hints,
      // Keep any aliases already entered by hand.
      aliases: [...new Set([...player.aliases, ...result.aliases])],
      hint_source: 'claude',
    });
    res.json({
      player: { ...updated, missing: readiness(updated) },
      note: result.note,
      canonicalName: result.canonicalName,
      usage: result.usage,
    });
  } catch (error) {
    res.status(502).json({ error: `Claude request failed: ${error.message}` });
  }
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
  const player = players.get(Number(req.params.id));
  if (!player?.photo) return res.status(404).end();
  res.sendFile(path.resolve(UPLOAD_DIR, player.photo));
});

adminRouter.get('/players/:id/silhouette-image', (req, res) => {
  const player = players.get(Number(req.params.id));
  if (!player?.silhouette_image) return res.status(404).end();
  res.sendFile(path.resolve(UPLOAD_DIR, player.silhouette_image));
});

adminRouter.get('/schedule', (req, res) => {
  res.json({ today: todayKey(), upcoming: schedule.upcoming(), stats: plays.stats(todayKey()) });
});

adminRouter.put('/schedule/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });

  const player = players.get(Number(req.body?.playerId));
  if (!player) return res.status(404).json({ error: 'No such player' });
  if (readiness(player).length > 0) {
    return res.status(400).json({ error: 'That player is still a draft.' });
  }
  schedule.set(date, player.id);
  res.json({ ok: true, upcoming: schedule.upcoming() });
});

adminRouter.delete('/schedule/:date', (req, res) => {
  schedule.clear(req.params.date);
  res.json({ ok: true, upcoming: schedule.upcoming() });
});

/**
 * What people guessed on a given day.
 *
 * Every guess is already stored against an anonymous session id — no names, emails or addresses
 * are kept, so this shows what was guessed but never who guessed it.
 */
adminRouter.get('/insights', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.date ?? '') ? req.query.date : todayKey();
  const player = playerForDate(date);
  const rounds = plays.forDate(date);

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
  res.json({ dates: plays.playedDates() });
});

// Public game API. Everything here is safe for an anonymous visitor.

import express from 'express';
import path from 'node:path';
import { playSession } from './auth.mjs';
import { loadRound, publicState, submitGuess, todayKey } from './game.mjs';

const UPLOAD_DIR = process.env.SILHOUEDS_UPLOADS ?? 'data/uploads';

// The browser reports its own zone so the puzzle rolls over at each player's local midnight.
// A zone name is at most a handful of segments; anything else is ignored and the default applies.
function zoneOf(req) {
  const tz = req.query?.tz ?? req.body?.tz;
  return typeof tz === 'string' && tz.length <= 64 ? tz : undefined;
}

export const gameRouter = express.Router();

gameRouter.get('/puzzle', (req, res) => {
  const sessionId = playSession(req, res);
  const date = todayKey(new Date(), zoneOf(req));
  const round = loadRound(sessionId, date);
  if (!round) {
    return res.status(503).json({ error: 'No puzzle is ready yet. Check back soon.' });
  }
  res.json(publicState(round.player, { ...round.play, date }));
});

// Today's silhouette artwork. Public — it is the puzzle.
gameRouter.get('/puzzle/silhouette', (req, res) => {
  const round = loadRound(playSession(req, res), todayKey(new Date(), zoneOf(req)));
  if (!round?.player.silhouette_image) return res.status(404).end();
  res.sendFile(path.resolve(UPLOAD_DIR, round.player.silhouette_image));
});

// The full photo. Served only once this visitor's round is over, so it cannot be used to
// look up the answer early.
gameRouter.get('/puzzle/reveal', (req, res) => {
  const sessionId = playSession(req, res);
  const round = loadRound(sessionId, todayKey(new Date(), zoneOf(req)));
  if (!round?.player.reveal_image) return res.status(404).end();
  if (!round.play.finished) return res.status(403).end();
  res.sendFile(path.resolve(UPLOAD_DIR, round.player.reveal_image));
});

gameRouter.post('/guess', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, req.body?.guess, { timeZone: zoneOf(req) });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

gameRouter.post('/skip', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, '', { skipped: true, timeZone: zoneOf(req) });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

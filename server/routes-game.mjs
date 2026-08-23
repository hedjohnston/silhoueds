// Public game API. Everything here is safe for an anonymous visitor.

import express from 'express';
import { playSession } from './auth.mjs';
import { loadRound, publicState, submitGuess, todayKey } from './game.mjs';

export const gameRouter = express.Router();

gameRouter.get('/puzzle', (req, res) => {
  const sessionId = playSession(req, res);
  const round = loadRound(sessionId);
  if (!round) {
    return res.status(503).json({ error: 'No puzzle is ready yet. Check back soon.' });
  }
  res.json(publicState(round.player, { ...round.play, date: todayKey() }));
});

gameRouter.post('/guess', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, req.body?.guess);
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

gameRouter.post('/skip', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, '', { skipped: true });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

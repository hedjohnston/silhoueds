// Public game API. Everything here is safe for an anonymous visitor.

import express from 'express';
import path from 'node:path';
import { playSession } from './auth.mjs';
import { zoneOf } from './request.mjs';
import {
  loadRound, publicState, submitGuess, todayKey, resolveRoundDate, statsFor, setMode,
} from './game.mjs';
import { schedule, plays } from './db.mjs';

const UPLOAD_DIR = process.env.SILHOUEDS_UPLOADS ?? 'data/uploads';

/** Which round this request is for: today by default, or an earlier one from the archive. */
function dateOf(req) {
  const today = todayKey(new Date(), zoneOf(req));
  const requested = req.query?.date ?? req.body?.date;
  return resolveRoundDate(typeof requested === 'string' ? requested : undefined, today);
}

export const gameRouter = express.Router();

gameRouter.get('/puzzle', (req, res) => {
  const sessionId = playSession(req, res);
  const date = dateOf(req);
  if (!date) return res.status(404).json({ error: 'No puzzle for that date.' });
  const round = loadRound(sessionId, date);
  if (!round) {
    return res.status(503).json({ error: 'No puzzle is ready yet. Check back soon.' });
  }
  res.json(publicState(round.player, { ...round.play, date }));
});

// Today's silhouette artwork. Public — it is the puzzle.
gameRouter.get('/puzzle/silhouette', (req, res) => {
  const date = dateOf(req);
  if (!date) return res.status(404).end();
  const round = loadRound(playSession(req, res), date);
  if (!round?.player.silhouette_image) return res.status(404).end();
  res.sendFile(path.resolve(UPLOAD_DIR, round.player.silhouette_image));
});

// The full photo. Served only once this visitor's round is over, so it cannot be used to
// look up the answer early.
gameRouter.get('/puzzle/reveal', (req, res) => {
  const sessionId = playSession(req, res);
  const date = dateOf(req);
  if (!date) return res.status(404).end();
  const round = loadRound(sessionId, date);
  if (!round?.player.reveal_image) return res.status(404).end();
  // Hard mode keeps the photo back until the round is over; easy mode is the opt-in exception.
  if (!round.play.finished && round.play.mode !== 'easy') return res.status(403).end();
  res.sendFile(path.resolve(UPLOAD_DIR, round.player.reveal_image));
});

gameRouter.post('/guess', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, req.body?.guess, { timeZone: zoneOf(req), date: req.body?.date });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

gameRouter.post('/skip', (req, res) => {
  const sessionId = playSession(req, res);
  const state = submitGuess(sessionId, '', { skipped: true, timeZone: zoneOf(req), date: req.body?.date });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

// Choose the difficulty. Refused once the round has a guess — the reply always carries the
// current state, so a client that is out of step simply re-renders with the truth.
gameRouter.post('/mode', (req, res) => {
  const sessionId = playSession(req, res);
  const date = dateOf(req);
  if (!date) return res.status(404).json({ error: 'No puzzle for that date.' });
  const state = setMode(sessionId, date, req.body?.mode);
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

// This visitor's record. Their own rounds only — there is no cross-player leaderboard.
gameRouter.get('/stats', (req, res) => {
  const sessionId = playSession(req, res);
  res.json(statsFor(sessionId, todayKey(new Date(), zoneOf(req))));
});

// Past puzzles and how this visitor did on each. Never carries the answer for an unfinished one.
gameRouter.get('/archive', (req, res) => {
  const sessionId = playSession(req, res);
  const today = todayKey(new Date(), zoneOf(req));
  const entries = schedule.past(today).map((date) => {
    const play = plays.get(sessionId, date);
    return {
      date,
      today: date === today,
      status: !play?.finished ? (play ? 'started' : 'unplayed') : play.won ? 'solved' : 'failed',
      guesses: play?.finished && play.won ? play.guesses.length : null,
      mode: play?.mode ?? 'hard',
    };
  });
  res.json({ today, entries });
});

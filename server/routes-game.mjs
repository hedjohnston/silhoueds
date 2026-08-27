// Public game API. Everything here is safe for an anonymous visitor.

import express from 'express';
import { playSession } from './auth.mjs';
import { zoneOf } from './request.mjs';
import {
  loadRound, publicState, submitGuess, todayKey, resolveRoundDate, statsFor, setMode,
  normalizeCategory,
} from './game.mjs';
import { schedule, plays } from './db.mjs';
import { sendUpload } from './uploads.mjs';

/** Which category this request is for — Premier League or International, each its own game. */
function categoryOf(req) {
  return normalizeCategory(req.query?.category ?? req.body?.category);
}

/** Which round this request is for: today by default, or an earlier one from the archive. */
function dateOf(req, category) {
  const today = todayKey(new Date(), zoneOf(req));
  const requested = req.query?.date ?? req.body?.date;
  return resolveRoundDate(typeof requested === 'string' ? requested : undefined, today, category);
}

export const gameRouter = express.Router();

gameRouter.get('/puzzle', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const date = dateOf(req, category);
  if (!date) return res.status(404).json({ error: 'No puzzle for that date.' });
  const round = loadRound(sessionId, date, category);
  if (!round) {
    return res.status(503).json({ error: 'No puzzle is ready yet. Check back soon.' });
  }
  res.json(publicState(round.player, { ...round.play, date }));
});

// Today's silhouette artwork. Public — it is the puzzle.
gameRouter.get('/puzzle/silhouette', (req, res) => {
  const category = categoryOf(req);
  const date = dateOf(req, category);
  if (!date) return res.status(404).end();
  const round = loadRound(playSession(req, res), date, category);
  sendUpload(res, round?.player.silhouette_image);
});

// The full photo. Served only once this visitor's round is over, so it cannot be used to
// look up the answer early.
gameRouter.get('/puzzle/reveal', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const date = dateOf(req, category);
  if (!date) return res.status(404).end();
  const round = loadRound(sessionId, date, category);
  if (!round?.player.reveal_image) return res.status(404).end();
  // Hard mode keeps the photo back until the round is over; easy mode is the opt-in exception.
  if (!round.play.finished && round.play.mode !== 'easy') return res.status(403).end();
  sendUpload(res, round.player.reveal_image);
});

gameRouter.post('/guess', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const state = submitGuess(sessionId, req.body?.guess, {
    timeZone: zoneOf(req), date: req.body?.date, category,
  });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

gameRouter.post('/skip', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const state = submitGuess(sessionId, '', {
    skipped: true, timeZone: zoneOf(req), date: req.body?.date, category,
  });
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

// Choose the difficulty. Refused once the round has a guess — the reply always carries the
// current state, so a client that is out of step simply re-renders with the truth.
gameRouter.post('/mode', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const date = dateOf(req, category);
  if (!date) return res.status(404).json({ error: 'No puzzle for that date.' });
  const state = setMode(sessionId, date, category, req.body?.mode);
  if (!state) return res.status(503).json({ error: 'No puzzle is ready yet.' });
  res.json(state);
});

// This visitor's record. Their own rounds only — there is no cross-player leaderboard.
gameRouter.get('/stats', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  res.json(statsFor(sessionId, todayKey(new Date(), zoneOf(req)), category));
});

// Past puzzles and how this visitor did on each. Never carries the answer for an unfinished one.
gameRouter.get('/archive', (req, res) => {
  const sessionId = playSession(req, res);
  const category = categoryOf(req);
  const today = todayKey(new Date(), zoneOf(req));
  const entries = schedule.past(today, category).map((date) => {
    const play = plays.get(sessionId, date, category);
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

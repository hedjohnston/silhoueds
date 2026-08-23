// Game state machine: load the day's puzzle, take guesses, reveal hints, end the round.

import { todayKey, puzzleIndexForDate, loadProgress, saveProgress } from './puzzle.js';
import { matchesPlayer, attachTypeahead } from './autocomplete.js';

export const MAX_GUESSES = 6;

const el = (id) => document.getElementById(id);

const dom = {
  silhouette: el('silhouette'),
  hints: el('hints'),
  guessesLeft: el('guesses-left'),
  history: el('guess-history'),
  form: el('guess-form'),
  input: el('guess-input'),
  suggestions: el('suggestions'),
  skip: el('skip-button'),
  result: el('result'),
  resultTitle: el('result-title'),
  resultName: el('result-name'),
  share: el('share-button'),
  shareStatus: el('share-status'),
  puzzleDate: el('puzzle-date'),
};

let player;
let roster = [];
let state;

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

/** Inline the SVG rather than using <img>, so CSS `color` can tint it for the reveal. */
async function renderSilhouette(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  dom.silhouette.innerHTML = await response.text();
}

/** Wrong guesses so far — each one unlocks the next hint. */
function wrongCount() {
  return state.guesses.filter((guess) => !guess.correct).length;
}

function render() {
  const revealed = Math.min(wrongCount(), player.hints.length);

  dom.hints.innerHTML = '';
  player.hints.slice(0, revealed).forEach((hint) => {
    const chip = document.createElement('li');
    chip.className = 'hint';
    chip.innerHTML = `<span class="hint-label"></span><span class="hint-value"></span>`;
    chip.querySelector('.hint-label').textContent = hint.label;
    chip.querySelector('.hint-value').textContent = hint.value;
    dom.hints.append(chip);
  });
  if (revealed === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint hint-empty';
    empty.textContent = 'No hints yet — a wrong guess or a skip reveals one.';
    dom.hints.append(empty);
  }

  dom.history.innerHTML = '';
  state.guesses.forEach((guess) => {
    const row = document.createElement('li');
    row.className = guess.correct ? 'guess guess-correct' : 'guess guess-wrong';
    row.textContent = guess.skipped ? 'Skipped' : guess.name;
    dom.history.append(row);
  });

  const remaining = MAX_GUESSES - state.guesses.length;
  dom.guessesLeft.textContent = state.finished
    ? ''
    : `${remaining} ${remaining === 1 ? 'guess' : 'guesses'} left`;

  dom.silhouette.classList.toggle('revealed', state.finished);
  dom.form.hidden = state.finished;
  dom.skip.hidden = state.finished;
  dom.result.hidden = !state.finished;

  if (state.finished) {
    dom.resultTitle.textContent = state.won ? 'Got it!' : 'Out of guesses';
    dom.resultName.textContent = player.name;
  }
}

function finish(won) {
  state.finished = true;
  state.won = won;
  saveProgress(state);
  render();
}

function submitGuess(rawName, { skipped = false } = {}) {
  if (state.finished) return;
  const name = rawName.trim();
  if (!skipped && !name) return;

  const correct = !skipped && matchesPlayer(name, player);
  state.guesses.push({ name, correct, skipped });
  dom.input.value = '';
  saveProgress(state);

  if (correct) return finish(true);
  if (state.guesses.length >= MAX_GUESSES) return finish(false);
  render();
}

/** Wordle-style grid: one square per guess, green only on the winning one. */
export function shareText() {
  const squares = state.guesses
    .map((guess) => (guess.correct ? '🟩' : guess.skipped ? '⬜' : '🟥'))
    .join('');
  const score = state.won ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  return `Silhoueds ${state.date} ${score}\n${squares}`;
}

async function copyShare() {
  const text = shareText();
  try {
    await navigator.clipboard.writeText(text);
    dom.shareStatus.textContent = 'Copied to clipboard';
  } catch {
    dom.shareStatus.textContent = text;
  }
}

export async function init() {
  const [players, rosterData] = await Promise.all([
    loadJson('data/players.json'),
    loadJson('data/roster.json'),
  ]);

  const date = todayKey();
  player = players.players[puzzleIndexForDate(date, players.players.length)];
  roster = rosterData.names;
  state = loadProgress(date);

  dom.puzzleDate.textContent = new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  await renderSilhouette(player.silhouette);

  attachTypeahead({
    input: dom.input,
    list: dom.suggestions,
    names: roster,
    onSubmit: (name) => submitGuess(name),
  });

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitGuess(dom.input.value);
  });
  dom.skip.addEventListener('click', () => submitGuess('', { skipped: true }));
  dom.share.addEventListener('click', copyShare);

  render();
}

init().catch((error) => {
  document.body.dataset.error = 'true';
  dom.silhouette.textContent = error.message;
});

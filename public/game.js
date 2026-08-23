// Game client. It holds no answers and no player list — the server decides whether a guess is
// right and hands back only the hints that have been earned.

const el = (id) => document.getElementById(id);

const dom = {
  silhouette: el('silhouette'),
  hints: el('hints'),
  guessesLeft: el('guesses-left'),
  history: el('guess-history'),
  form: el('guess-form'),
  input: el('guess-input'),
  skip: el('skip-button'),
  notice: el('notice'),
  result: el('result'),
  resultTitle: el('result-title'),
  resultName: el('result-name'),
  share: el('share-button'),
  shareStatus: el('share-status'),
  puzzleDate: el('puzzle-date'),
};

let state = null;
let busy = false;

// The puzzle rolls over at the player's own local midnight, so the server needs their zone.
const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
})();

async function api(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = timeZone ? `${path}${separator}tz=${encodeURIComponent(timeZone)}` : path;
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function renderSilhouette() {
  // Once the round is over, the full photo takes the stage.
  const key = state.revealUrl ?? state.silhouetteUrl ?? state.silhouette ?? '';
  if (dom.silhouette.dataset.rendered === key) return;
  dom.silhouette.dataset.rendered = key;
  dom.silhouette.innerHTML = '';

  if (state.revealUrl) {
    const photo = document.createElement('img');
    photo.className = 'reveal';
    photo.src = timeZone
      ? `${state.revealUrl}?tz=${encodeURIComponent(timeZone)}`
      : state.revealUrl;
    photo.alt = state.answer ? `Photo of ${state.answer}` : 'The answer revealed';
    dom.silhouette.append(photo);
    return;
  }

  if (state.silhouetteUrl) {
    const art = document.createElement('img');
    // Image requests carry the zone too, so they resolve the same day as the round.
    art.src = timeZone
      ? `${state.silhouetteUrl}?tz=${encodeURIComponent(timeZone)}`
      : state.silhouetteUrl;
    art.alt = "Today's silhouette";
    dom.silhouette.append(art);
    return;
  }

  // A traced outline is inlined as SVG so CSS `color` can style it.
  dom.silhouette.innerHTML = state.silhouette ?? '';
}

function renderHints() {
  dom.hints.innerHTML = '';
  if (state.hints.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint hint-empty';
    empty.textContent = 'No hints yet — a wrong guess or a skip reveals one.';
    dom.hints.append(empty);
    return;
  }
  for (const hint of state.hints) {
    const chip = document.createElement('li');
    chip.className = 'hint';
    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = hint.label;
    const value = document.createElement('span');
    value.className = 'hint-value';
    value.textContent = hint.value;
    chip.append(label, value);
    dom.hints.append(chip);
  }
}

function renderHistory() {
  dom.history.innerHTML = '';
  for (const guess of state.guesses) {
    const row = document.createElement('li');
    row.className = guess.correct
      ? 'guess guess-correct'
      : guess.skipped
        ? 'guess guess-skipped'
        : 'guess guess-wrong';
    row.textContent = guess.skipped ? 'Skipped' : guess.name;
    dom.history.append(row);
  }
}

function render() {
  renderSilhouette();
  renderHints();
  renderHistory();

  dom.guessesLeft.textContent =
    `${state.guessesLeft} ${state.guessesLeft === 1 ? 'guess' : 'guesses'} left`;
  // Once the round is over these reserve empty space above the result, so drop them.
  dom.guessesLeft.hidden = state.finished;
  dom.notice.hidden = state.finished;

  dom.form.hidden = state.finished;
  dom.skip.hidden = state.finished;
  dom.result.hidden = !state.finished;

  if (state.finished) {
    dom.resultTitle.textContent = state.won ? 'Got it!' : 'Out of guesses';
    dom.resultName.textContent = state.answer ?? '';
  }
}

function notify(message) {
  dom.notice.textContent = message ?? '';
}

async function send(path, body) {
  if (busy || state?.finished) return;
  busy = true;
  dom.input.disabled = true;
  try {
    const next = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    const spelling = next.spelling;
    state = next;
    dom.input.value = '';
    render();
    notify(spelling ? 'Close enough on the spelling — counted as correct.' : '');
  } catch (error) {
    notify(error.message);
  } finally {
    busy = false;
    dom.input.disabled = false;
    if (!state.finished) dom.input.focus();
  }
}

/** Wordle-style grid: one square per guess, green only on the winning one. */
function shareText() {
  const squares = state.guesses
    .map((guess) => (guess.correct ? '🟩' : guess.skipped ? '⬜' : '🟥'))
    .join('');
  const score = state.won ? `${state.guesses.length}/${state.maxGuesses}` : `X/${state.maxGuesses}`;
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

async function init() {
  try {
    state = await api('/api/puzzle');
  } catch (error) {
    notify(error.message);
    dom.form.hidden = true;
    dom.skip.hidden = true;
    return;
  }

  dom.puzzleDate.textContent = new Date(`${state.date}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const guess = dom.input.value.trim();
    if (guess) send('/api/guess', { guess });
  });
  dom.skip.addEventListener('click', () => send('/api/skip'));
  dom.share.addEventListener('click', copyShare);

  render();
  dom.input.focus();
}

init();

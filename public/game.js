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
  share: Array.from(document.querySelectorAll('.share-button')),
  shareStatus: Array.from(document.querySelectorAll('.share-status')),
  puzzleDate: el('puzzle-date'),
  stats: el('stats'),
  comeback: el('comeback'),
  statsButton: el('stats-button'),
  archiveButton: el('archive-button'),
  sheet: el('sheet'),
  sheetTitle: el('sheet-title'),
  sheetBody: el('sheet-body'),
  modes: el('modes'),
  modeHard: el('mode-hard'),
  modeEasy: el('mode-easy'),
  modeNote: el('mode-note'),
  categoryPL: el('category-pl'),
  categoryIntl: el('category-intl'),
};

const MODE_KEY = 'silhoueds:mode';
const CATEGORY_KEY = 'silhoueds:category';
const CATEGORIES = ['premier-league', 'international'];
const DEFAULT_CATEGORY = 'international';

function preferredMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'easy' ? 'easy' : 'hard';
  } catch {
    return 'hard';
  }
}

function rememberMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private window or storage blocked — the round still knows its own mode server-side.
  }
}

function preferredCategory() {
  try {
    const stored = localStorage.getItem(CATEGORY_KEY);
    return CATEGORIES.includes(stored) ? stored : DEFAULT_CATEGORY;
  } catch {
    return DEFAULT_CATEGORY;
  }
}

function rememberCategory(category) {
  try {
    localStorage.setItem(CATEGORY_KEY, category);
  } catch {
    // Private window or storage blocked — the tab just won't be remembered next visit.
  }
}

// Premier League and The Rest are two independent daily games — switching just opens the other
// one, the way switching difficulty doesn't. The tag stays `international`: it is what every
// stored play and schedule row is filed under, and only the label on the button changed.
let category = preferredCategory();

// Which round is on screen — today unless the archive opened an earlier one.
let viewingDate = null;

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

function withParams(path) {
  const params = new URLSearchParams();
  if (timeZone) params.set('tz', timeZone);
  if (viewingDate) params.set('date', viewingDate);
  params.set('category', category);
  const query = params.toString();
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

async function api(path, options = {}) {
  const url = withParams(path);
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function renderSilhouette() {
  // Easy mode puts the photo on the stage from the start, filtered flat; the fill is the puzzle.
  const source = state.revealUrl ?? state.photoUrl ?? state.silhouetteUrl ?? state.silhouette ?? '';
  const key = `${source}|${state.photoUrl ? 'photo' : ''}`;

  if (dom.silhouette.dataset.rendered === key) {
    applyFill();
    return;
  }
  dom.silhouette.dataset.rendered = key;
  dom.silhouette.innerHTML = '';

  if (state.photoUrl && !state.revealUrl) {
    const photo = document.createElement('img');
    // Deliberately not `.reveal`: that carries the framed-photograph border, which would announce
    // this as a photo from the first moment and give away that hard mode is showing the same
    // picture. The frame arrives with the answer, at the end.
    photo.className = 'morph';
    photo.src = withParams(state.photoUrl);
    photo.alt = "Today's player, coming into focus";
    dom.silhouette.append(photo);
    applyFill();
    return;
  }

  if (state.revealUrl) {
    const photo = document.createElement('img');
    photo.className = 'reveal';
    photo.src = withParams(state.revealUrl);
    photo.alt = state.answer ? `Photo of ${state.answer}` : 'The answer revealed';
    dom.silhouette.append(photo);
    return;
  }

  if (state.silhouetteUrl) {
    const art = document.createElement('img');
    // Image requests carry the zone too, so they resolve the same day as the round.
    art.src = withParams(state.silhouetteUrl);
    art.alt = "Today's silhouette";
    dom.silhouette.append(art);
    return;
  }

  // A traced outline is inlined as SVG so CSS `color` can style it.
  dom.silhouette.innerHTML = state.silhouette ?? '';
}

/**
 * The ink shape resolving into a photograph.
 *
 * One image throughout — the photo is a background-removed cut-out, so its own alpha channel is
 * the silhouette, and `brightness(0)` flattens it to exactly the shape hard mode shows. Nothing
 * is masked or crossfaded: the outline never moves, only what is inside it resolves.
 */
function applyFill() {
  const photo = dom.silhouette.querySelector('img.morph');
  if (!photo || !state.fill) return;
  const { brightness, contrast, saturate } = state.fill;
  photo.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
}

function renderCategories() {
  for (const [button, value] of [[dom.categoryPL, 'premier-league'], [dom.categoryIntl, 'international']]) {
    const active = value === category;
    button.classList.toggle('mode-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

async function chooseCategory(next) {
  if (category === next || busy) return;
  category = next;
  rememberCategory(next);
  renderCategories();
  await openRound(null);
}

function renderModes() {
  const locked = state.guesses.length > 0 || state.finished;
  const unavailable = !state.easyAvailable;

  for (const button of [dom.modeHard, dom.modeEasy]) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('mode-active', active);
    button.setAttribute('aria-pressed', String(active));
  }

  dom.modeEasy.disabled = locked || unavailable;
  dom.modeHard.disabled = locked;

  dom.modeNote.textContent = unavailable
    ? 'Easy mode needs a photo, and today\'s puzzle has none.'
    : locked
      ? 'Locked in for this round.'
      : '';
}

async function chooseMode(mode) {
  // No round on screen means nothing to set the difficulty of.
  if (!state || state.mode === mode) return;
  rememberMode(mode);
  try {
    state = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) });
    render();
  } catch (error) {
    notify(error.message);
  }
}

function renderHints() {
  dom.hints.innerHTML = '';

  if (state.hints.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint-empty';
    empty.textContent = 'No hints yet — a wrong guess or a skip reveals one.';
    dom.hints.append(empty);
    return;
  }

  const card = document.createElement('section');
  card.className = 'hint-card';

  const head = document.createElement('header');
  head.className = 'hint-card-head';
  const title = document.createElement('span');
  title.textContent = 'Hints';
  const count = document.createElement('span');
  count.className = 'hint-count';
  count.textContent = `${state.hints.length} of ${state.hintsTotal ?? state.hints.length}`;
  head.append(title, count);

  const list = document.createElement('ol');
  list.className = 'hint-rows';

  state.hints.forEach((hint, index) => {
    const row = document.createElement('li');
    // The newest hint is the new information, so it carries a tint — but once the round is over
    // every hint arrived at once, so none of them is "new" and the tint would be arbitrary.
    row.className =
      !state.finished && index === state.hints.length - 1 ? 'hint hint-latest' : 'hint';

    const badge = document.createElement('span');
    badge.className = 'hint-index';
    badge.textContent = String(index + 1);
    badge.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');
    body.className = 'hint-body';
    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = hint.label;
    const value = document.createElement('span');
    value.className = 'hint-value';
    value.textContent = hint.value;
    body.append(label, value);

    row.append(badge, body);
    list.append(row);
  });

  card.append(head, list);
  dom.hints.append(card);
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
  renderCategories();
  renderModes();
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
    renderCountdown();
    api('/api/stats')
      .then((stats) => renderStats(dom.stats, stats, state.won ? state.guesses.length : null))
      .catch(() => {});
  }
}

function notify(message) {
  dom.notice.textContent = message ?? '';
}

async function send(path, body) {
  // `!state` covers the no-round case, where the finally below would read state.finished.
  if (busy || !state || state.finished) return;
  busy = true;
  dom.input.disabled = true;
  try {
    const next = await api(path, {
      method: 'POST',
      body: JSON.stringify({ ...(body ?? {}), tz: timeZone, date: viewingDate ?? undefined }),
    });
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

/**
 * One line noting anything that makes the win less than clean — hints revealed, a skip used, or
 * a loss — so the grid doesn't read as tidier than the round actually was. Counts only: never the
 * hints themselves or the answer.
 */
function shareCaveat() {
  if (!state.won) return "Didn't get it";

  // A skip reveals a hint the same way an ordinary miss does, so these two counts are disjoint
  // causes of the same hint reveals — summing them equals state.hints.length, never double-counted.
  const misses = state.guesses.filter((guess) => !guess.correct && !guess.skipped).length;
  const skips = state.guesses.filter((guess) => guess.skipped).length;

  const notes = [];
  if (misses > 0) notes.push(`${misses} hint${misses === 1 ? '' : 's'}`);
  if (skips > 0) notes.push(skips === 1 ? 'a skip' : `${skips} skips`);
  return notes.length > 0 ? `With ${notes.join(' and ')}` : '';
}

/** Wordle-style grid: one square per guess, green only on the winning one. */
function shareGrid() {
  const squares = state.guesses
    .map((guess) => (guess.correct ? '🟩' : guess.skipped ? '⬜' : '🟥'))
    .join('');
  const score = state.won ? `${state.guesses.length}/${state.maxGuesses}` : `X/${state.maxGuesses}`;
  // A symbol, not the word: the grid is glanceable, and hard mode's flex is this being absent —
  // which only reads if the marker is loud enough to notice missing.
  const marker = state.mode === 'easy' ? ' 👁' : '';
  const tag = state.category === 'premier-league' ? ' PL' : '';
  const caveat = shareCaveat();
  const caveatLine = caveat ? `\n${caveat}` : '';
  return `Silhoueds${tag} ${state.date} ${score}${marker}\n${squares}${caveatLine}`;
}

/** Grid plus link, for when we're pasting text rather than handing over a URL separately. */
function shareText() {
  // The link is the point: without it nobody who sees this can find the game. A blank line before
  // it keeps WhatsApp/iMessage/Telegram from treating the score line as part of the link preview —
  // without one they scope the link's styling to the whole paragraph it sits in.
  return `${shareGrid()}\n\n${location.origin}`;
}

/** Four figures and a bar per guess count, so a win reads in context. */
function renderStats(target, stats, highlight) {
  target.innerHTML = '';

  const figures = document.createElement('dl');
  figures.className = 'stat-figures';
  const cells = [
    ['Played', stats.played],
    ['Win %', stats.winRate],
    ['Streak', stats.currentStreak],
    ['Longest', stats.bestStreak],
  ];
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    const number = document.createElement('dt');
    number.textContent = String(value);
    const name = document.createElement('dd');
    name.textContent = label;
    cell.append(number, name);
    figures.append(cell);
  }
  target.append(figures);

  if (stats.played === 0) return;

  const most = Math.max(1, ...Object.values(stats.distribution));
  const chart = document.createElement('div');
  chart.className = 'stat-chart';
  for (let n = 1; n <= stats.maxGuesses; n++) {
    const count = stats.distribution[n] ?? 0;
    const row = document.createElement('div');
    row.className = n === highlight ? 'stat-row stat-row-current' : 'stat-row';
    const key = document.createElement('span');
    key.className = 'stat-key';
    key.textContent = String(n);
    const bar = document.createElement('span');
    bar.className = 'stat-bar';
    bar.style.width = `${Math.max(8, (count / most) * 100)}%`;
    bar.textContent = String(count);
    row.append(key, bar);
    chart.append(row);
  }
  const caption = document.createElement('p');
  caption.className = 'stat-caption';
  caption.textContent = 'Guesses used, when you got it';
  target.append(caption, chart);

  renderModeSplit(target, stats);
}

/**
 * Hard and easy side by side.
 *
 * The streak above spans both modes deliberately, so this is where choosing hard shows up at all:
 * without it an easy win and a hard win are the same number and there is no reason to take the
 * silhouette on. Hidden until there is actually something to compare — a player who has only ever
 * played one mode is being shown a row of zeroes, not a comparison.
 */
function renderModeSplit(target, stats) {
  const modes = [['Hard', stats.byMode?.hard], ['Easy', stats.byMode?.easy]];
  if (!modes.every(([, side]) => side) || modes.some(([, side]) => side.played === 0)) return;

  const caption = document.createElement('p');
  caption.className = 'stat-caption';
  caption.textContent = 'How you do in each mode';

  const split = document.createElement('dl');
  split.className = 'stat-split';
  for (const [label, side] of modes) {
    const name = document.createElement('dt');
    name.textContent = label;
    const value = document.createElement('dd');
    value.textContent = `${side.won} of ${side.played} · ${side.winRate}%`;
    split.append(name, value);
  }

  target.append(caption, split);
}

async function showStats() {
  try {
    const stats = await api('/api/stats');
    dom.sheetTitle.textContent = 'Your stats';
    renderStats(dom.sheetBody, stats, null);
    dom.sheet.showModal();
  } catch (error) {
    notify(error.message);
  }
}

const STATUS_TEXT = { solved: 'Solved', failed: 'Missed', started: 'In progress', unplayed: 'Not played' };

async function showArchive() {
  try {
    const { entries } = await api('/api/archive');
    dom.sheetTitle.textContent = 'Past puzzles';
    dom.sheetBody.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sheet-empty';
      empty.textContent = 'No past puzzles yet — today is the first.';
      dom.sheetBody.append(empty);
    }

    const list = document.createElement('ul');
    list.className = 'archive';
    for (const entry of entries) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.className = `archive-entry archive-${entry.status}`;
      const when = document.createElement('span');
      when.textContent = entry.today
        ? 'Today'
        : new Date(`${entry.date}T00:00:00Z`).toLocaleDateString(undefined, {
            day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
          });
      const status = document.createElement('span');
      status.className = 'archive-status';
      const played = entry.guesses
        ? `${STATUS_TEXT[entry.status]} in ${entry.guesses}`
        : STATUS_TEXT[entry.status];
      // Mark easy rounds so past results stay comparable.
      status.textContent = entry.mode === 'easy' ? `${played} · easy` : played;
      button.append(when, status);
      button.onclick = () => {
        dom.sheet.close();
        openRound(entry.today ? null : entry.date);
      };
      item.append(button);
      list.append(item);
    }
    dom.sheetBody.append(list);
    dom.sheet.showModal();
  } catch (error) {
    notify(error.message);
  }
}

/** Time until this player's own next midnight — the rollover is local to them. */
function renderCountdown() {
  if (!state?.finished) return;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const left = midnight - now;
  const hours = Math.floor(left / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  dom.comeback.textContent = viewingDate
    ? 'That was a past puzzle — open today from Past puzzles.'
    : `Next silhouette in ${hours}h ${minutes}m.`;
}

/** The share button appears above and below the stats, so status has to reach both lines. */
function setShareStatus(text) {
  for (const line of dom.shareStatus) line.textContent = text;
}

async function copyToClipboard() {
  const text = shareText();
  try {
    await navigator.clipboard.writeText(text);
    setShareStatus('Copied to clipboard');
  } catch {
    // No clipboard access — show it so it can at least be copied by hand.
    setShareStatus(text);
  }
}

/**
 * Open the system share sheet where there is one, and fall back to the clipboard.
 *
 * The link goes inside `text` rather than in a separate `url` field: several share targets
 * (WhatsApp among them) use only `url` and silently drop `text` when both are present, so a
 * separate `url` field meant the score never reached the recipient — only the bare link did.
 */
async function share() {
  // The buttons live inside the hidden result box when there's no round, but the listeners are
  // attached before the first load now, so don't rely on that alone.
  if (!state) return;
  const payload = { title: 'Silhoueds', text: shareText() };

  if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
    try {
      await navigator.share(payload);
      setShareStatus('');
      return;
    } catch (error) {
      // Dismissing the sheet is a choice, not a failure — say nothing and stop.
      if (error?.name === 'AbortError') return;
      // Anything else (no permission, unsupported target) falls through to the clipboard.
    }
  }

  await copyToClipboard();
}

/**
 * Show that there is no round to play, and clear the last one off the screen.
 *
 * Without this the previous round's silhouette, hints and guesses stayed put under the new tab —
 * so switching to a category with no puzzle read as if that category were showing yesterday's
 * player. The message goes in the stage, where the puzzle would have been.
 */
function showNoRound(message) {
  state = null;
  notify('');

  document.body.dataset.error = 'true';
  dom.silhouette.dataset.rendered = '';
  dom.silhouette.textContent = message;

  dom.hints.innerHTML = '';
  dom.history.innerHTML = '';
  dom.puzzleDate.textContent = '';
  dom.modeNote.textContent = '';

  dom.guessesLeft.hidden = true;
  dom.form.hidden = true;
  dom.skip.hidden = true;
  dom.result.hidden = true;

  // The category tabs stay live so the player can get back to one that has a puzzle.
  dom.modeHard.disabled = true;
  dom.modeEasy.disabled = true;
  renderCategories();
}

async function openRound(date) {
  viewingDate = date;
  notify('');
  try {
    state = await api('/api/puzzle');
  } catch (error) {
    showNoRound(error.message);
    return;
  }

  delete document.body.dataset.error;
  dom.puzzleDate.textContent = new Date(`${state.date}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  dom.silhouette.dataset.rendered = '';

  const wanted = preferredMode();
  if (wanted !== state.mode && state.guesses.length === 0 && !state.finished && state.easyAvailable) {
    try {
      state = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: wanted }) });
    } catch {
      // Keep whatever the server says the round is.
    }
  }

  render();
  if (!state.finished) dom.input.focus();
}

async function init() {
  // Wired before the first load, not after: when that load fails there is still a page to drive,
  // and the category tabs are the only way back to one that has a puzzle.
  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const guess = dom.input.value.trim();
    if (guess) send('/api/guess', { guess });
  });
  dom.skip.addEventListener('click', () => send('/api/skip'));
  for (const button of dom.share) button.addEventListener('click', share);
  dom.modeHard.addEventListener('click', () => chooseMode('hard'));
  dom.modeEasy.addEventListener('click', () => chooseMode('easy'));
  dom.categoryPL.addEventListener('click', () => chooseCategory('premier-league'));
  dom.categoryIntl.addEventListener('click', () => chooseCategory('international'));
  dom.statsButton.addEventListener('click', showStats);
  dom.archiveButton.addEventListener('click', showArchive);
  setInterval(renderCountdown, 30000);

  await openRound(null);
}

init();

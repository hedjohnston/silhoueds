import { createTracer } from './trace.js';

const el = (id) => document.getElementById(id);
const dom = Object.fromEntries(
  [
    'login', 'login-form', 'login-error', 'password', 'app', 'logout',
    'add-form', 'new-name', 'new-category', 'new-photo', 'new-silhouette', 'add-error',
    'player-filter', 'player-category-filter', 'players', 'counts',
    'schedule-form', 'schedule-category', 'schedule-date', 'schedule-player-search',
    'schedule-player-id', 'schedule-player-results', 'schedule', 'schedule-error',
    'tracer', 'tracer-title', 'tracer-stage', 'tracer-photo', 'tracer-svg', 'tracer-preview',
    'tracer-smooth', 'tracer-dim', 'tracer-undo', 'tracer-clear', 'tracer-save', 'tracer-error',
    'storage-alarm', 'insights', 'insight-category', 'insight-date',
  ].map((id) => [id, el(id)]),
);

let players = [];
let hintLabels = [];
let usedPlayerIds = [];
let tracingPlayer = null;
// Which player cards are expanded, so a re-render (e.g. after Save edits) doesn't collapse them.
const expandedPlayerIds = new Set();

// Premier League and International are two independent daily games, distinguished only by this
// tag on each player. Populated from the server so the label list lives in one place.
let categories = [];
const CATEGORY_LABELS = { 'premier-league': 'Premier League', international: 'International' };
const categoryLabel = (category) => CATEGORY_LABELS[category] ?? category;

let playerFilter = 'all';
let scheduleCategory = null;
let insightCategory = null;

function fillCategorySelect(select) {
  const chosen = select.value;
  select.innerHTML = '';
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = categoryLabel(category);
    select.append(option);
  }
  if ([...select.options].some((o) => o.value === chosen)) select.value = chosen;
}

// Sent with every request so dates are resolved where the operator is, not where the server runs.
const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
})();

async function api(path, { method = 'GET', body, form } = {}) {
  if (timeZone) {
    path += `${path.includes('?') ? '&' : '?'}tz=${encodeURIComponent(timeZone)}`;
  }
  const options = { method };
  if (form) options.body = form;
  else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { 'Content-Type': 'application/json' };
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

const showError = (node, error) => {
  node.textContent = error?.message ?? error ?? '';
};

// --- players -------------------------------------------------------------

function statusChip(player) {
  if (player.status === 'ready') return '<span class="chip chip-ready">Live</span>';
  const missing = player.missing.join(' + ');
  return `<span class="chip chip-draft">Draft${missing ? ` — needs ${missing}` : ''}</span>`;
}

/** The silhouette thumbnail, shared between the collapsed summary and the expanded card. */
function buildArt(player, { small = false } = {}) {
  const art = document.createElement('div');
  art.className = small ? 'player-art player-art-thumb' : 'player-art';
  if (player.silhouette_image) {
    const image = document.createElement('img');
    image.src = `/api/admin/players/${player.id}/silhouette-image`;
    image.alt = '';
    art.append(image);
  } else if (player.silhouette) {
    art.innerHTML = player.silhouette;
  } else {
    art.innerHTML = '<span class="art-empty">no silhouette</span>';
  }
  return art;
}

function renderPlayerCategoryFilter() {
  dom['player-category-filter'].innerHTML = '';
  for (const value of ['all', ...categories]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = value === playerFilter ? 'filter-chip filter-chip-active' : 'filter-chip';
    button.textContent = value === 'all' ? 'All' : categoryLabel(value);
    button.onclick = () => {
      playerFilter = value;
      renderPlayerCategoryFilter();
      renderPlayers();
    };
    dom['player-category-filter'].append(button);
  }
}

function renderPlayers() {
  dom.players.innerHTML = '';
  const query = dom['player-filter'].value.trim().toLowerCase();
  const visible = players
    .filter((p) => !query || p.name.toLowerCase().includes(query))
    .filter((p) => playerFilter === 'all' || p.category === playerFilter);

  for (const player of visible) {
    const card = document.createElement('details');
    card.className = 'player';
    card.open = expandedPlayerIds.has(player.id);
    card.addEventListener('toggle', () => {
      if (card.open) expandedPlayerIds.add(player.id);
      else expandedPlayerIds.delete(player.id);
    });

    const summary = document.createElement('summary');
    const thumb = buildArt(player, { small: true });
    const title = document.createElement('h3');
    title.textContent = player.name;
    const category = document.createElement('span');
    category.className = 'chip chip-category';
    category.textContent = categoryLabel(player.category);
    const chip = document.createElement('span');
    chip.innerHTML = statusChip(player);
    summary.append(thumb, title, category, chip);

    const body = document.createElement('div');
    body.className = 'player-body';

    const art = buildArt(player);

    const details = document.createElement('div');
    details.className = 'player-details';

    const hints = document.createElement('ol');
    hints.className = 'hint-rows';
    for (const label of hintLabels) {
      const existing = player.hints.find((h) => h.label === label);
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'hint-row-label';
      name.textContent = label;
      const input = document.createElement('input');
      input.value = existing?.value ?? '';
      input.placeholder = '—';
      input.dataset.label = label;
      row.append(name, input);
      hints.append(row);
    }

    const aliasField = document.createElement('input');
    aliasField.className = 'aliases';
    aliasField.value = player.aliases.join(', ');
    aliasField.placeholder = 'Accepted spellings, comma separated';

    const aliasLabel = document.createElement('label');
    aliasLabel.className = 'alias-label';
    aliasLabel.textContent = 'Also accepted';
    aliasLabel.append(aliasField);

    const categoryField = document.createElement('select');
    categoryField.className = 'category-select';
    fillCategorySelect(categoryField);
    categoryField.value = player.category;

    const categoryLabelField = document.createElement('label');
    categoryLabelField.className = 'alias-label';
    categoryLabelField.textContent = 'Category';
    categoryLabelField.append(categoryField);

    const actions = document.createElement('div');
    actions.className = 'player-actions';

    const replace = document.createElement('button');
    replace.className = 'ghost';
    replace.textContent = 'Replace images';
    replace.onclick = () => openImagePicker(player);

    const trace = document.createElement('button');
    trace.className = 'ghost';
    trace.textContent = player.silhouette_image || player.silhouette ? 'Touch up by hand' : 'Trace by hand';
    trace.onclick = () => openTracer(player);

    const save = document.createElement('button');
    save.className = 'ghost';
    save.textContent = 'Save edits';
    save.onclick = async () => {
      const edited = [...hints.querySelectorAll('input')]
        .map((input) => ({ label: input.dataset.label, value: input.value.trim() }))
        .filter((h) => h.value);
      try {
        await api(`/api/admin/players/${player.id}`, {
          method: 'PATCH',
          body: {
            hints: edited,
            category: categoryField.value,
            aliases: aliasField.value.split(',').map((a) => a.trim()).filter(Boolean),
          },
        });
        await refresh();
      } catch (error) {
        alert(error.message);
      }
    };

    const publish = document.createElement('button');
    publish.className = player.status === 'ready' ? 'ghost' : 'primary';
    publish.textContent = player.status === 'ready' ? 'Unpublish' : 'Publish';
    publish.onclick = async () => {
      try {
        await api(`/api/admin/players/${player.id}`, {
          method: 'PATCH',
          body: { status: player.status === 'ready' ? 'draft' : 'ready' },
        });
        await refresh();
      } catch (error) {
        alert(error.message);
      }
    };

    const remove = document.createElement('button');
    remove.className = 'ghost danger';
    remove.textContent = 'Delete';
    remove.onclick = async () => {
      if (!confirm(`Delete ${player.name}? This cannot be undone.`)) return;
      await api(`/api/admin/players/${player.id}`, { method: 'DELETE' });
      await refresh();
    };

    actions.append(replace, trace, save, publish, remove);
    details.append(hints, aliasLabel, categoryLabelField, actions);
    body.append(art, details);
    card.append(summary, body);
    dom.players.append(card);
  }

  const live = players.filter((p) => p.status === 'ready').length;
  dom.counts.textContent = `${live} live · ${players.length - live} draft`;
}

/** Ready players in the schedule's own category that have never been scheduled anywhere. */
function schedulablePlayers() {
  return players.filter(
    (p) => p.status === 'ready' && p.category === scheduleCategory && !usedPlayerIds.includes(p.id),
  );
}

/**
 * Wire up the searchable name picker for the schedule form, replacing a dropdown that won't
 * scale. Called once — the handlers read `players`/`usedPlayerIds`/`scheduleCategory` live on
 * every keystroke, so nothing needs re-wiring as the data changes.
 */
function initSchedulePicker() {
  const search = dom['schedule-player-search'];
  const idField = dom['schedule-player-id'];
  const results = dom['schedule-player-results'];

  // A name typed without picking a row must not carry over a stale selection.
  search.oninput = () => {
    idField.value = '';
    const query = search.value.trim().toLowerCase();
    const matches = query
      ? schedulablePlayers().filter((p) => p.name.toLowerCase().includes(query))
      : schedulablePlayers();

    results.innerHTML = '';
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'picker-empty';
      empty.textContent = schedulablePlayers().length === 0
        ? 'No unused ready players left in this category — publish more, or clear a schedule entry.'
        : 'No match.';
      results.append(empty);
    } else {
      for (const player of matches) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = player.name;
        button.onclick = () => {
          idField.value = player.id;
          search.value = player.name;
          results.hidden = true;
        };
        row.append(button);
        results.append(row);
      }
    }
    results.hidden = false;
  };

  search.onfocus = () => {
    if (search.value.trim()) search.oninput();
  };

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.picker')) results.hidden = true;
  });
}

/** Clear whatever was typed/picked in the schedule form — used when the category changes. */
function resetSchedulePicker() {
  dom['schedule-player-search'].value = '';
  dom['schedule-player-id'].value = '';
  dom['schedule-player-results'].hidden = true;
}

async function refresh() {
  const data = await api('/api/admin/players');
  players = data.players;
  hintLabels = data.hintLabels;
  renderPlayers();
  await refreshSchedule();
  await refreshInsightDates().catch(() => {});
}

async function refreshSchedule() {
  const { upcoming, today, stats, usedPlayerIds: used } = await api(
    `/api/admin/schedule?category=${scheduleCategory}`,
  );
  usedPlayerIds = used;
  dom.schedule.innerHTML = '';
  if (upcoming.length === 0) {
    dom.schedule.innerHTML = '<li class="empty">Nothing scheduled — days auto-fill from live players.</li>';
  }
  for (const entry of upcoming) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${entry.date}${entry.date === today ? ' (today)' : ''} — ${entry.name}`;
    const clear = document.createElement('button');
    clear.className = 'ghost';
    clear.textContent = 'Clear';
    clear.onclick = async () => {
      await api(`/api/admin/schedule/${entry.date}?category=${scheduleCategory}`, { method: 'DELETE' });
      await refreshSchedule();
    };
    row.append(label, clear);
    dom.schedule.append(row);
  }
  if (stats?.plays) {
    const row = document.createElement('li');
    row.className = 'empty';
    row.textContent = `Today: ${stats.plays} played, ${stats.wins ?? 0} solved.`;
    dom.schedule.append(row);
  }
}

/** Swap in new artwork for an existing player. */
function openImagePicker(player) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp,image/avif,image/svg+xml';
  picker.multiple = true;
  picker.onchange = async () => {
    const [first, second] = picker.files;
    if (!first) return;
    const form = new FormData();
    // One file replaces the silhouette; two replace silhouette then photo, in that order.
    form.append('silhouette', first);
    if (second) form.append('photo', second);
    try {
      await api(`/api/admin/players/${player.id}/images`, { method: 'POST', form });
      await refresh();
    } catch (error) {
      alert(error.message);
    }
  };
  picker.click();
}

// --- guess log -----------------------------------------------------------

function statRow(label, value) {
  const cell = document.createElement('div');
  const number = document.createElement('strong');
  number.textContent = String(value);
  const name = document.createElement('span');
  name.textContent = label;
  cell.append(number, name);
  return cell;
}

function guessList(title, items, render) {
  const block = document.createElement('div');
  block.className = 'insight-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  block.append(heading);

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint-text';
    empty.textContent = 'Nothing yet.';
    block.append(empty);
    return block;
  }

  const list = document.createElement('ul');
  list.className = 'insight-list';
  for (const item of items) list.append(render(item));
  block.append(list);
  return block;
}

async function renderInsights(date) {
  const params = new URLSearchParams({ category: insightCategory });
  if (date) params.set('date', date);
  const data = await api(`/api/admin/insights?${params}`);
  dom.insights.innerHTML = '';

  const { summary } = data;
  const figures = document.createElement('div');
  figures.className = 'insight-figures';
  figures.append(
    statRow('players', summary.players),
    statRow('solved', `${summary.solved} (${summary.solveRate}%)`),
    statRow('avg guesses', summary.averageGuesses),
    statRow('easy / hard', `${summary.modes.easy ?? 0} / ${summary.modes.hard ?? 0}`),
  );
  dom.insights.append(figures);

  if (summary.players === 0) {
    const none = document.createElement('p');
    none.className = 'hint-text';
    none.textContent = 'Nobody has played this one yet.';
    dom.insights.append(none);
    return;
  }

  // Near-misses first: these are the ones costing people the puzzle unfairly.
  dom.insights.append(
    guessList('Near misses — probably should have counted', data.nearMisses, (item) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${item.name} — ${item.count}×`;
      const add = document.createElement('button');
      add.className = 'ghost';
      add.textContent = 'Accept as alias';
      add.disabled = !data.player;
      add.onclick = async () => {
        add.disabled = true;
        add.textContent = 'Adding…';
        try {
          await api(`/api/admin/players/${data.player.id}`, {
            method: 'PATCH',
            body: { aliases: [...new Set([...data.player.aliases, item.name.toLowerCase()])] },
          });
          await refresh();
          await renderInsights(dom['insight-date'].value);
        } catch (error) {
          alert(error.message);
        }
      };
      row.append(label, add);
      return row;
    }),
  );

  dom.insights.append(
    guessList('Most common wrong guesses', data.wrongGuesses, (item) => {
      const row = document.createElement('li');
      row.textContent = `${item.name} — ${item.count}×`;
      return row;
    }),
  );

  const details = document.createElement('details');
  details.className = 'insight-block';
  const toggle = document.createElement('summary');
  toggle.textContent = `Full log (${data.log.length} rounds)`;
  details.append(toggle);
  const list = document.createElement('ul');
  list.className = 'insight-list insight-log';
  for (const round of data.log) {
    const row = document.createElement('li');
    const who = document.createElement('code');
    who.textContent = round.session;
    const what = document.createElement('span');
    what.textContent = round.guesses.join(' → ') || '(no guesses)';
    const outcome = document.createElement('span');
    outcome.className = round.won ? 'log-won' : 'log-lost';
    outcome.textContent = round.finished ? (round.won ? 'solved' : 'missed') : 'in progress';
    row.append(who, what, outcome);
    list.append(row);
  }
  details.append(list);
  dom.insights.append(details);
}

async function refreshInsightDates() {
  const { dates } = await api(`/api/admin/insights/dates?category=${insightCategory}`);
  const chosen = dom['insight-date'].value;
  dom['insight-date'].innerHTML = '';
  if (dates.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No plays yet';
    dom['insight-date'].append(option);
    dom.insights.innerHTML = '';
    return;
  }
  for (const entry of dates) {
    const option = document.createElement('option');
    option.value = entry.date;
    option.textContent = `${entry.date} — ${entry.players} player${entry.players === 1 ? '' : 's'}`;
    dom['insight-date'].append(option);
  }
  dom['insight-date'].value = dates.some((d) => d.date === chosen) ? chosen : dates[0].date;
  await renderInsights(dom['insight-date'].value);
}

// --- tracer --------------------------------------------------------------

const tracer = createTracer({
  stage: dom['tracer-stage'],
  svg: dom['tracer-svg'],
  preview: dom['tracer-preview'],
  onChange: (count) => {
    dom['tracer-save'].disabled = count < 3;
  },
});

function openTracer(player) {
  tracingPlayer = player;
  dom['tracer-title'].textContent = `Trace ${player.name}`;
  showError(dom['tracer-error'], '');
  if (player.photo) {
    dom['tracer-photo'].src = `/api/admin/players/${player.id}/photo`;
    dom['tracer-photo'].hidden = false;
  } else {
    dom['tracer-photo'].removeAttribute('src');
    dom['tracer-photo'].hidden = true;
    showError(dom['tracer-error'], 'No photo uploaded — you can still trace freehand.');
  }
  tracer.load();
  dom.tracer.showModal();
}

dom['tracer-smooth'].onchange = (e) => tracer.setSmooth(e.target.checked);
dom['tracer-undo'].onclick = () => tracer.undo();
dom['tracer-clear'].onclick = () => tracer.clear();
dom['tracer-dim'].oninput = (e) => {
  dom['tracer-photo'].style.opacity = String(e.target.value / 100);
};
dom['tracer-save'].onclick = async () => {
  const svg = tracer.toSvg();
  if (!svg) return;
  try {
    await api(`/api/admin/players/${tracingPlayer.id}`, {
      method: 'PATCH',
      body: { silhouette: svg },
    });
    dom.tracer.close();
    await refresh();
  } catch (error) {
    showError(dom['tracer-error'], error);
  }
};

// --- forms ---------------------------------------------------------------

dom['login-form'].onsubmit = async (event) => {
  event.preventDefault();
  showError(dom['login-error'], '');
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: dom.password.value } });
    dom.password.value = '';
    await start();
  } catch (error) {
    showError(dom['login-error'], error);
  }
};

dom.logout.onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' });
  location.reload();
};

dom['add-form'].onsubmit = async (event) => {
  event.preventDefault();
  showError(dom['add-error'], '');
  const form = new FormData();
  form.append('name', dom['new-name'].value.trim());
  form.append('category', dom['new-category'].value);
  if (dom['new-silhouette'].files[0]) form.append('silhouette', dom['new-silhouette'].files[0]);
  if (dom['new-photo'].files[0]) form.append('photo', dom['new-photo'].files[0]);
  const button = dom['add-form'].querySelector('button');
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    await api('/api/admin/players', { method: 'POST', form });
    dom['add-form'].reset();
    await refresh();
  } catch (error) {
    showError(dom['add-error'], error);
  } finally {
    button.disabled = false;
    button.textContent = 'Add';
  }
};

dom['schedule-form'].onsubmit = async (event) => {
  event.preventDefault();
  showError(dom['schedule-error'], '');
  const playerId = dom['schedule-player-id'].value;
  if (!playerId) {
    showError(dom['schedule-error'], 'Pick a player from the list first.');
    return;
  }
  try {
    await api(`/api/admin/schedule/${dom['schedule-date'].value}`, {
      method: 'PUT',
      body: { playerId: Number(playerId), category: scheduleCategory },
    });
    resetSchedulePicker();
    await refreshSchedule();
  } catch (error) {
    showError(dom['schedule-error'], error);
  }
};

dom['schedule-category'].onchange = async () => {
  scheduleCategory = dom['schedule-category'].value;
  resetSchedulePicker();
  await refreshSchedule();
};

dom['insight-category'].onchange = async () => {
  insightCategory = dom['insight-category'].value;
  await refreshInsightDates();
};

dom['insight-date'].onchange = () => renderInsights(dom['insight-date'].value);

// --- boot ----------------------------------------------------------------

async function start() {
  const { signedIn, storage, categories: fetched } = await api('/api/admin/session');
  dom.login.hidden = signedIn;
  dom.app.hidden = !signedIn;
  if (!signedIn) return;

  categories = fetched ?? [];
  scheduleCategory = categories[0];
  insightCategory = categories[0];
  fillCategorySelect(dom['new-category']);
  fillCategorySelect(dom['schedule-category']);
  fillCategorySelect(dom['insight-category']);
  dom['schedule-category'].value = scheduleCategory;
  dom['insight-category'].value = insightCategory;
  renderPlayerCategoryFilter();

  // The one failure that silently destroys work: writing to a disk that isn't persistent.
  const ephemeral = storage && storage.checked && !storage.mounted;
  dom['storage-alarm'].hidden = !ephemeral;
  if (ephemeral) {
    dom['storage-alarm'].textContent =
      `Data is not on a persistent disk (${storage.directory}). Anything you add here will be ` +
      `lost when the server restarts. Check that the volume is still mounted before adding players.`;
  }
  initSchedulePicker();
  dom['player-filter'].oninput = renderPlayers;
  await refresh();
}

start();

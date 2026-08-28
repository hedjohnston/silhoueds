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
    'archive-played', 'accounts',
  ].map((id) => [id, el(id)]),
);

let players = [];
// The fixed rungs each category plays with, plus every hint category invented so far.
let hintCatalog = { standard: [], ladders: {}, custom: [] };
let usedPlayerIds = [];
// The operator's own today, from the server — what makes a scheduled day "already run".
let today = null;
let tracingPlayer = null;
// Which player cards are expanded, so a re-render (e.g. after Save edits) doesn't collapse them.
const expandedPlayerIds = new Set();

// Premier League and The Rest are two independent daily games, distinguished only by this
// tag on each player. Populated from the server so the label list lives in one place.
//
// The labels are display only — the stored tag stays `international`, so renaming the game costs
// no migration and no change to any saved player, schedule row or play.
let categories = [];
const CATEGORY_LABELS = { 'premier-league': 'Premier League', international: 'The Rest' };
const categoryLabel = (category) => CATEGORY_LABELS[category] ?? category;

// 'all' or one category shows the working set; 'archived' is the only view that shows retired
// footballers, so a season's worth of spent players stays out of the way.
let playerFilter = 'all';
const ARCHIVED_FILTER = 'archived';
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

/**
 * What easy mode opens on: the reveal photo flattened to `brightness(0)`.
 *
 * Easy mode fills this shape in a step at a time rather than sharpening a blur, which works
 * because the photo is a background-removed cut-out — its own alpha is the silhouette. That makes
 * this preview the one place the failure is visible: a photo uploaded *without* a transparent
 * background flattens to a black rectangle rather than a figure, and the round would give the game
 * away on sight. Better to catch it here than on the day it runs.
 */
function buildEasyOpening(player) {
  if (!player.photo) return null;

  const wrap = document.createElement('div');
  wrap.className = 'player-art player-art-opening';

  const image = document.createElement('img');
  image.src = `/api/admin/players/${player.id}/photo`;
  image.alt = '';
  // The same filter game.js applies at step 0, so this is the player's actual first frame.
  image.style.filter = 'brightness(0)';

  const caption = document.createElement('span');
  caption.className = 'art-caption';
  caption.textContent = 'easy opens here';

  wrap.append(image, caption);
  return wrap;
}

/** The dropdown entry that swaps in a field for naming a category of your own. */
const WRITE_MY_OWN = '\u0000write-my-own';

/**
 * One hint slot: a dropdown naming the category, and the answer to it.
 *
 * Every slot offers the same choice — the standard categories this game uses, every category
 * invented on any card, and one more entry for naming a new one. Nothing is fixed to a position,
 * so a slot left empty is simply a hint the round doesn't have.
 */
function hintSlot({ label, value }, { offered, taken, onChange }) {
  const node = document.createElement('li');

  const choice = document.createElement('select');
  choice.className = 'hint-row-label';

  const typed = document.createElement('input');
  typed.className = 'hint-row-typed';
  typed.placeholder = 'Name your category';
  typed.hidden = true;

  const field = document.createElement('input');
  field.className = 'hint-row-value';
  field.value = value ?? '';
  field.placeholder = '—';

  const readLabel = () => (choice.value === WRITE_MY_OWN ? typed.value.trim() : choice.value);

  /**
   * Rebuild the menu, leaving out categories another slot has already taken.
   *
   * Two slots holding the same category would reveal one hint twice and waste a guess, so the
   * choice is removed rather than policed after the fact. A slot always keeps its own selection,
   * or picking it would remove it from under itself.
   */
  const renderOptions = () => {
    const chosen = choice.value;
    const mine = readLabel();
    const spoken = taken(node);
    choice.innerHTML = '';
    choice.append(new Option('Choose a category…', ''));
    for (const option of offered()) {
      if (!spoken.has(option) || option === mine) choice.append(new Option(option, option));
    }
    choice.append(new Option('Write a new one…', WRITE_MY_OWN));
    choice.value = chosen;
  };

  const settle = () => {
    const writing = choice.value === WRITE_MY_OWN;
    typed.hidden = !writing;
    // Naming a category but answering nothing stores nothing, so the pair travels together.
    node.classList.toggle('hint-row-custom', writing);
  };

  choice.onchange = () => {
    settle();
    if (choice.value === WRITE_MY_OWN) typed.focus();
    onChange();
  };
  typed.oninput = onChange;

  node.append(choice, field, typed);

  return {
    node,
    renderOptions,
    /** Show the stored label, which may be one being written that no menu lists yet. */
    fill: () => {
      renderOptions();
      if (label && ![...choice.options].some((option) => option.value === label)) {
        choice.value = WRITE_MY_OWN;
        typed.value = label;
      } else {
        choice.value = label ?? '';
      }
      settle();
    },
    focus: () => choice.focus(),
    read: () => ({ label: readLabel(), value: field.value.trim() }),
  };
}

/**
 * The hint editor: five slots, in the order the game reveals them.
 *
 * Five because a wrong guess releases a hint and there are six guesses — so there are only five
 * gaps between them, and a sixth hint would arrive with the answer rather than in time to be used.
 * Every slot is free choice, and the order they are left in is the order they are revealed in, so
 * the first slot is what a player earns for their first wrong guess. The count comes from the
 * server (`hints.max`), which owns it.
 */
function buildHintEditor(player, chosenCategory) {
  const list = document.createElement('ol');
  list.className = 'hint-rows';

  const caption = document.createElement('p');
  caption.className = 'hint-tally';
  caption.textContent = 'Revealed in this order, one per wrong guess';

  const max = hintCatalog.max ?? 5;
  let slots = [];

  /** Everything a slot may be set to: this game's standard categories, then the invented ones. */
  const offered = () => [
    ...(hintCatalog.ladders[chosenCategory()] ?? hintCatalog.standard),
    ...(hintCatalog.custom ?? []),
  ];

  const taken = (self) =>
    new Set(
      slots
        .filter((slot) => slot.node !== self)
        .map((slot) => slot.read().label)
        .filter(Boolean),
    );

  // One slot changing frees or spends a category for all the others, so every menu is rebuilt.
  const onChange = () => {
    for (const slot of slots) slot.renderOptions();
  };

  const read = () => {
    const hints = [];
    for (const slot of slots) {
      const hint = slot.read();
      if (hint.label && hint.value) hints.push(hint);
    }
    return hints;
  };

  const draw = (hints) => {
    list.innerHTML = '';
    slots = [];
    // A standard category this game has no use for cannot be kept; an invented one always can,
    // including one being written that no card has saved yet.
    const usable = new Set(offered());
    const kept = hints
      .filter((h) => h.label && (usable.has(h.label) || !hintCatalog.standard.includes(h.label)))
      .slice(0, max);

    for (let index = 0; index < max; index++) {
      const slot = hintSlot(kept[index] ?? { label: '', value: '' }, { offered, taken, onChange });
      slots.push(slot);
      list.append(slot.node);
    }
    for (const slot of slots) slot.fill();
  };

  draw(player.hints);

  // There is nothing to add: the slots are always all present, filled or not.
  return {
    list,
    caption,
    // Switching a player's category switches which standard categories are on offer.
    recategorise: () => draw(read()),
    read,
  };
}

function renderPlayerCategoryFilter() {
  dom['player-category-filter'].innerHTML = '';
  const archivedCount = players.filter((p) => p.archived).length;
  for (const value of ['all', ...categories, ARCHIVED_FILTER]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = value === playerFilter ? 'filter-chip filter-chip-active' : 'filter-chip';
    if (value === 'all') button.textContent = 'All';
    else if (value === ARCHIVED_FILTER) button.textContent = `Archived (${archivedCount})`;
    else button.textContent = categoryLabel(value);
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
  // Archived footballers show in their own view and nowhere else — that is what archiving buys.
  const visible = players
    .filter((p) => !query || p.name.toLowerCase().includes(query))
    .filter((p) =>
      playerFilter === ARCHIVED_FILTER
        ? p.archived
        : !p.archived && (playerFilter === 'all' || p.category === playerFilter));

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

    // When they had their day, so a spent footballer is obvious without opening the card.
    if (player.lastScheduled) {
      const ran = document.createElement('span');
      const past = player.lastScheduled <= today;
      ran.className = past ? 'chip chip-ran' : 'chip chip-queued';
      ran.textContent = `${past ? 'Ran' : 'Booked'} ${player.lastScheduled}`;
      summary.append(ran);
    }
    if (player.archived) {
      const archived = document.createElement('span');
      archived.className = 'chip chip-archived';
      archived.textContent = 'Archived';
      summary.append(archived);
    }

    const body = document.createElement('div');
    body.className = 'player-body';

    const art = buildArt(player);

    const details = document.createElement('div');
    details.className = 'player-details';

    const categoryField = document.createElement('select');
    categoryField.className = 'category-select';
    fillCategorySelect(categoryField);
    categoryField.value = player.category;

    const hintEditor = buildHintEditor(player, () => categoryField.value);
    // Each game has its own ladder, so moving a player between them redraws their rungs at once
    // rather than after a save-and-reload.
    categoryField.onchange = () => hintEditor.recategorise();

    const aliasField = document.createElement('input');
    aliasField.className = 'aliases';
    aliasField.value = player.aliases.join(', ');
    aliasField.placeholder = 'Accepted spellings, comma separated';

    const aliasLabel = document.createElement('label');
    aliasLabel.className = 'alias-label';
    aliasLabel.textContent = 'Also accepted';
    aliasLabel.append(aliasField);

    // Any link the admin might paste — watch, share, shorts, embed — or a bare video id; the
    // server does the parsing and rejects anything it doesn't recognise as YouTube.
    const videoField = document.createElement('input');
    videoField.className = 'aliases';
    videoField.value = player.video_id ?? '';
    videoField.placeholder = 'YouTube link — a goal, a moment (optional)';

    const videoLabel = document.createElement('label');
    videoLabel.className = 'alias-label';
    videoLabel.textContent = 'Video, shown with the reveal';
    videoLabel.append(videoField);

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
      try {
        await api(`/api/admin/players/${player.id}`, {
          method: 'PATCH',
          body: {
            hints: hintEditor.read(),
            category: categoryField.value,
            aliases: aliasField.value.split(',').map((a) => a.trim()).filter(Boolean),
            videoUrl: videoField.value.trim(),
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

    // Archiving is the gentle version of Delete: the footballer keeps every round they ran, and
    // simply stops being a candidate for another one.
    const archive = document.createElement('button');
    archive.className = 'ghost';
    archive.textContent = player.archived ? 'Restore' : 'Archive';
    archive.onclick = async () => {
      try {
        await api(`/api/admin/players/${player.id}`, {
          method: 'PATCH',
          body: { archived: !player.archived },
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

    actions.append(replace, trace, save, publish, archive, remove);
    details.append(hintEditor.list, hintEditor.caption, aliasLabel, videoLabel, categoryLabelField, actions);
    const opening = buildEasyOpening(player);
    body.append(art, ...(opening ? [opening] : []), details);
    card.append(summary, body);
    dom.players.append(card);
  }

  const active = players.filter((p) => !p.archived);
  const live = active.filter((p) => p.status === 'ready').length;
  const archived = players.length - active.length;
  dom.counts.textContent =
    `${live} live · ${active.length - live} draft` + (archived ? ` · ${archived} archived` : '');
  renderArchivePlayed();
}

/** Everyone whose day has passed and who is still cluttering up the live list. */
function playedButActive() {
  return players.filter((p) => !p.archived && p.lastScheduled && p.lastScheduled <= today);
}

function renderArchivePlayed() {
  const spent = playedButActive().length;
  dom['archive-played'].disabled = spent === 0;
  dom['archive-played'].textContent = spent === 0 ? 'Archive played' : `Archive ${spent} played`;
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
  hintCatalog = data.hints;
  today = data.today;
  renderPlayerCategoryFilter();
  renderPlayers();
  await refreshSchedule();
  await refreshInsightDates().catch(() => {});
  await refreshAccounts().catch(() => {});
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

async function refreshAccounts() {
  const { users: accounts } = await api('/api/admin/users');
  dom.accounts.innerHTML = '';
  if (accounts.length === 0) {
    dom.accounts.innerHTML = '<li class="empty">Nobody has signed in yet.</li>';
    return;
  }
  for (const account of accounts) {
    const row = document.createElement('li');

    const who = document.createElement('span');
    who.className = 'account-who';
    const name = document.createElement('span');
    name.textContent = account.name || '(no name given)';
    const email = document.createElement('span');
    email.className = 'account-email';
    email.textContent = account.email || '(no email given)';
    who.append(name, email);

    const remove = document.createElement('button');
    remove.className = 'ghost danger';
    remove.textContent = 'Delete';
    remove.onclick = async () => {
      if (!confirm(`Delete this account and everything it's played? This cannot be undone.`)) return;
      await api(`/api/admin/users/${account.id}`, { method: 'DELETE' });
      await refreshAccounts();
    };

    row.append(who, remove);
    dom.accounts.append(row);
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

dom['archive-played'].onclick = async () => {
  const spent = playedButActive();
  if (spent.length === 0) return;
  if (!confirm(`Archive ${spent.length} footballer(s) whose day has already been and gone?`)) return;
  try {
    await api('/api/admin/players/archive-played', { method: 'POST' });
    await refresh();
  } catch (error) {
    alert(error.message);
  }
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

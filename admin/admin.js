import { createTracer } from './trace.js';

const el = (id) => document.getElementById(id);
const dom = Object.fromEntries(
  [
    'login', 'login-form', 'login-error', 'password', 'app', 'logout', 'claude-state',
    'add-form', 'new-name', 'new-photo', 'new-silhouette', 'add-error', 'players', 'counts',
    'schedule-form', 'schedule-date', 'schedule-player', 'schedule', 'schedule-error',
    'tracer', 'tracer-title', 'tracer-stage', 'tracer-photo', 'tracer-svg', 'tracer-preview',
    'tracer-smooth', 'tracer-dim', 'tracer-undo', 'tracer-clear', 'tracer-save', 'tracer-error',
    'tracer-auto', 'tracer-threshold', 'seg-state', 'storage-alarm',
  ].map((id) => [id, el(id)]),
);

let players = [];
let hintLabels = [];
let tracingPlayer = null;
let segmentation = { available: false };

async function api(path, { method = 'GET', body, form } = {}) {
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

function renderPlayers() {
  dom.players.innerHTML = '';
  for (const player of players) {
    const card = document.createElement('li');
    card.className = 'player';

    const head = document.createElement('div');
    head.className = 'player-head';
    const title = document.createElement('h3');
    title.textContent = player.name;
    const chip = document.createElement('span');
    chip.innerHTML = statusChip(player);
    head.append(title, chip);

    const body = document.createElement('div');
    body.className = 'player-body';

    const art = document.createElement('div');
    art.className = 'player-art';
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

    const source = document.createElement('p');
    source.className = 'source';
    source.textContent =
      player.hint_source === 'claude' ? 'Hints drafted by Claude — review before publishing.' : '';

    const actions = document.createElement('div');
    actions.className = 'player-actions';

    const generate = document.createElement('button');
    generate.className = 'ghost';
    generate.textContent = 'Generate hints with Claude';
    generate.onclick = async () => {
      generate.disabled = true;
      generate.textContent = 'Asking Claude…';
      try {
        const { note } = await api(`/api/admin/players/${player.id}/hints`, { method: 'POST' });
        await refresh();
        if (note) alert(`Claude noted: ${note}`);
      } catch (error) {
        alert(error.message);
        generate.disabled = false;
        generate.textContent = 'Generate hints with Claude';
      }
    };

    const replace = document.createElement('button');
    replace.className = 'ghost';
    replace.textContent = 'Replace images';
    replace.onclick = () => openImagePicker(player);

    const auto = document.createElement('button');
    auto.className = 'ghost';
    auto.textContent = 'Auto-cut from photo';
    auto.disabled = !player.photo || !segmentation.available;
    auto.title = !player.photo
      ? 'This player has no reference photo.'
      : segmentation.available
        ? 'Cut the player out of their photo automatically.'
        : 'Automatic silhouettes are unavailable — see the note at the top.';
    auto.onclick = async () => {
      auto.disabled = true;
      auto.textContent = 'Tracing…';
      try {
        await api(`/api/admin/players/${player.id}/silhouette`, { method: 'POST' });
        await refresh();
      } catch (error) {
        alert(error.message);
        auto.disabled = false;
        auto.textContent = 'Make silhouette from photo';
      }
    };

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

    actions.append(replace, auto, generate, trace, save, publish, remove);
    details.append(hints, aliasLabel, source, actions);
    body.append(art, details);
    card.append(head, body);
    dom.players.append(card);
  }

  const live = players.filter((p) => p.status === 'ready').length;
  dom.counts.textContent = `${live} live · ${players.length - live} draft`;

  dom['schedule-player'].innerHTML = '';
  for (const player of players.filter((p) => p.status === 'ready')) {
    const option = document.createElement('option');
    option.value = player.id;
    option.textContent = player.name;
    dom['schedule-player'].append(option);
  }
}

async function refresh() {
  const data = await api('/api/admin/players');
  players = data.players;
  hintLabels = data.hintLabels;
  renderPlayers();
  await refreshSchedule();
}

async function refreshSchedule() {
  const { upcoming, today, stats } = await api('/api/admin/schedule');
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
      await api(`/api/admin/schedule/${entry.date}`, { method: 'DELETE' });
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

dom['tracer-auto'].onclick = async () => {
  const button = dom['tracer-auto'];
  button.disabled = true;
  button.textContent = 'Tracing…';
  showError(dom['tracer-error'], '');
  try {
    await api(`/api/admin/players/${tracingPlayer.id}/silhouette`, {
      method: 'POST',
      body: { threshold: Number(dom['tracer-threshold'].value) / 100 },
    });
    dom.tracer.close();
    await refresh();
  } catch (error) {
    showError(dom['tracer-error'], error);
  } finally {
    button.disabled = false;
    button.textContent = 'Auto-trace at this cut-off';
  }
};

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
  if (dom['new-silhouette'].files[0]) form.append('silhouette', dom['new-silhouette'].files[0]);
  if (dom['new-photo'].files[0]) form.append('photo', dom['new-photo'].files[0]);
  const button = dom['add-form'].querySelector('button');
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    const { steps } = await api('/api/admin/players', { method: 'POST', form });
    dom['add-form'].reset();
    await refresh();
    const problems = Object.entries(steps ?? {})
      .filter(([, value]) => value !== 'done')
      .map(([step, value]) => `${step}: ${value}`);
    showError(dom['add-error'], problems.join(' · '));
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
  try {
    await api(`/api/admin/schedule/${dom['schedule-date'].value}`, {
      method: 'PUT',
      body: { playerId: Number(dom['schedule-player'].value) },
    });
    await refreshSchedule();
  } catch (error) {
    showError(dom['schedule-error'], error);
  }
};

// --- boot ----------------------------------------------------------------

async function start() {
  const { signedIn, claudeConfigured, segmentation: seg, storage } = await api('/api/admin/session');
  segmentation = seg ?? { available: false };
  dom.login.hidden = signedIn;
  dom.app.hidden = !signedIn;
  if (!signedIn) return;

  dom['claude-state'].textContent = claudeConfigured ? 'Claude connected' : 'No ANTHROPIC_API_KEY set';
  dom['claude-state'].className = `claude-state ${claudeConfigured ? 'ok' : 'warn'}`;

  // The one failure that silently destroys work: writing to a disk that isn't persistent.
  const ephemeral = storage && storage.checked && !storage.mounted;
  dom['storage-alarm'].hidden = !ephemeral;
  if (ephemeral) {
    dom['storage-alarm'].textContent =
      `Data is not on a persistent disk (${storage.directory}). Anything you add here will be ` +
      `lost when the server restarts. Check that the volume is still mounted before adding players.`;
  }

  dom['seg-state'].textContent = segmentation.available
    ? 'Auto silhouettes on'
    : segmentation.modulesInstalled
      ? 'No model — run: npm run fetch-model'
      : 'Auto silhouettes off — onnxruntime-node not installed';
  dom['seg-state'].className = `claude-state ${segmentation.available ? 'ok' : 'warn'}`;
  await refresh();
}

start();

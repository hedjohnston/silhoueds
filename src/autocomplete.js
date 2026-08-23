// Name normalisation and the guess typeahead.

/** Fold a name to a comparable key: lowercase, accent-free, alphanumerics only. */
export function normalize(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** True if `guess` names `player` — matching the full name or any listed alias. */
export function matchesPlayer(guess, player) {
  const key = normalize(guess);
  if (!key) return false;
  return [player.name, ...(player.aliases ?? [])].some((name) => normalize(name) === key);
}

/** Roster names matching `query`, prefix matches first, capped at `limit`. */
export function suggest(query, names, limit = 6) {
  const key = normalize(query);
  if (!key) return [];
  const prefix = [];
  const contains = [];
  for (const name of names) {
    const candidate = normalize(name);
    if (candidate.startsWith(key)) prefix.push(name);
    else if (candidate.includes(key)) contains.push(name);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * Wires a text input to a suggestion list: arrow keys move the active item, Enter picks it
 * (or submits the raw text when nothing is active), Escape closes the list.
 */
export function attachTypeahead({ input, list, names, onSubmit }) {
  let active = -1;

  const close = () => {
    list.innerHTML = '';
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const render = () => {
    const options = suggest(input.value, names);
    if (options.length === 0) return close();
    list.innerHTML = '';
    options.forEach((name, i) => {
      const item = document.createElement('li');
      item.id = `suggestion-${i}`;
      item.className = 'suggestion';
      item.role = 'option';
      item.textContent = name;
      item.setAttribute('aria-selected', String(i === active));
      // mousedown, not click: it fires before the input loses focus.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        input.value = name;
        close();
        onSubmit(name);
      });
      list.append(item);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const highlight = (next) => {
    const items = [...list.children];
    if (items.length === 0) return;
    active = (next + items.length) % items.length;
    items.forEach((item, i) => item.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', items[active].id);
  };

  input.addEventListener('input', () => {
    active = -1;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (list.hidden) render();
      highlight(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = active >= 0 ? list.children[active].textContent : input.value;
      close();
      onSubmit(chosen);
    } else if (event.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  return { close };
}

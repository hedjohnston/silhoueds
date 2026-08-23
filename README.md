# Silhoueds

A daily guessing game: name the footballer from their silhouette.

One player per day, six guesses. Every wrong guess (or a skip) reveals the next hint —
position, nationality, era, league, then the club they're best known for. Finish and you get a
shareable emoji grid.

## Running it

Static site, no build step and no runtime dependencies. Serve the folder over HTTP:

```sh
python3 -m http.server 8000    # or: npx serve .
```

then open <http://localhost:8000>. It needs a server rather than `file://` because it loads
ES modules and JSON with `fetch`. It deploys to GitHub Pages as-is.

### Or build a single file

To get a copy that opens by double-clicking, with no server at all:

```sh
node tools/build-standalone.mjs
```

That writes `dist/silhoueds.html` — the whole game in one file, with the data and silhouettes
embedded and handed to the unchanged game code by a small `fetch` shim. Handy for sharing a
playable copy. Rebuild it after changing anything under `src/`, `data/` or `public/`.

## How a round works

- The puzzle is keyed to the UTC date. Days are grouped into cycles the size of the player pool
  and each cycle is a fresh deterministic shuffle, so everyone gets the same player on the same
  day and nobody repeats until the whole pool has been used (`src/puzzle.js`).
- Guesses are matched accent- and punctuation-insensitively against the player's name and their
  aliases, so `CR7`, `Ibrahimović` and `ibrahimovic` all land (`src/autocomplete.js`).
- Progress is kept in `localStorage` under one key, scoped to the date — a reload restores the
  board rather than handing out fresh guesses.

## Adding a player

Silhouettes are original hand-drawn SVG, traced from a reference photo. That keeps the artwork
ours rather than a cut-out of someone's copyrighted image.

1. Drop the reference photo in `assets/source/` (this folder is git-ignored — source photos
   stay out of the repo).
2. Build a tracing page:

   ```sh
   node tools/trace-helper.mjs assets/source/your-photo.jpg
   ```

   It writes a self-contained HTML file: the photo scaled into the silhouette's 400×600 viewBox,
   under a labelled coordinate grid, with a live cursor readout and a contrast toggle. Open it and
   read coordinates straight off the pose.
3. Draw the outline as a single `<g fill="currentColor" stroke="currentColor">` on that same
   400×600 viewBox and save it to `public/silhouettes/<slug>.svg`. Use `currentColor` throughout —
   the game tints the silhouette on the reveal, which only works if the SVG inherits colour.
   Thick round-capped strokes make good limbs; keep a visible gap between arms and torso or the
   figure reads as a blob.
4. Add the entry to `data/players.json`:

   ```json
   {
     "id": "player-slug",
     "name": "Player Name",
     "aliases": ["nickname", "surname"],
     "silhouette": "public/silhouettes/player-slug.svg",
     "hints": [
       { "label": "Position", "value": "Forward" },
       { "label": "Nationality", "value": "Brazil" },
       { "label": "Era", "value": "1994 – 2011" },
       { "label": "League", "value": "La Liga & Serie A" },
       { "label": "Best known at", "value": "Barcelona" }
     ]
   }
   ```

   Hints are shown in array order, so go from vaguest to most giveaway. Five hints matches the
   six-guess ladder; fewer is fine, extras are ignored.
5. Add the name to `data/roster.json` too. That list is what the guess autocomplete offers — it's
   deliberately a superset of the playable players so the suggestions never narrow down the answer.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css` | Page shell and styling |
| `src/game.js` | Round state machine — guesses, hint reveal, win/lose, share text |
| `src/puzzle.js` | Date seeding and `localStorage` persistence |
| `src/autocomplete.js` | Name normalisation, matching, typeahead |
| `data/players.json` | Playable players and their hints |
| `data/roster.json` | Names offered by the autocomplete |
| `public/silhouettes/` | The artwork |
| `tools/trace-helper.mjs` | Photo → tracing page |
| `tools/build-standalone.mjs` | Bundles the game into one self-contained HTML file |

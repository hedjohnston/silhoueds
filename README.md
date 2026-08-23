# Silhoueds

A daily guessing game: name the footballer from their silhouette.

One player per day, six guesses. Every wrong guess (or a skip) reveals the next hint — position,
nationality, era, league, then the club they're best known for. Finish and you get a shareable
emoji grid.

There is no dropdown of names. Players type a guess freely, and the server decides whether it's
right — the browser never receives the answer until the round is over.

## Running it

Needs Node 22.5 or newer (`node -v`) — the SQLite storage is built into Node from that version.

```sh
npm install
cp .env.example .env          # then fill in the two required values
npm run seed                  # loads the three starter players
npm start
```

`.env` is read automatically at startup. Anything already set in your shell wins over it.

Game at <http://localhost:3000>, admin at <http://localhost:3000/admin>.

Two environment variables are required and the server refuses to boot without them:

| Variable | What it's for |
| --- | --- |
| `SILHOUEDS_SECRET` | Signs the admin and play-session cookies |
| `SILHOUEDS_ADMIN_PASSWORD` | The password for `/admin` |
| `ANTHROPIC_API_KEY` | Optional — only for generating hints with Claude |

Storage is a SQLite file at `data/silhoueds.db`, via `node:sqlite` — built into Node 22.5+, so
there is no native module to compile. Uploaded photos live in `data/uploads/`. Neither directory
is web-served; back up both to keep your players.

## Adding a footballer

In the admin, type the name, choose a photo, press **Add**. That one step does the rest:

- **The silhouette is cut out of the photo automatically** — U^2-Net runs locally through
  onnxruntime, the largest subject is kept, and the outline is traced and simplified into an
  SVG path. About half a second per photo. Nothing is uploaded anywhere.
- **Claude drafts the hints and accepted spellings** from the name.

Both land on a draft for you to review. **Publish** is refused until a player has artwork and at
least one hint.

If the cut-out isn't right, open **Touch up by hand**: nudge the cut-off slider and re-run the
auto-trace, or click points around the outline yourself. Full-body photos with the player clear
of the background give the best results; a busy crowd behind them is fine.

### What is sent to Claude

Only the name you typed. The reference photo is never sent — you already know who the player is,
so there is nothing to identify, and keeping photos out of the request avoids using the model for
face recognition. Segmentation is entirely local, so photos never leave your machine at all.
Claude is asked to report `known: false` rather than invent a career for a name it doesn't
recognise.

### If automatic silhouettes are unavailable

`onnxruntime-node` and `sharp` are **optional** dependencies, and the model is fetched on install.
If either step fails, the app still runs — the admin says so at the top and hand-tracing still
works. To retry the model download:

```sh
npm run fetch-model
```

The model is U^2-Net (u2netp, 4.4 MB, Apache-2.0), verified by checksum on download and stored in
`models/`, which is git-ignored.

## Guess matching

With no dropdown, guesses have to be forgiving. `server/matching.mjs` folds accents, punctuation
and casing, then allows a small edit distance that scales with name length — so `Ibrahimović`,
`ibrahimovic` and `Ibrahimovic` all match, and a one-letter slip in a long name is accepted with a
note that the spelling was off. Short names stay strict, so `Pepe` never matches `Pele`.

Each player also carries an alias list (surname alone, nicknames, common misspellings), which
Claude drafts and you can edit.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.mjs` | Express app — serves the game, the admin and the API |
| `server/db.mjs` | SQLite schema and queries |
| `server/game.mjs` | Round logic: scheduling, hint reveal, win/lose |
| `server/matching.mjs` | Name normalisation and fuzzy matching |
| `server/claude.mjs` | Hint generation via the Claude API |
| `server/auth.mjs` | Signed admin and play-session cookies |
| `server/routes-game.mjs`, `server/routes-admin.mjs` | HTTP endpoints |
| `server/seed.mjs` | Loads the three starter players |
| `public/` | The game the players see |
| `admin/` | Admin UI, including the silhouette editor |
| `server/segment.mjs` | Photo to silhouette: local segmentation |
| `server/vectorise.mjs` | Mask to SVG: component pick, boundary trace, simplify |
| `tools/fetch-model.mjs` | Downloads the segmentation model |

## API

Public:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/puzzle` | Today's silhouette, earned hints, guesses so far |
| `POST /api/guess` | `{ guess }` → updated state; the answer only once the round ends |
| `POST /api/skip` | Burns a guess to reveal a hint |

Admin (all behind a signed cookie except `/login`): `POST /api/admin/login`, `GET|POST
/api/admin/players`, `POST /api/admin/players/:id/hints`, `PATCH|DELETE /api/admin/players/:id`,
`POST /api/admin/players/:id/silhouette`, `GET /api/admin/players/:id/photo`,
`GET|PUT|DELETE /api/admin/schedule[/:date]`.

## Deploying

One process, one SQLite file — it runs anywhere Node does. Set the environment variables, put it
behind TLS, and set `NODE_ENV=production` so cookies are marked `secure`. Persist `data/` across
deploys, or you lose your players and their artwork.

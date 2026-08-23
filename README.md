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
| `SILHOUEDS_TIMEZONE` | Optional — fallback zone, default `UTC` (see below) |
| `SILHOUEDS_PUBLIC_URL` | Optional — only behind a proxy that rewrites the host |

Storage is a SQLite file at `data/silhoueds.db`, via `node:sqlite` — built into Node 22.5+, so
there is no native module to compile. Uploaded photos live in `data/uploads/`. Neither directory
is web-served; back up both to keep your players.

## Adding a footballer

In the admin, type the name and upload two images:

| Image | What it is |
| --- | --- |
| **Silhouette** | The puzzle itself — what players see and guess from |
| **Full photo** | Revealed in place of the silhouette once the round ends |

Claude drafts the hints and the accepted spellings from the name. Everything lands on a draft;
**Publish** is refused until a player has artwork and at least one hint. Use **Replace images** to
swap either image later.

For a player you have no silhouette image for, **Trace by hand** in the admin lets you click an
outline around the photo instead.

The full photo is served only to a visitor whose round is already over — before that the endpoint
returns 403, so it cannot be fetched early to look up the answer. Neither image is reachable by
guessing a path; both go through the API.

### What is sent to Claude

Only the name you typed. The reference photo is never sent — you already know who the player is,
so there is nothing to identify, and keeping photos out of the request avoids using the model for
face recognition. Your images never leave your machine at all. Claude is asked to report
`known: false` rather than invent a career for a name it doesn't recognise.

## What players get

- **Hints** arrive one per miss, in a fixed ladder, shown in a panel that counts them off.
- **Stats** — played, win rate, current and best streak, and the spread of guesses used on wins.
  Held per browser against the anonymous session cookie; there is no cross-player leaderboard.
- **Past puzzles** — an archive of days that actually ran, so someone joining late can catch up.
  A future date is refused, and a past date that never ran is refused rather than assigned on
  demand, which would quietly burn through the pool.
- **Sharing** — the result grid carries the site link, and the page has `og:`/`twitter:` tags so
  a pasted link previews with `public/preview.png`. That image is a figure drawn for the purpose,
  never a player in rotation, so sharing can't spoil a puzzle. The tags need an absolute URL and
  scrapers don't run JavaScript, so `server/index.mjs` serves `/` through a substitution rather
  than as a static file.

## Guess matching

With no dropdown, guesses have to be forgiving. `server/matching.mjs` folds accents, punctuation
and casing, then allows a small edit distance that scales with name length — so `Ibrahimović`,
`ibrahimovic` and `Ibrahimovic` all match, and a one-letter slip in a long name is accepted with a
note that the spelling was off. Short names stay strict, so `Pepe` never matches `Pele`.

Each player also carries an alias list (surname alone, nicknames, common misspellings), which
Claude drafts and you can edit.

## Look

The player-facing design follows Minute Cryptic: an off-white ground, pastel colour blocks,
heavy black outlines with a hard offset shadow, Sansita for display and Mulish for text, all
loaded from Google Fonts. It is light-mode only and paints its own colours rather than following
the viewer's system theme.

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

## API

Public:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/puzzle` | Today's silhouette, earned hints, guesses so far. `?date=` plays an archived day |
| `POST /api/guess` | `{ guess }` → updated state; the answer only once the round ends |
| `POST /api/skip` | Burns a guess to reveal a hint |
| `GET /api/stats` | This visitor's played, win rate, streaks and guess distribution |
| `GET /api/archive` | Past puzzles and how this visitor did on each |

Admin (all behind a signed cookie except `/login`): `POST /api/admin/login`, `GET|POST
/api/admin/players`, `POST /api/admin/players/:id/hints`, `PATCH|DELETE /api/admin/players/:id`,
`POST /api/admin/players/:id/silhouette`, `GET /api/admin/players/:id/photo`,
`GET|PUT|DELETE /api/admin/schedule[/:date]`.

## Deploying

The game needs a real server with a **persistent disk** — there is a SQLite database and a folder
of uploaded images. Static hosts and serverless platforms (Vercel, Netlify, GitHub Pages) cannot
run it: their filesystems are read-only or wiped between requests, so the game would lose every
player you add.

Everything lives in one directory, set by two variables:

| Variable | Default | Set it to |
| --- | --- | --- |
| `SILHOUEDS_DB` | `data/silhoueds.db` | a path on the persistent disk |
| `SILHOUEDS_UPLOADS` | `data/uploads` | a folder on the same disk |

Back that directory up. It is the whole game.

**A missing volume does not announce itself.** `server/db.mjs` creates the directory if it is
absent, so the game runs perfectly and then loses everything on the next restart or deploy. Two
guards exist for exactly that: a loud warning in the startup logs, and a red banner across the top
of the admin. If you see either, stop adding players and fix the mount first — `fly launch`
rewriting `fly.toml` and dropping its `[[mounts]]` block is the usual cause. Check with:

```sh
fly volumes list                      # a volume should exist and be attached
fly ssh console -C "df -h /data"      # /data should be its own filesystem, not the root overlay
grep -A2 'mounts' fly.toml            # the [[mounts]] block must still be there
```

Set `SILHOUEDS_ACCEPT_EPHEMERAL=true` only if the data really is disposable.

### Fly.io

`Dockerfile` and `fly.toml` are ready to go. With the [flyctl CLI](https://fly.io/docs/flyctl/install/)
installed:

```sh
fly launch --no-deploy            # pick a name; keep the existing fly.toml when asked
fly volumes create silhoueds_data --size 1        # the persistent disk
fly secrets set \
  SILHOUEDS_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  SILHOUEDS_ADMIN_PASSWORD='pick-a-strong-password' \
  ANTHROPIC_API_KEY='sk-ant-...'
fly deploy
fly scale count 1                 # exactly one machine — see below
```

Then seed the starter players once:

```sh
fly ssh console -C "node --disable-warning=ExperimentalWarning /app/server/seed.mjs"
```

The game is at `https://<your-app>.fly.dev`, the admin at `/admin`.

**Run exactly one machine.** The database is a SQLite file on a single volume, so a second
machine would serve its own separate copy of the game.

### Anywhere else

The `Dockerfile` is generic — it works on Railway, Render, a VPS, or anything that runs a
container. Whatever you use:

- Mount a persistent volume at `/data` (the image already points both paths there).
- Set `SILHOUEDS_SECRET`, `SILHOUEDS_ADMIN_PASSWORD`, and `ANTHROPIC_API_KEY`.
- Serve it over HTTPS. `NODE_ENV=production` is set in the image, which marks the cookies
  `Secure` — over plain HTTP browsers will drop them and nobody will stay signed in.
- Run one instance.

Without Docker, any host with Node 22.5+ works: clone, `npm ci`, set the variables, `npm start`,
and put a reverse proxy with TLS in front.

### Before you publish

- Change `SILHOUEDS_ADMIN_PASSWORD` from anything you have used locally. `/admin` is protected by
  that password alone.
- Add a few players and schedule them, so visitors do not land on an empty puzzle.
- Check the game at `/` in a private window — that is what everyone else sees.

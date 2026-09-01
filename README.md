# Silhoueds

A daily guessing game: name the footballer from their silhouette.

Two independent daily puzzles run side by side — Premier League and The Rest — each its own
schedule, streak and stats, switched with a tab in the game. One player per puzzle per day, six
guesses. Every wrong guess (or a skip) reveals the next hint — era, position, league, nationality,
then the club they're best known for. Finish and you get a shareable emoji grid.

(The Rest is filed under `international` in the database and the API. Only the label changed.)

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
| `SILHOUEDS_TIMEZONE` | Optional — fallback zone, default `Australia/Sydney` |
| `SILHOUEDS_ACCEPT_EPHEMERAL` | Optional — silences the persistent-disk warning |
| `SILHOUEDS_PUBLIC_URL` | Optional — only behind a proxy that rewrites the host |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional — enables "Sign in with Google"; leave both unset to run anonymous-only |

Storage is a SQLite file at `data/silhoueds.db`, via `node:sqlite` — built into Node 22.5+, so
there is no native module to compile. Uploaded photos live in `data/uploads/`. Neither directory
is web-served; back up both to keep your players.

## Adding a footballer

In the admin, type the name and upload the photo:

| Image | What it is |
| --- | --- |
| **Full photo** | Revealed in place of the silhouette once the round ends |
| **Silhouette** | The puzzle itself — what players see and guess from. Optional: made from the photo |

The photos this game uses are cut-outs — the player against nothing — so the shape is already in
the file's own alpha channel, and the silhouette is that shape painted black. Upload a cut-out PNG
as the photo and the silhouette is made from it on the spot (`server/silhouette.mjs`, PNG in and
PNG out through `node:zlib`, no image library). The silhouette field then only exists for
overriding that, and an uploaded one always wins.

Nothing is derived from a photo that can't give a real shape — a JPEG, which has no alpha, or a
photo with its background still on, which would come out a solid black rectangle. Those leave the
player with no silhouette, which **Publish** already refuses, rather than a puzzle nobody could
win. Replacing the photo later leaves an existing silhouette alone, so a traced or uploaded one is
never quietly thrown away; clear it first to have a new photo make one.

`node tools/make-silhouette.mjs <cut-out.png>` runs the same code from the command line, for
seeing what an image will give before it goes near the site.

The first and last name are filled into **Also accepted** when the player is created, so either
half counts as an answer without typing them in. They are ordinary aliases from then on — a first
name half the league shares is worth deleting, and a particle stays with the surname it belongs to
(`David de Gea` gives `David` and `de Gea`). Add the hints by hand once the player is created.
**Publish** is refused until a player has artwork and at least one hint their game actually
reveals. Use **Replace images** to swap either image later.

Hints are **six numbered slots**, and the order you leave them in is the order they are revealed
in — slot 1 is what a player earns for their first wrong guess. Six because hard mode releases one
per wrong guess and there are only six guesses, so a seventh could never be reached.

Every slot is a dropdown offering the same thing: the standard categories, every category invented
on any card (one list, shared by both games), and **Write a new one…** to name one that isn't there
yet. Nothing is pinned to a position — put nationality first if you want the puzzle over quickly,
or last if you don't.

A Premier League player is never offered **League**: every player in that game is in that league,
so the hint would burn a guess for nothing. Moving a player between games re-offers the slots on
the spot, and a League hint stored before the split is ignored by the game immediately.

A category already used on a card disappears from the other five menus, since the same hint twice
would waste a guess. The API is the backstop for both that and the six-slot cap, refusing an
over-full or repeating save rather than storing hints nothing can reveal.

**Archive** retires a footballer who has had their day: they leave the player list, they stop
being a candidate for another round, and every day they already ran still plays. **Archive played**
does the whole backlog in one click — everyone whose scheduled date has passed, leaving anyone
still booked ahead alone. Both are reversible with **Restore**, from the **Archived** filter.

For a player you have no silhouette image for, **Trace by hand** in the admin lets you click an
outline around the photo instead.

The full photo is served only to a visitor whose round is already over — before that the endpoint
returns 403, so it cannot be fetched early to look up the answer. Neither image is reachable by
guessing a path; both go through the API.

## Difficulty

Two modes, chosen with a toggle above the puzzle and remembered for next time.

- **Hard** — the original game. A black silhouette, and the colour photo is not sent to the
  browser at all until the round is over.
- **Easy** — the colour photo takes the stage from the start, blurred to 34px, sharpening a step
  with every guess or skip spent and clearing when the round ends. Kit colours and posture read
  early, the face last. The hints are all available from the off rather than being earned, but
  they stay behind a **Reveal hints** cover until asked for — otherwise a player who meant to
  take the puzzle on hard has read every hint before they reach the toggle. Revealing is
  remembered per round, so a reload mid-round doesn't hide them again.

The mode belongs to the round, not the browser: it is stored on the play and **locked once the
first guess is made**, so a round can't be started hard and finished easy. Easy rounds are marked
in the share text and in the archive. Easy needs a full photo, so the toggle is disabled with a
reason on a day whose player has only a silhouette.

**The easy-mode blur is applied in the browser**, so a player who goes looking can open the image
and see it sharp. That is an accepted trade — easy mode is opt-in, the game is self-scored, and
blurring server-side would mean re-adding an image library and a few hundred MB to the container.
Hard mode is unaffected: its photo is never sent early.

## What players get

- **Hints** arrive one per miss in hard mode, in the order the admin arranged that player's six
  slots, shown in a panel that counts them off. Stored order is the running order — `hints.mjs`
  only enforces the rules the database cannot: a category the game has no use for is dropped, a
  repeat counts once, and nothing past the sixth is reachable. Each game
  gets the categories it can use — the Premier League puzzle never offers league — and the admin
  arranges the six slots into whatever running order it wants.
- **Stats** — played, win rate, current and best streak, and the spread of guesses used on wins.
  Held per browser against the anonymous session cookie; there is no cross-player leaderboard.
- **Past puzzles** — an archive of days that actually ran, so someone joining late can catch up.
  A future date is refused, and a past date that never ran is refused rather than assigned on
  demand, which would quietly burn through the pool.
- **Sharing** — the button opens the phone's own share sheet where there is one (iOS, Android,
  most desktop browsers), falling back to the clipboard. The link goes *inside* the shared text
  rather than in a separate `url` field: several targets, WhatsApp among them, use only `url` and
  silently drop `text` when both are present, which sent the bare link and none of the score.
- **Installable** — a web manifest and an `apple-touch-icon`, so the game can be added to the
  Home Screen and opens without browser chrome. Icons are committed; regenerate them with
  `node tools/make-icons.mjs --source assets/icon-source.jpg`, which needs Playwright via `npx`
  (deliberately not a project dependency). `--source` accepts a screenshot of the game's own
  stage — it finds the panel, steps past the frame and crops the figure out.
- **No accidental zoom** — the game blocks pinch-zoom where the platform allows it, and kills
  double-tap zoom and the iOS zoom-on-input everywhere. iOS Safari ignores the viewport flag by
  design, so the targeted fixes carry it there. The admin keeps normal zoom, being a desk tool.
- **Link previews** — a pasted link shows a plain text card: title, description and URL, with
  **no image, deliberately**. `og:image`/`twitter:image` were tried and removed by request, so
  don't reinstate them without asking. The remaining tags still need an absolute URL and scrapers
  don't run JavaScript, so `server/index.mjs` serves `/` through a substitution rather than as a
  static file.

## What people guessed

Every guess is stored against an anonymous session id, so the admin's **What people guessed**
panel can show, for any day anyone played:

- **A summary** — players, solve rate, average guesses, and the easy/hard split.
- **Common wrong guesses** — who people confuse with who.
- **Near misses** — typos that fell just outside the matcher's tolerance and so cost someone the
  puzzle. Each has a button that accepts it as an alias, so it counts next time. Two tests decide
  a near miss, and both are needed: an absolute edit-distance cap, and a proportional one — two
  edits is a typo in a long name but a different word in a four-letter one.
- **The full log** — every round's guesses in order, with a short session fragment.

No names, emails or IP addresses are stored, so this shows *what* was guessed, never *who*
guessed it. Guesses are free text, so they can contain anything a player types.

## Guess matching

With no dropdown, guesses have to be forgiving. `server/matching.mjs` folds accents, punctuation
and casing, then allows a small edit distance that scales with name length — so `Ibrahimović`,
`ibrahimovic` and `Ibrahimovic` all match, and a one-letter slip in a long name is accepted with a
note that the spelling was off. Short names stay strict, so `Pepe` never matches `Pele`.

Each player also carries an alias list (surname alone, nicknames, common misspellings). Creating
a player fills in the first and last name; the rest you enter and edit by hand.

## Look

The player-facing design follows Minute Cryptic: an off-white ground, pastel colour blocks,
heavy black outlines with a hard offset shadow, Sansita for display and Mulish for text, all
loaded from Google Fonts. It is light-mode only and paints its own colours rather than following
the viewer's system theme.

## Tests

```sh
npm test
```

`node:test` and `node:assert`, both built into Node — there are no dev dependencies and nothing to
install. They cover the pure logic where the fiddly bugs live: the fuzzy matcher's tolerance
boundaries, the streak walk, date resolution, hint gating in both modes, the per-game hint
categories and slot order, archiving, upload handling, the login throttle, and both migrations run
against fixtures built on the old shape.

**Deploys are gated on this.** `.github/workflows/fly-deploy.yml` runs the suite first and only
deploys if it passes, so a broken push stops at CI rather than at the Fly health check.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.mjs` | Express app — serves the game, the admin and the API |
| `server/db.mjs` | SQLite schema and queries |
| `server/game.mjs` | Round logic: scheduling, hint reveal, win/lose |
| `server/matching.mjs` | Name normalisation and fuzzy matching |
| `server/hints.mjs` | The hint categories each game offers, and what a player actually reveals |
| `server/auth.mjs` | Signed admin and play-session cookies, and the login throttle |
| `server/uploads.mjs` | The uploaded-image directory: serving and deleting |
| `server/silhouette.mjs` | Reads a cut-out PNG and paints it black — the silhouette, from the photo |
| `server/storage.mjs` | Detects a non-persistent disk and warns loudly |
| `server/request.mjs` | Reading the caller's timezone off a request |
| `server/env.mjs` | Loads `.env` at startup |
| `server/routes-game.mjs`, `server/routes-admin.mjs` | HTTP endpoints |
| `server/seed.mjs` | Loads the three starter players |
| `test/` | `npm test` — no dependencies, just `node:test` |
| `public/` | The game the players see |
| `admin/` | Admin UI, including the silhouette editor |
| `tools/` | One-off scripts run by hand: the app icons, the preview image, a silhouette from a file |

## API

Public:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/puzzle` | Today's silhouette, earned hints, guesses so far. `?date=` plays an archived day. `?category=premier-league\|international` picks the game, default `international` (shown as "The Rest") |
| `POST /api/guess` | `{ guess }` → updated state; the answer only once the round ends |
| `POST /api/skip` | Burns a guess to reveal a hint |
| `POST /api/mode` | `{ mode }` → sets hard or easy; refused once the round has a guess |
| `GET /api/stats` | This visitor's played, win rate, streaks and guess distribution |
| `GET /api/archive` | Past puzzles and how this visitor did on each |

Every endpoint above takes `?category=` (or `{ category }` in the body) — Premier League and
The Rest are separate games with their own schedule, plays and stats.

Auth — optional, and only ever about linking one browser's own stats to itself:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/session` | Whether this browser is signed in, and to what name |
| `GET /api/auth/google/start` \| `/callback` | The sign-in redirect and its return trip |
| `POST /api/auth/logout` | Sign out — the next visit is a fresh anonymous session |

Admin, all behind a signed cookie except `/login`, `/logout` and `/session`:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` \| `/logout` | Sign in or out. Login is throttled per caller after six failures |
| `GET /api/admin/session` | Whether you're signed in, plus the storage warning and the category list |
| `GET\|POST /api/admin/players` | List, or create from a name and images |
| `PATCH\|DELETE /api/admin/players/:id` | Edit hints, aliases, category, traced silhouette, status, archived — or remove |
| `POST /api/admin/players/archive-played` | Archive every footballer whose scheduled date has passed |
| `POST /api/admin/players/:id/images` | Replace the silhouette and/or the photo |
| `GET /api/admin/players/:id/photo` \| `/silhouette-image` | The stored images, for review |
| `GET\|PUT\|DELETE /api/admin/schedule[/:date]` | Read the queue, pin a player to a day, or clear one |
| `GET /api/admin/insights[?date=]` | What was guessed that day. Read-only — it never assigns a player |
| `GET /api/admin/insights/dates` | Days anyone has played |
| `GET\|DELETE /api/admin/users[/:id]` | List accounts, or delete one — deletes everything it ever played too |

These take `?category=` too, defaulting to `international`.

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

### Automatic deploys

`.github/workflows/fly-deploy.yml` deploys every push to `main`, and can also be run by hand from
the repo's Actions tab. It needs one repository secret:

```sh
fly tokens create deploy -a <your-app-name>
```

Add the output at **Settings → Secrets and variables → Actions → New repository secret**, named
`FLY_API_TOKEN`. The token is scoped to deploying this one app and can be revoked at any time with
`fly tokens revoke`. Paste it into GitHub, never into a chat or a commit.

With that in place, `deploy.sh` is only needed for the first deploy of a new app, or to create the
volume.

### Fly.io (by hand)

`Dockerfile` and `fly.toml` are ready to go. With the [flyctl CLI](https://fly.io/docs/flyctl/install/)
installed:

```sh
fly launch --no-deploy            # pick a name; keep the existing fly.toml when asked
fly volumes create silhoueds_data --size 1        # the persistent disk
fly secrets set \
  SILHOUEDS_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  SILHOUEDS_ADMIN_PASSWORD='pick-a-strong-password'
fly deploy
fly scale count 1                 # exactly one machine — see below
```

Optional — enables "Sign in with Google" (skip this and the app runs anonymous-only, exactly as
before):

```sh
fly secrets set \
  GOOGLE_CLIENT_ID='...' \
  GOOGLE_CLIENT_SECRET='...'
```

The redirect URI registered for that OAuth client in Google Cloud Console must exactly match
`https://<your-app>.fly.dev/api/auth/google/callback` — scheme included, or Google rejects the
callback with `redirect_uri_mismatch`.

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
- Set `SILHOUEDS_SECRET` and `SILHOUEDS_ADMIN_PASSWORD`.
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

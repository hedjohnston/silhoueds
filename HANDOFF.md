# Handoff

A resume-work note for picking this project back up in a new session — see `README.md` for how
the app itself works.

## What this is

Silhoueds: a daily footballer-silhouette guessing game. Live at
**https://silhoueds.fly.dev**, admin at **https://silhoueds.fly.dev/admin**.

## Repo & deploys

- Repo: `hedjohnston/silhoueds`, deploy branch is `main`.
- Every push to `main` auto-deploys via `.github/workflows/fly-deploy.yml` — nothing to trigger
  by hand. It can also be re-run manually from the Actions tab (`workflow_dispatch`) for a
  redeploy with no code change.
- This depends only on GitHub access to the repo and the `FLY_API_TOKEN` repo secret already
  set in GitHub — both independent of which Claude account is being used. Switching Claude
  accounts doesn't require touching Fly or GitHub at all, as long as the new session can read/push
  this repo.

## Secrets that already exist (values live in GitHub/Fly, never in this repo)

- GitHub repo secret: `FLY_API_TOKEN` — scoped to deploying this one Fly app.
- Fly app secrets: `SILHOUEDS_SECRET`, `SILHOUEDS_ADMIN_PASSWORD` (see `.env.example` for the
  full list including optional ones like `SILHOUEDS_TIMEZONE`).

## Starting a new session

1. Point it at the `hedjohnston/silhoueds` repo, `main` branch.
2. Have it read `README.md` first (architecture, local dev setup, deploy instructions), then this
   file.
3. Confirm it can reach `https://silhoueds.fly.dev` to check the live state before making changes.

## Decisions worth knowing before touching things

These aren't obvious from the code alone, and re-litigating them would undo deliberate choices:

- **Hint reveal order is Era → Position → League → Nationality → Best known at** (see
  `server/hints.mjs`) — chosen because era barely narrows the field while position splits it into
  groups, so era comes first.
- **No link-preview image on purpose.** `og:image`/`twitter:image` were tried, then removed by
  request — sharing the URL shows a plain text card, not an image.
- **A player is scheduled once, ever — never repeated.** The admin's schedule picker
  (`admin/admin.js`) filters candidates to ready players who have never appeared in the
  `schedule` table for any date, past or future (`schedule.allScheduledPlayerIds()` in
  `server/db.mjs`).
- **Hints are entered by hand.** An earlier Claude-assisted hint-drafting feature was built, then
  deliberately removed — don't re-add it without being asked.
- **Server-side "today" defaults to `Australia/Sydney`**, not UTC, overridable via
  `SILHOUEDS_TIMEZONE`. Players' own rounds always use their browser's timezone regardless.
- **Run exactly one Fly machine.** Storage is a single SQLite file on one volume; a second
  machine would serve a separate, diverging copy of the data.

For the detailed reasoning behind any of the above, `git log` has it — commit messages in this
repo are written to carry the "why," not just the "what."

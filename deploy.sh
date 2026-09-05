#!/usr/bin/env bash
# Fix the repo state and deploy. Safe to re-run.
#
#   bash deploy.sh
#
# Resolves the merge conflict, clears leftovers, makes sure fly.toml still mounts the volume,
# commits, creates the volume if it is missing, deploys, and then proves the data is on a real
# disk rather than trusting that it is.

set -uo pipefail

# Whatever branch is checked out, so this keeps working after the work is merged to main.
# Falls back to the repo's default branch when HEAD is detached or has no remote counterpart.
resolve_branch() {
  local current
  current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  if [ -n "$current" ] && git rev-parse --verify --quiet "origin/$current" >/dev/null 2>&1; then
    printf '%s' "$current"
    return
  fi
  local fallback
  fallback=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  printf '%s' "${fallback:-main}"
}

VOLUME="silhoueds_data"

# fly.toml is written by different tools with different quoting, so read values tolerantly.
toml_value() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" fly.toml 2>/dev/null | head -1 \
    | sed -E "s/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"'].*$//; s/[[:space:]]*$//"
}

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$1" >&2; exit 1; }

cd "$(dirname "$0")" || die "could not enter the project folder"

# ---------------------------------------------------------------- prerequisites
command -v git >/dev/null || die "git is not installed"
command -v fly >/dev/null || die "the Fly CLI is not installed. Run: brew install flyctl"
fly auth whoami >/dev/null 2>&1 || die "not signed in to Fly. Run: fly auth login"

say "Getting the latest code"
git fetch origin --quiet || die "could not reach GitHub"

BRANCH=$(resolve_branch)
ok "tracking branch: $BRANCH"

# Deploying a branch that the default branch has moved past ships stale code, silently. That has
# happened enough times to be worth stopping for.
DEFAULT=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
DEFAULT=${DEFAULT:-main}
if [ "$BRANCH" != "$DEFAULT" ] && git rev-parse --verify --quiet "origin/$DEFAULT" >/dev/null 2>&1; then
  BEHIND=$(git rev-list --count "origin/$BRANCH..origin/$DEFAULT" 2>/dev/null || echo 0)
  if [ "${BEHIND:-0}" -gt 0 ]; then
    die "you are on '$BRANCH', which is $BEHIND commit(s) behind '$DEFAULT'.
       Deploying now would ship older code. Switch over first:

         git checkout $DEFAULT && git pull && bash deploy.sh"
  fi
fi

# ---------------------------------------------------------------- unpushed work
# Everything below takes origin's copy of every tracked file, so anything committed here and not
# pushed is about to vanish — and the deploy that follows would ship the old code without saying
# so. That has happened: a fix to the guess matcher was committed, reset away by the line below,
# and deployed as the very version it replaced. Stopping costs one command; the silent version
# costs an afternoon of wondering why the change isn't live.
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
else
  AHEAD=0
fi

# fly.toml and package-lock.json are the two tracked files this script rewrites and commits by
# itself, so changes to them are expected here and are not work about to be lost.
DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null \
  | grep -vE '[[:space:]](fly\.toml|package-lock\.json)$')

if [ "${AHEAD:-0}" -gt 0 ] || [ -n "$DIRTY" ]; then
  WHAT="${AHEAD:-0} commit(s) that origin doesn't have"
  [ -n "$DIRTY" ] && WHAT="$WHAT, and uncommitted changes to:
$(printf '%s\n' "$DIRTY" | sed 's/^/         /')"
  die "you have work here the next step would throw away —
       $WHAT

       Push it first, then re-run this:

         git add -A && git commit -m 'what you changed'   # only if something is uncommitted
         git push origin $BRANCH
         bash deploy.sh"
fi

# The app name is the one thing here that is yours rather than mine, so carry it across.
PREV_APP=$(toml_value app)

# Keep a way back before touching anything.
BACKUP="backup/$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP" >/dev/null 2>&1 || true

# Clear anything half-finished from an earlier attempt, then take origin's version of every
# tracked file. Nothing in this repo is edited locally except fly.toml, which is rebuilt below.
git merge --abort >/dev/null 2>&1 || true
git rebase --abort >/dev/null 2>&1 || true
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH" --quiet || die "could not update to the latest code"
ok "updated to the latest code (previous state kept as branch $BACKUP)"

if [ -n "$(git ls-files --unmerged)" ]; then
  die "there are still conflicted files — paste this to Claude"
fi

if [ -d models ]; then
  rm -rf models
  ok "removed the leftover models/ folder"
fi

# ---------------------------------------------------------------- fly.toml
say "Checking fly.toml"
[ -f fly.toml ] || die "fly.toml is missing entirely — paste this to Claude"

APP=$(toml_value app)

# origin's fly.toml carries my app name; put theirs back if it differed.
if [ -n "$PREV_APP" ] && [ "$PREV_APP" != "$APP" ]; then
  awk -v app="$PREV_APP" '\
    /^[[:space:]]*app[[:space:]]*=/ && !seen { print "app = \"" app "\""; seen=1; next } { print }' \
    fly.toml > fly.toml.tmp && mv fly.toml.tmp fly.toml
  APP=$PREV_APP
  ok "kept your app name: $APP"
fi

[ -n "$APP" ] || die "fly.toml has no app name — paste this to Claude"

APPS=$(fly apps list 2>/dev/null | awk 'NR>1 {print $1}' | grep -v '^$')
if [ -z "$APPS" ]; then
  warn "couldn't list your Fly apps; trusting fly.toml"
elif ! printf '%s\n' "$APPS" | grep -qx "$APP"; then
  die "fly.toml names an app called '$APP', which isn't in your Fly account.
       Your apps are:
$(printf '%s\n' "$APPS" | sed 's/^/         /')
       Edit the 'app =' line in fly.toml to one of those, then re-run this."
fi
ok "deploying to app: $APP"

# The mount is the whole ballgame: without it the database is wiped on every restart.
if ! grep -q '\[\[mounts\]\]' fly.toml; then
  cat >> fly.toml <<'TOML'

[[mounts]]
  source = "silhoueds_data"
  destination = "/data"
TOML
  ok "restored the [[mounts]] block"
else
  ok "[[mounts]] block present"
fi

if ! grep -q 'SILHOUEDS_DB' fly.toml; then
  cat >> fly.toml <<'TOML'

[env]
  PORT = "3000"
  SILHOUEDS_DB = "/data/silhoueds.db"
  SILHOUEDS_UPLOADS = "/data/uploads"
TOML
  ok "restored the [env] block"
else
  ok "data paths present"
fi

# ---------------------------------------------------------------- commit
say "Saving your changes"
if [ -n "$(git status --porcelain -- fly.toml package-lock.json)" ]; then
  git add fly.toml package-lock.json
  git commit -q -m "Restore volume mount and resolve lockfile" || true
  git push -q origin HEAD 2>/dev/null && ok "committed and pushed" || warn "committed locally (push failed — not fatal)"
else
  ok "nothing to commit"
fi

if [ -n "$(git stash list 2>/dev/null)" ]; then
  warn "you have a leftover stash — harmless. 'git stash list' to see it."
fi

# ---------------------------------------------------------------- volume
say "Making sure the disk exists"
if fly volumes list -a "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  ok "volume '$VOLUME' already exists"
else
  REGION=$(toml_value primary_region)
  REGION=${REGION:-syd}
  fly volumes create "$VOLUME" --size 1 --region "$REGION" -a "$APP" --yes \
    || die "could not create the volume — paste the error above to Claude"
  ok "created volume '$VOLUME' in $REGION"
fi

# ---------------------------------------------------------------- already deploying?
# Pushing to main already deploys: .github/workflows/fly-deploy.yml runs on every push. Its
# concurrency group holds off other CI runs, but it cannot see a 'fly deploy' started from this
# laptop — and two deploys at once is exactly how this app collected nine volumes. The second
# deploy cannot attach the volume the first one is holding, so Fly hands it a brand-new empty
# one, and the app ends up answering from a blank database while the real disk sits on the other
# machine. Wait for CI instead; it is deploying the same commit anyway.
if command -v gh >/dev/null 2>&1; then
  INFLIGHT=$(gh run list --status in_progress --limit 5 2>/dev/null | grep -c 'Deploy')
  INFLIGHT=$((INFLIGHT + $(gh run list --status queued --limit 5 2>/dev/null | grep -c 'Deploy')))
  if [ "${INFLIGHT:-0}" -gt 0 ]; then
    die "GitHub is already deploying this app — every push to $DEFAULT does.
       Starting a second deploy now is what creates a spare machine on an empty volume.

       Watch that one finish instead, and you are done:

         gh run watch

       Re-run this script only if it fails."
  fi
  ok "no deploy already running on GitHub"
fi

# ---------------------------------------------------------------- deploy
say "Deploying (this takes a few minutes)"
fly deploy -a "$APP" || die "the deploy failed — paste the error above to Claude"

say "Only one machine should run, so the database isn't split in two"
fly scale count 1 -a "$APP" --yes >/dev/null 2>&1 && ok "scaled to one machine" || warn "could not scale; check 'fly status'"

# ---------------------------------------------------------------- one machine, one volume
# Scaling asks for one machine; this checks it actually got one, and that no spare volume is
# lying around waiting to be attached. Both matter because every volume on this app carries the
# same name: a second machine doesn't share the game, it mounts a different disk and serves a
# different game, and a second volume is the empty disk it will mount. That is not theoretical —
# a deploy once left the app answering from a fresh empty volume while the real one sat on a
# stopped machine, and nothing said a word about it.
say "Checking there is exactly one machine and one volume"
MACHINES=$(fly machines list -a "$APP" 2>/dev/null | grep -cE '^[[:space:]]*[0-9a-f]{14}[[:space:]]')
VOLUMES=$(fly volumes list -a "$APP" 2>/dev/null | grep -cE '^[[:space:]]*vol_[a-z0-9]+[[:space:]]')

if [ "${MACHINES:-0}" -eq 0 ] || [ "${VOLUMES:-0}" -eq 0 ]; then
  warn "couldn't count machines or volumes; check 'fly status' and 'fly volumes list -a $APP'"
elif [ "$MACHINES" -gt 1 ] || [ "$VOLUMES" -gt 1 ]; then
  printf '\n'
  fly machines list -a "$APP" 2>/dev/null
  fly volumes list -a "$APP" 2>/dev/null
  die "this app has $MACHINES machine(s) and $VOLUMES volume(s). It must have one of each.

       Every volume here is called '$VOLUME'. So a second machine is not sharing your game, it
       has mounted a different disk and serves a different one — probably empty; and a second
       volume is the empty disk waiting for a machine to mount it.

       Find which volume holds the data before deleting anything. For each machine:

         fly machine start <machine-id> -a $APP
         fly ssh console -a $APP --machine <machine-id> -C 'df -h /data'

       The one using megabytes is yours. Destroy the other machine, then its volume:

         fly machine destroy <other-machine-id> -a $APP --force
         fly volumes destroy <other-volume-id> -a $APP --yes

       Then re-run this script."
else
  ok "one machine, one volume"
fi

# ---------------------------------------------------------------- prove it
say "Checking the data is on a real disk"
MOUNT=$(fly ssh console -a "$APP" -C "df -h /data" 2>/dev/null | tail -1)
if printf '%s' "$MOUNT" | grep -qi 'overlay'; then
  die "/data is still the container's own filesystem, so data will still be wiped.
       Paste this to Claude:
       $MOUNT"
elif [ -z "$MOUNT" ]; then
  warn "couldn't read /data (the machine may still be starting). Re-run this script in a minute."
else
  ok "/data is a real volume:"
  printf '      %s\n' "$MOUNT"
fi

HOST=$(fly status -a "$APP" 2>/dev/null | grep -i hostname | awk '{print $NF}' | tr -d '"')
HOST=${HOST:-$APP.fly.dev}

say "Done"
cat <<DONE
    Game:  https://$HOST
    Admin: https://$HOST/admin

    Next, in this order:
      1. Open the admin and sign in.
      2. Check there is NO red banner across the top.
         If there is one, stop and tell Claude — data is still not safe.
      3. Add your players, publish them.
      4. Send friends the game link (not the admin one).
DONE

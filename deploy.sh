#!/usr/bin/env bash
# Fix the repo state and deploy. Safe to re-run.
#
#   bash deploy.sh
#
# Resolves the merge conflict, clears leftovers, makes sure fly.toml still mounts the volume,
# commits, creates the volume if it is missing, deploys, and then proves the data is on a real
# disk rather than trusting that it is.

set -uo pipefail

BRANCH="claude/football-silhouette-game-pqxv6t"
VOLUME="silhoueds_data"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$1" >&2; exit 1; }

cd "$(dirname "$0")" || die "could not enter the project folder"

# ---------------------------------------------------------------- prerequisites
command -v git >/dev/null || die "git is not installed"
command -v fly >/dev/null || die "the Fly CLI is not installed. Run: brew install flyctl"
fly auth whoami >/dev/null 2>&1 || die "not signed in to Fly. Run: fly auth login"

say "Tidying up the repo"
git fetch origin --quiet || die "could not reach GitHub"

# The lockfile is generated, so the committed version is always the right answer.
if git ls-files --unmerged | grep -q 'package-lock.json'; then
  git checkout "origin/$BRANCH" -- package-lock.json || die "could not resolve package-lock.json"
  git add package-lock.json
  ok "resolved the package-lock.json conflict"
else
  ok "no lockfile conflict"
fi

# Any other conflicted file is something I can't safely guess at.
if [ -n "$(git ls-files --unmerged)" ]; then
  git ls-files --unmerged | awk '{print "      " $4}' | sort -u
  die "the files above are still conflicted — paste this output to Claude"
fi

if [ -d models ]; then
  rm -rf models
  ok "removed the leftover models/ folder"
fi

# ---------------------------------------------------------------- fly.toml
say "Checking fly.toml"
[ -f fly.toml ] || die "fly.toml is missing entirely — paste this to Claude"

APP=$(grep -E '^app *=' fly.toml | head -1 | sed -E 's/.*"(.*)".*/\1/')
[ -n "$APP" ] || die "fly.toml has no app name — paste this to Claude"

if ! fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  die "fly.toml points at an app called '$APP', which isn't in your Fly account.
       Fix the 'app =' line in fly.toml to your real app name, then re-run this."
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
  REGION=$(grep -E '^primary_region' fly.toml | head -1 | sed -E 's/.*"(.*)".*/\1/')
  REGION=${REGION:-syd}
  fly volumes create "$VOLUME" --size 1 --region "$REGION" -a "$APP" --yes \
    || die "could not create the volume — paste the error above to Claude"
  ok "created volume '$VOLUME' in $REGION"
fi

# ---------------------------------------------------------------- deploy
say "Deploying (this takes a few minutes)"
fly deploy -a "$APP" || die "the deploy failed — paste the error above to Claude"

say "Only one machine should run, so the database isn't split in two"
fly scale count 1 -a "$APP" --yes >/dev/null 2>&1 && ok "scaled to one machine" || warn "could not scale; check 'fly status'"

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

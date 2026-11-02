#!/usr/bin/env bash
# Pulls the latest origin/main and re-runs docker compose — but only when
# origin/main has moved since the last successful update.
#
#   ./update.sh           check origin/main; if it moved, fast-forward this
#                         checkout to it and rebuild/restart the container
#   ./update.sh --force   rebuild/restart even if main hasn't moved
#
# Normally run on the HOST by energy-balance-update.service (installed by
# ./install.sh), which a systemd .path unit starts whenever the app's
# "Update" button drops caches/update_request.json. The server can't do this
# itself: it runs inside the container that's about to be rebuilt.
#
# State:
#   caches/update_state.json   {"deployed_sha": ...} — main's sha as of the
#                              last successful update (defaults to HEAD)
#   caches/update_status.json  what the app shows: state/message/from/to/time
set -euo pipefail

# The whole script is one { } block so bash parses it fully before running —
# the `git merge` below can rewrite this very file mid-run.
{
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="main"
REMOTE="origin"
REQUEST_PATH="$APP_DIR/caches/update_request.json"
STATE_PATH="$APP_DIR/caches/update_state.json"
STATUS_PATH="$APP_DIR/caches/update_status.json"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'error: unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$APP_DIR/caches"
# Consume the request up front so the .path unit doesn't re-trigger on it.
rm -f "$REQUEST_PATH"

FROM_SHA=""
TO_SHA=""
write_status() {  # state message
  python3 - "$STATUS_PATH" "$1" "$2" "$FROM_SHA" "$TO_SHA" <<'PY'
import json, os, sys
from datetime import datetime
path, state, message, frm, to = sys.argv[1:6]
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"state": state, "message": message, "from": frm or None, "to": to or None,
               "time": datetime.now().astimezone().isoformat(timespec="seconds")}, f)
os.replace(tmp, path)
PY
}
log() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$1" >&2; write_status error "$1"; exit 1; }

# Run git as the checkout's owner, so a root-run service never leaves
# root-owned files in .git (and git's safe.directory check passes).
OWNER="$(stat -c %U "$APP_DIR")"
git_() {
  if [ "$(id -u)" -eq 0 ] && [ "$OWNER" != "root" ] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$OWNER" -- git -C "$APP_DIR" "$@"
  else
    git -C "$APP_DIR" "$@"
  fi
}

write_status running "Checking ${REMOTE}/${BRANCH}…"

command -v git >/dev/null 2>&1 || fail "git is not installed on the host"
[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "neither 'docker compose' nor 'docker-compose' is available"
fi

log "Fetching ${REMOTE}/${BRANCH}"
git_ fetch --quiet "$REMOTE" "$BRANCH" || fail "git fetch ${REMOTE} ${BRANCH} failed"
TO_SHA="$(git_ rev-parse "${REMOTE}/${BRANCH}")"

FROM_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("deployed_sha") or "")' "$STATE_PATH" 2>/dev/null || true)"
[ -n "$FROM_SHA" ] || FROM_SHA="$(git_ rev-parse HEAD)"

if [ "$FROM_SHA" = "$TO_SHA" ] && [ "$FORCE" -eq 0 ]; then
  log "Already up to date (${TO_SHA:0:7})"
  write_status up_to_date "Already up to date — ${BRANCH} is still at ${TO_SHA:0:7}."
  exit 0
fi

CURRENT_BRANCH="$(git_ rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] \
  || fail "checkout is on '${CURRENT_BRANCH}', not '${BRANCH}' — switch it to ${BRANCH} to use updates"

write_status running "Pulling ${FROM_SHA:0:7} → ${TO_SHA:0:7}…"
log "Fast-forwarding to ${REMOTE}/${BRANCH} (${TO_SHA:0:7})"
git_ merge --ff-only --quiet "${REMOTE}/${BRANCH}" \
  || fail "could not fast-forward to ${REMOTE}/${BRANCH} (local changes or diverged history?)"

# Record the new sha before `up` — recreating the container restarts the
# server, and the app should see "updated" once it's back.
python3 -c 'import json,sys; json.dump({"deployed_sha": sys.argv[2]}, open(sys.argv[1], "w"))' "$STATE_PATH" "$TO_SHA"
write_status running "Rebuilding and restarting the container (${TO_SHA:0:7})…"

log "Rebuilding and restarting"
if ! (cd "$APP_DIR" && "${COMPOSE[@]}" up -d --build --remove-orphans); then
  # Leave deployed_sha unset so the next Update retries the rebuild.
  rm -f "$STATE_PATH"
  fail "docker compose up --build failed — see: journalctl -u energy-balance-update"
fi
docker image prune -f >/dev/null 2>&1 || true

write_status updated "Updated ${FROM_SHA:0:7} → ${TO_SHA:0:7}."
log "Done"
exit 0
}

#!/usr/bin/env bash
# Deploys energy-balance from THIS machine to a remote Docker host over ssh.
#
#   deploy/deploy.sh user@host               install, or update the app
#   deploy/deploy.sh --force-data user@host  also REPLACE the remote's data
#                                            with this machine's (asks first;
#                                            the remote's data is backed up)
#   deploy/deploy.sh --status user@host      show what's deployed there
#   deploy/deploy.sh --backup user@host      download the remote's data to
#                                            ./backups/ (never overwrites)
#   deploy/deploy.sh --rollback user@host    swap back to the previous app
#   deploy/deploy.sh --config-set tls_enabled=true user@host
#                                            change the remote's config.json
#                                            (repeatable; VALUE is JSON, else
#                                            a string) and restart the app
#
# Options: --yes (skip the --force-data prompt), --remote-dir DIR (where the
# compose file goes on the remote; default ~/energy-balance), --platform
# linux/arm64 etc. (default: detected from the remote's `uname -m`).
#
# How the data is handled:
#   * The app image (`app` stage of the Dockerfile) is code only.
#   * The remote keeps config.json, schedule_sources/, secrets/ and caches/
#     in the Docker volume `energy-balance-data`, mounted at /data.
#   * First install (the volume holds no data yet): this machine's data is
#     staged into the `seed` image, which is the app image plus ONE extra
#     layer holding /seed. It's shipped with the app, copied into the volume
#     once by deploy/seed-data.sh, then deleted on both ends.
#   * Every later run ships only the app image, so the remote's data (which
#     the remote app keeps updating) is never touched.
#   * --force-data is the only way to overwrite it again. It stops the app,
#     tars the current volume into /data/.backups/ (newest 10 kept), and
#     re-seeds from this machine.
#
# Remote requirements: Docker with the compose plugin, and an ssh user that
# can run `docker` (in the docker group, or passwordless sudo). Use
# ~/.ssh/config for ports, keys and jump hosts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOLUME="energy-balance-data"
IMG_APP="energy-balance:app"            # what the remote runs
IMG_PREV="energy-balance:previous"      # what it ran before (for --rollback)
IMG_SHIP_APP="energy-balance:deploy-app"
IMG_SHIP_SEED="energy-balance:deploy-seed"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

ACTION=deploy
FORCE_DATA=0
YES=0
REMOTE_DIR='~/energy-balance'
PLATFORM=""
HOST=""
CONFIG_SET=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force-data) FORCE_DATA=1 ;;
    --yes|-y)     YES=1 ;;
    --status)     ACTION=status ;;
    --backup)     ACTION=backup ;;
    --rollback)   ACTION=rollback ;;
    --config-set) shift; ACTION=config; CONFIG_SET+=("${1:?--config-set needs KEY=VALUE}") ;;
    --remote-dir) shift; REMOTE_DIR="${1:?--remote-dir needs a value}" ;;
    --platform)   shift; PLATFORM="${1:?--platform needs a value}" ;;
    -h|--help)    usage; exit 0 ;;
    -*)           usage >&2; die "unknown option: $1" ;;
    *)            [ -z "$HOST" ] || die "only one host, got '$HOST' and '$1'"; HOST="$1" ;;
  esac
  shift
done
[ -n "$HOST" ] || { usage >&2; die "missing user@host"; }
case "$REMOTE_DIR" in *[[:space:]\'\"\;\&\|\$\`]*) die "--remote-dir must be a plain path" ;; esac

# --- ssh: one multiplexed connection for every remote step -------------------
WORK="$(mktemp -d)"
chmod 700 "$WORK"
SSH=(ssh -o ControlMaster=auto -o "ControlPath=$WORK/ssh-%C" -o ControlPersist=120)
SEED_BUILT=0
cleanup() {
  # The seed image holds this machine's secrets — never leave it lying around
  # (on either end; the remote copy is removed right after seeding).
  if [ "$SEED_BUILT" -eq 1 ]; then docker rmi "$IMG_SHIP_SEED" >/dev/null 2>&1 || true; fi
  "${SSH[@]}" -O exit "$HOST" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

rsh() { "${SSH[@]}" "$HOST" "$@"; }

log "Connecting to $HOST"
rsh true || die "cannot ssh to $HOST"

if rsh 'docker info >/dev/null 2>&1'; then
  RD="docker"
elif rsh 'sudo -n docker info >/dev/null 2>&1'; then
  RD="sudo -n docker"
else
  die "$HOST: can't run docker (install it, and add your user to the docker group or allow passwordless sudo)"
fi
rsh "$RD compose version >/dev/null 2>&1" || die "$HOST: the docker compose plugin isn't installed"
RCOMPOSE="cd $REMOTE_DIR && $RD compose"

remote_has_image() { rsh "$RD image inspect $1 >/dev/null 2>&1"; }
remote_has_volume() { rsh "$RD volume inspect $VOLUME >/dev/null 2>&1"; }
# Prints the seed marker and returns 0 if the volume holds data, 1 if not, 2
# if that can't be determined yet (volume exists but no image to look with).
remote_data_state() {
  remote_has_volume || return 1
  remote_has_image "$IMG_APP" || return 2
  rsh "$RD run --rm -v $VOLUME:/data --entrypoint bash $IMG_APP /app/deploy/seed-data.sh --check"
}

# The log of the server's most recent startup (from `since` if given, an
# RFC3339 time on the remote's clock, else whatever the container has).
startup_log() {
  local since_arg=""
  [ -n "${1:-}" ] && since_arg="--since $1"
  { rsh "$RCOMPOSE logs --no-log-prefix --no-color $since_arg energy-balance 2>/dev/null" || true; } \
    | awk '/Energy Balance server running/ { buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }'
}

# Waits (up to ~60s — `tailscale cert` can take a while) for the server to
# finish starting after `since`, then says whether HTTPS came up, and if not,
# why. Sets HTTPS_URL on success.
HTTPS_URL=""
report_https() {
  local since="${1:-}" logs="" i waited=0
  # Done = HTTPS up, a definite failure, or startup finished without TLS.
  # The server gets its cert in the background, and a machine's first one
  # can take minutes, so allow up to ~6 minutes.
  local done_re='HTTPS \(real, trusted cert\)|Could not obtain a TLS|HTTPS listener failed|no tls_hostname is set'
  for i in $(seq 1 180); do
    logs="$(startup_log "$since")"
    [ -z "$since" ] && break
    if printf '%s' "$logs" | grep -qE 'Login required|Generated login'; then
      printf '%s' "$logs" | grep -qE "$done_re" && break
      printf '%s' "$logs" | grep -q 'Setting up HTTPS' || break
      if [ "$waited" -eq 0 ]; then
        log "Waiting for $HOST's HTTPS certificate (a machine's first one can take a few minutes)…"
        waited=1
      fi
    fi
    sleep 2
  done
  if [ -z "$logs" ]; then
    warn "no startup output from the server yet — check: ssh $HOST 'cd $REMOTE_DIR && docker compose logs'"
    return
  fi
  if printf '%s' "$logs" | grep -q 'HTTPS (real, trusted cert)'; then
    HTTPS_URL="$(printf '%s' "$logs" | sed -n 's/.*HTTPS (real, trusted cert): //p' | tail -1)"
    log "HTTPS is up: $HTTPS_URL"
    return
  fi
  if ! printf '%s' "$logs" | grep -qE 'Setting up HTTPS|tls_enabled is true'; then
    warn "HTTPS is OFF on $HOST (tls_enabled is false in its config.json), so it's plain HTTP only."
    warn "  Browsers will say 'not secure' and phones set to HTTPS-only won't load it. Turn it on with:"
    warn "    deploy/deploy.sh --config-set tls_enabled=true $HOST"
    return
  fi
  if ! printf '%s' "$logs" | grep -qE "$done_re"; then
    warn "HTTPS isn't up on $HOST yet — still waiting for its certificate (HTTP works meanwhile)."
    warn "  Check again in a few minutes with: deploy/deploy.sh --status $HOST"
    return
  fi
  warn "HTTPS failed to start on $HOST, so it's plain HTTP only (the server retries every 5 minutes). It said:"
  printf '%s\n' "$logs" | { grep -E 'tailscale|tls_hostname|HTTPS|TLS|certificate|Retrying' || true; } | sed 's/^/      /' >&2
  if ! rsh 'test -S /var/run/tailscale/tailscaled.sock'; then
    warn "  $HOST has no Tailscale daemon socket at /var/run/tailscale/tailscaled.sock."
    warn "  Install Tailscale there (https://tailscale.com/download/linux), run 'sudo tailscale up',"
    warn "  then: deploy/deploy.sh --config-set tls_enabled=true $HOST   (restarts the app)"
  fi
  local pinned
  pinned="$(printf '%s' "$logs" | sed -n 's/.*Setting up HTTPS for \(.*\) (from tls_hostname in config.json).*/\1/p' | tail -1)"
  if [ -n "$pinned" ]; then
    warn "  config.json pins tls_hostname='$pinned'. Tailscale only issues a cert for the machine's own"
    warn "  name, so if that's another machine's, let it auto-detect with:"
    warn "    deploy/deploy.sh --config-set tls_hostname= $HOST"
  else
    local name
    name="$(printf '%s' "$logs" | sed -n 's/.*Setting up HTTPS for \(.*\) (auto-detected).*/\1/p' | tail -1)"
    warn "  To see what Tailscale itself says, run this ON $HOST (it can take a minute or two):"
    warn "    sudo tailscale cert --cert-file /tmp/eb.crt --key-file /tmp/eb.key ${name:-<its-name>.ts.net}"
  fi
}

# --- --status / --backup / --rollback / --config-set ------------------------
if [ "$ACTION" = status ]; then
  if remote_has_image "$IMG_APP"; then
    rsh "$RD image inspect $IMG_APP --format 'app image:  {{index .Config.Labels \"org.energy-balance.revision\"}} (built {{index .Config.Labels \"org.energy-balance.built\"}} on {{index .Config.Labels \"org.energy-balance.built-on\"}})'"
  else
    echo "app image:  not deployed"
  fi
  remote_has_image "$IMG_PREV" && rsh "$RD image inspect $IMG_PREV --format 'previous:   {{index .Config.Labels \"org.energy-balance.revision\"}}'"
  rsh "$RD ps -a --filter label=com.docker.compose.project=energy-balance --format 'container:  {{.Names}} {{.Status}}'" || true
  set +e; marker="$(remote_data_state)"; rc=$?; set -e
  case $rc in
    0) echo "data:       initialized — $marker" ;;
    1) echo "data:       not initialized (next deploy seeds it from this machine)" ;;
    *) echo "data:       volume exists, state unknown" ;;
  esac
  report_https
  exit 0
fi

if [ "$ACTION" = backup ]; then
  remote_has_volume && remote_has_image "$IMG_APP" || die "$HOST has no deployed data to back up"
  mkdir -p "$APP_DIR/backups"
  out="$APP_DIR/backups/$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9._-' '_')-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  log "Downloading $HOST's data volume"
  ( umask 077; rsh "$RD run --rm -v $VOLUME:/data:ro --entrypoint tar $IMG_APP -czf - -C /data --exclude=./.backups ." > "$out" )
  log "Saved $out ($(du -h "$out" | cut -f1)) — contains secrets, keep it private"
  exit 0
fi

if [ "$ACTION" = rollback ]; then
  remote_has_image "$IMG_PREV" || die "$HOST has no previous app image to roll back to"
  log "Swapping the current and previous app images"
  rsh "$RD tag $IMG_APP energy-balance:rollback-tmp && $RD tag $IMG_PREV $IMG_APP && $RD tag energy-balance:rollback-tmp $IMG_PREV && $RD rmi energy-balance:rollback-tmp >/dev/null"
  since="$(rsh 'date -u +%Y-%m-%dT%H:%M:%SZ')"
  rsh "$RCOMPOSE up -d --remove-orphans"
  log "Rolled back (run --rollback again to undo). Data was not touched."
  report_https "$since"
  exit 0
fi

if [ "$ACTION" = config ]; then
  remote_has_volume && remote_has_image "$IMG_APP" || die "$HOST has nothing deployed yet"
  rsh "$RD run --rm --entrypoint test $IMG_APP -f /app/deploy/config_set.py" \
    || die "$HOST's app image predates --config-set; deploy once (deploy/deploy.sh $HOST), then retry"
  changes="$(python3 - "${CONFIG_SET[@]}" <<'PY'
import json, sys
out = {}
for arg in sys.argv[1:]:
    key, sep, raw = arg.partition("=")
    if not sep or not key:
        sys.exit(f"error: --config-set wants KEY=VALUE, got {arg!r}")
    try:
        out[key] = json.loads(raw)
    except ValueError:
        out[key] = raw  # not JSON: a plain string (KEY= gives "")
print(json.dumps(out))
PY
)"
  log "Updating config.json on $HOST (previous copy kept as config.json.bak-*)"
  rsh "$RCOMPOSE stop >/dev/null 2>&1 || true"
  printf '%s' "$changes" | rsh "$RD run --rm -i -v $VOLUME:/data --entrypoint python3 $IMG_APP /app/deploy/config_set.py" \
    || { rsh "$RCOMPOSE up -d >/dev/null 2>&1"; die "could not update config.json (app restarted unchanged)"; }
  since="$(rsh 'date -u +%Y-%m-%dT%H:%M:%SZ')"
  log "Restarting the app"
  rsh "$RCOMPOSE up -d --remove-orphans"
  report_https "$since"
  exit 0
fi

# --- deploy: decide whether data gets seeded ---------------------------------
set +e; marker="$(remote_data_state)"; DATA_STATE=$?; set -e
SEED=0
if [ "$FORCE_DATA" -eq 1 ]; then
  SEED=1
  if [ "$DATA_STATE" -ne 1 ]; then
    echo
    echo "  --force-data will REPLACE all energy-balance data on $HOST"
    echo "  (config, Strava/intervals tokens, logs, caches) with this machine's."
    [ "$DATA_STATE" -eq 0 ] && echo "  Current remote data: $marker"
    echo "  The remote's current data is backed up inside the volume first."
    echo
    if [ "$YES" -ne 1 ]; then
      [ -t 0 ] || die "refusing --force-data without a terminal; pass --yes to confirm"
      read -r -p "  Type the host name ($HOST) to confirm: " answer
      [ "$answer" = "$HOST" ] || die "not confirmed — nothing was changed"
    fi
  fi
elif [ "$DATA_STATE" -eq 0 ]; then
  log "Remote data is initialized — shipping the app only, data stays as is"
elif [ "$DATA_STATE" -eq 1 ]; then
  log "Remote has no data yet — it will be initialized from this machine"
  SEED=1
else
  # seed-data.sh (without --force) refuses if it finds data, so this is safe.
  log "Can't tell whether the remote volume holds data — shipping seed data; it's only used if the volume is empty"
  SEED=1
fi

# --- build --------------------------------------------------------------------
if [ -z "$PLATFORM" ]; then
  case "$(rsh uname -m)" in
    x86_64|amd64)  PLATFORM=linux/amd64 ;;
    aarch64|arm64) PLATFORM=linux/arm64 ;;
    armv7l|armv7*) PLATFORM=linux/arm/v7 ;;
    *) die "unknown remote architecture; pass --platform" ;;
  esac
fi

docker info >/dev/null 2>&1 || die "can't talk to the local Docker daemon"
if docker buildx version >/dev/null 2>&1; then BUILD=(docker buildx build --load); else BUILD=(docker build); fi

REVISION="unknown"
if git -C "$APP_DIR" rev-parse HEAD >/dev/null 2>&1; then
  REVISION="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
    REVISION="$REVISION-dirty"
    warn "deploying uncommitted changes from your working tree"
  fi
fi
LABELS=(--label "org.energy-balance.revision=$REVISION"
        --label "org.energy-balance.built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        --label "org.energy-balance.built-on=$(hostname)")

log "Building the app image for $PLATFORM ($REVISION)"
"${BUILD[@]}" --platform "$PLATFORM" --target app "${LABELS[@]}" -t "$IMG_SHIP_APP" "$APP_DIR"
SHIP=("$IMG_SHIP_APP")

if [ "$SEED" -eq 1 ]; then
  [ -f "$APP_DIR/configs/config.json" ] || die "configs/config.json is missing here — nothing to initialize the remote with"
  STAGE="$WORK/seed"
  mkdir -p "$STAGE/configs" "$STAGE/caches"
  log "Staging this machine's data"
  cp -p "$APP_DIR/configs/config.json" "$STAGE/configs/"
  [ -d "$APP_DIR/configs/schedule_sources" ] && cp -rp "$APP_DIR/configs/schedule_sources" "$STAGE/configs/"
  [ -d "$APP_DIR/secrets" ] && cp -rp "$APP_DIR/secrets" "$STAGE/"
  # Response caches only — not update_*.json (this host's in-app update state),
  # temp files or corrupt-file backups. The Tailscale cert/key are skipped too:
  # they're for this machine's hostname, and the remote fetches its own.
  find "$APP_DIR/caches" -maxdepth 1 -type f -name '*cache.json' -exec cp -p {} "$STAGE/caches/" \; 2>/dev/null || true
  find "$STAGE" \( -name '*.tmp-*' -o -name '*.corrupt-*' \) -exec rm -f {} +
  [ -f "$STAGE/secrets/app_store.json" ] || warn "secrets/app_store.json not found — the remote starts with no logged data"

  python3 - "$STAGE" "$(hostname)" "$REVISION" <<'PY'
import json, os, sys
from datetime import datetime, timezone
stage, host, rev = sys.argv[1:4]
files = sorted(os.path.relpath(os.path.join(d, f), stage)
               for d, _, fs in os.walk(stage) for f in fs)
with open(os.path.join(stage, ".eb-seed-info"), "w") as f:
    json.dump({"seeded_from": host, "revision": rev,
               "seeded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "files": files}, f)
cfg_path = os.path.join(stage, "configs", "config.json")
cfg = json.load(open(cfg_path))
# Tailscale only issues a cert for a machine's OWN name, so a pinned
# tls_hostname from this machine can never work on the remote. Blank it in
# the copy so the remote auto-detects its own (your local config is untouched).
if cfg.get("tls_hostname"):
    print(f"    (tls_hostname={cfg['tls_hostname']!r} is this machine's; "
          "the remote's copy auto-detects its own name instead)")
    cfg["tls_hostname"] = ""
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
if not cfg.get("tls_enabled"):
    print("warning: tls_enabled is false — the remote will serve plain HTTP only "
          "(enable later with --config-set tls_enabled=true)", file=sys.stderr)
PY
  (cd "$STAGE" && find . -type f ! -name .eb-seed-info | sed 's|^\./|    |' | sort)

  log "Building the seed image (app + one data layer)"
  SEED_BUILT=1
  "${BUILD[@]}" --platform "$PLATFORM" --target seed --build-context "seeddata=$STAGE" \
    "${LABELS[@]}" -t "$IMG_SHIP_SEED" "$APP_DIR"
  rm -rf "$STAGE"
  SHIP+=("$IMG_SHIP_SEED")
fi

# --- ship ---------------------------------------------------------------------
log "Sending ${SHIP[*]} to $HOST"
# Saved together, the seed image's shared app layers only travel once.
if command -v pv >/dev/null 2>&1; then
  docker save "${SHIP[@]}" | gzip -1 | pv | rsh "gunzip | $RD load -q"
else
  docker save "${SHIP[@]}" | gzip -1 | rsh "gunzip | $RD load -q"
fi

# --- install on the remote ---------------------------------------------------
log "Setting up $REMOTE_DIR on $HOST"
rsh "mkdir -p $REMOTE_DIR && cat > $REMOTE_DIR/docker-compose.yml" < "$APP_DIR/deploy/docker-compose.remote.yml"
rsh "$RD volume create $VOLUME >/dev/null"

if [ "$SEED" -eq 1 ]; then
  SEED_ARGS=""
  if [ "$FORCE_DATA" -eq 1 ]; then
    SEED_ARGS="--force"
    log "Stopping the app before replacing its data"
    rsh "[ -f $REMOTE_DIR/docker-compose.yml ] && $RCOMPOSE stop >/dev/null 2>&1 || true"
  fi
  log "Seeding the data volume"
  set +e
  rsh "$RD run --rm -v $VOLUME:/data --entrypoint bash $IMG_SHIP_SEED /app/deploy/seed-data.sh $SEED_ARGS"
  rc=$?
  set -e
  rsh "$RD rmi $IMG_SHIP_SEED >/dev/null 2>&1 || true"   # the seed layer held secrets; it's in the volume now
  case $rc in
    0) ;;
    3) log "Kept the remote's existing data" ;;
    *) die "seeding failed (exit $rc) — the app was not updated" ;;
  esac
fi

# Keep the old image as :previous for --rollback, then promote the new one.
rsh "if $RD image inspect $IMG_APP >/dev/null 2>&1; then $RD tag $IMG_APP $IMG_PREV; fi; $RD tag $IMG_SHIP_APP $IMG_APP && $RD rmi $IMG_SHIP_APP >/dev/null"

# Publish the ports the remote's own config.json asks for.
rsh "$RD run --rm -v $VOLUME:/data:ro --entrypoint python3 $IMG_APP -c '
import json
try: c = json.load(open(\"/data/configs/config.json\"))
except Exception: c = {}
p = int(c.get(\"port\") or 8081)
t = int(c.get(\"tls_port\") or p + 1)
print(\"EB_PORT=%d\" % p)
print(\"EB_TLS_PORT=%d\" % t)
' > $REMOTE_DIR/.env"

since="$(rsh 'date -u +%Y-%m-%dT%H:%M:%SZ')"
log "Starting the app"
rsh "$RCOMPOSE up -d --remove-orphans"
rsh "$RD image prune -f >/dev/null 2>&1 || true"
# Docker's own restart policy brings it back after a reboot, as long as the
# Docker daemon itself starts at boot.
rsh "systemctl is-enabled docker >/dev/null 2>&1" \
  || warn "docker doesn't look enabled at boot on $HOST — run: sudo systemctl enable docker"

report_https "$since"
port="$(rsh "sed -n 's/^EB_PORT=//p' $REMOTE_DIR/.env")"
if [ -n "$HTTPS_URL" ]; then
  log "Done — $REVISION is running on $HOST. Open $HTTPS_URL (plain HTTP is also on port ${port:-8081})"
else
  log "Done — $REVISION is running on $HOST at http://${HOST#*@}:${port:-8081}/ (HTTP only, see above)"
fi

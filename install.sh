#!/usr/bin/env bash
# Installs energy-balance as a Docker service that starts on host boot.
#
#   ./install.sh              build (or rebuild) the image, (re)start the
#                             container, and register the boot-time service
#   ./install.sh --pull       same, but also `git pull` this checkout and
#                             refresh the python base image first
#   ./install.sh --uninstall  stop the container and remove the boot service
#                             (leaves configs/, secrets/, caches/ untouched)
#
# Safe to re-run: each run rebuilds the image from the current checkout and
# recreates the container only if the image changed. The container keeps
# bind-mounting this directory (see docker-compose.yml), so configs/,
# secrets/ and caches/ persist across updates.
#
# Boot mechanism: on systemd hosts a `energy-balance.service` unit runs
# `docker compose up -d` from this directory once docker.service is up. On
# hosts without systemd, it falls back to the compose file's
# `restart: unless-stopped` policy, which only works if the Docker daemon
# itself is started at boot.
set -euo pipefail

SERVICE_NAME="energy-balance"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

PULL=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --pull)      PULL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   usage; exit 0 ;;
    *)           usage >&2; die "unknown option: $arg" ;;
  esac
done

# Root-only steps (systemd unit, enabling docker) go through sudo when needed.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  SUDO=()
fi
as_root() {
  if [ "$(id -u)" -ne 0 ] && [ ${#SUDO[@]} -eq 0 ]; then
    die "need root for: $* (re-run as root or install sudo)"
  fi
  "${SUDO[@]}" "$@"
}

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# --- Docker / compose detection ---------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "neither 'docker compose' nor 'docker-compose' is available"
fi

# Use sudo for docker too if the current user can't reach the daemon.
DOCKER_PREFIX=()
if ! docker info >/dev/null 2>&1; then
  if [ ${#SUDO[@]} -gt 0 ] && sudo docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=(sudo)
  else
    die "cannot talk to the Docker daemon (is it running? is $(id -un) in the docker group?)"
  fi
fi
compose() { (cd "$APP_DIR" && "${DOCKER_PREFIX[@]}" "${COMPOSE[@]}" "$@"); }

# --- Uninstall ----------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if has_systemd && [ -f "$UNIT_PATH" ]; then
    log "Disabling and removing ${UNIT_PATH}"
    as_root systemctl disable --now "${SERVICE_NAME}.service" || true
    as_root rm -f "$UNIT_PATH"
    as_root systemctl daemon-reload
  fi
  log "Stopping and removing the container"
  compose down
  log "Uninstalled. Data in configs/, secrets/ and caches/ was left in place."
  exit 0
fi

# --- Pre-flight ---------------------------------------------------------------
if [ ! -f "$APP_DIR/configs/config.json" ]; then
  log "configs/config.json not found — copying configs/config.example.json"
  cp "$APP_DIR/configs/config.example.json" "$APP_DIR/configs/config.json"
  warn "edit configs/config.json with your settings, then re-run ./install.sh"
fi

if [ "$PULL" -eq 1 ]; then
  if [ -d "$APP_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    log "Pulling latest source"
    git -C "$APP_DIR" pull --ff-only
  else
    warn "--pull given but $APP_DIR is not a git checkout; skipping git pull"
  fi
fi

# --- Build + (re)start ----------------------------------------------------------
BUILD_ARGS=()
[ "$PULL" -eq 1 ] && BUILD_ARGS+=(--pull)

log "Building image"
compose build "${BUILD_ARGS[@]}"

# `up -d` recreates the container only when its image/config changed, so
# re-running after a rebuild picks up the new image with minimal downtime.
log "Starting container"
compose up -d --remove-orphans

# Drop dangling layers left behind by the previous image.
"${DOCKER_PREFIX[@]}" docker image prune -f >/dev/null || true

# --- Start on boot --------------------------------------------------------------
if has_systemd; then
  # Make sure the Docker daemon itself comes up at boot.
  as_root systemctl enable docker.service >/dev/null 2>&1 \
    || warn "could not enable docker.service; make sure Docker starts at boot"

  COMPOSE_BIN="$(command -v "${COMPOSE[0]}")"
  COMPOSE_ARGS="${COMPOSE[*]:1}"
  [ -n "$COMPOSE_ARGS" ] && COMPOSE_ARGS=" $COMPOSE_ARGS"

  UNIT_CONTENT="[Unit]
Description=energy-balance (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}
ExecStart=${COMPOSE_BIN}${COMPOSE_ARGS} up -d --remove-orphans
ExecStop=${COMPOSE_BIN}${COMPOSE_ARGS} stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
"

  if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$(printf '%s' "$UNIT_CONTENT")" ]; then
    log "${UNIT_PATH} already up to date"
  else
    log "Writing ${UNIT_PATH}"
    printf '%s' "$UNIT_CONTENT" | as_root tee "$UNIT_PATH" >/dev/null
    as_root systemctl daemon-reload
  fi
  as_root systemctl enable "${SERVICE_NAME}.service" >/dev/null
  # Mark the unit active without re-running it (the container is already up).
  as_root systemctl start "${SERVICE_NAME}.service"
  log "Enabled ${SERVICE_NAME}.service — the server will start on boot"
else
  warn "systemd not detected; relying on docker-compose.yml's 'restart: unless-stopped'."
  warn "Make sure the Docker daemon is configured to start at boot on this host."
fi

log "Done. The app is at http://localhost:8081/"

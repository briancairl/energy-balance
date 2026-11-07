#!/usr/bin/env bash
# Copies the data baked into the `seed` image (/seed) into the data volume
# (/data). Runs INSIDE a throwaway container started by deploy/deploy.sh:
#
#   docker run --rm -v energy-balance-data:/data energy-balance:deploy-seed \
#     bash /app/deploy/seed-data.sh [--force]
#
#   (no flag)  initialize /data — refuses (exit 3) if it already holds data
#   --force    back up the current /data to /data/.backups/, then replace it
#              with /seed
#   --check    exit 0 if /data is initialized, 1 if not (prints the marker)
#
# This is the last line of defence: deploy.sh already decides whether to seed,
# but this script independently refuses to touch existing data without --force.
set -euo pipefail

SEED=/seed
DATA=/data
MARKER="$DATA/.eb-seeded"
BACKUPS="$DATA/.backups"
KEEP_BACKUPS=10

MODE=init
case "${1:-}" in
  "")      ;;
  --force) MODE=force ;;
  --check) MODE=check ;;
  *) echo "seed-data.sh: unknown option: $1" >&2; exit 2 ;;
esac

# Initialized = seeded before, OR the app has written real data there (e.g. it
# was set up by hand) — either way it's not ours to overwrite silently.
initialized() {
  [ -e "$MARKER" ] || [ -e "$DATA/secrets/app_store.json" ] || [ -e "$DATA/configs/config.json" ]
}

if [ "$MODE" = check ]; then
  if initialized; then
    if [ -e "$MARKER" ]; then cat "$MARKER"; else echo '{"note": "data present, no seed marker"}'; fi
    exit 0
  fi
  exit 1
fi

[ -d "$SEED" ] || { echo "seed-data.sh: $SEED not found — run this from the seed image" >&2; exit 2; }
mkdir -p "$DATA"

if initialized; then
  if [ "$MODE" != force ]; then
    echo "Data volume is already initialized — leaving it untouched (use --force-data to replace it)."
    exit 3
  fi
  mkdir -p "$BACKUPS"
  backup="$BACKUPS/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  echo "Backing up current data to ${backup#"$DATA"/} (inside the volume)"
  tar -czf "$backup" -C "$DATA" --exclude=./.backups .
  # Keep only the newest $KEEP_BACKUPS backups.
  ls -1t "$BACKUPS"/data-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  find "$DATA" -mindepth 1 -maxdepth 1 ! -name .backups -exec rm -rf {} +
fi

echo "Copying seed data into the volume"
cp -a "$SEED"/. "$DATA"/
[ -d "$DATA/secrets" ] && chmod -R go-rwx "$DATA/secrets"
mkdir -p "$DATA/configs" "$DATA/caches" "$DATA/secrets"

# deploy.sh stages .eb-seed-info (source host, time, revision, file list);
# promote it to the marker so later runs know this volume is initialized.
if [ -e "$DATA/.eb-seed-info" ]; then
  mv "$DATA/.eb-seed-info" "$MARKER"
else
  printf '{"seeded_at": "%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER"
fi
echo "Data volume initialized."

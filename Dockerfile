# --- app: code only (no config, secrets or caches — see .dockerignore) --------
FROM python:3.12-slim AS app

WORKDIR /app

# Unbuffered stdout, so server.py's startup messages (including whether HTTPS
# came up) show in `docker logs` right away instead of sitting in a buffer.
ENV PYTHONUNBUFFERED=1

# server.py is stdlib-only — no pip install needed.
COPY . .

# The tailscale CLI only (not tailscaled) — used for `tailscale cert` /
# `tailscale status`, which talk to the HOST's already-running, already-
# authenticated tailscaled over its control socket (bind-mounted in by
# docker-compose.yml). This lets the container obtain a cert for the host's
# existing tailnet identity without joining the tailnet as a separate node
# itself. Downloaded with urllib instead of curl so the image doesn't need
# an extra apt package just for this.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    url="https://pkgs.tailscale.com/stable/tailscale_latest_${arch}.tgz"; \
    python3 -c "import urllib.request; urllib.request.urlretrieve(\"$url\", \"/tmp/ts.tgz\")"; \
    tar -xzf /tmp/ts.tgz -C /tmp; \
    mv /tmp/tailscale_*_"$arch"/tailscale /usr/local/bin/tailscale; \
    rm -rf /tmp/ts.tgz /tmp/tailscale_*_"$arch"

EXPOSE 8081 8082

CMD ["python3", "src/python/server.py"]

# --- seed: app + this machine's data, as ONE extra layer --------------------
# Built only by deploy/deploy.sh, with the data staged into a named build
# context (`--build-context seeddata=<dir>`). It shares every layer with
# `app` above and adds /seed on top. deploy.sh ships it only on a first
# install (or with --force-data), runs deploy/seed-data.sh from it once to
# copy /seed into the data volume, then deletes it on both ends — the app
# image you update with never contains any of this data.
FROM app AS seed
COPY --from=seeddata / /seed/

# --- default: plain `docker build .` / docker-compose.yml build the app -----
FROM app

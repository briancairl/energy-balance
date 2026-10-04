FROM python:3.12-slim

WORKDIR /app

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

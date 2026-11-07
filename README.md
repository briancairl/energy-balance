# energy-balance
Small locally hosted app for tracking nutrition targets for endurance training

## Running with Docker

Works the same on Windows or Linux:

```bash
docker compose up -d --build
```

This builds the image and runs it with the project directory mounted in, so
`configs/config.json`, `secrets/tokens.json`, the `caches/`, and
`secrets/app_store.json` are read/written straight from your checkout and
persist across restarts — same as running `python3 src/python/server.py`
directly. Copy `configs/config.example.json` to `configs/config.json` first
if you haven't already. The app is then at `http://localhost:8081/`.

### Installing as a service (Linux)

```bash
./install.sh            # build the image, start it, and start it on every boot
./install.sh --pull     # update: git pull + refresh base image, rebuild, restart
./install.sh --uninstall
```

`install.sh` runs the Docker build, starts the container, and on systemd hosts
installs `/etc/systemd/system/energy-balance.service`, which runs
`docker compose up -d` from this checkout once Docker is up at boot (it uses
`sudo` for the systemd steps). Re-running it rebuilds the image from the
current checkout and recreates the container only if the image changed; your
`configs/`, `secrets/` and `caches/` are untouched. Without systemd it falls
back to the compose file's `restart: unless-stopped` policy.

### Updating from the app

Setup → **App update** → **Update** pulls the latest `origin/main` and re-runs
`docker compose up -d --build`, but only if `main` has moved since the last
update (the checkout must be on `main`). The server can't rebuild the
container it runs in, so the button just drops `caches/update_request.json`;
on systemd hosts `install.sh` also installs `energy-balance-update.path`,
which watches for that file and runs `./update.sh` on the host. Progress and
the result show up in the card (from `caches/update_status.json`); logs are in
`journalctl -u energy-balance-update`. Without systemd, run `./update.sh` on
the host yourself (`--force` rebuilds even if main hasn't moved).

## Deploying to another machine over ssh

`deploy/deploy.sh` builds the image here and pushes it to a remote Docker host
over ssh (no registry needed), then starts it there:

```bash
deploy/deploy.sh user@host                # first install, or update the app
deploy/deploy.sh --status user@host       # what's deployed, data state
deploy/deploy.sh --backup user@host       # download the remote's data to ./backups/
deploy/deploy.sh --rollback user@host     # swap back to the previous app image
deploy/deploy.sh --force-data user@host   # REPLACE the remote's data with this machine's
deploy/deploy.sh --config-set tls_enabled=true user@host   # edit the remote's config.json + restart
```

The remote needs Docker with the compose plugin, and the ssh user must be able
to run `docker` (docker group or passwordless sudo). Ports, keys and jump hosts
come from `~/.ssh/config`. The image is built for the remote's CPU
(detected with `uname -m`, or pass `--platform`).

**How your data is handled:**

- The app image contains code only. On the remote, `config.json`,
  `schedule_sources/`, `secrets/` and the caches live in the Docker volume
  `energy-balance-data`. Updating the app never touches that volume.
- **First install** (the volume is empty): your data from this checkout is
  packed into a separate *seed* image, which is the app image plus one extra
  layer with the data. It is copied into the volume once, then the seed image
  is deleted on both machines. Your Strava connection comes along, so you don't
  need to redo OAuth on the remote.
- **Every later run** ships only the app. The remote keeps its own data, which
  it keeps updating as you use it.
- **`--force-data`** is the only way to overwrite the remote's data again. It
  asks you to type the host name (or pass `--yes`), stops the app, saves the
  current data to `/data/.backups/` inside the volume (newest 10 kept), and then
  copies in this machine's data.
- Not copied: the Tailscale cert/key (the remote gets its own) and the in-app
  update state. A pinned `tls_hostname` is cleared in the remote's copy, since
  Tailscale only issues a cert for a machine's own name.

**HTTPS on the remote.** Browsers flag plain `http://` as "not secure", and
phones set to HTTPS-only won't load it. For HTTPS the remote needs Tailscale
installed and logged in (`sudo tailscale up`), and `tls_enabled: true` in its
config. Then open `https://<remote>.<tailnet>.ts.net:8082/`, not the plain
`http://…:8081` address. After every deploy, restart and `--status`, the script
reports whether HTTPS came up, and why not if it didn't.

On the remote, the compose file is in `~/energy-balance` (`--remote-dir` changes
this). From there you can run `docker compose logs -f`, `restart` and so on. The
container restarts on boot as long as the Docker daemon is enabled at boot. The
in-app Update button is turned off on a remote install; update it with
`deploy.sh` from here.

## Project layout

```
assets/       Icons, logo, PWA manifest image
configs/      config.json, manifest.json, schedule_sources/, Tailscale cert/key
caches/       Strava/intervals.icu response caches
secrets/      app_store.json (data store), tokens.json — gitignored, never committed
src/js/       Frontend source (app-source.jsx) and compiled output (app.js)
src/python/   Backend: server.py and its helper scripts
deploy/       deploy.sh (push to a remote over ssh) and its helpers
```

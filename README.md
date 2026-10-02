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

## Project layout

```
assets/       Icons, logo, PWA manifest image
configs/      config.json, manifest.json, schedule_sources/, Tailscale cert/key
caches/       Strava/intervals.icu response caches
secrets/      app_store.json (data store), tokens.json — gitignored, never committed
src/js/       Frontend source (app-source.jsx) and compiled output (app.js)
src/python/   Backend: server.py and its helper scripts
```

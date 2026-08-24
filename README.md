# energy-balance
Small locally hosted app for tracking nutrition targets for endurance training

## Running with Docker

Works the same on Windows or Linux:

```bash
docker compose up -d --build
```

This builds the image and runs it with the project directory mounted in, so
`config.json`, `tokens.json`, the caches, and `app_store.json` are read/written
straight from your checkout and persist across restarts — same as running
`python3 server.py` directly. Copy `config.example.json` to `config.json`
first if you haven't already. The app is then at `http://localhost:8081/`.

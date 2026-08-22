#!/usr/bin/env python3
"""
Energy Balance — local backend.

Handles the Strava OAuth flow and calorie lookups server-side, because:
  1. Strava's token exchange endpoint has no CORS support, specifically so that
     apps can't do it from browser JS and leak their client_secret.
  2. Strava only puts `calories` on the per-activity DETAIL endpoint, not the
     summary list, so we have to make one authenticated call per activity.

Fetched activity data is cached to disk (strava_cache.json), keyed by date,
so a given historical date is only ever pulled from Strava once — including
across server restarts. Only "today" is always re-checked live, since new
activities can still land on it. Force a re-check of already-cached dates
with ?refresh=true, or wipe the whole cache via GET /api/strava/cache/clear.

Profile, nutrition log, weight log, and the intervals.icu cache are also
stored server-side now (app_store.json), not in the browser — so every
device pointed at this server (desktop, phone, tablet, on the same network)
sees and edits the same data, instead of each browser having its own copy.

A login is always required (HTTP Basic Auth) since this server is reachable
from your whole network, not just localhost. If config.json doesn't have
access_username/access_password set, one is generated automatically on first
run and saved there — check the terminal output after starting the server.

Optional real HTTPS via Tailscale: if you're on a tailnet, this server can get
a genuine, browser-trusted certificate (via Tailscale's built-in Let's Encrypt
integration) and serve HTTPS on a second port alongside the existing plain-HTTP
one — no self-signed-cert warnings, no browser settings to toggle. This is what
lets phones with "Always use secure connections" enabled (increasingly Chrome's
default) connect cleanly instead of erroring on a plain-HTTP server. See the
"HTTPS via Tailscale" section below.

This uses only the Python standard library — nothing to pip install.

Setup:
  1. Register an app at https://www.strava.com/settings/api
     - Authorization Callback Domain: localhost
  2. Copy config.example.json to config.json and fill in your client_id / client_secret.
     Leave access_username/access_password blank to have credentials generated
     for you, or set your own.
  3. Run:  python3 server.py
     It prints your login credentials (first run only) and two URLs: one for
     this machine, one for other devices on your network.
  4. On THIS machine, open the localhost URL and click "Connect to Strava" —
     Strava's OAuth callback only works from localhost (it's tied to the
     Authorization Callback Domain you registered), so do this step here once.
  5. On other devices (phone, tablet, another computer), open the LAN URL
     printed on startup, and log in with the same credentials. They read/write
     the same server-side data and reuse the Strava connection made in step 4
     automatically — no separate Strava login needed.

HTTPS via Tailscale (optional):
  1. In the Tailscale admin console, DNS page: enable MagicDNS, then under
     "HTTPS Certificates" select Enable HTTPS. One-time, account-level.
     Details: https://tailscale.com/docs/how-to/set-up-https-certificates
  2. Make sure the `tailscale` CLI is installed and on PATH on this machine
     (it already is if you installed the Tailscale app).
  3. In config.json, set "tls_enabled": true. Leave "tls_hostname" blank to
     auto-detect this machine's MagicDNS name, or set it explicitly. Leave
     "tls_port" blank to default to port + 1 (e.g. 8082 if port is 8081).
  4. Restart the server. It obtains a real certificate automatically (via
     `tailscale cert`) and serves HTTPS on the new port, alongside the
     existing plain-HTTP server — nothing about the HTTP setup above changes.
     The certificate renews itself automatically in the background.
  5. Use https://<your-tailscale-hostname>:<tls_port>/ from any device on
     your tailnet — including the local Strava-connect step in step 4 above,
     which can still use the plain http://localhost URL as before.

MacrosFirst via Google Sheets (optional):
  MacrosFirst's own API is partner-gated, but it already offers a Premium
  "Google Sheets Importer" that writes your daily nutrition log to a Sheet
  you own — this connects to THAT sheet via the standard Google Sheets API,
  same OAuth-broker pattern as Strava above.
  1. In MacrosFirst: enable Premium → Google Sheets Importer, and note the
     Sheet's ID (the long string in its URL between /d/ and /edit).
  2. In Google Cloud Console (console.cloud.google.com): create a project,
     enable the "Google Sheets API", and create OAuth 2.0 Client ID
     credentials (type: Web application). Add
     http://localhost:<port>/google/callback as an authorized redirect URI.
     While the app is in "Testing" publish status, add your own Google
     account as a test user — this is fine and expected for personal use,
     no Google app-review process needed.
  3. In config.json, set google_client_id, google_client_secret, and
     google_sheet_id from the steps above.
  4. Restart the server, open the localhost URL (same local-only rule as
     Strava's OAuth), and click "Connect Google Sheets" in the Log tab.
  5. Use "Sync from Google Sheet" any time to pull the latest rows — you'll
     map its columns once, same as a CSV import, since export layouts vary.
"""

import base64
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import threading
import time
from datetime import datetime, timedelta
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
TOKENS_PATH = os.path.join(HERE, "tokens.json")
GOOGLE_TOKENS_PATH = os.path.join(HERE, "google_tokens.json")
CACHE_PATH = os.path.join(HERE, "strava_cache.json")
INTERVALS_CACHE_PATH = os.path.join(HERE, "intervals_cache.json")
STORE_PATH = os.path.join(HERE, "app_store.json")
TLS_CERT_PATH = os.path.join(HERE, "tailscale.crt")
TLS_KEY_PATH = os.path.join(HERE, "tailscale.key")

STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"
INTERVALS_API = "https://intervals.icu/api/v1"
GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

# Python's urllib sends "Python-urllib/3.x" by default, which Cloudflare's
# Browser Integrity Check (and similar bot-detection on other APIs) flags
# and blocks outright — surfaces as a 403 "error code: 1010". A normal-looking
# browser User-Agent on our outbound requests avoids that.
OUTBOUND_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
}

# Icon/manifest assets served as static files — see logo-master.svg for the source.
STATIC_ASSETS = {
    "/favicon.ico": ("favicon.ico", "image/x-icon"),
    "/favicon-16x16.png": ("favicon-16x16.png", "image/png"),
    "/favicon-32x32.png": ("favicon-32x32.png", "image/png"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/icon-192-maskable.png": ("icon-192-maskable.png", "image/png"),
    "/icon-512-maskable.png": ("icon-512-maskable.png", "image/png"),
    "/logo-header.png": ("logo-header.png", "image/png"),
    "/manifest.json": ("manifest.json", "application/manifest+json"),
}


# Guards every JSON file's read-modify-write cycle. One global lock is simpler
# than per-file locks and these writes are infrequent/small enough that it
# costs nothing in practice — the goal is just to stop two nearly-simultaneous
# requests from truncating/writing the same file at the same time, which is
# exactly what corrupts it (interleaved partial writes -> invalid JSON).
_json_lock = threading.Lock()


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        # Don't let one corrupted file permanently break every request that
        # touches it — back it up for manual recovery and start fresh.
        backup_path = f"{path}.corrupt-{int(time.time())}"
        try:
            os.replace(path, backup_path)
            print(f"⚠️  {path} was corrupted ({e}); backed up to {backup_path} and starting fresh.")
        except OSError as backup_err:
            print(f"⚠️  {path} was corrupted ({e}); could not back it up: {backup_err}")
        return default


def save_json(path, data):
    """Writes to a temp file and atomically renames it into place, so a
    reader never sees a partially-written file, and a crash mid-write can't
    corrupt the original. Combined with _json_lock, this is what actually
    fixes the race — atomicity alone isn't enough if two writers still
    interleave their read-modify-write cycles."""
    tmp_path = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, path)


def load_store():
    """Generic key -> JSON value store, replacing what used to be per-browser
    localStorage. Keys used by the frontend: 'profile', 'nutrition-log',
    'weight-log', 'intervals-cache'."""
    with _json_lock:
        return load_json(STORE_PATH, {})


def save_store(store):
    with _json_lock:
        save_json(STORE_PATH, store)


def update_store(mutate_fn):
    """Atomic read-modify-write for the store: loads it, calls mutate_fn(store)
    to modify it in place (or return a replacement), and saves — all under one
    lock acquisition, so no other request's read-modify-write can interleave
    in between the read and the write. This is the piece that was missing:
    load_store()+save_store() called separately (as two lock acquisitions)
    still leaves a window for another thread to read stale data in between."""
    with _json_lock:
        store = load_json(STORE_PATH, {})
        result = mutate_fn(store)
        save_json(STORE_PATH, result if result is not None else store)
        return result if result is not None else store


def get_lan_ip():
    """Best-effort local network IP (doesn't actually send anything to 8.8.8.8,
    just uses a UDP socket to ask the OS which interface would be used)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def get_tls_config():
    """TLS is opt-in via config.json ('tls_enabled': true). Hostname can be
    set explicitly ('tls_hostname') or auto-detected from `tailscale status`.
    Requires MagicDNS + "Enable HTTPS" turned on once in the Tailscale admin
    console (DNS page) — tailscale.com/docs/how-to/set-up-https-certificates."""
    cfg = load_json(CONFIG_PATH, {})
    if not cfg.get("tls_enabled"):
        return None
    hostname = cfg.get("tls_hostname") or get_tailscale_hostname()
    if not hostname:
        print("⚠️  tls_enabled is true but no tls_hostname is set and none could be")
        print("     auto-detected from `tailscale status`. Set tls_hostname in config.json,")
        print("     or make sure the tailscale CLI is on PATH and you're logged in.")
        return None
    tls_port = cfg.get("tls_port") or (cfg.get("port", 8081) + 1)
    return {"hostname": hostname, "port": tls_port}


def get_tailscale_hostname():
    """Reads this machine's MagicDNS name from `tailscale status --json`."""
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        dns_name = (data.get("Self", {}) or {}).get("DNSName", "")
        return dns_name.rstrip(".") or None
    except Exception:
        return None


def ensure_tls_cert(hostname, cert_path, key_path):
    """Obtains (or renews) a real, trusted certificate for this hostname via
    Tailscale's built-in Let's Encrypt integration. Safe to call repeatedly —
    Tailscale just hands back the existing cert if it's still valid, so this
    can run on every startup and periodically thereafter without any cost."""
    try:
        result = subprocess.run(
            ["tailscale", "cert", "--cert-file", cert_path, "--key-file", key_path, hostname],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"  `tailscale cert` failed: {result.stderr.strip()}")
            return False
        return True
    except FileNotFoundError:
        print("  `tailscale` CLI not found on PATH — install Tailscale and make sure it's on PATH.")
        return False
    except Exception as e:
        print(f"  `tailscale cert` error: {e}")
        return False


def run_https_server(port, cert_path, key_path, ready_box):
    """Runs a second, HTTPS listener alongside the main HTTP one — same
    Handler, same data, different transport. Kept separate from the primary
    HTTP server (rather than replacing it) specifically so the Strava OAuth
    callback — which is hardcoded to plain http://localhost by Strava's own
    Authorization Callback Domain rules — keeps working unmodified."""
    https_server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    https_server.socket = context.wrap_socket(https_server.socket, server_side=True)
    ready_box["server"] = https_server
    ready_box["context"] = context
    ready_box["event"].set()
    https_server.serve_forever()


def tls_renewal_loop(hostname, cert_path, key_path, ssl_context):
    """Re-runs `tailscale cert` roughly daily. Reloading the context in place
    (rather than restarting the server) means already-open connections are
    unaffected and new ones just start picking up the renewed cert."""
    while True:
        time.sleep(20 * 60 * 60)
        if ensure_tls_cert(hostname, cert_path, key_path):
            try:
                ssl_context.load_cert_chain(cert_path, key_path)
                print("[tls] Certificate renewed.")
            except Exception as e:
                print(f"[tls] Renewed cert failed to load: {e}")


def load_cache():
    """Persistent on-disk cache of Strava activities, keyed by ISO date.
    An empty list for a date means "confirmed no activities that day" — a
    known rest day, not a gap. This survives server restarts, so a date is
    only ever fetched from Strava once (except today, always re-checked)."""
    return load_json(CACHE_PATH, {"by_date": {}})


def save_cache(cache):
    save_json(CACHE_PATH, cache)


def load_intervals_cache():
    """Same idea as the Strava cache, but for intervals.icu: activities and
    wellness entries, both keyed by ISO date. Fetched server-side now, so
    the data is available to every device without any browser having to
    have made the request first."""
    return load_json(INTERVALS_CACHE_PATH, {"activities_by_date": {}, "wellness_by_date": {}})


def save_intervals_cache(cache):
    save_json(INTERVALS_CACHE_PATH, cache)


def get_intervals_config():
    """intervals.icu credentials come from config.json now — a server-side
    default — rather than requiring each browser to have entered/cached an
    API key itself."""
    cfg = load_json(CONFIG_PATH, {})
    key = cfg.get("intervals_api_key")
    if not key:
        return None
    athlete_id = cfg.get("intervals_athlete_id") or "0"
    return {"api_key": key, "athlete_id": athlete_id}


def http_get_json_basic_auth(url, username, password):
    auth = base64.b64encode(f"{username}:{password}".encode()).decode()
    req = urllib.request.Request(url, headers={**OUTBOUND_HEADERS, "Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def date_range(start_date, end_date):
    d0 = time.mktime(time.strptime(start_date, "%Y-%m-%d"))
    d1 = time.mktime(time.strptime(end_date, "%Y-%m-%d"))
    dates = []
    cur = d0
    while cur <= d1:
        dates.append(time.strftime("%Y-%m-%d", time.localtime(cur)))
        cur += 86400
    return dates


def get_config():
    cfg = load_json(CONFIG_PATH)
    if not cfg or not cfg.get("client_id") or not cfg.get("client_secret"):
        return None
    cfg.setdefault("port", 8081)
    return cfg


def get_google_config():
    cfg = load_json(CONFIG_PATH, {})
    if not cfg.get("google_client_id") or not cfg.get("google_client_secret") or not cfg.get("google_sheet_id"):
        return None
    return {
        "client_id": cfg["google_client_id"],
        "client_secret": cfg["google_client_secret"],
        "sheet_id": cfg["google_sheet_id"],
        "range": cfg.get("google_sheet_range") or "A1:Z1000",
        "port": cfg.get("port", 8081),
    }


def ensure_fresh_google_token(gcfg):
    """Google's refresh response omits refresh_token (it stays the same and
    is reused, unlike Strava which rotates it) and returns expires_in
    (seconds) rather than an absolute expires_at, so that's computed here."""
    tokens = load_json(GOOGLE_TOKENS_PATH)
    if not tokens:
        return None
    if tokens.get("expires_at", 0) > time.time() + 60:
        return tokens
    try:
        result = http_post_form(GOOGLE_TOKEN_URL, {
            "client_id": gcfg["client_id"],
            "client_secret": gcfg["client_secret"],
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        })
    except urllib.error.HTTPError as e:
        print("Google token refresh failed:", e.read())
        return None
    tokens["access_token"] = result["access_token"]
    tokens["expires_at"] = time.time() + result.get("expires_in", 3600)
    save_json(GOOGLE_TOKENS_PATH, tokens)
    return tokens


def fetch_google_sheet_rows(gcfg, tokens):
    """Shared by the manual /api/google/sheet endpoint and the background
    auto-sync job. Returns {fields, rows} in the same shape a CSV import
    produces, so both paths can reuse the same column-mapping logic."""
    url = f"{GOOGLE_SHEETS_API}/{gcfg['sheet_id']}/values/{urllib.parse.quote(gcfg['range'])}"
    data = http_get_json(url, tokens["access_token"])
    values = data.get("values", [])
    if not values:
        return {"fields": [], "rows": []}
    fields = values[0]
    rows = []
    for raw_row in values[1:]:
        row = {}
        for idx, field in enumerate(fields):
            row[field] = raw_row[idx] if idx < len(raw_row) else ""
        rows.append(row)
    return {"fields": fields, "rows": rows}


def parse_sheet_date(raw):
    """Sheets returns dates as their DISPLAYED string by default (not serial
    numbers), but the exact format depends on the cell's own formatting —
    try the common ones. Returns an ISO date string, or None if unparseable."""
    raw = (raw or "").strip()
    if not raw:
        return None
    raw = re.sub(r"[T ]\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$", "", raw)  # strip a trailing time like " 0:00:00", without mangling "Aug 21, 2026"
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%b %d, %Y", "%B %d, %Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def normalize_nutrition_entry(raw):
    """Python mirror of the frontend's normalizeNutritionEntry — keeps manual
    and macrosfirst entries separate so one never silently clobbers the other."""
    if not raw:
        return {"manual": None, "macrosfirst": None}
    if "manual" in raw or "macrosfirst" in raw:
        return {"manual": raw.get("manual"), "macrosfirst": raw.get("macrosfirst")}
    return {"manual": raw, "macrosfirst": None}  # legacy flat shape


def auto_sync_google_sheet():
    """Fetches the sheet, applies the column mapping saved from the last
    manual "Sync from Google Sheet" + import, and writes results straight
    into nutrition-log's macrosfirst slot for each date — no browser needed."""
    gcfg = get_google_config()
    if not gcfg:
        return "not configured"
    tokens = ensure_fresh_google_token(gcfg)
    if not tokens:
        return "not connected"

    store = load_store()
    colmap = store.get("google-sheet-colmap")
    if not colmap or not colmap.get("date") or not colmap.get("calories"):
        return "no column mapping saved yet — do one manual sync + import first"

    sheet = fetch_google_sheet_rows(gcfg, tokens)  # network call — kept outside the lock below
    if not sheet["rows"]:
        return "sheet returned no rows"

    def num(row, col):
        if not col:
            return 0
        try:
            return float(str(row.get(col, "0")).replace(",", "") or 0)
        except ValueError:
            return 0

    updates = {}
    for row in sheet["rows"]:
        date_key = parse_sheet_date(row.get(colmap["date"]))
        if not date_key:
            continue
        updates[date_key] = {
            "calories": num(row, colmap["calories"]),
            "protein": num(row, colmap.get("protein")),
            "carbs": num(row, colmap.get("carbs")),
            "fat": num(row, colmap.get("fat")),
        }

    # Only this part touches the shared file, and it's a fast in-memory merge —
    # re-reads nutrition-log fresh under the lock so a concurrent write to some
    # other date (e.g. a manual entry from the browser) can't get clobbered.
    def mutate(s):
        nutrition = s.get("nutrition-log") or {}
        for date_key, macros in updates.items():
            existing = normalize_nutrition_entry(nutrition.get(date_key))
            existing["macrosfirst"] = macros
            nutrition[date_key] = existing
        s["nutrition-log"] = nutrition
        s["google-last-auto-sync"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        return s
    update_store(mutate)
    return f"imported {len(updates)} row(s)"


def seconds_until_next(hh, mm):
    now = datetime.now()
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def google_auto_sync_loop():
    while True:
        cfg = load_json(CONFIG_PATH, {})
        time_str = cfg.get("google_sync_time") or "04:00"
        try:
            hh, mm = (int(x) for x in time_str.split(":"))
        except Exception:
            hh, mm = 4, 0
        wait = seconds_until_next(hh, mm)
        print(f"[google-sync] next automatic sync at {hh:02d}:{mm:02d} (in {wait / 3600:.1f}h)")
        time.sleep(wait)
        try:
            result = auto_sync_google_sheet()
            print(f"[google-sync] {result}")
        except Exception as e:
            print(f"[google-sync] failed: {e}")


def ensure_auth_config():
    """Guarantees a username/password exist — generating and saving one on
    first run if config.json doesn't have them — so the server never runs
    open to the network. Returns (username, password, was_just_generated)."""
    cfg = load_json(CONFIG_PATH, {})
    changed = False
    generated = False
    if not cfg.get("access_username"):
        cfg["access_username"] = "athlete"
        changed = True
    if not cfg.get("access_password"):
        cfg["access_password"] = secrets.token_urlsafe(9)
        changed = True
        generated = True
    if changed:
        save_json(CONFIG_PATH, cfg)
    return cfg["access_username"], cfg["access_password"], generated


def http_post_form(url, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers=OUTBOUND_HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def http_get_json(url, token):
    req = urllib.request.Request(url, headers={**OUTBOUND_HEADERS, "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def ensure_fresh_token(cfg):
    tokens = load_json(TOKENS_PATH)
    if not tokens:
        return None
    if tokens.get("expires_at", 0) > time.time() + 60:
        return tokens
    # refresh
    try:
        result = http_post_form(STRAVA_TOKEN_URL, {
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        })
    except urllib.error.HTTPError as e:
        print("Token refresh failed:", e.read())
        return None
    tokens["access_token"] = result["access_token"]
    tokens["refresh_token"] = result["refresh_token"]
    tokens["expires_at"] = result["expires_at"]
    save_json(TOKENS_PATH, tokens)
    return tokens


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[server]", fmt % args)

    def _check_auth(self):
        """HTTP Basic Auth, always required — this server is reachable from
        every device on your network, not just localhost, so there's no
        "off" mode. Credentials come from config.json (auto-generated on
        first run if not set — see the terminal output at startup)."""
        user, pw, _ = ensure_auth_config()
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:]).decode()
                got_user, got_pw = decoded.split(":", 1)
                if got_user == user and got_pw == pw:
                    return True
            except Exception:
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Energy Balance"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html, status=200):
        body = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        if not os.path.exists(path):
            self.send_response(404)
            self.end_headers()
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._check_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            return self._send_file(os.path.join(HERE, "index.html"), "text/html; charset=utf-8")
        if path == "/app.js":
            return self._send_file(os.path.join(HERE, "app.js"), "application/javascript")
        if path in STATIC_ASSETS:
            fname, ctype = STATIC_ASSETS[path]
            return self._send_file(os.path.join(HERE, fname), ctype)

        if path == "/login":
            cfg = get_config()
            if not cfg:
                return self._send_html(MISSING_CONFIG_HTML, 500)
            host = (self.headers.get("Host") or "").split(":")[0]
            if host not in ("localhost", "127.0.0.1"):
                return self._send_html(WRONG_HOST_LOGIN_HTML.format(port=cfg["port"]), 400)
            redirect_uri = f"http://localhost:{cfg['port']}/callback"
            params = {
                "client_id": cfg["client_id"],
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "approval_prompt": "auto",
                "scope": "activity:read_all,profile:read_all",
            }
            url = STRAVA_AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()
            return

        if path == "/callback":
            cfg = get_config()
            if not cfg:
                return self._send_html(MISSING_CONFIG_HTML, 500)
            error = qs.get("error", [None])[0]
            if error:
                return self._send_html(f"<h2>Strava authorization failed</h2><p>{error}</p>", 400)
            code = qs.get("code", [None])[0]
            if not code:
                return self._send_html("<h2>Missing authorization code</h2>", 400)
            try:
                result = http_post_form(STRAVA_TOKEN_URL, {
                    "client_id": cfg["client_id"],
                    "client_secret": cfg["client_secret"],
                    "code": code,
                    "grant_type": "authorization_code",
                })
            except urllib.error.HTTPError as e:
                return self._send_html(f"<h2>Token exchange failed</h2><pre>{e.read().decode()}</pre>", 500)
            tokens = {
                "access_token": result["access_token"],
                "refresh_token": result["refresh_token"],
                "expires_at": result["expires_at"],
                "athlete": result.get("athlete"),
            }
            save_json(TOKENS_PATH, tokens)
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        if path == "/google/login":
            gcfg = get_google_config()
            if not gcfg:
                return self._send_html(MISSING_GOOGLE_CONFIG_HTML, 500)
            host = (self.headers.get("Host") or "").split(":")[0]
            if host not in ("localhost", "127.0.0.1"):
                return self._send_html(WRONG_HOST_LOGIN_HTML.format(port=gcfg["port"]), 400)
            redirect_uri = f"http://localhost:{gcfg['port']}/google/callback"
            params = {
                "client_id": gcfg["client_id"],
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "https://www.googleapis.com/auth/spreadsheets.readonly",
                "access_type": "offline",  # needed to get a refresh_token
                "prompt": "consent",       # forces a refresh_token even on re-auth
            }
            url = GOOGLE_AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()
            return

        if path == "/google/callback":
            gcfg = get_google_config()
            if not gcfg:
                return self._send_html(MISSING_GOOGLE_CONFIG_HTML, 500)
            error = qs.get("error", [None])[0]
            if error:
                return self._send_html(f"<h2>Google authorization failed</h2><p>{error}</p>", 400)
            code = qs.get("code", [None])[0]
            if not code:
                return self._send_html("<h2>Missing authorization code</h2>", 400)
            redirect_uri = f"http://localhost:{gcfg['port']}/google/callback"
            try:
                result = http_post_form(GOOGLE_TOKEN_URL, {
                    "client_id": gcfg["client_id"],
                    "client_secret": gcfg["client_secret"],
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": redirect_uri,
                })
            except urllib.error.HTTPError as e:
                return self._send_html(f"<h2>Token exchange failed</h2><pre>{e.read().decode()}</pre>", 500)
            if "refresh_token" not in result:
                # Happens if the user had already granted consent before and
                # Google didn't re-issue one — prompt=consent above should
                # normally prevent this, but fail loudly rather than silently.
                return self._send_html(
                    "<h2>No refresh token returned</h2>"
                    "<p>Revoke this app's access at "
                    "<a href='https://myaccount.google.com/permissions'>myaccount.google.com/permissions</a> "
                    "and try connecting again.</p>", 500)
            tokens = {
                "access_token": result["access_token"],
                "refresh_token": result["refresh_token"],
                "expires_at": time.time() + result.get("expires_in", 3600),
            }
            save_json(GOOGLE_TOKENS_PATH, tokens)
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        if path == "/api/google/status":
            gcfg = get_google_config()
            if not gcfg:
                return self._send_json({"connected": False, "configError": True})
            tokens = ensure_fresh_google_token(gcfg)
            return self._send_json({"connected": tokens is not None})

        if path == "/api/google/sheet":
            gcfg = get_google_config()
            if not gcfg:
                return self._send_json({"error": "Google Sheets not configured. See config.example.json."}, 500)
            tokens = ensure_fresh_google_token(gcfg)
            if not tokens:
                return self._send_json({"error": "Not connected to Google. Visit /google/login first."}, 401)
            try:
                sheet = fetch_google_sheet_rows(gcfg, tokens)
            except urllib.error.HTTPError as e:
                return self._send_json({"error": f"Google Sheets API error {e.code}: {e.read().decode()}"}, 502)
            return self._send_json(sheet)

        if path == "/api/strava/status":
            cfg = get_config()
            if not cfg:
                return self._send_json({"connected": False, "configError": True})
            tokens = ensure_fresh_token(cfg)
            if not tokens:
                return self._send_json({"connected": False})
            athlete = tokens.get("athlete") or {}
            return self._send_json({
                "connected": True,
                "athlete": {
                    "firstname": athlete.get("firstname"),
                    "lastname": athlete.get("lastname"),
                },
            })

        if path == "/api/strava/disconnect":
            if os.path.exists(TOKENS_PATH):
                os.remove(TOKENS_PATH)
            return self._send_json({"ok": True})

        if path == "/api/strava/cache/status":
            cache = load_cache()
            dates = list(cache.get("by_date", {}).keys())
            return self._send_json({"cachedDates": len(dates), "oldest": min(dates) if dates else None, "newest": max(dates) if dates else None})

        if path == "/api/strava/cache/clear":
            if os.path.exists(CACHE_PATH):
                os.remove(CACHE_PATH)
            return self._send_json({"ok": True})

        if path == "/api/store":
            key = qs.get("key", [None])[0]
            if not key:
                return self._send_json({"error": "missing key"}, 400)
            store = load_store()
            return self._send_json({"key": key, "value": store.get(key)})

        if path == "/api/intervals/status":
            cfg = get_intervals_config()
            return self._send_json({"configured": cfg is not None, "athleteId": cfg["athlete_id"] if cfg else None})

        if path == "/api/intervals/activities":
            cfg = get_intervals_config()
            if not cfg:
                return self._send_json({"error": "intervals.icu not configured. Add intervals_api_key to config.json."}, 500)

            dates_param = qs.get("dates", [None])[0]
            force_refresh = qs.get("refresh", ["false"])[0].lower() == "true"
            today = time.strftime("%Y-%m-%d", time.localtime())

            if dates_param:
                requested_dates = sorted(set(d for d in dates_param.split(",") if d))
            else:
                days = int(qs.get("days", ["21"])[0])
                oldest = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
                requested_dates = date_range(oldest, today)

            cache = load_intervals_cache()
            acts_by_date = cache.setdefault("activities_by_date", {})
            wellness_by_date = cache.setdefault("wellness_by_date", {})

            # Same idea as the Strava cache: skip intervals.icu entirely for
            # any date we've already fetched, except today.
            dates_to_fetch = [d for d in requested_dates if force_refresh or d == today or d not in acts_by_date]

            if dates_to_fetch:
                oldest_f, newest_f = min(dates_to_fetch), max(dates_to_fetch)
                try:
                    act_url = f"{INTERVALS_API}/athlete/{cfg['athlete_id']}/activities?oldest={oldest_f}&newest={newest_f}"
                    act_data = http_get_json_basic_auth(act_url, "API_KEY", cfg["api_key"])

                    well_url = f"{INTERVALS_API}/athlete/{cfg['athlete_id']}/wellness.json?oldest={oldest_f}&newest={newest_f}"
                    try:
                        well_data = http_get_json_basic_auth(well_url, "API_KEY", cfg["api_key"])
                    except urllib.error.HTTPError:
                        well_data = []

                    fetched_acts_by_date = {d: [] for d in dates_to_fetch}
                    for a in act_data:
                        d = (a.get("start_date_local") or a.get("start_date") or "")[:10]
                        if d in fetched_acts_by_date:
                            fetched_acts_by_date[d].append(a)
                        elif d:
                            fetched_acts_by_date.setdefault(d, []).append(a)

                    fetched_wellness_by_date = {}
                    for w in well_data:
                        d = w.get("id") or w.get("date")
                        if d:
                            fetched_wellness_by_date[d] = w

                    for d in dates_to_fetch:
                        acts_by_date[d] = fetched_acts_by_date.get(d, [])
                        wellness_by_date[d] = fetched_wellness_by_date.get(d)  # may be None — cached as such
                    save_intervals_cache(cache)
                except urllib.error.HTTPError as e:
                    body = e.read().decode()
                    return self._send_json({"error": f"intervals.icu API error {e.code}: {body}"}, 502)

            activities = []
            wellness = []
            for d in requested_dates:
                activities.extend(acts_by_date.get(d, []))
                w = wellness_by_date.get(d)
                if w:
                    wellness.append(w)

            return self._send_json({
                "activities": activities,
                "wellness": wellness,
                "syncedDates": requested_dates,
                "fromCache": len(requested_dates) - len(dates_to_fetch),
                "fetchedFromIntervals": len(dates_to_fetch),
            })

        if path == "/api/strava/activities":
            cfg = get_config()
            if not cfg:
                return self._send_json({"error": "Server not configured. See config.example.json."}, 500)
            tokens = ensure_fresh_token(cfg)
            if not tokens:
                return self._send_json({"error": "Not connected to Strava. Visit /login first."}, 401)

            dates_param = qs.get("dates", [None])[0]
            force_refresh = qs.get("refresh", ["false"])[0].lower() == "true"
            today = time.strftime("%Y-%m-%d", time.localtime())

            if dates_param:
                requested_dates = sorted(set(d for d in dates_param.split(",") if d))
            else:
                # Full-range mode: used for the initial bootstrap sync.
                days = int(qs.get("days", ["21"])[0])
                oldest = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
                requested_dates = date_range(oldest, today)

            cache = load_cache()
            by_date = cache.setdefault("by_date", {})

            # Skip Strava entirely for any date already on disk — except today,
            # which stays "live" since more activities can still land on it.
            dates_to_fetch = [d for d in requested_dates if force_refresh or d == today or d not in by_date]

            if dates_to_fetch:
                oldest_f, newest_f = min(dates_to_fetch), max(dates_to_fetch)
                after_ts = int(time.mktime(time.strptime(oldest_f, "%Y-%m-%d")))
                before_ts = int(time.mktime(time.strptime(newest_f, "%Y-%m-%d"))) + 86400
                try:
                    summaries = []
                    page = 1
                    while True:
                        url = f"{STRAVA_API}/athlete/activities?after={after_ts}&before={before_ts}&per_page=100&page={page}"
                        batch = http_get_json(url, tokens["access_token"])
                        if not batch:
                            break
                        summaries.extend(batch)
                        if len(batch) < 100:
                            break
                        page += 1
                        if page > 5:  # safety cap: 500 activities
                            break

                    wanted = set(dates_to_fetch)
                    summaries = [s for s in summaries if (s.get("start_date_local") or "")[:10] in wanted]

                    fetched_by_date = {d: [] for d in dates_to_fetch}
                    for s in summaries:
                        d = (s.get("start_date_local") or "")[:10]
                        act_id = s["id"]
                        try:
                            detail = http_get_json(f"{STRAVA_API}/activities/{act_id}", tokens["access_token"])
                        except urllib.error.HTTPError:
                            detail = {}
                        fetched_by_date.setdefault(d, []).append({
                            "id": act_id,
                            "name": s.get("name"),
                            "type": s.get("type"),
                            "start_date_local": s.get("start_date_local"),
                            "moving_time": s.get("moving_time"),
                            "kilojoules": s.get("kilojoules"),
                            "calories": detail.get("calories"),
                            "suffer_score": detail.get("suffer_score") or s.get("suffer_score"),
                        })

                    for d, acts in fetched_by_date.items():
                        by_date[d] = acts  # empty list = confirmed rest day, cached as such
                    save_cache(cache)
                except urllib.error.HTTPError as e:
                    body = e.read().decode()
                    return self._send_json({"error": f"Strava API error {e.code}: {body}"}, 502)

            results = []
            for d in requested_dates:
                results.extend(by_date.get(d, []))

            return self._send_json({
                "activities": results,
                "syncedDates": requested_dates,
                "fromCache": len(requested_dates) - len(dates_to_fetch),
                "fetchedFromStrava": len(dates_to_fetch),
            })

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if not self._check_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/store":
            key = qs.get("key", [None])[0]
            if not key:
                return self._send_json({"error": "missing key"}, 400)
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"null"
            try:
                value = json.loads(raw.decode())
            except json.JSONDecodeError:
                return self._send_json({"error": "invalid JSON body"}, 400)

            def mutate(s):
                s[key] = value
                return s
            update_store(mutate)
            return self._send_json({"ok": True, "key": key})

        self.send_response(404)
        self.end_headers()


MISSING_CONFIG_HTML = """
<h2>config.json not found or incomplete</h2>
<p>Copy <code>config.example.json</code> to <code>config.json</code> in the same folder as
<code>server.py</code>, and fill in your Strava <code>client_id</code> and
<code>client_secret</code> from <a href="https://www.strava.com/settings/api">
strava.com/settings/api</a> (set Authorization Callback Domain to <code>localhost</code>),
then restart the server.</p>
"""

MISSING_GOOGLE_CONFIG_HTML = """
<h2>Google Sheets isn't configured</h2>
<p>Set <code>google_client_id</code>, <code>google_client_secret</code>, and
<code>google_sheet_id</code> in <code>config.json</code> — see the "MacrosFirst via Google
Sheets" section at the top of <code>server.py</code> for the full setup, then restart.</p>
"""

WRONG_HOST_LOGIN_HTML = """
<h2>Connect from this machine, not over the network</h2>
<p>This OAuth callback is tied to the domain registered with the provider
(<code>localhost</code>), so the one-time "Connect" step only works when opened
as <code>http://localhost:{port}/</code> directly on the computer running <code>server.py</code>.</p>
<p>Once you've connected it there, every other device on your network (phone, tablet, etc.)
automatically shares that same connection — they never need to do this step themselves.</p>
"""


def main():
    cfg = get_config()
    port = cfg["port"] if cfg else 8081
    if not cfg:
        print(f"⚠️  No valid config.json found in {HERE}.")
        print("   Copy config.example.json -> config.json and fill in your Strava client_id/client_secret.")
        print(f"   The server will still start on port {port} so you can see setup instructions at /login.")

    user, pw, generated = ensure_auth_config()
    lan_ip = get_lan_ip()

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Energy Balance server running.")
    print(f"  This machine: http://localhost:{port}/")
    if lan_ip:
        print(f"  Other devices on your network: http://{lan_ip}:{port}/")
    else:
        print("  Could not detect a LAN IP — check your network connection if you need other devices to connect.")

    tls_cfg = get_tls_config()
    if tls_cfg:
        print(f"  Setting up HTTPS for {tls_cfg['hostname']} …")
        if ensure_tls_cert(tls_cfg["hostname"], TLS_CERT_PATH, TLS_KEY_PATH):
            ready_box = {"event": threading.Event()}
            threading.Thread(
                target=run_https_server,
                args=(tls_cfg["port"], TLS_CERT_PATH, TLS_KEY_PATH, ready_box),
                daemon=True,
            ).start()
            ready_box["event"].wait(timeout=10)
            if "context" in ready_box:
                print(f"  HTTPS (real, trusted cert): https://{tls_cfg['hostname']}:{tls_cfg['port']}/")
                threading.Thread(
                    target=tls_renewal_loop,
                    args=(tls_cfg["hostname"], TLS_CERT_PATH, TLS_KEY_PATH, ready_box["context"]),
                    daemon=True,
                ).start()
            else:
                print("  ⚠️  HTTPS listener failed to start in time — continuing on HTTP only.")
        else:
            print("  ⚠️  Could not obtain a TLS certificate — continuing on HTTP only.")
            print("     Make sure MagicDNS + \"Enable HTTPS\" are turned on for your tailnet:")
            print("     https://tailscale.com/docs/how-to/set-up-https-certificates")

    if get_google_config():
        threading.Thread(target=google_auto_sync_loop, daemon=True).start()
        print("  Google Sheets auto-sync scheduled (set google_sync_time in config.json, default 04:00).")

    if generated:
        print("  🔑 Generated login credentials (saved to config.json):")
        print(f"     username: {user}")
        print(f"     password: {pw}")
        print("     Use these to log in from every device — change them any time in config.json.")
    else:
        print(f"  🔑 Login required — username: {user} (password set in config.json)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()

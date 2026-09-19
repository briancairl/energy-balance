"""
schedule_sync.py — shared logic for turning a training-schedule JSON file
into entries in the app's `training-schedule` store key.

This used to live only in sync_schedule_from_plan.py, hardcoded to one file
(road_to_placid_plan.json) that you had to re-run by hand. It's now a plain
library of pure functions so two callers can share it:

  - server.py's schedule_sources_sync_loop(), which watches every *.json file
    in schedule_sources/ and re-imports one automatically (via a content
    hash, not mtime — see file_sha256) whenever it changes, with no restart
    or manual step needed.
  - sync_schedule_from_plan.py, kept as a thin CLI for manual/--dry-run use
    against a single file.

Each file in schedule_sources/ is tagged with its own source (the filename
without ".json"), so importing several files at once — e.g. a periodized
base plan plus a separate hand-curated block — never confuses one file's
entries for another's, and re-importing one file only ever replaces that
file's own previously-synced entries.

Two input shapes are supported, auto-detected by sync_source_into_store():
  - "plan" format: {"meta": {"races": [...]}, "weeks": [...]} — a full
    periodized plan export (see sync_plan_into_store). Races persist forever
    once added; single-session entries regenerate every sync against a
    rolling --weeks-ahead window.
  - "entries" format: {"entries": [...]} (or a bare top-level list) of
    already-shaped training-schedule entries — kind "single"/"race"/
    "recurring" exactly as the app itself stores them, minus "id"/"source"
    (stamped on import). No time-window regeneration: the file is simply
    authoritative for its own entries, replaced wholesale each sync. This is
    the shape to reach for when you already know the exact sessions you want
    rather than deriving them from a periodized plan.
"""
import hashlib
import json
import os
import random
import re
import string
import datetime as dt

_SAFE_STEM_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def sanitize_source_filename(name):
    """Turns a user-supplied filename (from a browser file picker — never
    trust it as a path) into a safe basename to write under schedule_sources/.
    Strips any directory components first (a name like '../../etc/passwd' or
    'a/b.json' must not escape the directory), then drops everything but
    [A-Za-z0-9_.-] from the stem, so the result can only ever land inside
    schedule_sources/ as a single flat file. Returns None if nothing usable
    is left (e.g. a name that was all path separators or all stripped)."""
    base = os.path.basename(name or "")
    if base.endswith(".json"):
        base = base[:-len(".json")]
    stem = _SAFE_STEM_RE.sub("_", base).strip("._")
    if not stem:
        return None
    return stem + ".json"

DISC_TO_ACTIVITY = {"swim": "Swim", "bike": "Ride", "run": "Run", "strength": "Strength"}
SKIP_DISC = {"rest", "walk"}

RACE_TUNING = {
    # plan race id -> (taperDays, zone)
    "oly2026": (7, 2),
    "half2026": (4, 3),
    "marathon2026": (10, 3),
    "lp2027": (14, 3),
    "li703_2027": (7, 3),
}

RACE_DURATION_LOOKUP = {
    "oly2026": 100, "half2026": 105, "marathon2026": 240,
    "lp2027": 720, "li703_2027": 300,
}


def file_sha256(path):
    """Content hash used to decide whether a schedule-source file actually
    changed. Deliberately hashes bytes, not mtime — mtime changes on a touch
    or a checkout with no content change, which would trigger pointless
    re-imports; a hash only changes when the plan itself does."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def discover_schedule_sources(sources_dir):
    """Every *.json file in sources_dir is a plan to import, tagged with its
    own filename stem so multiple plans can coexist without their entries
    colliding. Returns a sorted list of (path, source_tag) for determinism."""
    if not os.path.isdir(sources_dir):
        return []
    out = []
    for name in os.listdir(sources_dir):
        if name.endswith(".json"):
            out.append((os.path.join(sources_dir, name), name[:-len(".json")]))
    return sorted(out)


def gen_id(offset=0):
    ms = int(dt.datetime.now().timestamp() * 1000) + offset
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{ms}-{suffix}"


def classify_zone(disc, title, detail):
    if disc == "strength":
        return 1
    text = f"{title} {detail}".lower()
    if "recovery" in text and "spin" in text:
        return 1
    if any(k in text for k in ["dress rehearsal", "marathon pace", "tempo", "threshold", "race power",
                                "race-pace", "race pace", "hills", "surges", "70.3 pace"]):
        return 3
    return 2


def short_note(title):
    # "Swim — Technique" -> "Technique", "Bike — Long w/ Climbing" -> "Long w/ Climbing"
    if "—" in title:
        return title.split("—", 1)[1].strip()
    return title


def covered_by_existing(session_date, kept_entries):
    """True if a KEPT (not from this same source) recurring or single entry
    already applies to this date — regardless of activity type. Prevents
    double-counting a day the athlete (or another plan source) already has
    an entry for."""
    js_weekday = (session_date.weekday() + 1) % 7
    iso = session_date.isoformat()
    for e in kept_entries:
        if e.get("kind") == "race":
            continue
        if e.get("kind") == "single":
            if e.get("date") == iso:
                return True
            continue
        days = e.get("daysOfWeek") or []
        if js_weekday not in days:
            continue
        if iso < e.get("startDate", "0000-00-00"):
            continue
        end = e.get("endDate")
        if end and iso > end:
            continue
        return True
    return False


def sync_plan_into_store(store, plan, source_tag, weeks_ahead=8):
    """Pure function: given an already-parsed plan dict and the full store
    dict, returns (new_schedule, summary_lines). Does not touch disk — callers
    decide when/how to persist (server.py does it inside update_store's lock;
    the CLI does it as a one-shot atomic write)."""
    schedule = store.get("training-schedule", [])
    today = dt.date.today()
    window_start = today
    window_end = today + dt.timedelta(weeks=weeks_ahead)

    existing_race_dates = {e["raceDate"] for e in schedule if e.get("kind") == "race"}

    # Only this source's *single* (window-refreshed) entries get dropped and
    # regenerated each sync. Race entries this source already added are left
    # in `kept` untouched — races are added once and never rebuilt, so a
    # second sync must not strip them out only to see existing_race_dates
    # (computed above, before filtering) block them from being re-added.
    kept = [e for e in schedule
            if not (e.get("source") == source_tag and e.get("kind") == "single")]
    capped_log = []
    for e in kept:
        if e.get("kind") in ("race", "single"):
            continue
        if e.get("endDate") in (None, ""):
            new_end = (window_start - dt.timedelta(days=1)).isoformat()
            capped_log.append((e.get("id"), e.get("notes") or e.get("activityType"), new_end))
            e["endDate"] = new_end

    new_entries = []

    # --- races (whole calendar, not window-limited) ---
    for race in plan.get("meta", {}).get("races", []):
        if race["date"] in existing_race_dates:
            continue
        taper_days, zone = RACE_TUNING.get(race["id"], (7, 3))
        new_entries.append({
            "id": gen_id(len(new_entries)),
            "kind": "race",
            "activityType": "Other",
            "zone": zone,
            "durationMin": RACE_DURATION_LOOKUP.get(race["id"], 120),
            "raceDate": race["date"],
            "taperDays": taper_days,
            "notes": race["name"],
            "source": source_tag,
        })

    # --- recurring sessions, window-limited ---
    n_sessions = 0
    n_skipped_conflict = 0
    for week in plan.get("weeks", []):
        week_start = dt.date.fromisoformat(week["weekStart"])
        if week_start > window_end:
            continue
        week_end = dt.date.fromisoformat(week["weekEnd"])
        if week_end < window_start:
            continue
        for s in week["sessions"]:
            disc = s["disc"]
            if disc in SKIP_DISC or s["mins"] <= 0:
                continue
            if s["title"].upper().startswith("RACE"):
                continue  # represented by the race entry instead
            activity_type = DISC_TO_ACTIVITY.get(disc)
            if not activity_type:
                continue
            day_offset = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].index(s["day"])
            session_date = week_start + dt.timedelta(days=day_offset)
            if not (window_start <= session_date <= window_end):
                continue
            if covered_by_existing(session_date, kept):
                n_skipped_conflict += 1
                continue
            new_entries.append({
                "id": gen_id(len(new_entries) + 1000),
                "kind": "single",
                "activityType": activity_type,
                "zone": classify_zone(disc, s["title"], s.get("detail", "")),
                "durationMin": s["mins"],
                "date": session_date.isoformat(),
                "notes": short_note(s["title"]),
                "source": source_tag,
            })
            n_sessions += 1

    final_schedule = kept + new_entries

    lines = [f"[{source_tag}] window: {window_start} .. {window_end} ({weeks_ahead} weeks)",
             f"[{source_tag}] kept {len(kept)} existing entries (not from this source)."]
    for eid, label, new_end in capped_log:
        lines.append(f"[{source_tag}]   capped open-ended entry {eid!r} ({label!r}) -> endDate {new_end}")
    n_races_added = sum(1 for e in new_entries if e.get("kind") == "race")
    lines.append(f"[{source_tag}] added {n_races_added} race entries, {n_sessions} single session entries.")
    if n_skipped_conflict:
        lines.append(f"[{source_tag}] skipped {n_skipped_conflict} plan session(s) "
                      f"overlapping a date already covered by another entry.")
    lines.append(f"[{source_tag}] total training-schedule entries after sync: {len(final_schedule)}")

    return final_schedule, lines


def sync_entries_into_store(store, entries, source_tag):
    """Pure function for the "entries" input shape: the file already lists
    exact training-schedule entries, so there's no window to regenerate —
    each sync just replaces this source's entries wholesale with whatever
    the file currently says. Simpler than sync_plan_into_store because
    there's nothing to derive: an id is assigned only if the entry doesn't
    already carry one (so hand-picked stable ids survive a re-sync), and the
    source tag is always stamped fresh so a copy-pasted entry can't
    accidentally claim to belong to a different source."""
    schedule = store.get("training-schedule", [])
    kept = [e for e in schedule if e.get("source") != source_tag]

    new_entries = []
    for i, e in enumerate(entries):
        entry = dict(e)
        entry.setdefault("id", gen_id(i))
        entry["source"] = source_tag
        new_entries.append(entry)

    final_schedule = kept + new_entries
    lines = [
        f"[{source_tag}] entries file: kept {len(kept)} existing entries (not from this source), "
        f"wrote {len(new_entries)} entries from file.",
        f"[{source_tag}] total training-schedule entries after sync: {len(final_schedule)}",
    ]
    return final_schedule, lines


def sync_source_into_store(store, data, source_tag, weeks_ahead=8):
    """Dispatches to the right sync function based on the file's shape —
    see the module docstring for what each shape looks like."""
    if isinstance(data, list):
        return sync_entries_into_store(store, data, source_tag)
    if isinstance(data, dict) and "entries" in data:
        return sync_entries_into_store(store, data["entries"], source_tag)
    return sync_plan_into_store(store, data, source_tag, weeks_ahead=weeks_ahead)

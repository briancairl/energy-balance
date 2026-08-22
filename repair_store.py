#!/usr/bin/env python3
"""
Best-effort recovery for a corrupted app_store.json.

What happened: two nearly-simultaneous writes to the store file (from the
old server.py, before the concurrency fix) interleaved their writes and left
the file as invalid JSON — valid content up to some point, garbage after.

This script finds the longest prefix of the file that forms valid JSON (by
walking through it, and after every closing '}' or ']', trying to close off
whatever structures were still open and parse the result), and writes that
out as a separate file for you to review — it never touches your original.

Usage:
    python3 repair_store.py app_store.json
    (or point it at the .corrupt-<timestamp> backup the fixed server.py
    creates automatically the first time it encounters the corrupted file)

Output:
    <input>.recovered.json — review this, then rename/copy it over
    app_store.json yourself (with the server stopped) if it looks right.
"""

import json
import sys


def try_parse(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def attempt_recovery(text):
    result = try_parse(text)
    if result is not None:
        return result, "The file actually parses as-is — it may not be corrupted after all."

    stack = []
    best = None
    for i, ch in enumerate(text):
        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            candidate = text[:i + 1] + "".join("}" if c == "{" else "]" for c in reversed(stack))
            parsed = try_parse(candidate)
            if parsed is not None:
                best = (parsed, i + 1)
    if best:
        parsed, cutoff = best
        pct = 100 * cutoff / len(text)
        return parsed, f"Recovered by keeping the first {cutoff} of {len(text)} characters ({pct:.1f}%) and closing open structures."
    return None, "Could not recover any valid JSON from this file — it may be corrupted too early to salvage anything."


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 repair_store.py <corrupted-file>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r") as f:
        text = f.read()

    result, message = attempt_recovery(text)
    if result is None:
        print("❌", message)
        sys.exit(1)

    print("✅", message)
    if isinstance(result, dict):
        print("Recovered top-level keys:", list(result.keys()))
        for key, value in result.items():
            if isinstance(value, dict):
                print(f"  {key}: {len(value)} entries")

    out_path = path + ".recovered.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nWrote recovered data to: {out_path}")
    print("Review it, then — with server.py stopped — replace app_store.json with it if it looks right:")
    print(f"  cp {out_path} app_store.json")


if __name__ == "__main__":
    main()

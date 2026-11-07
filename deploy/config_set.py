"""Sets keys in the data volume's configs/config.json. Run inside a
throwaway container by `deploy/deploy.sh --config-set KEY=VALUE user@host`,
with the changes as a JSON object on stdin. The previous file is kept next to
it as config.json.bak-<timestamp>."""
import json
import os
import shutil
import sys
import time

path = "/data/configs/config.json"
changes = json.load(sys.stdin)
with open(path) as f:
    cfg = json.load(f)
shutil.copy2(path, f"{path}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
def shown(key, value):
    # Don't echo credentials back to the terminal.
    if value and any(w in key.lower() for w in ("secret", "password", "token", "key")):
        return "<hidden>"
    return json.dumps(value)


for key, value in changes.items():
    print(f"  {key}: {shown(key, cfg.get(key))} -> {shown(key, value)}")
    cfg[key] = value
tmp = f"{path}.tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, path)

#!/usr/bin/env python3
"""Layered settings: one place that says which setting a ticket really runs with.

Layers, lowest to highest:  kit defaults < global (the hub's specs/worker-fleet.config.json) < project < ticket.
A layer is a dict with an optional `enabled` flag (default true; `false` skips the whole layer). It only overrides the keys it lists.
Dicts merge key by key; scalars and lists replace whole. dashboard.port and secrets are process-wide and never layered.

    resolve(global_cfg, project_layer, ticket_layer) -> {"effective": {...}, "sources": {"models.worker.claude.model": "ticket", ...},
                                                         "ignored": ["project: dashboard"]}
    python wv-settings.py resolve --hub HUB --project NAME --base PROJECT_ROOT --ticket 012 [--key models.worker.runtime]

Pure functions plus a thin CLI, so .cjs and .sh callers shell out to it. Resolve once when an agent starts; never re-read mid-run.
"""
import argparse
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT_FILE = HERE / "wv-settings-defaults.json"
LAYERABLE = ("harness", "models", "approvals", "budget", "concurrency", "landing", "stack")
LAYERS = ("kit", "global", "project", "ticket")


def read_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def kit_defaults():
    return read_json(KIT_FILE)


def merge(base, over):
    """`over` on top of `base`: dicts merge per key, everything else (scalars, lists) is replaced whole. Neither input is changed."""
    out = copy.deepcopy(base) if isinstance(base, dict) else {}
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def layer_values(layer):
    """What a layer contributes: {} when it is missing, not a dict, or `enabled: false`; else its keys without the flag."""
    if not isinstance(layer, dict) or layer.get("enabled", True) is False:
        return {}
    return {k: v for k, v in layer.items() if k != "enabled"}


def _leaves(d, prefix=""):
    for k, v in d.items():
        p = prefix + k
        if isinstance(v, dict) and v:
            yield from _leaves(v, p + ".")
        else:
            yield p, v


def resolve(global_cfg, project_layer=None, ticket_layer=None, kit=None):
    effective, sources, ignored = {}, {}, []
    for name, layer in (("kit", kit if kit is not None else kit_defaults()), ("global", global_cfg),
                        ("project", project_layer), ("ticket", ticket_layer)):
        vals = layer_values(layer)
        if name in ("project", "ticket"):
            for k in [k for k in vals if k not in LAYERABLE]:
                ignored.append(name + ": " + k)
                del vals[k]
        effective = merge(effective, vals)
        for path, _ in _leaves(vals):
            sources[path] = name
    return {"effective": effective, "sources": sources, "ignored": ignored}


def get(result, dotted, default=None):
    """One effective value by dotted path, e.g. get(r, "models.worker.opencode.model")."""
    cur = result["effective"]
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


# ---- loading the layers from disk -------------------------------------------------------------------------------------------

def _project_entry(hub, project):
    data = read_json(Path(hub) / "specs" / "projects.json")
    rows = data.get("projects") if isinstance(data.get("projects"), list) else []
    for row in rows:
        if isinstance(row, dict) and project and project in (row.get("name"), row.get("root")):
            return row
    return {}


def load(hub, project=None, base=None, ticket=None):
    """Read the three layers: the hub config, the project's `fleet.settings` in specs/projects.json, the ticket's job/stage/<NNN>.json `settings`."""
    g = read_json(Path(hub) / "specs" / "worker-fleet.config.json")
    p = (_project_entry(hub, project).get("fleet") or {}).get("settings") if project else None
    t = None
    if base and ticket:
        t = read_json(Path(base) / "job" / "stage" / (str(ticket).split("-")[0] + ".json")).get("settings")
    return resolve(g, p, t)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve")
    r.add_argument("--hub", required=True)
    r.add_argument("--project")
    r.add_argument("--base")
    r.add_argument("--ticket")
    r.add_argument("--key", help="print one effective value (dotted path) instead of everything")
    a = ap.parse_args(argv)
    res = load(a.hub, a.project, a.base, a.ticket)
    if a.key:
        v = get(res, a.key)
        print(v if isinstance(v, str) else json.dumps(v))
        return 0 if v is not None else 1
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

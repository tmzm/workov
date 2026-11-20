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
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT_FILE = HERE / "wv-settings-defaults.json"
LAYERABLE = ("harness", "models", "approvals", "budget", "concurrency", "landing", "stack")
LAYERS = ("kit", "global", "project", "ticket")
# roles that run once for the whole hub, or inside the router's own session: a project or a ticket cannot change them at launch
GLOBAL_ONLY_ROLES = ("router", "watchdog", "designer")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
_ROLE_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
_OC_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]{0,120}$")
_CL_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


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

def _norm(p):
    return os.path.normcase(os.path.abspath(str(p))) if p else ""


def _project_entry(hub, project):
    """The projects.json row of a project, found by its name or by its root folder (slash style and case do not matter)."""
    data = read_json(Path(hub) / "specs" / "projects.json")
    rows = data.get("projects") if isinstance(data.get("projects"), list) else []
    for row in rows:
        if isinstance(row, dict) and project and (project == row.get("name") or (row.get("root") and _norm(project) == _norm(row.get("root")))):
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


# ---- writing the layers ----------------------------------------------------------------------------------------------------

def _write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def _patch(layer, values, enabled):
    """`values` merged into `layer`; a None value removes that key; `enabled` (when given) sets the flag. A new layer starts disabled."""
    out = merge(layer if isinstance(layer, dict) else {"enabled": False}, {})
    def apply(dst, src):
        for k, v in src.items():
            if v is None:
                dst.pop(k, None)
            elif isinstance(v, dict) and isinstance(dst.get(k), dict):
                apply(dst[k], v)
            else:
                dst[k] = copy.deepcopy(v)
    apply(out, values or {})
    if enabled is not None:
        out["enabled"] = bool(enabled)
    return out


def clean_models(models, scope):
    """Validate a `models` edit for a scope (global, project or ticket); returns the cleaned dict, '' becoming None (= remove the key).
    Raises ValueError with a sentence fit for the UI. Per role: `runtime` (worker only), `opencode.model`, `claude.model`, `claude.effort`."""
    if not isinstance(models, dict):
        raise ValueError("The models must be an object.")
    out = {}
    for role, spec in models.items():
        if not isinstance(role, str) or not _ROLE_RE.match(role) or not isinstance(spec, dict):
            raise ValueError("That is not a role of the fleet.")
        if scope != "global" and role in GLOBAL_ONLY_ROLES:
            raise ValueError("The " + role + " runs once for the whole fleet: set it globally.")
        r = {}
        for k, v in spec.items():
            if k == "runtime":
                if role not in ("worker", "planner") or v not in ("", "claude", "opencode"):
                    raise ValueError("Only the worker and the planner have a runtime, and it is claude or opencode.")
                r[k] = v or None
            elif k in ("opencode", "claude") and isinstance(v, dict):
                sub = {}
                for kk, vv in v.items():
                    vv = (vv or "").strip() if isinstance(vv, str) or vv is None else vv
                    if kk == "model":
                        if vv and not (_OC_MODEL_RE if k == "opencode" else _CL_MODEL_RE).match(str(vv)):
                            raise ValueError("That model name has characters a model name does not have.")
                        sub[kk] = vv or None
                    elif kk == "effort" and k == "claude":
                        if vv and vv not in EFFORTS:
                            raise ValueError("The effort is one of " + ", ".join(EFFORTS) + ".")
                        sub[kk] = vv or None
                    else:
                        raise ValueError("Unknown setting.")
                r[k] = sub
            else:
                raise ValueError("Unknown setting.")
        out[role] = r
    return out


def set_global(hub, models):
    """Edit models.<role> in the hub's worker-fleet.config.json (the global layer), keeping one rolling backup next to it."""
    path = Path(hub) / "specs" / "worker-fleet.config.json"
    cfg = read_json(path)
    if path.exists():
        shutil.copy2(path, str(path) + ".bak-settings")
    cfg = _patch(cfg, {"models": models}, None)
    _write_json(path, cfg)
    return cfg.get("models", {})


def set_project_layer(hub, name, root, values=None, enabled=None):
    """Edit a project's layer in the hub's specs/projects.json (`fleet.settings`), creating the project row and the layer when missing."""
    path = Path(hub) / "specs" / "projects.json"
    data = read_json(path)
    rows = data.get("projects") if isinstance(data.get("projects"), list) else []
    row = next((r for r in rows if isinstance(r, dict) and (r.get("name") == name or (root and r.get("root") and _norm(r["root"]) == _norm(root)))), None)
    if row is None:
        row = {"name": name, "root": str(root or "")}
        rows.append(row)
    fleet = row.setdefault("fleet", {})
    fleet["settings"] = _patch(fleet.get("settings"), values, enabled)
    data["projects"] = rows
    _write_json(path, data)
    return fleet["settings"]


def set_ticket_layer(base, ticket, values=None, enabled=None):
    """Edit a ticket's layer: `settings` in <project>/job/stage/<NNN>.json, keeping every other key of that file."""
    path = Path(base) / "job" / "stage" / (str(ticket).split("-")[0] + ".json")
    data = read_json(path)
    data["settings"] = _patch(data.get("settings"), values, enabled)
    _write_json(path, data)
    return data["settings"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve")
    r.add_argument("--hub", required=True)
    r.add_argument("--project")
    r.add_argument("--base")
    r.add_argument("--ticket")
    r.add_argument("--key", help="print one effective value (dotted path) instead of everything")
    w = sub.add_parser("set", help="edit a project or ticket layer")
    w.add_argument("--scope", choices=("project", "ticket"), required=True)
    w.add_argument("--hub", required=True)
    w.add_argument("--project", help="project name (scope project)")
    w.add_argument("--base", help="project folder")
    w.add_argument("--ticket")
    w.add_argument("--values", default="{}", help='JSON of the keys to set; a null value removes the key')
    w.add_argument("--enabled", choices=("true", "false"))
    a = ap.parse_args(argv)
    if a.cmd == "set":
        vals = json.loads(a.values)
        en = None if a.enabled is None else a.enabled == "true"
        layer = set_project_layer(a.hub, a.project, a.base, vals, en) if a.scope == "project" else set_ticket_layer(a.base, a.ticket, vals, en)
        print(json.dumps(layer, indent=2, ensure_ascii=False))
        return 0
    res = load(a.hub, a.project, a.base, a.ticket)
    if a.key:
        v = get(res, a.key)
        print(v if isinstance(v, str) else json.dumps(v))
        return 0 if v is not None else 1
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""wv-migrate-settings.py [--hub DIR] [--registry FILE] [--apply]

Moves what used to override the hub's settings into the layers (see wv-settings.py). Dry run unless --apply; safe to run again.

1. A project whose own specs/worker-fleet.config.json differs from the hub's: the layerable keys that differ become that project's layer
   in the hub's specs/projects.json, DISABLED (no project is switched on automatically). An identical config adds nothing.
2. A ticket that is not done and whose rd.md header still says `**Worker harness:**` / `**Worker model:**`: the header becomes the ticket's
   layer (`settings` in job/stage/<NNN>.json, enabled) and the header text is removed from rd.md, so no header can override the settings.
Backups of everything it changes go to ~/.workov/backups/settings-<time>/.
"""
import argparse
import importlib.util
import json
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location("wv_settings", HERE / "wv-settings.py")
W = importlib.util.module_from_spec(_s)
_s.loader.exec_module(W)

HOME = Path.home() / ".workov"


def diff(base, over):
    """The parts of `over` that differ from `base`, as a nested dict (changed or new keys; lists compared whole)."""
    out = {}
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            d = diff(base[k], v)
            if d:
                out[k] = d
        elif base.get(k) != v:
            out[k] = v
    return out


def project_layer_values(hub_cfg, project_cfg):
    return diff(hub_cfg, {k: v for k, v in project_cfg.items() if k in W.LAYERABLE})


def board_status(base, num):
    try:
        text = (Path(base) / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"^\|\s*" + re.escape(num) + r"\s*\|[^|]*\|\s*([a-z-]+)", text, re.M)
    return m.group(1) if m else ""


HARNESS = re.compile(r"[ \t]*·?[ \t]*\*\*Worker harness:\*\*[ \t]*([A-Za-z]+)")
MODEL = re.compile(r"^\*\*Worker model:\*\*[ \t]*([A-Za-z0-9._/:-]+)[ \t]*\n", re.M)


def header_layer(text):
    """(layer values, rd.md text without the headers) for an rd.md header block; ({}, text) when it has none."""
    head, sep, rest = text.partition("\n## ")
    hm, mm = HARNESS.search(head), MODEL.search(head)
    if not hm and not mm:
        return {}, text
    worker = {}
    runtime = hm.group(1).lower() if hm else None
    model = mm.group(1) if mm else None
    if runtime in ("claude", "opencode"):
        worker["runtime"] = runtime
    if model:
        if "/" in model:
            worker.setdefault("opencode", {})["model"] = model
        else:
            worker.setdefault("claude", {})["model"] = model
            worker.setdefault("runtime", runtime or "claude")
    head = MODEL.sub("", HARNESS.sub("", head))
    return ({"models": {"worker": worker}} if worker else {}), head + sep + rest


def backup(stamp, path):
    path = Path(path)
    if path.exists():
        dst = HOME / "backups" / ("settings-" + stamp) / path.drive.replace(":", "") / Path(*path.parts[1:] if path.drive else path.parts)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dst)


def run(hub, registry, apply):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    hub_cfg = W.read_json(Path(hub) / "specs" / "worker-fleet.config.json")
    rows = json.loads(Path(registry).read_text(encoding="utf-8")) if Path(registry).exists() else []
    report = []
    for row in rows if isinstance(rows, list) else []:
        name, root = row.get("name"), Path(row.get("root") or "")
        if not name or not root.exists():
            continue
        existing = (W._project_entry(hub, name).get("fleet") or {}).get("settings")
        cfg = W.read_json(root / "specs" / "worker-fleet.config.json")
        vals = project_layer_values(hub_cfg, cfg) if cfg else {}
        if vals and existing is None:
            report.append("project %s: layer from its own config (%d key group(s)), disabled" % (name, len(vals)))
            if apply:
                backup(stamp, Path(hub) / "specs" / "projects.json")
                W.set_project_layer(hub, name, root, vals, False)
        for rd in sorted((root / "specs" / "tickets").glob("*/rd.md")):
            num = rd.parent.name.split("-")[0]
            text = rd.read_text(encoding="utf-8")
            vals, clean = header_layer(text)
            if clean == text or board_status(root, num) == "done":
                continue
            report.append("ticket %s/%s: header moved into its layer %s" % (name, num, json.dumps(vals) if vals else "(nothing to keep)"))
            if apply:
                backup(stamp, rd)
                backup(stamp, root / "job" / "stage" / (num + ".json"))
                if vals:
                    W.set_ticket_layer(root, num, vals, True)
                rd.write_text(clean, encoding="utf-8")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--hub", default=None)
    ap.add_argument("--registry", default=str(HOME / "fleets.json"))
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    hub = a.hub or W.read_json(HOME / "hub.json").get("root", "")
    if not hub:
        print("no hub: run it with --hub DIR", file=sys.stderr)
        return 2
    lines = run(hub, a.registry, a.apply)
    print("\n".join(lines) if lines else "nothing to migrate")
    if lines and not a.apply:
        print("(dry run: add --apply to write it)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

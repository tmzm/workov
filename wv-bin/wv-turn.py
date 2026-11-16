#!/usr/bin/env python3
"""wv-turn.py <this-fleet-root> [--peek]

The one router: every registered project (~/.workerov/fleets.json) has its own router loop, but only the project whose turn
it is makes a router model call. Prints "run" and exits 0 when this project's loop should run a cycle now, otherwise prints
why it waits and exits 1 (the loop then just sleeps, which costs nothing).

  1. A project that must be watched always runs: it has a live worker, a ticket in progress, or an answered decision that
     has to be handed to a waiting worker.
  2. A project with only ready tickets may start work only when no project has a live worker (one worker at a time on the
     computer). When several projects are ready, the one that ran longest ago goes first (fair turns).
  3. A project that is switched off (job/fleet-off), or has nothing ready or running, never runs.
--peek only reports, it never takes the turn (the dashboard uses it).
A worker counts as live when its entry in job/router-state.json has a port that is listening."""
import json
import re
import socket
import sys
import time
from pathlib import Path

TURN_FILE = Path.home() / ".workerov" / "router-turn.json"


def norm(p):
    return str(p).replace("\\", "/").rstrip("/").lower()


def read_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return {}


def live_workers(root):
    n = 0
    for e in read_json(Path(root) / "job" / "router-state.json").get("dispatched", []) or []:
        port = e.get("port") if isinstance(e, dict) else None
        if isinstance(port, int):
            try:
                with socket.create_connection(("127.0.0.1", port), 0.4):
                    n += 1
            except OSError:
                pass
    return n


def info(root):
    base = Path(root)
    try:
        board = (base / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        board = ""
    status = [m.group(1) for m in re.finditer(r"^\|\s*\d{3}\s*\|[^|]*\|\s*([a-z-]+)\s*\|", board, re.M)]
    state = read_json(base / "job" / "router-state.json")
    answered = any((base / "specs" / "tickets" / str(slug) / "user-decision.md").exists() for slug in state.get("pendingDecisions", []) or [])
    return {
        "off": (base / "job" / "fleet-off").exists(),
        "live": live_workers(root),
        "progress": "in-progress" in status,
        "ready": "ready" in status,
        "answered": answered,
    }


def main():
    args = [a for a in sys.argv[1:] if a != "--peek"]
    peek = "--peek" in sys.argv
    me = args[0] if args else ""
    fleets = read_json(Path.home() / ".workerov" / "fleets.json")
    fleets = fleets if isinstance(fleets, list) else []
    roots = [str(f.get("root", "")) for f in fleets if isinstance(f, dict) and f.get("root")]
    if me and norm(me) not in [norm(r) for r in roots]:
        roots.append(me)
    mine = info(me)
    if mine["off"]:
        print("this project is switched off")
        return 1
    if mine["live"] or mine["progress"] or mine["answered"]:
        return _ok(me, record=False)
    if not mine["ready"]:
        print("nothing ready or running")
        return 1
    others = {r: info(r) for r in roots if norm(r) != norm(me)}
    for r, i in others.items():
        if i["live"]:
            print("waiting: a worker is running in " + Path(r).name)
            return 1
    last = read_json(TURN_FILE)
    ready = [r for r, i in others.items() if i["ready"] and not i["off"]] + [me]
    # the same order for every caller (oldest turn first, then by path), so two projects never both wait for the other
    first = min(ready, key=lambda r: (last.get(norm(r), 0), norm(r)))
    if norm(first) != norm(me):
        print("waiting: it is " + Path(first).name + "'s turn")
        return 1
    return _ok(me, record=not peek)


def _ok(me, record):
    if record:
        last = read_json(TURN_FILE)
        last[norm(me)] = time.time()
        try:
            TURN_FILE.parent.mkdir(parents=True, exist_ok=True)
            TURN_FILE.write_text(json.dumps(last), encoding="utf-8")
        except OSError:
            pass
    print("run")
    return 0


if __name__ == "__main__":
    sys.exit(main())

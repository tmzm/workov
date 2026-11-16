#!/usr/bin/env python3
"""wv-busy.py <this-fleet-root>

The machine runs one worker at a time. Prints the names of OTHER registered fleets (~/.workerov/fleets.json) that have a
live worker and exits 0 when there is at least one, so the calling router loop holds back new dispatches. Exits 1 and
prints nothing when none is busy, or when this fleet is itself the one with a live worker (it is the active fleet).
A worker counts as live when its entry in the fleet's job/router-state.json has a port that is listening."""
import json
import socket
import sys
from pathlib import Path


def norm(p):
    return str(p).replace("\\", "/").rstrip("/").lower()


def live_ports(root):
    try:
        state = json.loads((Path(root) / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        return []
    ports = []
    for e in state.get("dispatched", []) or []:
        port = e.get("port") if isinstance(e, dict) else None
        if isinstance(port, int):
            try:
                with socket.create_connection(("127.0.0.1", port), 0.4):
                    ports.append(port)
            except OSError:
                pass
    return ports


def main():
    me = norm(sys.argv[1]) if len(sys.argv) > 1 else ""
    try:
        fleets = json.loads((Path.home() / ".workerov" / "fleets.json").read_text(encoding="utf-8"))
    except Exception:
        fleets = []
    if me and live_ports(sys.argv[1]):
        return 1
    busy = []
    for f in fleets if isinstance(fleets, list) else []:
        root = str((f or {}).get("root", ""))
        if not root or norm(root) == me:
            continue
        if live_ports(root):
            busy.append(str(f.get("name") or Path(root).name))
    if busy:
        print(", ".join(busy))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

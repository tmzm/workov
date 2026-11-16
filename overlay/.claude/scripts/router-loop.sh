#!/usr/bin/env bash
# wv-fleet: keep the OpenCode router working without a terminal. `opencode run --agent router` ends when the router
# finishes one cycle, and its wake watcher can't wake an OpenCode run on Windows. This loop starts the next cycle in
# the same router session every WV_ROUTER_INTERVAL seconds (default 90) while any ticket is specifying, ready or
# in-progress, then exits. One loop per repo (job/router-loop.pid). Usage: bash .claude/scripts/router-loop.sh
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
mkdir -p job
PIDFILE=job/router-loop.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "router loop already running (pid $(cat "$PIDFILE"))"; exit 0; fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
INTERVAL="${WV_ROUTER_INTERVAL:-90}"
export WV_APPROVALS="${WV_APPROVALS:-auto}"
# wv-fleet: heavy pnpm/npm commands (test, lint, build, install) wait their turn machine-wide
export PATH="$HOME/.wv-bin:$PATH"
# bash agents call the real pnpm/ng directly; this makes them go through the same lock
export BASH_ENV="$HOME/.wv-bin/wv-bashenv.sh"
working() { grep -E '^\| [0-9]{3} ' specs/tickets/BOARD.md | grep -q -E '\| (specifying|ready|in-progress) *\|'; }
# A blocked ticket whose answer is saved (user-decision.md) but not yet forwarded still needs a router cycle: the router
# is the one that hands the answer to the waiting worker. Without this the loop stops and the answer is never delivered.
answered() {
  for f in specs/tickets/*/user-decision.md; do
    [ -f "$f" ] || continue
    d="$(basename "$(dirname "$f")")"
    grep -E '"pendingDecisions"' job/router-state.json 2>/dev/null | grep -q "\"$d\"" && return 0
  done
  return 1
}
active() { working || answered; }
# One worker at a time across every project on this machine: when another registered fleet (~/.workerov/fleets.json)
# has a live worker, this cycle may reconcile and answer decisions but must not start a worker.
# A project that is only waiting for another project's worker (nothing of its own building, no answered decision to hand
# over) needs no model call: sleeping costs nothing, a cycle that only says "dispatch paused" costs tokens every interval.
waiting_only() {
  [ -n "$(python3 -I "$HOME/.wv-bin/wv-busy.py" "$PWD" 2>/dev/null | tr -d '\r')" ] || return 1
  grep -qE '^\| [0-9]{3} .*\| in-progress *\|' specs/tickets/BOARD.md && return 1
  answered && return 1
  return 0
}
busy_note() {
  local b
  b="$(python3 -I "$HOME/.wv-bin/wv-busy.py" "$PWD" 2>/dev/null | tr -d '\r')"
  [ -n "$b" ] && printf ' DISPATCH PAUSED: this computer runs one worker at a time and %s has a worker running. Do not start any worker this cycle (no new dispatch, no new worktree); keep reconciling and answering decisions, and say in your one summary line that dispatch is waiting for %s.' "$b" "$b"
  return 0
}
latest_router_session() {
  python3 -I - "$PWD" <<'PY'
import os, sqlite3, sys
db = os.environ.get("OPENCODE_DB") or os.path.join(os.path.expanduser("~"), ".local", "share", "opencode", "opencode.db")
root = sys.argv[1].replace("\\", "/").rstrip("/").lower()
try:
    con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=5)
    for sid, d in con.execute("SELECT id, directory FROM session_v2 WHERE agent = 'router' AND parent_id IS NULL ORDER BY time_created DESC LIMIT 20"):
        if (d or "").replace("\\", "/").rstrip("/").lower().endswith(root.split(":", 1)[-1]):
            print(sid); break
except Exception:
    pass
PY
}
SID="${WV_ROUTER_SESSION:-}"
FIRST="Run the fleet. Reconcile job/router-state.json first: a worker listed there may still be alive inside OpenCode (check its job/status.json heartbeat and its session) before you re-dispatch it. Dispatch every ready ticket, verify finished ones against eval.md, and land them per their Landing mode. Do one full cycle, then end your turn; you will be called again."
NEXT="Next router cycle: reconcile, read worker heartbeats and results, dispatch ready tickets, verify and land finished ones, answer or record pending decisions. Then end your turn."
while active; do
  if waiting_only; then
    echo "[router-loop] waiting for another project's worker: no router cycle until it is done"
    sleep "$INTERVAL"
    continue
  fi
  if [ -z "$SID" ]; then
    opencode run --auto --agent router "$FIRST$(busy_note)"
    SID="$(latest_router_session | tr -d '\r')"
    echo "[router-loop] router session: ${SID:-unknown}"
  else
    opencode run --auto --agent router --session "$SID" "$NEXT$(busy_note)"
  fi
  active || break
  sleep "$INTERVAL"
done
echo "[router-loop] no ticket is specifying, ready, in-progress or waiting for its answer to be forwarded: stopping"

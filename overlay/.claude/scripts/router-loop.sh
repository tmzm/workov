#!/usr/bin/env bash
# Workerov: THE router. One loop and one OpenCode router session serve every project registered in ~/.workerov/fleets.json,
# one project per cycle. `opencode run --agent router` ends when the router finishes one cycle and cannot be woken on Windows,
# so this loop starts the next cycle every WV_ROUTER_INTERVAL seconds (default 90) for as long as any project needs the
# router, then exits. wv-turn.py --pick chooses the project (fair turns, one worker at a time on the computer) and the cycle
# message names it. The permission plugin (.opencode/wv/router-scope.mjs) keeps the router inside that project's folder.
# It runs from the hub only (the folder whose dashboard serves the board); another project's folder does nothing.
# Usage: bash .claude/scripts/router-loop.sh
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
HOME_DIR="$HOME/.workerov"
HERE="$(cygpath -m "$(pwd)" 2>/dev/null || pwd)"
HUB="$(python3 -I - "$HOME_DIR/hub.json" <<'PYHUB'
import json, sys
try:
    print(str(json.load(open(sys.argv[1], encoding="utf-8")).get("root", "")).replace(chr(92), "/").rstrip("/"))
except Exception:
    pass
PYHUB
)"
HUB="$(printf '%s' "$HUB" | tr -d '\r')"
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
SAME="$(python3 -I -c "import os,sys;print(int(os.path.exists(sys.argv[1]) and os.path.samefile(sys.argv[1], sys.argv[2])))" "$HUB" "$HERE" 2>/dev/null | tr -d '')"
if [ -n "$HUB" ] && [ "$SAME" = "0" ] && [ -d "$HUB/job" ]; then
  echo "the one router runs from $HUB; nothing to do here"
  exit 0
fi
mkdir -p job
PIDFILE=job/router-loop.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "router loop already running (pid $(cat "$PIDFILE"))"; exit 0; fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE" "$HOME_DIR/router-project.json"' EXIT
INTERVAL="${WV_ROUTER_INTERVAL:-90}"
export WV_APPROVALS="${WV_APPROVALS:-auto}"
# heavy pnpm/npm commands (test, lint, build, install) wait their turn machine-wide
export PATH="$HOME/.wv-bin:$PATH"
# bash agents call the real pnpm/ng directly; this makes them go through the same lock
export BASH_ENV="$HOME/.wv-bin/wv-bashenv.sh"

# one worker at a time across every project: tell the router when another project's worker is running
busy_note() {
  local b
  b="$(python3 -I "$HOME/.wv-bin/wv-busy.py" "$1" 2>/dev/null | tr -d '\r')"
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
FIRST="Run the fleet for this project. Reconcile job/router-state.json first: a worker listed there may still be alive inside OpenCode (check its job/status.json heartbeat and its session) before you re-dispatch it. Dispatch every ready ticket, verify finished ones against eval.md, and land them per their Landing mode. Do one full cycle, then end your turn; you will be called again."
NEXT="Next router cycle for this project: reconcile, read worker heartbeats and results, dispatch ready tickets, verify and land finished ones, answer or record pending decisions. Then end your turn."
while true; do
  PICK="$(python3 -I "$HOME/.wv-bin/wv-turn.py" --pick | tr -d '\r')"
  case "$PICK" in
    run*) ;;
    *) echo "[router-loop] ${PICK:-no project needs the router}: stopping"; break ;;
  esac
  NAME="$(printf '%s' "$PICK" | cut -f2)"
  ROOT="$(printf '%s' "$PICK" | cut -f3)"
  printf '{"name": "%s", "root": "%s", "at": "%s"}\n' "$NAME" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME_DIR/router-project.json"
  CTX="PROJECT $NAME, HOME $ROOT. This cycle is only about this project. Every path in your instructions that starts with job/, specs/, .claude/ or .opencode/ means that path under HOME (use the absolute path), and every git or script command must start with: cd \"$ROOT\" && . Do not touch any other project."
  echo "[router-loop] cycle for $NAME"
  if [ -z "$SID" ]; then
    opencode run --auto --agent router "$CTX $FIRST$(busy_note "$ROOT")"
    SID="$(latest_router_session | tr -d '\r')"
    echo "[router-loop] router session: ${SID:-unknown}"
  else
    opencode run --auto --agent router --session "$SID" "$CTX $NEXT$(busy_note "$ROOT")"
  fi
  sleep "$INTERVAL"
done
echo "[router-loop] no project is specifying, ready, in progress or waiting for its answer to be forwarded: stopping"

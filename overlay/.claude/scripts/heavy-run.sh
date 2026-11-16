#!/usr/bin/env bash
# heavy-run.sh <command...>: run one memory-heavy command (install, test, build, lint) while holding a machine-wide lock,
# so two fleets, or two workers, never run them at the same time. Every `ng test` starts a headless Chromium; three at
# once, plus installs, ran this machine out of memory. Waits up to WV_HEAVY_WAIT seconds (default 1800) for its turn.
set -uo pipefail
[ "$#" -gt 0 ] || { echo "usage: heavy-run.sh <command...>" >&2; exit 2; }
LOCK="${TMPDIR:-${TEMP:-/tmp}}/wv-heavy.lock"
WAIT="${WV_HEAVY_WAIT:-1800}"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  # a lock whose owner is gone (killed run, reboot) is stale: take it over
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  if [ "$waited" -ge "$WAIT" ]; then echo "heavy-run: still locked by pid ${owner:-?} after ${WAIT}s" >&2; exit 75; fi
  [ "$waited" -eq 0 ] && echo "heavy-run: waiting for another heavy command (pid ${owner:-?}) to finish..." >&2
  sleep 5; waited=$((waited + 5))
done
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM
export WV_HEAVY_HELD=1
"$@"

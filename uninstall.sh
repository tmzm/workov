#!/usr/bin/env bash
# wv-fleet uninstaller: removes a fleet that was installed INSIDE a working copy (the old behaviour) and leaves the repo as it
# was. Usage: bash uninstall.sh <repo>   (stop the fleet first: nothing here stops processes)
#   - the tickets and briefs are copied to ~/Workerov/archive/<name>-<time>/ first, nothing is thrown away;
#   - every path the installer excluded (exclude.txt) is removed, but only ignored files: tracked files are restored with
#     git checkout, so your own work is never deleted;
#   - the exclude lines are dropped and the project leaves ~/.workerov/fleets.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?usage: bash uninstall.sh <repo>}"
TARGET="$(cd "$TARGET" && pwd)"
git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository: $TARGET" >&2; exit 2; }
NAME="$(basename "$TARGET")"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCH="$HOME/Workerov/archive/$NAME-$STAMP"
mkdir -p "$ARCH"
[ -d "$TARGET/specs/tickets" ] && cp -r "$TARGET/specs/tickets" "$ARCH/tickets" && echo "archived the tickets to $ARCH/tickets"
[ -d "$TARGET/job/briefs" ] && cp -r "$TARGET/job/briefs" "$ARCH/briefs"
[ -f "$TARGET/specs/worker-fleet.config.json" ] && cp "$TARGET/specs/worker-fleet.config.json" "$ARCH/"
PATHS=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *'*'*) continue ;; esac   # glob lines (specs/tickets/*/delivery/) are covered by the tickets archive
  PATHS+=("$line")
done < "$HERE/exclude.txt"
cd "$TARGET"
# tracked files the installer changed: put them back as committed
CHANGED="$(git diff --name-only -- "${PATHS[@]}" 2>/dev/null || true)"
if [ -n "$CHANGED" ]; then
  # shellcheck disable=SC2086
  echo "$CHANGED" | while IFS= read -r f; do git checkout -- "$f" && echo "restored $f"; done
fi
# ignored files only (the fleet's own): never tracked or untracked-but-not-ignored files
git clean -fdXq -- "${PATHS[@]}" 2>/dev/null || true
rmdir .claude .opencode specs .agents 2>/dev/null || true
# drop the exclude lines the installer added
EXCL="$(git rev-parse --git-common-dir)/info/exclude"
if [ -f "$EXCL" ]; then
  python3 - "$EXCL" "$HERE/exclude.txt" <<'PY'
import sys
excl, src = sys.argv[1], sys.argv[2]
drop = {l.rstrip("\r\n") for l in open(src, encoding="utf-8")}
keep = [l for l in open(excl, encoding="utf-8") if l.rstrip("\r\n") not in drop]
open(excl, "w", encoding="utf-8", newline="\n").writelines(keep)
PY
fi
# leave the machine-wide list
python3 - "$TARGET" <<'PY'
import json, os, sys
root = sys.argv[1].replace("\\", "/").rstrip("/").lower()
p = os.path.join(os.path.expanduser("~"), ".workerov", "fleets.json")
try:
    items = json.load(open(p, encoding="utf-8"))
except Exception:
    items = []
items = [i for i in items if str(i.get("root", "")).replace("\\", "/").rstrip("/").lower() != root]
json.dump(items, open(p, "w", encoding="utf-8"), indent=2)
PY
echo "fleet removed from $TARGET (git status below)"
git status --short | head -10

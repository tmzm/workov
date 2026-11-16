#!/usr/bin/env bash
# browser.sh — resolve a working `agent-browser` binary and exec it (ticket 033).
#
# Usage:
#   bash .claude/scripts/browser.sh <args...>   # exec the resolved binary with <args...>
#   bash .claude/scripts/browser.sh --resolve   # print the resolved absolute path, exit 0
#   bash .claude/scripts/browser.sh --session-for <role> [<id>]   # print this agent's session name
#
# Resolution order (first candidate that runs wins):
#   1. $AGENT_BROWSER_BIN (when set and non-empty)
#   2. `agent-browser` on PATH
#   3. ${VOLTA_HOME:-$HOME/.volta} image dir, `npm root -g`, then
#      $HOME/.local/bin, /usr/local/bin, /opt/homebrew/bin
# A candidate must be an executable file whose `--version` exits 0, so a broken
# shim (e.g. Volta's, exit 126) is skipped. Exit 127 + a message if none works.
# Zero dependencies: bash + standard coreutils only.
#
# Sessions (ticket 066): every agent drives the browser in its own named session,
# never agent-browser's shared default one, and passes `--session <name>` on every
# call. `--session-for <role> [<id>]` prints that name, `<project>-<role>[-<id>]`
# (for example worker-fleet-tester-061), on one line, then exits. <project> is
# project.name from the main checkout's specs/worker-fleet.config.json, else the
# main checkout's directory name, else `project`; each part is made session-safe
# (ASCII letters, digits and `-`). It needs python3 and never runs agent-browser,
# so it works when none is installed. Every other call is a pure pass-through.

# --session-for <role> [<id>]: print the agent's session name (ticket 066).
if [ "${1:-}" = "--session-for" ]; then
  shift
  SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  exec python3 -I - "$SELF_DIR" "$@" <<'PY'
import json, os, re, subprocess, sys, unicodedata

USAGE = "browser.sh: usage: browser.sh --session-for <role> [<id>]"


def slug(text, cap):
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t[:cap].rstrip("-")


def fail():
    sys.stderr.write(USAGE + "\n")
    sys.exit(2)


self_dir = sys.argv[1]
args = sys.argv[2:]
if not 1 <= len(args) <= 2:
    fail()
role = slug(args[0], 16)
if not role:
    fail()
parts = [role]
if len(args) == 2:
    ident = slug(args[1], 24)
    if not ident:
        fail()
    parts.append(ident)

main = os.path.normpath(os.path.join(self_dir, "..", ".."))
try:
    out = subprocess.run(
        ["git", "-C", self_dir, "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, timeout=10,
    )
    common = out.stdout.strip()
    if out.returncode == 0 and common:
        main = os.path.dirname(os.path.normpath(os.path.join(self_dir, common)))
except Exception:
    pass

project = ""
try:
    with open(os.path.join(main, "specs", "worker-fleet.config.json")) as f:
        name = json.load(f)["project"]["name"]
    if isinstance(name, str):
        project = slug(name, 24)
except Exception:
    pass
if not project:
    project = slug(os.path.basename(main), 24)
if not project:
    project = "project"

print("-".join([project] + parts))
PY
fi

TRIED=()
RESOLVED=""

# Absolute path of a file (or command name) without requiring realpath.
abspath() {
  local p="$1" d
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    */*) d=$(cd "$(dirname "$p")" 2>/dev/null && pwd) || { printf '%s\n' "$p"; return; }
         printf '%s/%s\n' "$d" "$(basename "$p")" ;;
    *) printf '%s\n' "$p" ;;
  esac
}

# try <candidate> -> returns 0 (and sets RESOLVED) when it works; otherwise
# records a "tried" line and sets REASON.
try() {
  local cand="$1" rc
  REASON=""
  if [ ! -e "$cand" ]; then
    REASON="not found"
  elif [ ! -f "$cand" ] || [ ! -x "$cand" ]; then
    REASON="not executable"
  else
    if command -v timeout >/dev/null 2>&1; then
      timeout 10 "$cand" --version >/dev/null 2>&1
    else
      "$cand" --version >/dev/null 2>&1
    fi
    rc=$?
    if [ "$rc" -eq 0 ]; then
      RESOLVED=$(abspath "$cand")
      return 0
    fi
    REASON="--version exited $rc"
  fi
  TRIED+=("  tried: $cand ($REASON)")
  return 1
}

resolve() {
  local os arch volta_bin npm_root

  # 1. explicit override
  if [ -n "${AGENT_BROWSER_BIN:-}" ]; then
    if try "$AGENT_BROWSER_BIN"; then return 0; fi
    echo "browser.sh: warning: AGENT_BROWSER_BIN=$AGENT_BROWSER_BIN does not run (--version failed); trying other locations" >&2
  else
    TRIED+=("  tried: AGENT_BROWSER_BIN (unset)")
  fi

  # 2. PATH
  local on_path
  on_path=$(command -v agent-browser 2>/dev/null || true)
  case "$on_path" in
    /*|*/*) if try "$on_path"; then return 0; fi ;;
    *) TRIED+=("  tried: agent-browser on PATH (not found)") ;;
  esac

  # 3. known install locations
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
  esac

  local -a bins=("agent-browser-$os-$arch")
  [ "$os" = "linux" ] && bins+=("agent-browser-linux-musl-$arch")

  local b
  volta_bin="${VOLTA_HOME:-${HOME:-}/.volta}/tools/image/packages/agent-browser/lib/node_modules/agent-browser/bin"
  for b in "${bins[@]}"; do
    if try "$volta_bin/$b"; then return 0; fi
  done

  if command -v npm >/dev/null 2>&1 && npm_root=$(npm root -g 2>/dev/null) && [ -n "$npm_root" ]; then
    for b in "${bins[@]}"; do
      if try "$npm_root/agent-browser/bin/$b"; then return 0; fi
    done
  fi

  local c
  for c in "${HOME:-}/.local/bin/agent-browser" /usr/local/bin/agent-browser /opt/homebrew/bin/agent-browser; do
    if try "$c"; then return 0; fi
  done
  return 1
}

if ! resolve; then
  {
    echo "browser.sh: error: no working agent-browser found."
    printf '%s\n' "${TRIED[@]}"
    echo "Fix: install it (npm i -g agent-browser) or set AGENT_BROWSER_BIN=/path/to/agent-browser."
  } >&2
  exit 127
fi

if [ "${1:-}" = "--resolve" ]; then
  printf '%s\n' "$RESOLVED"
  exit 0
fi

exec "$RESOLVED" "$@"

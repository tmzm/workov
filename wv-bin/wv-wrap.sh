#!/usr/bin/env bash
# wv-wrap.sh <tool> [args...]: called by the .cmd shims for pnpm, npm, npx and ng: heavy subcommands (install, test, lint, build, format, e2e) run one at a time on this
# machine, through the same lock as heavy-run.sh, whether or not the calling agent remembered to ask for it. Everything
# else passes straight through. The shims sit in ~/.wv-bin, which router-loop.sh puts first on PATH. Only .cmd shims are used: an extensionless file on PATH makes Windows ask which app should open it.
# the BASH_ENV functions that route bash agents here must not apply to this script itself (it looks up the REAL tool)
unset BASH_ENV
TOOL="${1:?usage: wv-wrap.sh <pnpm|npm|npx|ng> [args...]}"; shift
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REST="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$DIR" | paste -sd: -)"
REAL="$(PATH="$REST" command -v "$TOOL" || true)"
[ -n "$REAL" ] || { echo "$TOOL: the real command was not found on PATH" >&2; exit 127; }
sub="${1:-}"; [ "$sub" = run ] && sub="${2:-}"
# npx runs other tools: ng follows the ng rules, the test and browser tools are always heavy
if [ "$TOOL" = npx ]; then case "${1:-}" in ng) sub="${2:-}" ;; vitest|playwright|eslint|prettier|tsc) sub=build ;; *) sub= ;; esac; fi
case "$sub" in
  test|lint|build|install|i|ci|add|format|format:check|e2e|e2e:*|test:*)
    if [ -z "${WV_HEAVY_HELD:-}" ] && [ -f "$DIR/heavy-run.sh" ]; then exec bash "$DIR/heavy-run.sh" "$REAL" "$@"; fi ;;
esac
exec "$REAL" "$@"

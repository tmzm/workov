#!/usr/bin/env bash
# delegate-task.sh: Bridge script for Claude Code agents to delegate tasks to Codex or OpenCode CLI.
# Usage:
#   .claude/scripts/delegate-task.sh <codex|opencode> <review|exec|run> "<instruction>" [file-or-diff]
set -euo pipefail

TARGET="${1:-codex}"
ACTION="${2:-review}"
INSTRUCTION="${3:-}"
EXTRA_INPUT="${4:-}"

if [ -z "$INSTRUCTION" ]; then
  echo "Usage: $0 <codex|opencode> <review|exec|run> "<instruction>" [file-or-diff]" >&2
  exit 1
fi

echo "=== Delegating Task to $TARGET ($ACTION) ===" >&2

CONTEXT=""
if [ -n "$EXTRA_INPUT" ] && [ -f "$EXTRA_INPUT" ]; then
  CONTEXT=$(cat "$EXTRA_INPUT")
elif [ -n "$EXTRA_INPUT" ]; then
  CONTEXT="$EXTRA_INPUT"
elif [ "$ACTION" = "review" ]; then
  GIT_STAT=$(git status --short 2>/dev/null || true)
  GIT_DIFF=$(git diff HEAD 2>/dev/null | head -c 60000 || true)
  if [ -n "$GIT_STAT" ] || [ -n "$GIT_DIFF" ]; then
    CONTEXT="Git Status:
$GIT_STAT

Git Diff:
$GIT_DIFF"
  fi
fi

FULL_PROMPT="$INSTRUCTION"
if [ -n "$CONTEXT" ]; then
  FULL_PROMPT="$INSTRUCTION

--- CONTEXT / CODE DIFF ---
$CONTEXT"
fi

case "$TARGET" in
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      echo "ERROR: OpenAI Codex CLI ('codex') is not installed or not in PATH." >&2
      echo "Please install codex or set delegateCli: "none" in specs/worker-fleet.config.json." >&2
      exit 127
    fi

    if [ "$ACTION" = "exec" ]; then
      codex exec --full-auto "$FULL_PROMPT"
    else
      codex exec --sandbox read-only "$FULL_PROMPT" 2>/dev/null || codex exec "$FULL_PROMPT"
    fi
    ;;

  opencode)
    if ! command -v opencode >/dev/null 2>&1; then
      echo "ERROR: OpenCode CLI ('opencode') is not installed or not in PATH." >&2
      echo "Please install opencode or set delegateCli: "none" in specs/worker-fleet.config.json." >&2
      exit 127
    fi

    MODEL_ARG=()
    if [ -n "${OPENCODE_MODEL:-}" ]; then
      MODEL_ARG=(-m "$OPENCODE_MODEL")
    fi

    opencode run "${MODEL_ARG[@]}" "$FULL_PROMPT"
    ;;

  *)
    echo "ERROR: Unsupported delegation target '$TARGET'. Allowed: codex, opencode" >&2
    exit 1
    ;;
esac

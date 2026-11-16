#!/usr/bin/env bash
# log.sh — bounded log appender for worker phase logs (ticket 011).
#
# Usage:
#   some_command 2>&1 | bash .claude/scripts/log.sh job/logs/<ticket>-dev.log
#
# Appends stdin to <file>. When the file exceeds 2 MB it is truncated to
# the last 2 MB and prefixed with a "... truncated ..." marker line, so a
# long-running worker can never fill the disk.
# Zero dependencies: bash + standard coreutils only.

set -euo pipefail

MAX_BYTES=$((2 * 1024 * 1024))  # 2 MB per-file bound
MARKER="... truncated ..."

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <logfile>" >&2
  exit 1
fi

LOG_FILE="$1"
mkdir -p -- "$(dirname -- "$LOG_FILE")"

# Append stdin (streamed straight to disk — never buffered in memory).
cat >> "$LOG_FILE"

# Bound the file: keep only the last MAX_BYTES, plus a leading marker line.
FILE_SIZE="$(stat -c %s -- "$LOG_FILE" 2>/dev/null || wc -c < "$LOG_FILE")"
if [ "$FILE_SIZE" -gt "$MAX_BYTES" ]; then
  TMP_FILE="${LOG_FILE}.trunc.$$"
  tail -c "$MAX_BYTES" -- "$LOG_FILE" > "${TMP_FILE}.body"
  { printf '%s\n' "$MARKER"; cat "${TMP_FILE}.body"; } > "$TMP_FILE"
  rm -f -- "${TMP_FILE}.body"
  mv -f -- "$TMP_FILE" "$LOG_FILE"
fi

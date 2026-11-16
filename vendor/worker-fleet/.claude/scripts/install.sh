#!/usr/bin/env bash
#
# install.sh — install the worker-fleet workflow into an
# EXISTING git repository. Idempotent and non-destructive.
#
# Usage:
#   bash .claude/scripts/install.sh /path/to/target-repo
#   bash .claude/scripts/install.sh --help      (or -h: usage on stdout, exit 0)
#
# Behaviour:
#   * The target must exist and be a git repository; otherwise the script
#     exits 1 with a clear error. It also refuses to install into the
#     worker-fleet source repo itself, into anything containing it, or into
#     another worktree of the same repo (the source tree is read-only here).
#   * Copies the workflow assets (see MANIFEST below). Never copies job/,
#     .git/, or any runtime state — the manifest is an explicit allow-list.
#   * Non-destructive: every existing file that would be overwritten is
#     first MOVED to <target>/.worker-fleet-backup/<timestamp>[-N]/<relative-path>
#     (a fresh dir per run, even for runs within the same second; an existing
#     backup file is never overwritten).
#     Nothing is ever deleted; files already identical to the source are
#     left completely untouched (idempotent: no mtime churn on re-runs).
#   * When the source is a git checkout, ONLY files git tracks are installed
#     (git ls-files), so untracked/ignored scratch files (.env, swap files,
#     ...) in the source's .claude/* dirs never reach the target. A source
#     that is not a git checkout falls back to a directory walk that skips
#     dotfiles, *.swp, *~ and *.pyc.
#   * Creates the specs/ skeleton (specs/worker-fleet.config.json with
#     defaults, specs/tickets/BOARD.md with the empty header) ONLY if absent.
#   * Stamps <target>/.claude/worker-fleet.version with the version read from
#     the SOURCE specs/worker-fleet.config.json. An existing stamp that
#     differs makes the script print "upgraded from <old> to <new>"; the
#     stamp is only rewritten when its content actually changes. The stamp is
#     INSTALLER-OWNED: a stale regular-file stamp is overwritten in place
#     without a backup (it only ever holds a version string); a symlink or
#     non-regular stamp is REFUSED (exit 1, nothing installed), never written
#     through.
#   * `.agents/skills` is a tracked SYMLINK in worker-fleet (-> ../.claude/skills).
#     The installer recreates the SAME relative symlink in the target so it
#     resolves against the target's own .claude/skills (identical tree shape).
#     A link that cannot be safely recreated (broken, or resolving outside
#     the source tree) is dereferenced and installed as real files instead.
#   * Never writes or moves anything THROUGH a symlink in the target: every
#     component between <target> and the destination (.claude, .claude/agents,
#     .worker-fleet-backup, specs, ...) must be a real directory, else the
#     install is refused (exit 1) -- an untrusted clone could otherwise plant
#     a link that redirects writes outside the repo. The target root path
#     itself may be reached through a symlink. A pre-flight dry run of the
#     whole install walks every destination first, so a planted link at any
#     depth refuses the run before a single file is copied. If the run would
#     back something up, an unusable <target>/.worker-fleet-backup (a file, or
#     not writable) is likewise refused up front. The only-if-absent specs/
#     skeleton files are likewise refused when they are (even dangling)
#     symlinks, and are created exclusively (O_EXCL, never following links).
#   * Prints a gitignore hint for job/ (holds the dashboard auth token),
#     .claude/worktrees/, __pycache__/ and .worker-fleet-backup/ -- only the
#     entries the target's .gitignore does not already cover -- but NEVER
#     edits the target's .gitignore.
#
# Dependencies: plain bash + python3 (used for JSON parsing and for
# generating the default skeleton config via the source apply-setup.py).
set -euo pipefail

die() {
  echo "install.sh: error: $*" >&2
  exit 1
}

usage_text() {
  cat <<'USAGEEOF'
usage: bash .claude/scripts/install.sh <target-repo>

Installs the worker-fleet workflow into an EXISTING git
repository. Idempotent and non-destructive: files that would be
overwritten are first moved to <target>/.worker-fleet-backup/<timestamp>[-N]/.
USAGEEOF
}

usage() { # misuse: usage text on stderr, exit 1
  usage_text >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Argument & target validation
# ---------------------------------------------------------------------------

# --help / -h anywhere: usage on stdout, exit 0, nothing touched.
for arg in "$@"; do
  case "$arg" in
    --help | -h)
      usage_text
      exit 0
      ;;
  esac
done
# Any other dash-prefixed argument is an unknown option (never a directory).
for arg in "$@"; do
  case "$arg" in
    -*)
      echo "install.sh: error: unknown option: $arg" >&2
      usage
      ;;
  esac
done

[[ $# -eq 1 ]] || usage
TARGET_ARG="$1"

# Source root = the worker-fleet checkout this script lives in. All three roots
# use PHYSICAL paths (pwd -P) so the overlap checks below compare real
# locations even when the target argument or this script is reached through a
# symlink.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

[[ -f "$SRC/specs/worker-fleet.config.json" ]] ||
  die "source config not found: $SRC/specs/worker-fleet.config.json (run this script from a worker-fleet checkout)"

[[ -d "$TARGET_ARG" ]] || die "target directory not found: $TARGET_ARG"
TGT="$(cd "$TARGET_ARG" && pwd -P)"

# Refuse overlapping source/target: the source tree must never be modified.
if [[ "$TGT" == "$SRC" || "$TGT" == "$SRC"/* ]]; then
  die "refusing to install into the worker-fleet source repo itself: $TGT"
fi
if [[ "$SRC" == "$TGT"/* ]]; then
  die "refusing to install into a directory that contains the worker-fleet source repo: $TGT"
fi

# Target must be a git repository.
GIT_CHECK="$(git -C "$TGT" rev-parse --is-inside-work-tree 2>/dev/null || true)"
[[ "$GIT_CHECK" == "true" ]] ||
  die "not a git repository: $TGT (initialize one first, e.g.: git -C '$TGT' init)"

# Refuse sibling worktrees of the same repository (same git common dir).
# NB: `--path-format=absolute` only exists in git >= 2.31 (older git echoes the
# flag back, making both values equal and falsely rejecting every target), so
# use plain --git-common-dir (git >= 2.5) and resolve it ourselves: the value
# is relative to the repo dir unless already absolute.
git_common_dir_abs() { # $1 = repo dir; prints the absolute common dir or nothing
  local repo="$1" common
  common="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)" || return 0
  [[ -n "$common" ]] || return 0
  [[ "$common" == /* ]] || common="$repo/$common"
  (cd "$common" 2>/dev/null && pwd -P) || true
}
SRC_COMMON="$(git_common_dir_abs "$SRC")"
TGT_COMMON="$(git_common_dir_abs "$TGT")"
if [[ -n "$SRC_COMMON" && "$SRC_COMMON" == "$TGT_COMMON" && "$SRC" != "$TGT" ]]; then
  die "refusing to install into another worktree of the same repo: $TGT"
fi

# ---------------------------------------------------------------------------
# Version (read from the SOURCE config; the source tree is never modified)
# ---------------------------------------------------------------------------

VERSION="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/specs/worker-fleet.config.json")" ||
  die "failed to read the version field from $SRC/specs/worker-fleet.config.json"
[[ -n "$VERSION" ]] || die "source config has an empty version field"

# Pre-flight: the version stamp is installer-owned and rewritten in place, so
# refuse (before touching anything) if its path is a symlink or any other
# non-regular file -- writing would follow the link and clobber its target.
STAMP_REL=".claude/worker-fleet.version"
STAMP_FILE="$TGT/$STAMP_REL"
if [[ -L "$STAMP_FILE" ]]; then
  die "refusing to write the version stamp through a symlink: $STAMP_FILE (remove or replace it with a regular file, then re-run)"
fi
if [[ -e "$STAMP_FILE" && ! -f "$STAMP_FILE" ]]; then
  die "version stamp exists but is not a regular file: $STAMP_FILE (remove it, then re-run)"
fi

# Ticket 089: the config and the stamp used other names before the rename. They
# are MOVED to the new names (never read as settings), and only when they are
# regular files: an old path that is a symlink (even a dangling one) or not a
# regular file is refused before anything is installed.
LEGACY_CONFIG_REL="specs/super-agent.config.json"
LEGACY_STAMP_REL=".claude/super-agent.version"
NEW_CONFIG_REL="specs/worker-fleet.config.json"
for legacy in "$LEGACY_CONFIG_REL" "$LEGACY_STAMP_REL"; do
  if [[ -L "$TGT/$legacy" ]] || { [[ -e "$TGT/$legacy" ]] && [[ ! -f "$TGT/$legacy" ]]; }; then
    die "refusing to move $legacy: it is a symlink or not a regular file in $TGT. Move it yourself, then re-run."
  fi
done

# ---------------------------------------------------------------------------
# Install engine: copy / link / back up, skipping identical files
# ---------------------------------------------------------------------------

# Is the source a git checkout? If so only git-tracked files are installed.
GIT_SRC=0
SRC_TOP="$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$SRC_TOP" && "$(cd "$SRC_TOP" && pwd -P)" == "$(cd "$SRC" && pwd -P)" ]]; then
  GIT_SRC=1 # SRC is itself a git checkout root (not a tarball unpacked inside someone else's repo)
fi

# Backup run dir: created lazily on the first collision. A timestamp alone has
# one-second resolution, so two runs within the same second would share a dir
# and `mv` would silently overwrite the earlier run's backups. The dir is
# therefore claimed with an atomic `mkdir` (no -p): on EEXIST a numeric suffix
# (-1, -2, ...) is tried, so every run owns a brand-new, empty backup dir.
STAMP_RUN=""
BACKUP_NOT_WRITABLE_MSG="backup dir is not writable: $TGT/.worker-fleet-backup (fix its permissions or move it aside, then re-run)"
# PLAN=1 turns the install engine into a side-effect-free dry run: every guard
# still runs and NEED_BACKUP records whether any file would be backed up, but
# nothing is printed, created, copied, linked or moved. The pre-flight below
# runs the engine once in PLAN mode so every destination the real run would
# write is checked before the first write.
PLAN=0
NEED_BACKUP=0
claim_backup_run_dir() {
  [[ -z "$STAMP_RUN" ]] || return 0
  local base ts n=0 cand
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  base="$TGT/.worker-fleet-backup"
  guard_dest ".worker-fleet-backup/x" # the backup dir itself must not be a symlink
  [[ ! -L "$base" ]] || die "refusing to use a symlinked backup dir: $base"
  mkdir -p "$base" 2>/dev/null || die "$BACKUP_NOT_WRITABLE_MSG"
  cand="$ts"
  until mkdir "$base/$cand" 2>/dev/null; do
    # Only EEXIST is worth retrying with a new suffix; any other mkdir failure
    # (permissions, read-only fs, ...) will not go away on retry.
    if [[ ! -e "$base/$cand" && ! -L "$base/$cand" ]]; then
      die "$BACKUP_NOT_WRITABLE_MSG"
    fi
    n=$((n + 1))
    [[ $n -lt 10000 ]] || die "could not allocate a unique backup dir under $base"
    cand="$ts-$n"
  done
  STAMP_RUN="$cand"
}
CHANGED=0
COPIED=0
BACKUPS=0

path_exists() { [[ -e "$1" || -L "$1" ]]; }

# Symlink-escape guard. The target repo may be an untrusted clone that plants a
# symlink as an intermediate directory (e.g. `.claude` or `.claude/agents` ->
# somewhere outside the repo); writing or moving files "through" it would land
# outside $TGT. Before ANY write or move, every component of the destination
# path between $TGT and the leaf must not be a symlink, and the resolved parent
# directory must stay under the physical $TGT. The leaf itself is not checked
# here (the callers already move a colliding leaf, symlink included, into the
# backup area; moving a link never follows it).
TGT_REAL="$(cd "$TGT" && pwd -P)"
guard_dest() { # $1 = path relative to $TGT
  local rel="$1" rest cur="$TGT" part parent real
  rest="$(dirname "$rel")"
  [[ "$rest" != "." ]] || return 0
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    cur="$cur/$part"
    if [[ -L "$cur" ]]; then
      die "refusing to write through a symlink: ${cur#"$TGT"/} in $TGT is a symlink (-> $(readlink "$cur")). Remove it or replace it with a real directory, then re-run; nothing was written through it."
    fi
    [[ -d "$cur" ]] || break # missing, or a plain file (backed up by clear_blocking_ancestors)
  done
  parent="$(dirname "$TGT/$rel")"
  while [[ ! -d "$parent" && "$parent" != "$TGT" && "$parent" != "/" ]]; do parent="$(dirname "$parent")"; done
  real="$(cd "$parent" 2>/dev/null && pwd -P)" || die "cannot resolve destination directory for $rel"
  if [[ "$real" != "$TGT_REAL" && "$real" != "$TGT_REAL"/* ]]; then
    die "refusing to write outside the target: $rel resolves to $real (not under $TGT_REAL)"
  fi
}

# A plain FILE standing where a parent directory must go (e.g. a target file
# `.claude/skills/setup` while `.claude/skills/setup/SKILL.md` is installed) is
# moved into the backup area first, like any other collision. Symlinks never get
# here: guard_dest already refused them.
clear_blocking_ancestors() { # $1 = path relative to $TGT
  local rel="$1" rest cur="" part
  rest="$(dirname "$rel")"
  [[ "$rest" != "." ]] || return 0
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    cur="${cur:+$cur/}$part"
    if [[ -e "$TGT/$cur" && ! -d "$TGT/$cur" ]]; then
      backup_collision "$cur"
      return 0
    fi
    [[ -d "$TGT/$cur" ]] || return 0
  done
}

# Move a colliding target path into the timestamped backup area (never delete).
# An already-existing backup path is never overwritten: a numeric suffix
# (.1, .2, ...) picks the first free name.
backup_collision() {
  local rel="$1" dest n=0
  guard_dest "$rel"
  if [[ $PLAN -eq 1 ]]; then
    NEED_BACKUP=1
    return 0
  fi
  claim_backup_run_dir
  dest="$TGT/.worker-fleet-backup/$STAMP_RUN/$rel"
  mkdir -p "$(dirname "$dest")"
  while path_exists "$dest"; do
    n=$((n + 1))
    dest="$TGT/.worker-fleet-backup/$STAMP_RUN/$rel.$n"
  done
  mv -n "$TGT/$rel" "$dest"
  BACKUPS=$((BACKUPS + 1))
  CHANGED=1
  echo "  backup: existing $rel -> ${dest#$TGT/}"
}

# Install one regular file. Identical content => zero changes (idempotency).
install_file_from() { # $1 = absolute source file, $2 = relative path
  local s="$1" d="$TGT/$2"
  guard_dest "$2"
  if [[ -f "$d" && ! -L "$d" ]] && cmp -s "$s" "$d"; then
    return 0
  fi
  clear_blocking_ancestors "$2"
  if path_exists "$d"; then backup_collision "$2"; fi
  [[ $PLAN -eq 0 ]] || return 0
  mkdir -p "$(dirname "$d")"
  cp -p "$s" "$d"
  COPIED=$((COPIED + 1))
  CHANGED=1
  echo "  copy:   $2"
}

# Recursively install a directory tree (explicit traversal: only manifest
# paths are ever touched, so job/ and .git/ can never leak into a copy).
# Python bytecode caches (__pycache__, *.pyc) are runtime state — skipped.
#
# Git source: only files git TRACKS are installed (git ls-files), so untracked
# scratch files (.env, editor swap files, ...) are never copied. Non-git
# source (or a dereferenced directory outside the source tree): walk the
# tree, skipping dotfiles, *.swp, *~ and *.pyc.
install_dir_from() { # $1 = absolute source dir, $2 = relative path
  local s="$1" d="$TGT/$2"
  guard_dest "$2"
  clear_blocking_ancestors "$2"
  # A symlink standing where a real directory must go is refused, not followed
  # (and not silently swapped): it may point outside the target repo.
  if [[ -L "$d" ]]; then
    die "refusing to install into a symlinked directory: $2 in $TGT is a symlink (-> $(readlink "$d")). Remove it or replace it with a real directory, then re-run."
  fi
  if path_exists "$d" && [[ ! -d "$d" ]]; then
    backup_collision "$2"
  fi
  [[ $PLAN -eq 1 ]] || mkdir -p "$d"
  if [[ $GIT_SRC -eq 1 && "$s" == "$SRC"/* ]]; then
    install_dir_tracked "$s" "$2"
    return 0
  fi
  local child rel base
  while IFS= read -r -d '' child; do
    base="$(basename "$child")"
    case "$base" in
      __pycache__ | .* | *.swp | *~ | *.pyc) continue ;;
    esac
    rel="$2/$(basename "$child")"
    if [[ -L "$child" ]]; then
      install_link_from "$child" "$rel"
    elif [[ -d "$child" ]]; then
      install_dir_from "$child" "$rel"
    else
      install_file_from "$child" "$rel"
    fi
  done < <(find "$s" -mindepth 1 -maxdepth 1 -print0 | sort -z)
}

# Install the git-tracked files under one source dir ($1 absolute, inside
# $SRC; $2 = relative path in the target). Tracked symlinks keep the symlink
# handling; the working-tree copy is used so exec bits are preserved by cp -p.
install_dir_tracked() {
  local tgtrel="$2" srcrel="${1#"$SRC"/}" p src rel
  while IFS= read -r -d '' p; do
    case "$p" in
      */__pycache__/* | *.pyc) continue ;;
    esac
    src="$SRC/$p"
    rel="$tgtrel/${p#"$srcrel"/}"
    if [[ -L "$src" ]]; then
      install_link_from "$src" "$rel"
    elif [[ -f "$src" ]]; then
      install_file_from "$src" "$rel"
    else
      [[ $PLAN -eq 1 ]] || echo "  skip:   $p (tracked by git but missing or not a regular file in the source)" >&2
    fi
  done < <(git -C "$SRC" ls-files -z -- ":(literal)$srcrel" | sort -z)
}

# Install a symlink from the source tree. Relative links that resolve inside
# the source are recreated verbatim: the installer ships the whole tree
# shape, so "../.claude/skills" resolves against the TARGET's own copy.
install_link_from() { # $1 = absolute source symlink, $2 = relative path
  local s="$1" d="$TGT/$2"
  local link resolved newlink
  guard_dest "$2"
  clear_blocking_ancestors "$2"
  link="$(readlink "$s")"
  resolved="$(readlink -f "$s" 2>/dev/null || true)"
  if [[ -n "$resolved" && "$resolved" == "$SRC"/* && -d "$resolved" ]]; then
    newlink="$link"
    if [[ "$link" == /* ]]; then
      # Absolute link pointing inside the source: retarget to the target.
      newlink="${resolved/#$SRC/$TGT}"
    fi
    if [[ -L "$d" && "$(readlink "$d" 2>/dev/null || true)" == "$newlink" ]]; then
      return 0
    fi
    if path_exists "$d"; then backup_collision "$2"; fi
    [[ $PLAN -eq 0 ]] || return 0
    mkdir -p "$(dirname "$d")"
    ln -s "$newlink" "$d"
    COPIED=$((COPIED + 1))
    CHANGED=1
    echo "  link:   $2 -> $newlink"
  elif [[ -n "$resolved" && -d "$resolved" ]]; then
    # Link escapes the source tree: install the resolved files for real.
    [[ $PLAN -eq 1 ]] || echo "  note:   $2 resolves outside the source tree; installing real files"
    install_dir_from "$resolved" "$2"
  else
    [[ $PLAN -eq 1 ]] || echo "  skip:   $2 (broken symlink in source)" >&2
  fi
}

# ---------------------------------------------------------------------------
# The copy manifest (allow-list — nothing else is ever read or written)
# ---------------------------------------------------------------------------

MANIFEST=(
  .claude/agents
  .claude/skills
  .claude/scripts
  .claude/dashboard
  .claude/settings.json
  .opencode/agents
  .agents/skills
  opencode.json
)

echo "installing worker-fleet v$VERSION"
echo "  source: $SRC"
echo "  target: $TGT"
echo

# Pre-flight (before anything is copied): with a git source every manifest
# asset must be tracked, otherwise it would be silently skipped.
if [[ $GIT_SRC -eq 1 ]]; then
  for entry in "${MANIFEST[@]}"; do
    if [[ -e "$SRC/$entry" || -L "$SRC/$entry" ]] &&
      [[ -z "$(git -C "$SRC" ls-files -- ":(literal)$entry" | head -n 1)" ]]; then
      die "source asset is not tracked by git: $entry (commit it, or run from a clean worker-fleet checkout)"
    fi
  done
fi

# Pre-flight (before anything is written): no destination may sit behind a
# symlinked directory of the (possibly untrusted) target repo. Covers every
# manifest path, the backup dir, the specs/ skeleton and the version stamp's
# `.claude`; the per-write guards in the install engine re-check deeper paths.
for entry in "${MANIFEST[@]}"; do
  guard_dest "$entry"
  if [[ -d "$SRC/$entry" && ! -L "$SRC/$entry" && -L "$TGT/$entry" ]]; then
    die "refusing to install into a symlinked directory: $entry in $TGT is a symlink (-> $(readlink "$TGT/$entry")). Remove it or replace it with a real directory, then re-run."
  fi
done
guard_dest ".worker-fleet-backup/x"
[[ ! -L "$TGT/.worker-fleet-backup" ]] || die "refusing to use a symlinked backup dir: $TGT/.worker-fleet-backup"
guard_dest "specs/worker-fleet.config.json"
guard_dest "specs/tickets/BOARD.md"
guard_dest "$STAMP_REL"
# Files created only-if-absent must not be (dangling) symlinks: `-e` is false
# for a dangling link, so a naive "create if missing" would write through it.
for f in specs/worker-fleet.config.json specs/tickets/BOARD.md; do
  if [[ -L "$TGT/$f" ]]; then
    die "refusing to create $f: it is a symlink in $TGT (-> $(readlink "$TGT/$f")). Remove it, then re-run; nothing was written through it."
  fi
done

run_manifest() { # walks every manifest entry through the install engine
  local entry
  for entry in "${MANIFEST[@]}"; do
    if [[ -L "$SRC/$entry" ]]; then
      install_link_from "$SRC/$entry" "$entry"
    elif [[ -d "$SRC/$entry" ]]; then
      install_dir_from "$SRC/$entry" "$entry"
    elif [[ -f "$SRC/$entry" ]]; then
      install_file_from "$SRC/$entry" "$entry"
    else
      die "source asset missing: $entry (expected under $SRC)"
    fi
  done
}

# Pre-flight, full walk: dry-run the install engine over every destination the
# real run will touch (the same git ls-files / directory walk), so a symlinked
# intermediate directory at ANY depth (dangling or not) refuses the run before
# a single file is copied, linked, backed up or created. The per-write guards
# in the real run below stay as a second line of defence.
PLAN=1
run_manifest
PLAN=0

# Pre-flight, backup dir: only when this run would back up at least one file
# (so an `already up to date` re-run is never refused), the backup dir must be
# usable BEFORE anything is copied -- otherwise the run would die half-done.
if [[ $NEED_BACKUP -eq 1 ]]; then
  BACKUP_BASE="$TGT/.worker-fleet-backup"
  if [[ -e "$BACKUP_BASE" && ! -d "$BACKUP_BASE" ]]; then
    die "backup dir is not a directory: $BACKUP_BASE (move it aside, then re-run)"
  elif [[ -d "$BACKUP_BASE" ]]; then
    { [[ -w "$BACKUP_BASE" && -x "$BACKUP_BASE" ]]; } || die "$BACKUP_NOT_WRITABLE_MSG"
  else
    { [[ -w "$TGT" && -x "$TGT" ]]; } || die "$BACKUP_NOT_WRITABLE_MSG"
  fi
fi

run_manifest

# ---------------------------------------------------------------------------
# Ticket 089: move the pre-rename config and version stamp (real run only)
# ---------------------------------------------------------------------------

# Both old paths are regular files here (anything else was refused above). A move
# is a rename, so the content is byte-identical. When the new path already exists
# the old file is left alone: one warning for the config, none for the stamp.
if [[ -f "$TGT/$LEGACY_CONFIG_REL" ]]; then
  if ! path_exists "$TGT/$NEW_CONFIG_REL"; then
    mkdir -p "$TGT/specs"
    mv -- "$TGT/$LEGACY_CONFIG_REL" "$TGT/$NEW_CONFIG_REL"
    CHANGED=1
    echo "  move:   $LEGACY_CONFIG_REL -> $NEW_CONFIG_REL"
  else
    echo "  warning: $LEGACY_CONFIG_REL is no longer read; $NEW_CONFIG_REL is used"
  fi
fi
if [[ -f "$TGT/$LEGACY_STAMP_REL" ]] && ! path_exists "$STAMP_FILE"; then
  mv -- "$TGT/$LEGACY_STAMP_REL" "$STAMP_FILE"
  CHANGED=1
  echo "  move:   $LEGACY_STAMP_REL -> $STAMP_REL"
fi

# ---------------------------------------------------------------------------
# specs/ skeleton — created ONLY if absent, never backed up or overwritten
# ---------------------------------------------------------------------------

# "Only if absent" uses path_exists (-e || -L), NOT -e: a dangling symlink fails
# -e, so the file would be "created" by writing THROUGH the link to wherever it
# points (possibly outside the target). Leaf symlinks were already refused in
# the pre-flight above; creation here is also exclusive (O_EXCL never follows
# a symlink) as a second line of defence.

if ! path_exists "$TGT/specs/worker-fleet.config.json"; then
  mkdir -p "$TGT/specs"
  # NB: the `|| die` must sit on the SAME line as python3 — a `||` dangling
  # at end-of-line makes bash start the heredoc body on the next line.
  python3 -I - "$SRC" "$VERSION" "$TGT/specs/worker-fleet.config.json" <<'PYEOF' || die "failed to generate specs/worker-fleet.config.json"
import importlib.util
import json
import sys

src, version, out = sys.argv[1], sys.argv[2], sys.argv[3]

# Build the default config exactly like apply-setup.py does when no config
# exists (hybrid-bridge preset defaults), then run the same migrations so
# the skeleton is already at the current config schema version.
loader = importlib.util.spec_from_file_location(
    "apply_setup", src + "/.claude/scripts/apply-setup.py")
mod = importlib.util.module_from_spec(loader)
loader.loader.exec_module(mod)

config = {
    "version": "2.0.0",
    "harness": "both",
    "preset": "hybrid-bridge",
    "concurrency": {
        "maxParallelWorkers": 4,
        "mainPort": 3000,
        "reproducerPort": 3090,
        "workerBasePort": 3101,
        "dashboardPort": 3080,
    },
    "watchdog": {
        "intervalMinutes": 10,
        "stallThresholdMinutes": 15,
        "autoCompactWindow": 150000,
    },
    "regression": {"everyNMerges": 1},
    "models": mod.PRESETS["hybrid-bridge"]["models"],
    "dashboard": {
        "enabled": True,
        "autoStartWithRouter": True,
        "port": 3080,
        "allowRemoteActions": True,
        "tunnel": {"provider": "cloudflared", "namedTunnel": ""},
    },
}

mod.run_migrations(config, quiet=True)
config["version"] = version

with open(out, "x", encoding="utf-8") as f:  # "x" = O_CREAT|O_EXCL: never follows a symlink
    json.dump(config, f, indent=2)
PYEOF
  CHANGED=1
  echo "  create: specs/worker-fleet.config.json (defaults)"
fi

if ! path_exists "$TGT/specs/tickets/BOARD.md"; then
  mkdir -p "$TGT/specs/tickets"
  # noclobber (set -C) makes `>` exclusive (O_EXCL): it never follows a symlink.
  set -C
  cat > "$TGT/specs/tickets/BOARD.md" <<'BOARDEOF'
# Ticket Board

Status: `specifying` | `draft` | `ready` | `in-progress` | `blocked` | `done` | `failed` | `budget-exceeded` | `in-review`.
Mode: `solo` (one worker subagent) | `team` (agent team, for foundational or multi-surface tickets).
Runs: `alongside` (no dependencies, safe to run with other tickets) | `waits for NNN: reason`.

| # | Title | Status | Mode | Runs |
| --- | --- | --- | --- | --- |
BOARDEOF
  set +C
  CHANGED=1
  echo "  create: specs/tickets/BOARD.md (empty board)"
fi

# ---------------------------------------------------------------------------
# Version stamp (rewritten only when its content actually changes)
# ---------------------------------------------------------------------------

# The stamp is INSTALLER-OWNED: it is the one file that is deliberately
# overwritten in place WITHOUT a backup when its (regular-file) content is
# stale -- it only ever holds a version string, and the old value is reported
# as "upgraded from <old> to <new>". The installer never writes THROUGH a
# symlink: a symlinked (or otherwise non-regular) stamp was already refused up
# front, before anything was installed (see the pre-flight check above).
OLD_VERSION=""
if [[ -f "$STAMP_FILE" ]]; then # (symlinks/non-regular were refused up front)
  OLD_VERSION="$(cat "$STAMP_FILE")"
fi
STAMP_CHANGED=0
if [[ "$OLD_VERSION" != "$VERSION" ]]; then
  mkdir -p "$TGT/.claude"
  printf '%s\n' "$VERSION" > "$STAMP_FILE"
  STAMP_CHANGED=1
fi

# ---------------------------------------------------------------------------
# Summary, gitignore hint, next steps
# ---------------------------------------------------------------------------

echo
if [[ -n "$OLD_VERSION" && "$OLD_VERSION" != "$VERSION" ]]; then
  echo "upgraded from $OLD_VERSION to $VERSION"
elif [[ $CHANGED -eq 0 && $STAMP_CHANGED -eq 0 ]]; then
  echo "already up to date"
else
  echo "installed worker-fleet v$VERSION ($COPIED files installed, $BACKUPS backed up)"
fi

# Gitignore hint: list only the runtime/secret dirs the target's .gitignore
# does not already cover (probed with git check-ignore on a path inside each
# dir, so `job/`, `/job`, `job/*` ... all count). NEVER edits .gitignore.
HINT_ENTRIES=()
hint_probe() { # $1 = gitignore entry, $2 = probe path inside it
  if ! git -C "$TGT" check-ignore -q -- "$2" 2>/dev/null; then
    HINT_ENTRIES+=("$1")
  fi
}
hint_probe "job/" "job/dashboard-auth.json"
hint_probe ".claude/worktrees/" ".claude/worktrees/x/file"
hint_probe "__pycache__/" ".claude/scripts/__pycache__/x.pyc"
hint_probe ".worker-fleet-backup/" ".worker-fleet-backup/x"
if [[ ${#HINT_ENTRIES[@]} -gt 0 ]]; then
  echo "hint: add these to $TGT/.gitignore so runtime state and secrets stay out of git (not done automatically):"
  for e in "${HINT_ENTRIES[@]}"; do
    case "$e" in
      "job/") echo "  job/   <- holds the dashboard auth token (job/dashboard-auth.json): committing it leaks the token" ;;
      ".claude/worktrees/") echo "  .claude/worktrees/   <- isolated worker checkouts" ;;
      "__pycache__/") echo "  __pycache__/   <- Python bytecode caches" ;;
      ".worker-fleet-backup/") echo "  .worker-fleet-backup/   <- installer backups of replaced files" ;;
    esac
  done
fi

echo
echo "Next steps (run inside $TGT):"
echo "  1. Configure the workflow (preset, harness, ports, dashboard):"
echo "       python3 .claude/scripts/apply-setup.py"
echo "       (or just run /setup in your agent)"
echo "  2. Write your first tickets:        /write-tickets"
echo "  3. Launch the router:"
echo "       Claude Code:  claude --agent router --name router --permission-mode auto"
echo "       OpenCode:     opencode --agent router"
echo "  4. Start the Fleet Control Dashboard:"
echo "       bash .claude/scripts/start-dashboard.sh"

exit 0

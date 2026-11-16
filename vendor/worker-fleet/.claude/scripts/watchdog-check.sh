#!/usr/bin/env bash
# Health-check script for worker stalls, mobile Fleet Control decisions and
# dev-server ports. Its detection logic is shared by two consumers (ticket 017):
# the router/agents read the human-readable report, and the dashboard server's
# scheduler runs it with --json every watchdog.intervalSeconds, parsing the
# output into job/watchdog-report.json.
#
# Modes:
#   watchdog-check.sh                     Human-readable health report (default, unchanged).
#   watchdog-check.sh --json              Machine-readable JSON report:
#                                         {"ts","stalls":[{"file","ageSec","ticket"}],
#                                          "ports":[{"port","listening"}],
#                                          "decisions":["<paths>"],"anomalies":["<strings>"]}.
#                                         Same detection core as the human report — one
#                                         implementation, two renderings.
#   watchdog-check.sh --reap              Machine-readable JSON report of stale worker worktrees
#                                         (dry-run; nothing is removed; exit code 0).
#   watchdog-check.sh --reap --apply      Salvage-before-remove every stale worktree, then remove
#                                         it; prints the same JSON report with "removed": true.
#   watchdog-check.sh --reap [--apply] --path <worktree-dir>
#                                         Scoped operation: consider ONLY the one explicitly
#                                         identified worktree (used by the router to reap a
#                                         ledger-mapped worktree that lives outside the sandbox).
#
# Modes (ticket 026):
#   watchdog-check.sh --reap-completed    JSON report of every registered worktree and every
#                                         stale .claude/worktrees/ directory, classifying each
#                                         as reapable or keep-listed (dry-run; nothing is
#                                         removed; exit code 0).
#   watchdog-check.sh --reap-completed --apply
#                                         Remove exactly the SAFE set (see the four-gate
#                                         safety check below); keep-listed entries are never
#                                         touched. Prints the same JSON report with
#                                         "removed": true on the removed entries.
#   watchdog-check.sh --reap-completed [--apply] --path <worktree-dir>
#                                         Scoped operation: consider ONLY that one worktree
#                                         (registered worktree or .claude/worktrees/ husk).
#                                         The same safety gates still apply. Used by the
#                                         dashboard's reap_completed action for safe testing.
#
# Reap safety rails (003 FR-3/FR-4):
#   * The bulk scan only ever considers worker sandbox worktrees under
#     <repo>/.claude/worktrees/ that positively identify as reapable: each must
#     contain a job/status.json heartbeat whose file modification time (the one
#     heartbeat clock; the in-file "updatedAt" is never used) is older than
#     watchdog.stallThresholdMinutes from specs/worker-fleet.config.json.
#     Worktrees registered elsewhere in the shared git worktree registry are
#     never touched by the bulk scan.
#   * --path scopes the reap to exactly one worktree, which must still contain
#     a job/status.json heartbeat (positive identification) and passes the same
#     gates as the bulk scan.
#   * Ticket 061 liveness gates: every candidate is listed, and one that may
#     still be in use is kept ("action": "keep" with a reason), never
#     salvaged, unlocked or removed: an unparseable, fresh, "done" or
#     "blocked" heartbeat; a ticket that is done, in-review or blocked on the
#     board; a worktree locked by a live process or by hand; no way to list
#     processes (no /proc, no lsof); a live process whose cwd is inside it.
#     A Claude Code lock whose process is gone is released before the removal.
#     --reap-completed keeps a worktree with a live process inside as well.
#   * Salvage before remove (FR-3): new files under specs/tickets/<ticket>/evidence/
#     and specs/tickets/<ticket>/results.md are copied into this checkout's
#     ticket folder BEFORE any removal. If salvage fails the reap is ABORTED
#     for that worktree (nothing is destroyed) and the report shows
#     "action": "abort" so the watchdog/router can alert the user.
#   * Registered worktrees are removed with `git worktree remove --force`,
#     plain stale directories with `rm -rf`.
#   * The repo root, its ancestors, the current directory and its ancestors are
#     never reaped.
#   * Exit code 0 in dry-run and apply modes: detection (including a reported
#     salvage abort) is not a script failure.
#
# Completed-worktree reap safety rails (ticket 026 FR-2/FR-5) — a worktree is
# SAFE to reap only when ALL four gates pass:
#   1. Ticket `done` on specs/tickets/BOARD.md (the board is the single source
#      of truth for ticket status).
#   2. Proof the work landed in the main checkout: specs/tickets/<ticket>/
#      results.md AND specs/tickets/<ticket>/evidence/ exist.
#   3. Branch fully merged into main (git merge-base --is-ancestor <branch>
#      main; a detached worktree is checked via its HEAD commit). Unregistered
#      .claude/worktrees/ directory husks have no branch to lose — they are
#      reaped on gates 1+2 alone, which is how stale husks of already-merged
#      tickets get cleaned up.
#   4. No uncommitted/untracked changes inside the worktree (registered
#      worktrees only).
# Anything failing any gate is listed with "action": "keep" and the reason and
# is NEVER removed. The primary checkout (branch main/master), the repo root,
# the cwd and their ancestors are never reaped either.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage: bash .claude/scripts/watchdog-check.sh [--json] [--reap [--apply] [--path <worktree-dir>]]
                                               [--reap-completed [--apply] [--path <worktree-dir>]]

  (no flags)   Human-readable worker/dev-server health report.
  --json       Same detection core, rendered as the machine-readable report
               consumed by the dashboard server scheduler (ticket 017):
               {"ts","stalls","ports","decisions","anomalies"}.
  --reap       JSON report of every worker worktree candidate: stale ones as
               "reap", anything that may be in use as "keep" with the reason
               (dry-run; default). Heartbeat age = the file's modification time.
  --apply      With --reap: salvage new files under specs/tickets/<ticket>/evidence/
               and specs/tickets/<ticket>/results.md into this checkout's ticket
               folder BEFORE removing the worktree (salvage failure aborts that
               reap - nothing is destroyed), then remove it (git worktree remove
               --force for registered worktrees, rm -rf for plain stale
               directories) and report "removed": true. Exit code 0.
  --path DIR   Scope the reap to exactly one worktree (must contain a
               job/status.json heartbeat; same keep gates). The router uses this for
               ledger-mapped worktrees outside the .claude/worktrees/ sandbox.
  --reap-completed  JSON report of completed worktrees: every registered worktree
               and stale .claude/worktrees/ husk classified as reapable
               (ticket done on the board + branch merged into main + results.md
               and evidence/ landed in this checkout + clean worktree) or
               keep-listed with the reason (dry-run; default). With --apply the
               safe set is removed (git worktree remove --force for registered
               worktrees, rm -rf for husks). With --path DIR, only that one
               worktree is considered (same safety gates).
EOF
}

REAP=0
REAP_COMPLETED=0
APPLY=0
JSON_OUT=0
SCOPE_PATH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reap) REAP=1 ;;
    --reap-completed) REAP_COMPLETED=1 ;;
    --apply) APPLY=1 ;;
    --json) JSON_OUT=1 ;;
    --path)
      shift
      if [ $# -eq 0 ] || [ -z "$1" ]; then
        echo "error: --path requires a worktree directory argument" >&2
        exit 2
      fi
      SCOPE_PATH="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done
# --apply implies --reap when no reap mode was chosen (003 compatibility)
if [ "$APPLY" -eq 1 ] && [ "$REAP" -eq 0 ] && [ "$REAP_COMPLETED" -eq 0 ]; then REAP=1; fi
if [ "$REAP" -eq 1 ] && [ "$REAP_COMPLETED" -eq 1 ]; then
  echo "error: --reap and --reap-completed are separate modes; choose one" >&2
  exit 2
fi

# Ticket 089, FR-17: a legacy-only config (the new file is missing, the old one
# exists) would make the stall threshold fall back to its default and the reap modes
# run on it. Refuse in every mode except --help (handled above). 1 is the exit code
# for this refusal; 2 stays for usage errors. Nothing is reaped, salvaged or written.
LEGACY_CONFIG_REL="specs/super-agent.config.json"
if [ ! -e "$REPO_ROOT/specs/worker-fleet.config.json" ] && [ ! -L "$REPO_ROOT/specs/worker-fleet.config.json" ] \
  && { [ -e "$REPO_ROOT/$LEGACY_CONFIG_REL" ] || [ -L "$REPO_ROOT/$LEGACY_CONFIG_REL" ]; }; then
  echo "watchdog-check.sh: error: specs/worker-fleet.config.json is missing but $LEGACY_CONFIG_REL exists, and that file is no longer read. Run python3 .claude/scripts/apply-setup.py to migrate it." >&2
  exit 1
fi

if [ "$REAP_COMPLETED" -eq 1 ]; then
  python3 -I - "$REPO_ROOT" "$APPLY" "$SCOPE_PATH" <<'PY'
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
apply_mode = sys.argv[2] == "1"
scope_arg = sys.argv[3] if len(sys.argv) > 3 else ""


PROC_ROOT = "/proc"
PROC_CMD_MAX = 60


def list_processes():
    """The current user's live processes, listed once per run (ticket 061 FR-2).

    Returns (scan, procs): scan is 'proc' (PROC_ROOT is a directory), 'lsof'
    (lsof is on PATH) or 'unavailable'; procs is a list of (pid, cwd, command)
    with the command cut to 60 characters. A process whose cwd cannot be read
    (systemd --user, ssh-agent) or that vanished is skipped.
    """
    uid = os.getuid()
    if os.path.isdir(PROC_ROOT):
        if not os.path.isdir(os.path.join(PROC_ROOT, str(os.getpid()))):
            # A /proc that does not even list this process is empty or unmounted:
            # an empty scan would pass the process gate silently, so fail closed.
            return "unavailable", []
        try:
            names = os.listdir(PROC_ROOT)
        except OSError:
            names = None
        if names is not None:
            procs = []
            for name in names:
                if not name.isdigit():
                    continue
                entry = os.path.join(PROC_ROOT, name)
                try:
                    if os.stat(entry).st_uid != uid:
                        continue
                    cwd = os.readlink(os.path.join(entry, "cwd"))
                    try:
                        with open(os.path.join(entry, "cmdline"), "rb") as fh:
                            raw = fh.read(4096)
                    except OSError:
                        raw = b""
                except OSError:
                    continue
                cmd = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
                procs.append((int(name), cwd, cmd[:PROC_CMD_MAX]))
            return "proc", procs
    lsof = shutil.which("lsof")
    if lsof:
        try:
            r = subprocess.run(
                [lsof, "-a", "-d", "cwd", "-u", str(uid), "-Fpcn"],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            r = None
        if r is not None and (r.returncode == 0 or r.stdout.strip()):
            procs = []
            pid, cmd = None, ""
            for line in r.stdout.splitlines():
                if line.startswith("p") and line[1:].isdigit():
                    pid, cmd = int(line[1:]), ""
                elif line.startswith("c"):
                    cmd = line[1:]
                elif line.startswith("n") and pid is not None:
                    procs.append((pid, line[1:], cmd[:PROC_CMD_MAX]))
            return "lsof", procs
    return "unavailable", []


def process_inside(wt, procs):
    """(pid, command) of the lowest-pid live process whose cwd is the worktree or
    lies under it, else None."""
    root = str(wt).rstrip("/")
    for pid, cwd, cmd in sorted(procs):
        if cwd == root or cwd.startswith(root + "/"):
            return pid, cmd
    return None


# 073 FR-4.2 / 084 FR-2: fsmonitor, hooks and the global attributes file off, and the
# system config and attributes ignored (GIT_HARDEN_ENV), so nothing a worktree or the
# machine's system files define can make git run a command. Global config stays trusted.
GIT_HARDEN = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
              "-c", "core.attributesFile=/dev/null"]
GIT_HARDEN_ENV = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_ATTR_NOSYSTEM": "1"}
GITLINK_REASON = ("the worktree's index holds a gitlink (mode 160000, a submodule): git status would run "
                  "inside it; never reaping")
UNREADABLE_INDEX_REASON = "cannot list the worktree's index (git ls-files failed); never reaping"
UNTRUSTED_REASON = ("untrusted worktree: its .git is not a regular file pointing to its registered git dir; "
                    "git not run, never reaping")


def git(args, cwd=None, extra_env=None):
    env = dict(os.environ, **GIT_HARDEN_ENV)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["git"] + GIT_HARDEN + args,
        cwd=str(cwd or repo_root),
        capture_output=True,
        text=True,
        env=env,
    )


def common_git_dir():
    """Real path of the main repository's common git dir, or None (084 FR-1)."""
    r = git(["rev-parse", "--git-common-dir"])
    out = r.stdout.strip() if r.returncode == 0 else ""
    if not out:
        return None
    return os.path.realpath(os.path.join(str(repo_root), out))


def trusted_worktree(common_dir, wt):
    """084 FR-1: verify a worktree against the main repository's worktree registry.

    Returns (admin dir, work tree, common dir), all real paths, only when <wt>/.git is a
    regular file (not a symlink, not a directory, not missing) of at most 4 KiB
    holding one line `gitdir: <X>`, and X (relative to the worktree when
    relative) is the registered admin dir <common dir>/worktrees/<name>/ whose
    `gitdir` file names <wt>/.git. Otherwise None, and no git runs for it. The
    caller runs git with GIT_DIR and GIT_WORK_TREE set to the returned paths, so
    a later change of <wt>/.git cannot redirect it."""
    import stat as _stat

    try:
        if not common_dir:
            return None
        wt_real = os.path.realpath(str(wt))
        gitfile = os.path.join(str(wt), ".git")
        if not _stat.S_ISREG(os.lstat(gitfile).st_mode):
            return None
        fd = os.open(gitfile, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not _stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            data = os.read(fd, 4097)
        finally:
            os.close(fd)
        if len(data) > 4096:
            return None
        text = data.decode("utf-8")
        if text.endswith("\n"):
            text = text[:-1]
        if "\n" in text or not text.startswith("gitdir: ") or len(text) == len("gitdir: "):
            return None
        target = text[len("gitdir: "):]
        if not os.path.isabs(target):
            target = os.path.join(wt_real, target)
        target_real = os.path.realpath(target)
        wt_git = os.path.join(wt_real, ".git")
        wroot = os.path.join(common_dir, "worktrees")
        found = []
        for name in sorted(os.listdir(wroot)):
            admin = os.path.join(wroot, name)
            if os.path.islink(admin) or not os.path.isdir(admin):
                continue
            try:
                with open(os.path.join(admin, "gitdir"), "r", encoding="utf-8") as fh:
                    named = fh.read(4097).strip()
            except (OSError, UnicodeDecodeError):
                continue
            if not named:
                continue
            if not os.path.isabs(named):
                named = os.path.join(admin, named)
            if os.path.realpath(named) == wt_git:
                found.append(os.path.realpath(admin))
        if len(found) != 1 or found[0] != target_real:
            return None
        return found[0], wt_real, os.path.realpath(common_dir)
    except Exception:
        return None


def main():
    now = datetime.now(timezone.utc)

    # --- shared git facts ---------------------------------------------------
    def main_ref():
        for ref in ("refs/heads/main", "refs/heads/master"):
            if git(["rev-parse", "--verify", "--quiet", ref]).returncode == 0:
                return ref
        return ""

    MAIN_REF = main_ref()

    def is_merged(rev):
        if not MAIN_REF or not rev:
            return False
        return git(["merge-base", "--is-ancestor", str(rev), MAIN_REF]).returncode == 0

    registry_failed = []  # set when `git worktree list` fails: fail closed (061)

    def registered_worktrees():
        res = git(["worktree", "list", "--porcelain"])
        if res.returncode != 0:
            registry_failed.append(res.returncode)
        out = res.stdout
        entries = []
        cur = {}
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("worktree "):
                if cur:
                    entries.append(cur)
                cur = {"path": line.split(None, 1)[1].strip()}
            elif line.startswith("HEAD "):
                cur["commit"] = line.split(None, 1)[1].strip()
            elif line.startswith("branch "):
                cur["branch"] = line.split(None, 1)[1].strip().replace("refs/heads/", "")
            elif line == "bare":
                cur["bare"] = True
            elif line == "detached":
                cur["detached"] = True
            elif line == "locked" or line.startswith("locked "):
                cur["locked"] = True
        if cur:
            entries.append(cur)
        for e in entries:
            try:
                e["path"] = str(Path(e["path"]).resolve())
            except Exception:
                pass
        return entries

    def board_statuses():
        """{ticket id: status} from specs/tickets/BOARD.md (source of truth)."""
        statuses = {}
        p = repo_root / "specs" / "tickets" / "BOARD.md"
        if not p.is_file():
            return statuses
        in_table = False
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except Exception:
            return statuses
        for line in lines:
            s = line.strip()
            if s.startswith("|") and ("---" in s):
                in_table = True
                continue
            if in_table and s.startswith("|"):
                parts = [x.strip() for x in s.split("|")[1:-1]]
                if len(parts) >= 3 and parts[0] and parts[0] != "#":
                    statuses[parts[0]] = parts[2].lower()
        return statuses

    def ticket_folder(tid):
        """The specs/tickets/ folder for a ticket id, or None."""
        base = repo_root / "specs" / "tickets"
        if not base.is_dir():
            return None
        for d in sorted(base.glob(tid + "-*")):
            if d.is_dir():
                return d
        exact = base / tid
        return exact if exact.is_dir() else None

    def heartbeat(wt):
        """Heartbeat facts from the worktree's job/status.json.

        Returns dict(ticket, phase, mtime, unreadable). A MISSING file is
        fine (unreadable False); a file that exists but cannot be read or
        parsed as a JSON object is unreadable=True (callers keep the
        worktree: never fail open).
        """
        hb = {"ticket": "", "phase": "", "mtime": None, "unreadable": False}
        sp = wt / "job" / "status.json"
        if not sp.exists():
            return hb
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("heartbeat is not a JSON object")
            hb["ticket"] = str(data.get("ticket") or "")
            hb["phase"] = str(data.get("phase") or "")
            hb["mtime"] = sp.stat().st_mtime
            # File mtime only: the in-file updatedAt is writer-supplied and
            # can be wrong, so it never overrides the filesystem clock.
        except Exception:
            hb["unreadable"] = True
        return hb

    def checkout_mtime(wt):
        """mtime of the worktree's own HEAD file (written when the worktree is
        created or its branch is checked out), or None if unreadable."""
        try:
            gf = (wt / ".git")
            if gf.is_file():
                m = re.match(r"gitdir:\s*(.+)", gf.read_text(encoding="utf-8").strip())
                if not m:
                    return None
                gd = Path(m.group(1).strip())
            else:
                gd = gf
            return (gd / "HEAD").stat().st_mtime
        except Exception:
            return None

    def ticket_id_of(path, branch, hb_ticket):
        """Positive ticket identification only (never a stray 3-digit run):
        a heartbeat ticket 'NNN' / 'NNN-slug', a 'feat|fix|ticket/NNN-...'
        branch, or a directory named 'NNN-...' / '...-NNN' (worker-fleet-wt-001).
        Random hex agent-worktree names never identify a ticket."""
        m = re.match(r"^(\d{3})(?:-|$)", hb_ticket or "")
        if m:
            return m.group(1)
        m = re.match(r"^(?:feat|fix|ticket)/(\d{3})-", branch or "")
        if m:
            return m.group(1)
        name = Path(path).name
        if re.match(r"^agent-[0-9a-f]{12,}$", name):
            return ""
        m = re.match(r"^(\d{3})-", name) or re.search(r"-(\d{3})$", name)
        if m:
            return m.group(1)
        return ""

    # Live processes, listed once per run (061 FR-2).
    scan, procs = list_processes()

    cwd = Path(os.getcwd()).resolve()

    def protected(wt):
        # Never reap the repo root, its ancestors, the cwd, or the cwd's
        # ancestors (same rail as the 003 stale reaper).
        return (
            wt == repo_root
            or wt in repo_root.parents
            or wt == cwd
            or wt in cwd.parents
        )

    COMMON_DIR = common_git_dir()

    def trusted_env(trust):
        return {"GIT_DIR": trust[0], "GIT_WORK_TREE": trust[1], "GIT_COMMON_DIR": trust[2]}

    def has_gitlink(trust):
        """True/False: does the worktree's index hold a gitlink (mode 160000)? None when git
        cannot list the index. `git status` spawns a child git inside every gitlink, and that
        child reads sub/.git, which the worktree controls (084 review B1)."""
        r = git(["ls-files", "-s", "-z"], extra_env=trusted_env(trust))
        if r.returncode != 0:
            return None
        return any(e.startswith("160000 ") for e in r.stdout.split("\0"))

    def dirty(wt, trust):
        # Fail closed: if git cannot report the status, treat as dirty (keep).
        # 084 FR-1: git gets GIT_DIR / GIT_WORK_TREE from the verified registry entry
        # and never reads <wt>/.git. The caller has checked that the index holds no gitlink;
        # --ignore-submodules=all keeps `status` from spawning a child git in one that appeared
        # since, and the index is checked again afterwards (a gitlink then means dirty).
        r = git(["status", "--porcelain", "--ignore-submodules=all"], extra_env=trusted_env(trust))
        return r.returncode != 0 or bool(r.stdout.strip()) or has_gitlink(trust) is not False

    HUSK_OK_NAMES = {"job", "__pycache__", ".DS_Store"}

    def husk_foreign(wt):
        """Top-level entries of an unregistered husk other than job/,
        __pycache__ or .DS_Store (anything else may be someone's work)."""
        try:
            return sorted(n for n in os.listdir(str(wt)) if n not in HUSK_OK_NAMES)
        except Exception as e:
            return ["<unlistable: %s>" % e]

    def remove_worktree(wt, is_registered):
        if is_registered:
            r = git(["worktree", "remove", "--force", "--", str(wt)])
            if r.returncode != 0:
                return False, (r.stderr or r.stdout or "git worktree remove failed").strip()
            if wt.exists():
                return False, "worktree still present after git worktree remove"
            return True, ""
        import shutil
        try:
            shutil.rmtree(str(wt))
        except Exception as e:
            return False, "rm -rf failed: %s" % e
        if wt.exists():
            return False, "rm -rf failed"
        return True, ""

    # --- candidate set: every registered worktree + sandbox husks ----------
    all_registered = registered_worktrees()
    # The first porcelain entry is always the primary checkout: never reap it,
    # whatever branch it is on (or if it is detached).
    primary_path = all_registered[0]["path"] if all_registered else ""
    registered = [e for e in all_registered if not e.get("bare")]
    reg_paths = {e["path"] for e in registered}
    sandbox = repo_root / ".claude" / "worktrees"
    try:
        sandbox_real = sandbox.resolve()
    except Exception:
        sandbox_real = sandbox

    candidates = []
    for e in registered:
        candidates.append(
            {
                "path": e["path"],
                "branch": e.get("branch"),
                "commit": e.get("commit"),
                "registered": True,
                "locked": bool(e.get("locked")),
            }
        )
    if sandbox.is_dir():
        for d in sorted(sandbox.iterdir()):
            try:
                if d.is_symlink():
                    # Never follow a symlink out of the sandbox; list it only.
                    candidates.append(
                        {"path": str(d), "branch": None, "commit": None,
                         "registered": False, "symlink": True}
                    )
                    continue
                real = d.resolve()
                if d.is_dir() and str(real) not in reg_paths and real.parent == sandbox_real:
                    candidates.append(
                        {"path": str(real), "branch": None, "commit": None, "registered": False}
                    )
            except Exception:
                continue

    warnings = []
    scope = "full-registry"
    if scope_arg:
        scope = scope_arg
        sp = None
        if os.path.islink(scope_arg.rstrip("/") or scope_arg):
            warnings.append("refusing --path %s: it is a symlink (never followed)" % scope_arg)
            candidates = []
        else:
            try:
                sp = Path(scope_arg).resolve()
            except Exception as e:
                warnings.append("invalid --path %r: %s" % (scope_arg, e))
        if sp is not None:
            candidates = [c for c in candidates if c["path"] == str(sp)]
            if not candidates:
                warnings.append(
                    "%s is not a registered worktree or .claude/worktrees/ husk; "
                    "nothing to consider" % sp
                )

    board = board_statuses()
    entries = []
    for c in candidates:
        p = Path(c["path"])
        hb = heartbeat(p) if (p.exists() and not c.get("symlink")) else heartbeat(Path("/nonexistent-026"))
        hb_ticket, hb_phase = hb["ticket"], hb["phase"]
        tid = ticket_id_of(c["path"], c.get("branch"), hb_ticket)
        entry = {
            "worktree": c["path"],
            "ticket": tid,
            "branch": c.get("branch"),
            "registered": c["registered"],
            "action": "keep",
            "removed": False,
        }

        def keep(reason):
            entry["reason"] = reason
            entries.append(entry)

        # Safety gates, most specific first. A keep() is final: the worktree
        # is never removed (FR-5).
        if c.get("symlink"):
            keep("symlink inside .claude/worktrees/ is never followed or removed")
            continue
        if protected(p) or c["path"] == primary_path:
            keep("protected path (primary checkout, this checkout, its ancestors, or the cwd)")
            continue
        if c.get("locked"):
            keep("worktree is locked (git worktree lock)")
            continue
        if registry_failed:
            keep("cannot read the git worktree registry: never reaping")
            continue
        if scan == "unavailable":
            keep("cannot list live processes on this system (no /proc, no lsof): never reaping")
            continue
        holder = process_inside(p, procs)
        if holder:
            keep("a live process has its working directory inside the worktree "
                 "(pid %d: %s)" % holder)
            continue
        if c.get("branch") in ("main", "master"):
            keep("primary checkout on branch '%s'" % c["branch"])
            continue
        if not tid:
            keep("cannot positively identify a ticket (no heartbeat, branch, or "
                 "directory name carries a ticket id)")
            continue
        status = board.get(tid)
        if status is None:
            keep("ticket %s is not on specs/tickets/BOARD.md" % tid)
            continue
        if status != "done":
            keep("ticket %s status is '%s' (not 'done')" % (tid, status))
            continue
        folder = ticket_folder(tid)
        if folder is None:
            keep("no ticket folder specs/tickets/%s-*/ in this checkout" % tid)
            continue
        if not (folder / "results.md").is_file() or not (folder / "evidence").is_dir():
            keep("merged evidence missing in main checkout: specs/tickets/%s "
                 "needs results.md and evidence/" % folder.name)
            continue
        if hb["unreadable"]:
            keep("unreadable heartbeat: job/status.json exists but cannot be parsed")
            continue
        if hb_phase and hb_phase != "done":
            keep("heartbeat phase is '%s' (a worker may still be using it)" % hb_phase)
            continue
        if not c["registered"]:
            # Unregistered husk: no branch to verify, so be strict about what
            # may be rm -rf'd -- no git metadata, no heartbeat-less ambiguity.
            if (p / ".git").exists():
                keep("unregistered directory carries a .git entry (possible unmerged work)")
                continue
            if not hb_ticket and not re.match(r"^\d{3}-", p.name):
                keep("husk has no heartbeat and no 'NNN-' directory name")
                continue
            foreign = husk_foreign(p)
            if foreign:
                keep("husk contains content other than job/ or __pycache__ "
                     "(%s)" % ", ".join(foreign[:5]))
                continue
        if c["registered"]:
            if c.get("branch"):
                if not is_merged("refs/heads/" + c["branch"]):
                    keep("branch '%s' is not merged into main" % c["branch"])
                    continue
            elif c.get("commit"):
                if not is_merged(c["commit"]):
                    keep("detached HEAD %s is not an ancestor of main" % c["commit"][:8])
                    continue
            else:
                keep("registered worktree with no branch or commit; cannot verify merge")
                continue
            trust = trusted_worktree(COMMON_DIR, p)
            if trust is None:
                keep(UNTRUSTED_REASON)
                continue
            links = has_gitlink(trust)
            if links is None:
                keep(UNREADABLE_INDEX_REASON)
                continue
            if links:
                keep(GITLINK_REASON)
                continue
            if dirty(p, trust):
                keep("uncommitted or untracked changes present in the worktree "
                     "(or git status failed)")
                continue
            # A heartbeat only counts as "done" proof if it is newer than the
            # worktree's current checkout; a leftover heartbeat from an earlier
            # worker (rework branch checked out over it) proves nothing.
            co = checkout_mtime(p)
            if co is None:
                keep("cannot read the worktree's git dir; cannot verify the "
                     "heartbeat is current")
                continue
            if hb_phase and (hb["mtime"] is None or hb["mtime"] < co):
                keep("heartbeat predates the worktree's current checkout "
                     "(stale 'done' heartbeat from an earlier worker)")
                continue
            if c.get("commit") and MAIN_REF:
                # Fresh-branch guard, applied even with a 'done' heartbeat: a
                # worktree whose HEAD sits on main's first-parent chain (a
                # fix/NNN-* rework branch cut from main, or a branch at main's
                # tip) is indistinguishable from a worker that has not made its
                # first commit. A finished branch merged via a merge commit is
                # a second-parent tip and is not on that chain.
                fp = set(git(["rev-list", "--first-parent", MAIN_REF]).stdout.split())
                if c["commit"] in fp:
                    keep("HEAD is on main's first-parent chain: cannot tell a "
                         "finished worktree from a freshly created rework branch")
                    continue
        # All gates passed: safe to reap.
        entry["action"] = "reap"
        if apply_mode:
            ok, err = remove_worktree(p, c["registered"])
            if ok:
                entry["removed"] = True
            else:
                entry["action"] = "abort"
                entry["reason"] = err or "removal failed"
        entries.append(entry)

    reapable = [e for e in entries if e["action"] == "reap"]
    kept = [e for e in entries if e["action"] == "keep"]
    aborted = [e for e in entries if e["action"] == "abort"]
    report = {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": "apply" if apply_mode else "dry-run",
        "scope": scope,
        "processScan": scan,
        "summary": {
            "considered": len(entries),
            "reapable": len(reapable),
            "kept": len(kept),
            "aborted": len(aborted),
            "removed": sum(1 for e in entries if e.get("removed")),
        },
        "reapCompleted": entries,
    }
    if warnings:
        report["warnings"] = warnings
    print(json.dumps(report, indent=2))


try:
    main()
except Exception:
    traceback.print_exc()
    print(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "mode": "apply" if apply_mode else "dry-run",
                "summary": {"considered": 0, "reapable": 0, "kept": 0, "aborted": 0, "removed": 0},
                "reapCompleted": [],
                "error": "internal error; see stderr",
            },
            indent=2,
        )
    )
PY
  exit 0
fi

if [ "$REAP" -eq 1 ]; then
  python3 -I - "$REPO_ROOT" "$APPLY" "$SCOPE_PATH" <<'PY'
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
apply_mode = sys.argv[2] == "1"
scope_arg = sys.argv[3] if len(sys.argv) > 3 else ""

SAFE_TICKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# 073 FR-4.2 / 084 FR-2: fsmonitor, hooks and the global attributes file off, and the
# system config and attributes ignored, on every git call below. Global config stays trusted.
GIT_HARDEN = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
              "-c", "core.attributesFile=/dev/null"]


def git_env():
    return dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_ATTR_NOSYSTEM="1")


PROC_ROOT = "/proc"
PROC_CMD_MAX = 60
CLAUDE_LOCK = re.compile(r"^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$")


def list_processes():
    """The current user's live processes, listed once per run (ticket 061 FR-2).

    Returns (scan, procs): scan is 'proc' (PROC_ROOT is a directory), 'lsof'
    (lsof is on PATH) or 'unavailable'; procs is a list of (pid, cwd, command)
    with the command cut to 60 characters. A process whose cwd cannot be read
    (systemd --user, ssh-agent) or that vanished is skipped.
    """
    uid = os.getuid()
    if os.path.isdir(PROC_ROOT):
        if not os.path.isdir(os.path.join(PROC_ROOT, str(os.getpid()))):
            # A /proc that does not even list this process is empty or unmounted:
            # an empty scan would pass the process gate silently, so fail closed.
            return "unavailable", []
        try:
            names = os.listdir(PROC_ROOT)
        except OSError:
            names = None
        if names is not None:
            procs = []
            for name in names:
                if not name.isdigit():
                    continue
                entry = os.path.join(PROC_ROOT, name)
                try:
                    if os.stat(entry).st_uid != uid:
                        continue
                    cwd = os.readlink(os.path.join(entry, "cwd"))
                    try:
                        with open(os.path.join(entry, "cmdline"), "rb") as fh:
                            raw = fh.read(4096)
                    except OSError:
                        raw = b""
                except OSError:
                    continue
                cmd = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
                procs.append((int(name), cwd, cmd[:PROC_CMD_MAX]))
            return "proc", procs
    lsof = shutil.which("lsof")
    if lsof:
        try:
            r = subprocess.run(
                [lsof, "-a", "-d", "cwd", "-u", str(uid), "-Fpcn"],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            r = None
        if r is not None and (r.returncode == 0 or r.stdout.strip()):
            procs = []
            pid, cmd = None, ""
            for line in r.stdout.splitlines():
                if line.startswith("p") and line[1:].isdigit():
                    pid, cmd = int(line[1:]), ""
                elif line.startswith("c"):
                    cmd = line[1:]
                elif line.startswith("n") and pid is not None:
                    procs.append((pid, line[1:], cmd[:PROC_CMD_MAX]))
            return "lsof", procs
    return "unavailable", []


def process_inside(wt, procs):
    """(pid, command) of the lowest-pid live process whose cwd is the worktree or
    lies under it, else None."""
    root = str(wt).rstrip("/")
    for pid, cwd, cmd in sorted(procs):
        if cwd == root or cwd.startswith(root + "/"):
            return pid, cmd
    return None


def lock_state(lock):
    """Classify a registered worktree's lock (ticket 061 FR-1).

    `lock` is None (not locked) or the lock reason ('' when none was given).
    Returns ('none', None), ('live', pid) for a Claude Code lock whose owner is
    alive, ('stale', pid) for one whose owner is gone, or ('hand', None) for any
    other lock (a lock with no reason, or one that is not in Claude Code's
    format): a hand lock is never released.
    """
    if lock is None:
        return "none", None
    m = CLAUDE_LOCK.match(lock)
    if not m or int(m.group(1)) < 1:
        return "hand", None
    pid, start = int(m.group(1)), m.group(2)
    try:
        os.kill(pid, 0)
    except PermissionError:
        pass  # exists, owned by someone else
    except Exception:
        return "stale", pid  # no such process, or a pid out of range
    if start is not None:
        try:
            with open(os.path.join(PROC_ROOT, str(pid), "stat"), "r", encoding="utf-8", errors="replace") as fh:
                raw = fh.read()
            # field 22 is the process start time; fields are counted after the last ')'
            if raw.rsplit(")", 1)[1].split()[19] != start:
                return "stale", pid  # the pid was reused by another process
        except Exception:
            pass  # stat unreadable: the pid alone decides
    return "live", pid


def main():
    now = datetime.now(timezone.utc)

    threshold_sec = 900
    try:
        conf = json.loads(
            (repo_root / "specs" / "worker-fleet.config.json").read_text(encoding="utf-8")
        )
        threshold_sec = int(conf.get("watchdog", {}).get("stallThresholdMinutes", 15)) * 60
    except Exception:
        pass

    def heartbeat(wt):
        """Heartbeat facts from a worktree's job/status.json (ticket 061 FR-6).

        Returns dict(age, ticket, raw_ticket, phase, parsed). The age is
        now - the file's modification time (never the writer-supplied
        updatedAt), in whole seconds and never negative; None when the file's
        mtime cannot be read. parsed is False when the file is not a JSON object.
        """
        sp = wt / "job" / "status.json"
        data = {}
        parsed = False
        try:
            loaded = json.loads(sp.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
                parsed = True
        except Exception:
            data = {}
        age = None
        try:
            age = int(max(0, now.timestamp() - sp.stat().st_mtime))
        except Exception:
            age = None
        raw_ticket = str(data.get("ticket") or "")
        ticket = raw_ticket if SAFE_TICKET.match(raw_ticket) else wt.name
        return {
            "age": age,
            "ticket": ticket,
            "raw_ticket": raw_ticket,
            "phase": str(data.get("phase") or "").strip().lower(),
            "parsed": parsed,
        }

    def board_statuses():
        """{ticket id: status} from specs/tickets/BOARD.md (source of truth)."""
        statuses = {}
        bp = repo_root / "specs" / "tickets" / "BOARD.md"
        if not bp.is_file():
            return statuses
        in_table = False
        try:
            lines = bp.read_text(encoding="utf-8").splitlines()
        except Exception:
            return statuses
        for line in lines:
            t = line.strip()
            if t.startswith("|") and ("---" in t):
                in_table = True
                continue
            if in_table and t.startswith("|"):
                parts = [x.strip() for x in t.split("|")[1:-1]]
                if len(parts) >= 3 and parts[0] and parts[0] != "#":
                    statuses[parts[0]] = parts[2].lower()
        return statuses

    def registered_worktrees():
        try:
            res = subprocess.run(
                ["git"] + GIT_HARDEN + ["worktree", "list", "--porcelain"],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                env=git_env(),
            )
        except Exception:
            return None
        if res.returncode != 0:
            return None  # fail closed: the registry (and every lock) is unknown
        out = res.stdout
        # {resolved path: lock}; lock is None, "" (locked, no reason) or the reason.
        paths = {}
        cur = None
        for line in out.splitlines():
            if line.startswith("worktree "):
                try:
                    cur = Path(line.split(None, 1)[1].strip()).resolve()
                    paths[cur] = None
                except Exception:
                    cur = None
            elif cur is not None and (line == "locked" or line.startswith("locked ")):
                paths[cur] = line[7:].strip() if line.startswith("locked ") else ""
        return paths

    cwd = Path(os.getcwd()).resolve()

    def protected(wt):
        # Never reap the repo root, its ancestors, the cwd, or the cwd's ancestors.
        return (
            wt == repo_root
            or wt in repo_root.parents
            or wt == cwd
            or wt in cwd.parents
        )

    def salvage(wt, ticket):
        """FR-3 salvage: copy NEW files under specs/tickets/<ticket>/evidence/ and
        specs/tickets/<ticket>/results.md from the stale worktree into this
        checkout's ticket folder BEFORE removal. Returns salvaged relative paths.
        073 FR-3: nothing is copied through a symlink; each link met on the way
        down is skipped (with one warning) and never followed.
        084 FR-4: the walk goes through file descriptors, never through a path
        checked earlier. The worktree root and every folder below it is opened with
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW relative to its parent's descriptor; a
        file is opened with O_RDONLY | O_NOFOLLOW | O_NONBLOCK relative to its
        folder's descriptor and its bytes are copied from that descriptor only when
        fstat says it is a regular file. An entry that is swapped for a symlink
        while this runs is therefore never followed (the warning for a link that
        appeared mid-walk is best-effort)."""
        import stat as _stat

        salvaged = []
        dst_ticket = repo_root / "specs" / "tickets" / ticket
        warned = set()
        fds = []

        def skip_link(path):
            if str(path) not in warned:
                warned.add(str(path))
                warnings.append("salvage skipped symlink %s: never followed or copied" % path)

        def is_link(parent_fd, name):
            try:
                return _stat.S_ISLNK(os.stat(name, dir_fd=parent_fd, follow_symlinks=False).st_mode)
            except OSError:
                return False

        def open_dir(parent_fd, name, path):
            """fd of the directory `name` below parent_fd; None when it is absent, is not
            a directory, or is a symlink (warned, never followed)."""
            if parent_fd is None:
                return None
            try:
                st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError:
                return None
            if _stat.S_ISLNK(st.st_mode):
                skip_link(path)
                return None
            if not _stat.S_ISDIR(st.st_mode):
                return None
            try:
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            except OSError:
                if is_link(parent_fd, name):  # replaced by a symlink after the check above
                    skip_link(path)
                return None
            fds.append(fd)
            return fd

        def copy_file(dir_fd, name, path, dst):
            """Copy the regular file `name` of dir_fd to the new file dst, from the
            descriptor. True when copied; False for a link, a non-regular file or an
            existing dst (only new files are salvaged, nothing is overwritten)."""
            try:
                sfd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
            except OSError:
                if is_link(dir_fd, name):
                    skip_link(path)
                return False
            try:
                st = os.fstat(sfd)
                if not _stat.S_ISREG(st.st_mode):
                    return False
                dst.parent.mkdir(parents=True, exist_ok=True)
                try:
                    dfd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                except FileExistsError:
                    return False
                try:
                    while True:
                        chunk = os.read(sfd, 1 << 20)
                        if not chunk:
                            break
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(dfd, view):]
                    os.fchmod(dfd, _stat.S_IMODE(st.st_mode))
                    os.utime(dfd, ns=(st.st_atime_ns, st.st_mtime_ns))
                except BaseException:
                    os.close(dfd)
                    dfd = None
                    try:
                        os.unlink(str(dst))
                    except OSError:
                        pass
                    raise
                finally:
                    if dfd is not None:
                        os.close(dfd)
                return True
            finally:
                os.close(sfd)

        def walk(dir_fd, dir_path, rel):
            """Copy the new regular files below the folder dir_fd (rel: its path below evidence/)."""
            try:
                names = sorted(os.listdir(dir_fd))
            except OSError:
                return
            files, dirs = [], []
            for name in names:
                try:
                    mode = os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode
                except OSError:
                    continue
                if _stat.S_ISLNK(mode):
                    skip_link(dir_path / name)  # never followed
                elif _stat.S_ISREG(mode):
                    files.append(name)
                elif _stat.S_ISDIR(mode):
                    dirs.append(name)
            for name in files:
                sub = rel + (name,)
                dst = dst_ticket.joinpath("evidence", *sub)
                if copy_file(dir_fd, name, dir_path / name, dst):
                    salvaged.append("/".join(sub))
            for name in dirs:
                sub_fd = open_dir(dir_fd, name, dir_path / name)
                if sub_fd is not None:
                    try:
                        walk(sub_fd, dir_path / name, rel + (name,))
                    finally:
                        os.close(sub_fd)
                        fds.remove(sub_fd)

        try:
            root_fd = os.open(str(wt), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            return salvaged
        fds.append(root_fd)
        try:
            specs_fd = open_dir(root_fd, "specs", wt / "specs")
            tickets_fd = open_dir(specs_fd, "tickets", wt / "specs" / "tickets")
            src_ticket = wt / "specs" / "tickets" / ticket
            ticket_fd = open_dir(tickets_fd, ticket, src_ticket)
            ev_fd = open_dir(ticket_fd, "evidence", src_ticket / "evidence")
            if ev_fd is not None:
                walk(ev_fd, src_ticket / "evidence", ())
            if ticket_fd is not None:
                if copy_file(ticket_fd, "results.md", src_ticket / "results.md", dst_ticket / "results.md"):
                    salvaged.append("results.md")
        finally:
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass
        return salvaged

    def remove_worktree(wt, is_registered):
        if is_registered:
            r = subprocess.run(
                ["git"] + GIT_HARDEN + ["worktree", "remove", "--force", "--", str(wt)],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                env=git_env(),
            )
            if r.returncode != 0:
                return False, (r.stderr or r.stdout or "git worktree remove failed").strip()
            if wt.exists():
                return False, "worktree still present after git worktree remove"
            return True, ""
        try:
            shutil.rmtree(str(wt))
        except Exception as e:  # reported as an abort so it is recorded, not a crash
            return False, "rm -rf failed: %s" % e
        if wt.exists():
            return False, "rm -rf failed"
        return True, ""

    sandbox = repo_root / ".claude" / "worktrees"
    candidates = []
    warnings = []
    scope = str(sandbox)

    def symlink_below_sandbox(arg):
        """084 FR-5: True when a component of `arg` whose real parent is
        <repo>/.claude/worktrees or lies under it is a symlink (os.lstat).

        `arg` is walked component by component from the cwd (a relative path; the
        bash part sets the cwd to the repo root) or from / (an absolute one), keeping
        the real path reached so far. A symlink above the sandbox (macOS's /tmp, a
        symlinked parent of the repo) is followed and allowed."""
        sandbox_real = str(sandbox)
        cur = "/" if arg.startswith("/") else os.path.realpath(os.getcwd())
        for comp in arg.split("/"):
            if comp in ("", "."):
                continue
            if comp == "..":
                cur = os.path.dirname(cur)
                continue
            nxt = os.path.join(cur, comp)
            if os.path.islink(nxt):
                if cur == sandbox_real or cur.startswith(sandbox_real + "/"):
                    return True
                cur = os.path.realpath(nxt)
            else:
                cur = nxt
        return False

    if scope_arg:
        p = None
        # Drop trailing "" and "." components first (lstat of "link/." follows the
        # link), then check the remaining string physically ("linked-parent/../link"
        # is still caught) and lexically, no link being resolved by the stripping.
        parts = scope_arg.split("/")
        while parts and parts[-1] in ("", "."):
            parts.pop()
        core = "/".join(parts) or ("/" if scope_arg.startswith("/") else ".")
        last = parts[-1] if parts else ""
        lex = os.path.normpath(os.path.abspath(scope_arg))
        if os.path.islink(core) or os.path.islink(lex) or last == ".." or symlink_below_sandbox(scope_arg):
            # 073 FR-2: a symlinked --path is never followed (same text as --reap-completed).
            # A trailing ".." cannot be told apart lexically from the link's target, so it is refused too.
            # 084 FR-5: so is a symlink in any component below <repo>/.claude/worktrees/.
            warnings.append("refusing --path %s: it is a symlink (never followed)" % scope_arg)
        else:
            try:
                p = Path(scope_arg).resolve()
            except Exception as e:
                warnings.append("invalid --path %r: %s" % (scope_arg, e))
                p = None
        if p is not None:
            scope = str(p)
            if protected(p):
                warnings.append("refusing to reap protected path %s" % p)
            elif not (p / "job" / "status.json").is_file():
                warnings.append(
                    "%s has no job/status.json heartbeat; not positively "
                    "identifiable as a worker worktree; skipped" % p
                )
            else:
                candidates = [p]
    else:
        # Bulk auto-reap: worker sandbox only (.claude/worktrees/*). The shared
        # git worktree registry outside this sandbox is never auto-reaped.
        if sandbox.is_dir():
            for d in sorted(sandbox.iterdir()):
                try:
                    if d.is_symlink():
                        # 073 FR-1: checked before is_dir()/resolve(), which follow links.
                        warnings.append("skipped symlink %s: never followed or removed" % d)
                        continue
                    if d.is_dir() and (d / "job" / "status.json").is_file():
                        candidates.append(d.resolve())
                except Exception:
                    continue

    registered = registered_worktrees()
    registry_ok = registered is not None
    if not registry_ok:
        registered = {}
    board = board_statuses()
    scan, procs = list_processes()  # live processes, listed once per run (061 FR-2)

    def unlock(wt):
        r = subprocess.run(
            ["git"] + GIT_HARDEN + ["worktree", "unlock", "--", str(wt)],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            env=git_env(),
        )
        if r.returncode != 0:
            return False, (r.stderr or r.stdout or "git worktree unlock failed").strip()
        return True, ""

    def keep_reason(wt, hb):
        """The first liveness gate that applies (061 FR-3/FR-4), as
        (reason, stale_lock_pid), or (None, pid) when every gate passes.
        pid is the stale Claude Code lock's owner, to be released on --apply."""
        if not hb["parsed"]:
            return "heartbeat job/status.json cannot be parsed: cannot tell the worker's phase", None
        age = hb["age"]
        if age is None:
            return "cannot read the heartbeat file's modification time", None
        if age <= threshold_sec:
            return "heartbeat is fresh (%ds <= %ds)" % (age, threshold_sec), None
        if hb["phase"] == "done":
            return ("heartbeat phase is 'done': the worker finished and its branch waits for verification "
                    "or merge (completed worktrees are reaped only by --reap-completed)"), None
        if hb["phase"] == "blocked":
            return "heartbeat phase is 'blocked': the worker waits for a user decision", None
        m = re.match(r"^(\d{3})(?:-|$)", hb["raw_ticket"])
        status = board.get(m.group(1)) if m else None
        if status in ("done", "in-review"):
            return ("ticket %s is '%s' on specs/tickets/BOARD.md: completed worktrees are reaped only "
                    "by --reap-completed" % (m.group(1), status)), None
        if status == "blocked":
            return ("ticket %s is 'blocked' on specs/tickets/BOARD.md: the worker waits for a user "
                    "decision" % m.group(1)), None
        if not registry_ok:
            # Without the registry no lock is known and a registered worktree is
            # indistinguishable from a plain directory (which would be rm -rf'd).
            return "cannot read the git worktree registry: never reaping", None
        lock = registered.get(wt)
        state, pid = lock_state(lock)
        if state == "live":
            return "worktree is locked by a live process (pid %d): %s" % (pid, lock), None
        if state == "hand":
            return "worktree is locked by hand (git worktree lock): %s" % (lock or "no reason given"), None
        if scan == "unavailable":
            return "cannot list live processes on this system (no /proc, no lsof): never reaping", None
        holder = process_inside(wt, procs)
        if holder:
            return ("a live process has its working directory inside the worktree "
                    "(pid %d: %s)" % holder), None
        return None, (pid if state == "stale" else None)

    entries = []
    for wt in candidates:
        if protected(wt):
            warnings.append("refusing to reap protected path %s" % wt)
            continue
        hb = heartbeat(wt)
        ticket = hb["ticket"]
        entry = {
            "worktree": str(wt),
            "ticket": ticket,
            "heartbeatAgeSec": hb["age"],
            "action": "reap",
            "registered": wt in registered,
            "removed": False,
            "salvaged": [],
        }
        reason, stale_pid = keep_reason(wt, hb)
        if reason is not None:
            entry["action"] = "keep"
            entry["reason"] = reason
            entries.append(entry)
            continue
        if apply_mode:
            try:
                entry["salvaged"] = salvage(wt, ticket)
            except Exception as e:
                entry["action"] = "abort"
                entry["removed"] = False
                entry["reason"] = (
                    "salvage failed; reap aborted and worktree preserved: %s" % e
                )
                entries.append(entry)
                continue
            if stale_pid is not None:
                # A Claude Code lock whose process is gone: release it, as Claude
                # Code itself does, else git refuses the removal (061 FR-1).
                ok, err = unlock(wt)
                if not ok:
                    entry["action"] = "abort"
                    entry["reason"] = "could not release the stale lock: %s" % err
                    entries.append(entry)
                    continue
            ok, err = remove_worktree(wt, wt in registered)
            if ok:
                entry["removed"] = True
            else:
                entry["action"] = "abort"
                entry["reason"] = err or "removal failed"
        entries.append(entry)

    # 017 review fix 4 / 003 FR-7: an "abort" only exists in --apply mode and the
    # report above is gone once printed, so record unresolved aborts in
    # job/reap-aborts.json; `--json` folds them into `anomalies` ("reap abort:")
    # until the worktree is later removed (entry dropped) or disappears.
    # Best-effort: bookkeeping failure never changes the reap result.
    if apply_mode and entries:
        try:
            ab_path = repo_root / "job" / "reap-aborts.json"
            try:
                prior = json.loads(ab_path.read_text(encoding="utf-8")).get("aborts", [])
            except Exception:
                prior = []
            by_wt = {str(a.get("worktree")): a for a in prior if isinstance(a, dict)}
            for e in entries:
                if e.get("action") == "abort":
                    by_wt[e["worktree"]] = {
                        "worktree": e["worktree"],
                        "ticket": e.get("ticket"),
                        "reason": e.get("reason") or "salvage failed",
                        "recordedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    }
                elif e.get("removed"):
                    by_wt.pop(e["worktree"], None)
            if by_wt or ab_path.exists():
                ab_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = ab_path.parent / (ab_path.name + ".tmp")
                tmp.write_text(json.dumps({"aborts": list(by_wt.values())}, indent=2) + "\n", encoding="utf-8")
                os.replace(str(tmp), str(ab_path))
        except Exception:
            pass

    report = {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": "apply" if apply_mode else "dry-run",
        "stallThresholdSec": threshold_sec,
        "scope": scope,
        "processScan": scan,
        "reap": entries,
    }
    if warnings:
        report["warnings"] = warnings
    print(json.dumps(report, indent=2))


try:
    main()
except Exception:
    traceback.print_exc()
    print(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "mode": "apply" if apply_mode else "dry-run",
                "reap": [],
                "error": "internal error; see stderr",
            },
            indent=2,
        )
    )
PY
  exit 0
fi

# Default mode (ticket 017): one Python detection core computes the health
# data once; --json renders the machine-readable report for the dashboard
# server scheduler, the default renders the same data human-readable. The
# detection logic is NOT duplicated between the two outputs.
python3 -I - "$REPO_ROOT" "$JSON_OUT" <<'PY'
import glob
import json
import os
import re
import socket
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
json_mode = sys.argv[2] == "1"

now = datetime.now(timezone.utc)
now_ts = now.timestamp()

SAFE_TICKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


# ---------------------------------------------------------------------------
# Port probing (017 review fix 2). A port counts as listening when EITHER
# 127.0.0.1 or ::1 accepts a connection: Node 17+/Vite bind "localhost" to
# ::1 only. The probed set is the project's main, dashboard and reproducer
# ports (068: concurrency.mainPort, dashboard.port, concurrency.reproducerPort;
# defaults 3000/3080/3090) plus the worker pool taken from config
# (concurrency.workerBasePort .. base + 2 * maxParallelWorkers, never
# narrower than the historical 3101-3120; 076: at most 1000 workers count).
# ---------------------------------------------------------------------------
def _probe(family, host, port):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(0.1)
            return s.connect_ex((host, port)) == 0
    except OSError:
        return False  # e.g. IPv6 unavailable on this host


def _listening(port):
    return _probe(socket.AF_INET, "127.0.0.1", port) or _probe(socket.AF_INET6, "::1", port)


def _cfg_port(value):
    """068 FR-1: a valid port is an int (not a bool) or an ASCII-digit string in 1..65535."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        digits = value.lstrip("0")
        if not (value.isascii() and value.isdigit()) or len(digits) > 5:
            return None
        value = int(digits or "0")
    if isinstance(value, int) and 1 <= value <= 65535:
        return value
    return None


# 076 FR-1: the probe never sizes its pool for more than this many workers, so
# a typo or hostile maxParallelWorkers cannot make a tick probe ~62,000 ports.
MAX_PROBE_WORKERS = 1000


def _cfg_workers(value):
    """068 FR-1: maxParallelWorkers is an int (not a bool) or ASCII-digit string >= 1, else 8.
    076 FR-1: a valid count above MAX_PROBE_WORKERS (1000) is capped to 1000."""
    if isinstance(value, bool):
        return 8
    if isinstance(value, str):
        if not (value.isascii() and value.isdigit()):
            return 8
        digits = value.lstrip("0")
        value = int(digits) if 0 < len(digits) <= 9 else (10 ** 9 if digits else 0)
    if isinstance(value, int) and value >= 1:
        return min(value, MAX_PROBE_WORKERS)  # 076: cap; also avoids huge-int formatting
    return 8


def probe_port_list(conf):
    # 068 FR-1/FR-2: main, dashboard and reproducer come from the project's
    # config (defaults 3000, 3080, 3090), then the worker pool.
    c = conf.get("concurrency") if isinstance(conf, dict) else None
    c = c if isinstance(c, dict) else {}
    d = conf.get("dashboard") if isinstance(conf, dict) else None
    d = d if isinstance(d, dict) else {}
    main_port = _cfg_port(c.get("mainPort")) or 3000
    dash_port = _cfg_port(d.get("port")) or _cfg_port(c.get("dashboardPort")) or 3080
    repro_port = _cfg_port(c.get("reproducerPort")) or 3090
    base = _cfg_port(c.get("workerBasePort")) or 3101
    max_workers = _cfg_workers(c.get("maxParallelWorkers"))
    end = min(max(base + 2 * max_workers, base + 19), 65535)
    ports = []
    for p in (main_port, dash_port, repro_port):
        if p not in ports:
            ports.append(p)
    for p in range(base, end + 1):
        if p not in ports:
            ports.append(p)
    return ports


# ---------------------------------------------------------------------------
# Scope-drift detection (017 review fix 3). Best-effort and fast: for each
# active worker worktree (heartbeat phase not done/failed) compare the files it
# changed (uncommitted via git status --porcelain, plus committed vs main)
# against the ticket's rd.md "## Do not touch" entries that are file paths.
# Every failure is swallowed - this must never fail the report.
# ---------------------------------------------------------------------------
SCOPE_BUDGET_SEC = 10  # whole scope-drift pass; the dashboard's manual trigger kills the script at 15s
_scope_deadline = 0.0  # absolute time.time() deadline shared by every git call below


# 073 FR-4.2 / 084 FR-2: a worktree's git config or attributes must never make git
# run a command, so every git call turns off core.fsmonitor, hooks and the global
# attributes file first, and (see _git_env) ignores the system config and attributes.
_GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
             "-c", "core.attributesFile=/dev/null"]


def _git_env(extra=None):
    """The environment of every git call (084 FR-2): system config and system
    attributes switched off; global config stays trusted."""
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_ATTR_NOSYSTEM="1")
    if extra:
        env.update(extra)
    return env


# 084 FR-3: the anomaly text of a registered worktree whose .git failed FR-1.
_UNTRUSTED_NOTE = "its .git is not a regular file pointing to its registered git dir; git not run"


def _registered_realpaths():
    """Real paths of the worktrees `git worktree list --porcelain` lists, run from
    the repo root (073 FR-4.1). None when the registry cannot be read: the caller
    then checks no worktree at all (fail closed)."""
    try:
        r = subprocess.run(
            ["git"] + _GIT_SAFE + ["worktree", "list", "--porcelain"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=8,
            env=_git_env(),
        )
    except Exception:
        return None
    if r.returncode != 0:
        return None
    paths = set()
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            try:
                paths.add(os.path.realpath(line.split(None, 1)[1].strip()))
            except Exception:
                continue
    return paths


def _common_dir():
    """Real path of the main repository's common git dir (`git rev-parse
    --git-common-dir` from the repo root), or None (084 FR-1)."""
    try:
        r = subprocess.run(
            ["git"] + _GIT_SAFE + ["rev-parse", "--git-common-dir"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=8,
            env=_git_env(),
        )
    except Exception:
        return None
    out = r.stdout.strip() if r.returncode == 0 else ""
    if not out:
        return None
    return os.path.realpath(os.path.join(str(repo_root), out))


def _trusted_worktree(common_dir, wt):
    """084 FR-1: verify a worktree against the main repository's worktree registry.

    Returns (admin dir, work tree, common dir), all real paths, only when <wt>/.git is a
    regular file (not a symlink, not a directory, not missing) of at most 4 KiB
    holding one line `gitdir: <X>`, and X (relative to the worktree when
    relative) is the registered admin dir <common dir>/worktrees/<name>/ whose
    `gitdir` file names <wt>/.git. Otherwise None, and no git runs for it. The
    caller runs git with GIT_DIR and GIT_WORK_TREE set to the returned paths, so
    a later change of <wt>/.git cannot redirect it."""
    import stat as _stat

    try:
        if not common_dir:
            return None
        wt_real = os.path.realpath(str(wt))
        gitfile = os.path.join(str(wt), ".git")
        if not _stat.S_ISREG(os.lstat(gitfile).st_mode):
            return None
        fd = os.open(gitfile, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not _stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            data = os.read(fd, 4097)
        finally:
            os.close(fd)
        if len(data) > 4096:
            return None
        text = data.decode("utf-8")
        if text.endswith("\n"):
            text = text[:-1]
        if "\n" in text or not text.startswith("gitdir: ") or len(text) == len("gitdir: "):
            return None
        target = text[len("gitdir: "):]
        if not os.path.isabs(target):
            target = os.path.join(wt_real, target)
        target_real = os.path.realpath(target)
        wt_git = os.path.join(wt_real, ".git")
        wroot = os.path.join(common_dir, "worktrees")
        found = []
        for name in sorted(os.listdir(wroot)):
            admin = os.path.join(wroot, name)
            if os.path.islink(admin) or not os.path.isdir(admin):
                continue
            try:
                with open(os.path.join(admin, "gitdir"), "r", encoding="utf-8") as fh:
                    named = fh.read(4097).strip()
            except (OSError, UnicodeDecodeError):
                continue
            if not named:
                continue
            if not os.path.isabs(named):
                named = os.path.join(admin, named)
            if os.path.realpath(named) == wt_git:
                found.append(os.path.realpath(admin))
        if len(found) != 1 or found[0] != target_real:
            return None
        return found[0], wt_real, os.path.realpath(common_dir)
    except Exception:
        return None


def _git(wt, args, timeout=8, trust=None):
    """Run git for a verified worktree under the shared module-level deadline.
    Returns (returncode, stdout); (-1, "") when the budget is exhausted, the
    worktree is not trusted (trust is None) or the call fails/times out.
    `trust` is _trusted_worktree()'s result: git gets GIT_DIR and GIT_WORK_TREE
    from it (084 FR-1) and never reads <wt>/.git. --no-optional-locks /
    GIT_OPTIONAL_LOCKS=0 keep `git status` from taking index.lock in a live
    worker's worktree."""
    if trust is None:
        return -1, ""
    remaining = _scope_deadline - time.time()
    if remaining <= 0:
        return -1, ""
    env = _git_env({"GIT_OPTIONAL_LOCKS": "0", "GIT_DIR": trust[0], "GIT_WORK_TREE": trust[1],
                    "GIT_COMMON_DIR": trust[2]})
    try:
        r = subprocess.run(
            ["git", "--no-optional-locks"] + _GIT_SAFE + args,
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=min(timeout, remaining),
            env=env,
        )
    except Exception:
        return -1, ""
    return r.returncode, r.stdout


_QUALIFIED = re.compile(r"\b(except|only|owned by)\b", re.I)


def _section(text, title):
    m = re.search(r"^##\s+" + title + r"\s*$(.*?)(?=^##\s|\Z)", text, re.M | re.S | re.I)
    return m.group(1) if m else ""


def _norm_token(tok):
    tok = tok.strip()
    return tok[2:] if tok.startswith("./") else tok


def _do_not_touch_paths(rd_path):
    """Machine-checkable file-path entries of the rd.md '## Do not touch' section.

    Conservative on purpose (a false positive makes the router tell a worker to
    revert legitimate work): a line containing 'except', 'only' or 'owned by'
    (outside parentheses) is qualified prose that cannot be checked by a script and is skipped, and any
    entry also listed (backticked) under '## Affected areas' is the ticket's own
    territory and is dropped."""
    try:
        text = rd_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return []
    dnt = _section(text, "Do not touch")
    if not dnt:
        return []
    affected = {_norm_token(t) for t in re.findall(r"`([^`\n]+)`", _section(text, "Affected areas"))}
    out = []
    for line in dnt.splitlines():
        if _QUALIFIED.search(re.sub(r"\([^)]*\)", "", line)):
            continue  # parenthetical asides such as '(print strings only)' do not qualify the paths
        # A parenthetical that says the file is an expected side effect / not a violation
        # (e.g. ticket 021's migrating config) names files that ARE allowed to change.
        line = re.sub(r"\([^)]*(?:not a violation|side effect)[^)]*\)", "", line, flags=re.I)
        for tok in re.findall(r"`([^`\n]+)`", line):
            tok = _norm_token(tok)
            if not tok or " " in tok or tok.startswith("-") or tok.startswith("http"):
                continue
            if "/" not in tok and not re.search(r"\.[A-Za-z0-9]+$", tok):
                continue  # not a file path (e.g. a bare word)
            if tok in affected:
                continue
            out.append(tok)
    return out


def _glob_regex(pattern):
    """Glob -> regex where '*' and '?' never cross '/', and '**' does."""
    i, n, res = 0, len(pattern), ""
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern[i : i + 2] == "**":
                res += ".*"
                i += 2
                continue
            res += "[^/]*"
        elif c == "?":
            res += "[^/]"
        elif c == "[":
            j = pattern.find("]", i + 2)  # a leading ']' is a literal member
            if j == -1:
                res += re.escape(c)
            else:
                body = pattern[i + 1 : j]
                if body.startswith("!"):
                    body = "^" + body[1:]  # fnmatch negation
                res += "[" + body.replace("\\", "\\\\") + "]"
                i = j
        else:
            res += re.escape(c)
        i += 1
    try:
        return re.compile(res + r"\Z")
    except re.error:
        return re.compile(re.escape(pattern) + r"\Z")  # odd entry: literal match, never raise


def _path_matches(changed, entry):
    """True when `changed` is the entry itself, lives under it, or (glob entries)
    is matched by it segment-wise, directory ancestors included."""
    if any(ch in entry for ch in "*?["):
        rx = _glob_regex(entry.rstrip("/"))
        parts = changed.split("/")
        return any(rx.match("/".join(parts[:k])) for k in range(1, len(parts) + 1))
    if entry.endswith("/"):
        return changed.startswith(entry)
    if "/" not in entry:  # bare file name such as notify.sh
        return changed == entry or changed.endswith("/" + entry)
    return changed == entry or changed.startswith(entry + "/")


def _changed_files(wt, trust=None):
    changed = set()
    # --ignore-submodules=dirty: `status` must not spawn a child git inside a gitlink; that child
    # reads sub/.git, which the worktree controls (084 review B1). The gitlink itself still shows.
    rc, out = _git(wt, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=dirty"],
                   trust=trust)
    if rc == 0:
        parts = out.split("\0")
        i = 0
        while i < len(parts):
            ent = parts[i]
            i += 1
            if len(ent) < 4:
                continue
            code, path = ent[:2], ent[3:]
            changed.add(path)
            if code[0] in "RC" or code[1] in "RC":
                i += 1  # skip the rename/copy origin entry
    for base in ("main", "origin/main"):
        rc, out = _git(wt, ["diff", "--name-only", "-z", base + "...HEAD"], trust=trust)
        if rc == 0:
            changed.update(x for x in out.split("\0") if x)
            break
    return changed


def scope_drift_anomalies():
    global _scope_deadline
    anomalies = []
    _scope_deadline = time.time() + SCOPE_BUDGET_SEC
    try:
        registered = _registered_realpaths()
        if registered is None:
            return anomalies  # 073 FR-4.1: registry unreadable, check no worktree
        common_dir = _common_dir()
        if common_dir is None:
            return anomalies  # 084 FR-1: no common git dir to verify against, check no worktree
        for p in sorted(glob.glob(str(repo_root / ".claude/worktrees/*/job/status.json"))):
            if time.time() > _scope_deadline:
                break
            try:
                f = Path(p)
                wt = f.parent.parent
                # 073 FR-4.1: git only runs in a registered, non-symlink worktree.
                if os.path.islink(str(wt)) or os.path.realpath(str(wt)) not in registered:
                    continue
                # 084 FR-1/FR-3: git runs only after <wt>/.git is verified against the
                # registry, and then only with GIT_DIR / GIT_WORK_TREE taken from it.
                trust = _trusted_worktree(common_dir, wt)
                if trust is None:
                    anomalies.append("untrusted worktree: %s - %s" % (wt, _UNTRUSTED_NOTE))
                    continue
                hb = json.loads(f.read_text(encoding="utf-8"))
                if not isinstance(hb, dict):
                    continue
                if str(hb.get("phase") or "") in ("done", "failed"):
                    continue
                ticket = str(hb.get("ticket") or "")
                if not SAFE_TICKET.match(ticket):
                    continue
                num = re.match(r"\d+", ticket)
                tid = num.group(0) if num else ticket
                rd = repo_root / "specs" / "tickets" / ticket / "rd.md"
                if not rd.is_file():
                    rd = wt / "specs" / "tickets" / ticket / "rd.md"
                entries = _do_not_touch_paths(rd)
                if not entries:
                    continue
                own = "specs/tickets/%s/" % ticket  # results.md, evidence/ ... are the ticket's own
                for changed in sorted(_changed_files(wt, trust)):
                    if changed.startswith(own):
                        continue
                    if any(_path_matches(changed, e) for e in entries):
                        anomalies.append(
                            "scope drift: %s modified %s (Do not touch)" % (tid, changed)
                        )
            except Exception:
                continue  # best-effort: one bad worktree never fails the report
    except Exception:
        pass
    return anomalies


# ---------------------------------------------------------------------------
# Reap-abort alerting (017 review fix 4; restores ticket 003 FR-7 in script
# mode). A reap "action": "abort" (salvage failed or removal failed, nothing
# destroyed) can only occur in `--reap --apply`, whose JSON report goes to the
# router's own output and is gone afterwards. The reap mode therefore records
# its abort entries in job/reap-aborts.json (see the reap block above) and this
# check folds every still-unresolved one into `anomalies` as `reap abort: ...`,
# so the scheduled report keeps flagging it until the worktree is reaped
# successfully or disappears. Best-effort: never fails the report.
# ---------------------------------------------------------------------------
def _heartbeat_age(wt):
    """Seconds since the worktree's job/status.json heartbeat file was last
    written (None if unknown). The file's modification time is the one heartbeat
    clock (ticket 061 FR-6): the writer-supplied updatedAt is never used."""
    sp = Path(wt) / "job" / "status.json"
    try:
        return max(0, now_ts - sp.stat().st_mtime)
    except Exception:
        return None


def reap_abort_anomalies(threshold_sec):
    anomalies = []
    try:
        data = json.loads((repo_root / "job" / "reap-aborts.json").read_text(encoding="utf-8"))
        entries = data.get("aborts", []) if isinstance(data, dict) else []
        for e in entries:
            if not isinstance(e, dict):
                continue
            wt = str(e.get("worktree") or "?")
            if wt != "?" and not Path(wt).exists():
                continue  # worktree is gone: nothing left to preserve or alert on
            age = _heartbeat_age(wt) if wt != "?" else None
            if age is not None and age <= threshold_sec:
                continue  # the worker is beating again: the aborted reap no longer applies
            anomalies.append(
                "reap abort: %s %s - %s"
                % (e.get("ticket") or "?", wt, e.get("reason") or "salvage failed")
            )
    except Exception:
        pass
    return anomalies


def _submitted_stamp(path):
    """The '**Submitted:** <ISO-8601>' stamp Fleet Control writes into a
    user-decision.md (None when absent, e.g. a hand-written file)."""
    try:
        with open(str(path), "r", encoding="utf-8", errors="ignore") as fh:
            m = re.search(r"^\*\*Submitted:\*\*\s*(\S+)", fh.read(), re.M)
        return m.group(1) if m else None
    except Exception:
        return None


def _forwarded_decision_keys():
    """(path, submitted) pairs the router has already forwarded, read from the
    run ledger. Best-effort: a missing/corrupt ledger means nothing is filtered."""
    keys = set()
    try:
        ledger = json.loads((repo_root / "job" / "router-state.json").read_text(encoding="utf-8"))
        for e in ledger.get("forwardedDecisions", []) if isinstance(ledger, dict) else []:
            if isinstance(e, dict) and e.get("path"):
                keys.add((str(e["path"]), e.get("submitted") or None))
    except Exception:
        pass
    return keys


def _board_statuses():
    """{ticket id: status} from specs/tickets/BOARD.md (ticket 061 FR-7)."""
    statuses = {}
    try:
        lines = (repo_root / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8").splitlines()
    except Exception:
        return statuses
    in_table = False
    for line in lines:
        t = line.strip()
        if t.startswith("|") and ("---" in t):
            in_table = True
            continue
        if in_table and t.startswith("|"):
            parts = [x.strip() for x in t.split("|")[1:-1]]
            if len(parts) >= 3 and parts[0] and parts[0] != "#":
                statuses[parts[0]] = parts[2].lower()
    return statuses


def main():
    # --- Config (same source as the reap mode): stall threshold is shared
    # by script mode and agent mode.
    threshold_sec = 900
    conf = {}
    try:
        conf = json.loads(
            (repo_root / "specs" / "worker-fleet.config.json").read_text(encoding="utf-8")
        )
        threshold_sec = int(conf.get("watchdog", {}).get("stallThresholdMinutes", 15)) * 60
    except Exception:
        pass

    anomalies = []

    # 1. Active git worktrees (human section + anomaly on failure).
    worktree_lines = []
    try:
        res = subprocess.run(
            ["git"] + _GIT_SAFE + ["worktree", "list"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            env=_git_env(),
        )
        if res.returncode == 0:
            worktree_lines = [ln for ln in res.stdout.splitlines() if ln.strip()]
        else:
            anomalies.append("git worktree list failed (exit %d)" % res.returncode)
    except Exception as e:
        anomalies.append("git worktree list failed: %s" % e)

    # 2. Worker status files: heartbeat age, stall detection, ticket id.
    #    Same file set as before: .claude/worktrees/*/job/status.json,
    #    job/status-*.json, job/status.json.
    status_files = []
    candidate_paths = []
    for pattern in (
        ".claude/worktrees/*/job/status.json",
        "job/status-*.json",
        "job/status.json",
    ):
        candidate_paths.extend(sorted(glob.glob(str(repo_root / pattern))))

    # Finished or waiting work is not a stall (ticket 061 FR-7): a heartbeat whose
    # phase is done, failed or blocked, or whose ticket is done, in-review or
    # blocked on the board, is reported with a NOTE instead of a WARNING.
    board = _board_statuses()

    stalls = []
    for p in candidate_paths:
        f = Path(p)
        try:
            rel = str(f.relative_to(repo_root))
        except ValueError:
            rel = str(f)
        try:
            mtime = f.stat().st_mtime
        except OSError:
            continue
        age = int(max(0, now_ts - mtime))
        content = ""
        data = {}
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            loaded = json.loads(content)
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            anomalies.append("status file %s is not valid JSON" % rel)
        ticket = str(data.get("ticket") or "")
        if ticket and not SAFE_TICKET.match(ticket):
            anomalies.append("status file %s has an unparseable ticket field" % rel)
            ticket = ""
        stalled = age > threshold_sec
        why = ""
        if stalled:
            phase = str(data.get("phase") or "").strip().lower()
            m = re.match(r"^(\d{3})(?:-|$)", str(data.get("ticket") or ""))
            status = board.get(m.group(1)) if m else None
            if phase in ("done", "failed", "blocked"):
                why = "heartbeat phase is '%s'" % phase
            elif status in ("done", "in-review", "blocked"):
                why = "ticket %s is '%s' on the board" % (m.group(1), status)
            if why:
                stalled = False
        # A ticket writer's heartbeat (ticket 070 FR-9) is never a stall: it has no
        # worktree to reap and no retry. Past 2 x the threshold it is a `writer stall:`
        # anomaly (the router only alerts), except while done or waiting for the user.
        if f.name.startswith("status-writer-") and f.parent == repo_root / "job":
            stalled = False
            wphase = str(data.get("phase") or "").strip().lower()
            if age > 2 * threshold_sec and wphase not in ("done", "waiting-user"):
                anomalies.append(
                    "writer stall: %s %s - no heartbeat for %ds (phase %s)"
                    % (ticket or f.stem, rel, age, wphase)
                )
        status_files.append(
            {"file": rel, "ageSec": age, "ticket": ticket, "stalled": stalled, "why": why, "content": content}
        )
        if stalled:
            stalls.append({"file": rel, "ageSec": age, "ticket": ticket})

    # 3. Mobile user-decision.md files (Fleet Control unblocks).
    #    017 review fix 6: user-decision.md files persist after the decision is
    #    forwarded, so listing every one each tick made the router re-forward
    #    them. The router records each forwarded decision in the run ledger
    #    (job/router-state.json "forwardedDecisions": [{"path","submitted"}]);
    #    `decisions` lists only files not yet recorded there (a re-answered
    #    decision has a new "**Submitted:**" stamp and so reappears).
    decisions = []
    decision_files = []
    forwarded_keys = _forwarded_decision_keys()
    tickets_dir = repo_root / "specs" / "tickets"
    if tickets_dir.is_dir():
        for d in sorted(tickets_dir.glob("*/user-decision.md")):
            if not d.is_file():
                continue
            try:
                rel = str(d.relative_to(repo_root))
            except ValueError:
                rel = str(d)
            try:
                age = int(max(0, now_ts - d.stat().st_mtime))
            except OSError:
                age = 0
            forwarded = (rel, _submitted_stamp(d)) in forwarded_keys
            if not forwarded:
                decisions.append(rel)
            decision_files.append({"file": rel, "ageSec": age, "forwarded": forwarded})

    # 4. Listening dev ports (the configured main, dashboard and reproducer
    #    ports + the configured worker pool);
    #    IPv4 or IPv6 loopback both count (see _listening above).
    ports = []
    for p in probe_port_list(conf):
        try:
            listening = _listening(p)
        except Exception as e:
            listening = False
            anomalies.append("port check failed for %d: %s" % (p, e))
        ports.append({"port": p, "listening": listening})

    # 5. Review-fix signals reported as anomaly strings (report schema unchanged).
    anomalies.extend(scope_drift_anomalies())
    anomalies.extend(reap_abort_anomalies(threshold_sec))

    ts = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    if json_mode:
        report = {
            "ts": ts,
            "stalls": stalls,
            "ports": ports,
            "decisions": decisions,
            "anomalies": anomalies,
        }
        print(json.dumps(report, indent=2))
        return

    # --- Human-readable rendering of the same data (default output) ---
    print("=== Watchdog Check at %s ===" % ts)

    print("--- Active Git Worktrees ---")
    if worktree_lines:
        for ln in worktree_lines:
            print(ln)
    else:
        print("No git worktrees listed.")

    print("--- Worker Status Files ---")
    if not status_files:
        print("No active job/status.json files found.")
    for sf in status_files:
        print("File: %s (last updated %ds ago)" % (sf["file"], sf["ageSec"]))
        if sf["content"]:
            print(sf["content"].rstrip("\n"))
        print("")
        if sf["stalled"]:
            print(
                "WARNING: %s has not updated in %ds (> %ds). Worker may be stuck or quiet."
                % (sf["file"], sf["ageSec"], threshold_sec)
            )
        elif sf["why"]:
            print(
                "NOTE: %s has not updated in %ds (> %ds) but is not a stall: %s."
                % (sf["file"], sf["ageSec"], threshold_sec, sf["why"])
            )

    print("--- User Decision Files (Fleet Control Unblocks) ---")
    if not decision_files:
        print("No user-decision.md files present.")
    for df in decision_files:
        print(
            "Found %s (updated %ds ago)%s"
            % (df["file"], df["ageSec"], " [already forwarded]" if df["forwarded"] else "")
        )

    print("--- Active Dev Server Ports ---")
    listening_ports = [p["port"] for p in ports if p["listening"]]
    if listening_ports:
        for p in listening_ports:
            print("Port :%d is LISTENING" % p)
    else:
        print("No dev ports listening.")

    if anomalies:
        print("--- Anomalies ---")
        for a in anomalies:
            print(a)


try:
    main()
except Exception:
    traceback.print_exc()
    if json_mode:
        # Never emit broken JSON: the scheduler must always be able to parse.
        print(
            json.dumps(
                {
                    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "stalls": [],
                    "ports": [],
                    "decisions": [],
                    "anomalies": ["watchdog-check internal error; see stderr"],
                },
                indent=2,
            )
        )
PY
exit 0

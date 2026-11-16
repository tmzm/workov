#!/usr/bin/env bash
# Zero-token wake watcher for the router (ticket 079).
#
# Blocks, without any model call or network access, until something the router
# must act on changes, then exits with two lines on stdout:
#   ROUTER_WAKE {"event": "wake|timeout|superseded|stopped|error", ...}
#   router-wake: <the same thing in words>
# The router starts it in the Bash tool's background mode, so the exit re-invokes
# an idle session. Three things wake it:
#   ready     a ticket id newly in the board's ready set (specs/tickets/BOARD.md);
#             off while dispatch.autoOnApprove is false in specs/worker-fleet.config.json
#   control   a new or changed job/control/*.json intent
#   decision  a new or changed specs/tickets/*/user-decision.md
# A change counts against the baseline kept in job/router-wake-state.json, so a
# change made while no watcher runs wakes the next one at once. After the first
# change it waits for 3 s of quiet (20 s at most), so a burst is one wake.
#
# Usage:
#   router-wake.sh [--timeout <seconds>] [--poll]   arm (default). --timeout is 5..86400,
#                                                   default 3600. --poll never uses inotifywait.
#   router-wake.sh --status                         print the status lines, change nothing
#   router-wake.sh --stop                           stop the running watcher, print the status lines
#   router-wake.sh --help | -h                      this text
#
# One watcher at a time: the lock is the directory job/router-wake.lock/ (file
# `pid`). A live holder is a process whose argument list is exactly
# `python3 -I - router-wake <this root> arm <timeout> <poll>`; the newest arm
# supersedes it (TERM, then KILL after 3 s) and takes over a stale lock (a dead
# pid, or a reused pid running anything else) without any signal.
#
# Exit codes: 0 for every event and for --status/--stop/--help, 1 for `error`,
# 2 for usage errors. Needs bash 3.2+ (no bash-4 features) and python3 (always
# run with -I, so nothing in the working directory is ever imported).

usage() {
  cat <<'EOF'
Usage:
  router-wake.sh [--timeout <seconds>] [--poll]
  router-wake.sh --status
  router-wake.sh --stop
  router-wake.sh --help

  --timeout <seconds>  exit with `timeout` after this long without a change
                       (a whole number from 5 to 86400, default 3600)
  --poll               never use inotifywait, poll once per second instead
  --status             print whether a watcher is running, change nothing
  --stop               stop the running watcher, then print the status
  --help, -h           print this text

Blocks until a ticket newly becomes ready, a job/control/*.json intent appears
or changes, or a specs/tickets/*/user-decision.md appears or changes. Prints
`ROUTER_WAKE {json}` and a human line, and exits 0.
EOF
}

bad_usage() {
  echo "router-wake.sh: $1" >&2
  usage >&2
  exit 2
}

MODE=arm
TIMEOUT=3600
POLL=0
SPECIAL=""
NFLAGS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)
      [ $# -ge 2 ] || bad_usage "--timeout needs a value"
      case "$2" in
        ''|*[!0-9]*) bad_usage "--timeout needs a whole number from 5 to 86400, got '$2'" ;;
      esac
      [ ${#2} -le 7 ] || bad_usage "--timeout needs a whole number from 5 to 86400, got '$2'"
      TIMEOUT=$((10#$2))
      if [ "$TIMEOUT" -lt 5 ] || [ "$TIMEOUT" -gt 86400 ]; then
        bad_usage "--timeout needs a whole number from 5 to 86400, got '$2'"
      fi
      NFLAGS=$((NFLAGS + 1))
      shift 2
      ;;
    --poll)
      POLL=1
      NFLAGS=$((NFLAGS + 1))
      shift
      ;;
    --status|--stop|--help|-h)
      [ -z "$SPECIAL" ] || bad_usage "$1 cannot be combined with $SPECIAL"
      SPECIAL="$1"
      NFLAGS=$((NFLAGS + 1))
      shift
      ;;
    *)
      bad_usage "unknown argument '$1'"
      ;;
  esac
done

if [ -n "$SPECIAL" ]; then
  [ "$NFLAGS" -eq 1 ] || bad_usage "$SPECIAL cannot be combined with another flag"
  case "$SPECIAL" in
    --help|-h) usage; exit 0 ;;
    --status) MODE=status ;;
    --stop) MODE=stop ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# One python3 -I process does the work (no process per poll).
# `python3 -I - router-wake <root> arm <timeout> <poll>` is the exact argument list the lock's identity check matches.
exec python3 -I - router-wake "$REPO_ROOT" "$MODE" "$TIMEOUT" "$POLL" <<'PY'
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time

MARK, ROOT, MODE = sys.argv[1], sys.argv[2], sys.argv[3]
TIMEOUT = int(sys.argv[4])
POLL = sys.argv[5] == "1"

JOB = os.path.join(ROOT, "job")
CONTROL = os.path.join(JOB, "control")
LOCK = os.path.join(JOB, "router-wake.lock")
STATE = os.path.join(JOB, "router-wake-state.json")
TICKETS = os.path.join(ROOT, "specs", "tickets")
BOARD = os.path.join(TICKETS, "BOARD.md")
CONFIG = os.path.join(ROOT, "specs", "worker-fleet.config.json")
# Ticket 089: the pre-rename config path. Never read; only tested for existence (FR-17).
LEGACY_CONFIG_REL = "specs/super-agent.config.json"

QUIET = 3.0       # seconds without a change before the exit
CAP = 20.0        # seconds after the first change at the latest
TICK = 0.1        # sleep slice, so a signal is handled within 0.1 s
OWN = os.getpid()
T0 = time.monotonic()

SIG = [0]         # the signal that asked us to stop
FINISHING = [False]
CHILD = [None]    # the running inotifywait, stopped by the signal handler


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def on_signal(signum, frame):
    if FINISHING[0]:
        return
    SIG[0] = signum
    child = CHILD[0]
    if child is not None:
        try:
            child.terminate()
        except Exception:
            pass


def nap(seconds):
    """Sleep in short slices; return early when a stop signal arrives."""
    end = time.monotonic() + seconds
    while not SIG[0]:
        left = end - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(TICK, left))


# ----------------------------------------------------------------- the lock
def parse_pid(text):
    """A pid is 1 to 10 ASCII digits with 1 <= value <= 2**31 - 1; anything else is None."""
    if not re.fullmatch(r"[0-9]{1,10}", text):
        return None
    value = int(text)
    return value if 1 <= value <= 2 ** 31 - 1 else None


def read_pid(directory):
    try:
        with open(os.path.join(directory, "pid"), encoding="utf-8") as fh:
            text = fh.read(64).strip()
    except (OSError, ValueError):
        return None
    return parse_pid(text)


def read_by():
    try:
        with open(os.path.join(LOCK, "superseded-by"), encoding="utf-8") as fh:
            text = fh.read(64).strip()
    except (OSError, ValueError):
        return None
    return parse_pid(text)


def pid_running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError, ValueError):
        return False
    return True


def lock_age():
    """Seconds since the lock directory last changed, or None when it is gone."""
    try:
        return time.time() - os.stat(LOCK).st_mtime
    except OSError:
        return None


PY_BASE = re.compile(r"(?i)python3?(\.[0-9]+)*")
PS_SHAPE = re.compile(r"(\S+) -I - router-wake (.+) arm ([0-9]{1,5}) ([01])")


def real_root(path):
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return None


def read_args(pid):
    """The holder's argument list, untruncated: ('argv', [..]) from /proc, ('ps', line), or None."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            raw = fh.read()
    except (OSError, ValueError):
        raw = None
    if raw:
        parts = raw.split(b"\0")
        if parts and parts[-1] == b"":
            parts.pop()
        return ("argv", [p.decode("utf-8", "surrogateescape") for p in parts])
    try:
        out = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "args="], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True, timeout=10).stdout
    except Exception:
        return None
    line = out.rstrip("\r\n")
    return ("ps", line) if line.strip() else None


def watcher_shape(args):
    """True when the argument list is exactly `python3 -I - router-wake <this root> arm <timeout> <poll>`."""
    if args is None:
        return False
    kind, value = args
    if kind == "argv":
        if len(value) != 8:
            return False
        interp, a1, a2, a3, root, mode, tmo, poll = value
    else:
        m = PS_SHAPE.fullmatch(value.strip())
        if m is None:
            return False
        interp, root, tmo, poll = m.group(1), m.group(2), m.group(3), m.group(4)
        a1, a2, a3, mode = "-I", "-", MARK, "arm"
    if not PY_BASE.fullmatch(os.path.basename(interp)):
        return False
    if (a1, a2, a3, mode) != ("-I", "-", MARK, "arm"):
        return False
    if not re.fullmatch(r"[0-9]{1,5}", tmo) or poll not in ("0", "1"):
        return False
    mine, theirs = real_root(ROOT), real_root(root)
    return mine is not None and mine == theirs


def is_watcher(pid):
    """A live holder: the PID runs and its argument list is exactly the arm-mode watcher's own."""
    if pid == OWN:
        return True
    if not pid_running(pid):
        return False
    return watcher_shape(read_args(pid))


def write_file_atomic(path, text):
    tmp = os.path.join(os.path.dirname(path), ".%s.%d.tmp" % (os.path.basename(path), OWN))
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def remove_lock():
    shutil.rmtree(LOCK, ignore_errors=True)


def release():
    if read_pid(LOCK) == OWN:
        remove_lock()


def supersede(pid):
    """Ask the live holder to give way: TERM, wait 3 s, then KILL."""
    try:
        write_file_atomic(os.path.join(LOCK, "superseded-by"), "%d\n" % OWN)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as exc:
        raise RuntimeError("cannot signal the lock holder (pid %d): %s" % (pid, exc))
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not SIG[0]:
        if not os.path.isdir(LOCK) or not pid_running(pid):
            break
        time.sleep(0.01)            # fine slices: the new watcher takes the lock right after the old one lets go
    if SIG[0]:
        return                      # we were asked to stop ourselves: leave the holder alone
    if os.path.isdir(LOCK):
        if is_watcher(pid) and pid_running(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            end = time.monotonic() + 1.0
            while time.monotonic() < end and pid_running(pid) and is_watcher(pid):
                time.sleep(0.05)
        # Remove only the lock we signalled: a racing arm may have taken a fresh one meanwhile.
        # A lock without a readable pid counts as ours only once it is at least 2 s old.
        now_pid = read_pid(LOCK)
        age = lock_age()
        if now_pid == pid or (now_pid is None and age is not None and age >= 2.0):
            remove_lock()


def acquire():
    """Take the lock. Returns None when taken, 'stop' on a signal, else an error text."""
    tries = 0
    while tries < 12:
        if SIG[0]:
            return "stop"
        tries += 1
        try:
            os.mkdir(LOCK)
        except FileExistsError:
            pass
        except OSError as exc:
            return "cannot create %s: %s" % (LOCK, exc)
        else:
            try:
                write_file_atomic(os.path.join(LOCK, "pid"), "%d\n" % OWN)
            except OSError as exc:
                remove_lock()
                return "cannot write the lock pid file: %s" % exc
            return None
        pid = read_pid(LOCK)
        if pid is not None:
            if pid != OWN and is_watcher(pid):
                try:
                    supersede(pid)
                except RuntimeError as exc:
                    return str(exc)
            else:
                # Stale: a dead pid or a reused one. Taken over without any signal.
                if read_pid(LOCK) == pid:
                    remove_lock()
            continue
        try:
            age = time.time() - os.stat(LOCK).st_mtime
        except OSError:
            continue
        if age >= 2.0:
            remove_lock()          # missing or unparseable pid in an old lock: stale
        else:
            nap(0.3)               # a watcher that is starting right now: wait and retry
    return "could not take the lock after %d tries" % tries


# ------------------------------------------------------------ status / stop
def status_lines(pid):
    obj = {"event": "status", "running": pid is not None, "pid": pid}
    human = "running (pid %d)" % pid if pid is not None else "not running"
    sys.stdout.write("ROUTER_WAKE " + json.dumps(obj) + "\nrouter-wake: " + human + "\n")
    sys.stdout.flush()


def holder_pid():
    pid = read_pid(LOCK)
    if pid is not None and is_watcher(pid):
        return pid
    return None


if MODE == "status":
    status_lines(holder_pid())
    sys.exit(0)

if MODE == "stop":
    pid = holder_pid()
    if pid is not None:
        if read_by() is None:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            if holder_pid() != pid or not os.path.isdir(LOCK):
                break
            time.sleep(0.05)
    status_lines(holder_pid())
    sys.exit(0)


# ------------------------------------------------------------------ arm mode
def board_ready():
    try:
        with open(BOARD, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return set()
    ready = set()
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", s.strip("|"))]
        if len(cells) >= 3 and re.fullmatch(r"[0-9]+", cells[0]) and cells[2].lower() == "ready":
            ready.add(cells[0])
    return ready


def file_sig(path):
    try:
        st = os.stat(path)
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return None
    return "%d-%d-%s" % (st.st_size, st.st_mtime_ns, digest)


def snapshot():
    control = {}
    try:
        for entry in os.scandir(CONTROL):
            if entry.name.startswith(".") or not entry.name.endswith(".json") or not entry.is_file():
                continue
            sig = file_sig(entry.path)
            if sig:
                control[entry.name] = sig
    except OSError:
        pass
    decisions = {}
    try:
        for entry in os.scandir(TICKETS):
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            sig = file_sig(os.path.join(entry.path, "user-decision.md"))
            if sig:
                decisions["specs/tickets/%s/user-decision.md" % entry.name] = sig
    except OSError:
        pass
    return {"ready": sorted(board_ready()), "control": control, "decisions": decisions}


def auto_on_approve():
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            cfg = json.load(fh)
        return not (isinstance(cfg, dict) and isinstance(cfg.get("dispatch"), dict)
                    and cfg["dispatch"].get("autoOnApprove") is False)
    except Exception:
        return True


def valid_baseline(data):
    return (isinstance(data, dict)
            and isinstance(data.get("ready"), list) and all(isinstance(x, str) for x in data["ready"])
            and isinstance(data.get("control"), dict) and all(isinstance(v, str) for v in data["control"].values())
            and isinstance(data.get("decisions"), dict) and all(isinstance(v, str) for v in data["decisions"].values()))


def load_baseline():
    """Returns (baseline, had_state_file)."""
    try:
        with open(STATE, encoding="utf-8") as fh:
            data = json.load(fh)
        if valid_baseline(data):
            return ({"ready": sorted(data["ready"]), "control": dict(data["control"]),
                     "decisions": dict(data["decisions"])}, True)
    except Exception:
        pass
    return snapshot(), False


def changes(cur, base, auto):
    ready = sorted(set(cur["ready"]) - set(base["ready"])) if auto else []
    control = sorted(n for n, s in cur["control"].items() if base["control"].get(n) != s)
    decisions = sorted(p for p, s in cur["decisions"].items() if base["decisions"].get(p) != s)
    return ready, control, decisions


def change_key(cur, auto):
    return (cur["ready"] if auto else None, cur["control"], cur["decisions"])


def write_state(baseline, last):
    data = {"savedAt": utc_now(), "ready": sorted(baseline["ready"]), "control": baseline["control"],
            "decisions": baseline["decisions"], "last": last}
    tmp = os.path.join(JOB, ".router-wake-state.json.%d.tmp" % OWN)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, STATE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def words(event, obj):
    if event == "wake":
        parts = []
        if obj["ready"]:
            parts.append("ready " + ", ".join(obj["ready"]))
        if obj["control"]:
            parts.append("control " + ", ".join(obj["control"]))
        if obj["decisions"]:
            parts.append("decision " + ", ".join(obj["decisions"]))
        return "woke after %ds: %s" % (obj["waitedSec"], "; ".join(parts))
    if event == "timeout":
        return "timeout after %ds, nothing changed" % obj["waitedSec"]
    if event == "superseded":
        return "superseded by a newer watcher (pid %s)" % obj.get("by")
    if event == "stopped":
        return "stopped"
    return "error: %s" % obj.get("message")


def arm():
    mechanism = "inotify" if (not POLL and shutil.which("inotifywait")) else "poll"
    state = {"held": False, "base": None, "had": False, "cur": None}

    def line_one(event, ready=(), control=(), decisions=(), by=None, message=None):
        reasons = []
        if ready:
            reasons.append("ready")
        if control:
            reasons.append("control")
        if decisions:
            reasons.append("decision")
        obj = {"event": event, "reasons": reasons, "ready": list(ready), "control": list(control),
               "decisions": list(decisions), "waitedSec": int(time.monotonic() - T0), "pid": OWN,
               "mechanism": mechanism, "at": utc_now()}
        if by is not None:
            obj["by"] = by
        if message is not None:
            obj["message"] = message
        return obj

    def finish(event, baseline=None, **kw):
        """Print the two lines, save the state, release the lock, exit."""
        FINISHING[0] = True
        obj = line_one(event, **kw)
        if state["held"]:
            keep = baseline if baseline is not None else (state["base"] or {"ready": [], "control": {}, "decisions": {}})
            write_state(keep, obj)
            release()
        try:
            sys.stdout.write("ROUTER_WAKE " + json.dumps(obj) + "\nrouter-wake: " + words(event, obj) + "\n")
            sys.stdout.flush()
        except (OSError, ValueError):
            pass
        sys.exit(1 if event == "error" else 0)

    def stop_event():
        by = read_by()
        if by is not None and by != OWN:
            finish("superseded", by=by)
        finish("stopped")

    try:
        # Ticket 089, FR-17: a legacy-only config would make auto_on_approve() fall back to its
        # default. Refuse at once, before the lock is taken or any directory is created.
        if not os.path.lexists(CONFIG) and os.path.lexists(os.path.join(ROOT, LEGACY_CONFIG_REL)):
            finish("error", message="specs/worker-fleet.config.json is missing but %s exists, and that file is "
                   "no longer read. Run python3 .claude/scripts/apply-setup.py to migrate it." % LEGACY_CONFIG_REL)
        try:
            os.makedirs(CONTROL, exist_ok=True)
        except OSError as exc:
            finish("error", message="cannot create %s: %s" % (CONTROL, exc))
        got = acquire()
        if got == "stop":
            finish("stopped")
        if got is not None:
            finish("error", message=got)
        state["held"] = True
        base, had = load_baseline()
        state["base"], state["had"] = base, had
        auto = auto_on_approve()

        cur = snapshot()
        prev_key = change_key(cur, auto)
        first = last = None
        if any(changes(cur, base, auto)):
            first = last = time.monotonic()

        while True:
            if SIG[0]:
                stop_event()
            lock_pid = read_pid(LOCK)
            if lock_pid != OWN:
                if lock_pid is None and not os.path.isdir(LOCK):
                    try:
                        os.mkdir(LOCK)
                        write_file_atomic(os.path.join(LOCK, "pid"), "%d\n" % OWN)
                    except OSError:
                        pass
                    lock_pid = read_pid(LOCK)
                if lock_pid is not None and lock_pid != OWN:
                    state["held"] = False      # the lock is someone else's now: leave it alone
                    finish("superseded", by=lock_pid)
            now = time.monotonic()
            if first is not None:
                if now - last >= QUIET or now - first >= CAP:
                    ready, control, decisions = changes(cur, base, auto)
                    if ready or control or decisions:
                        finish("wake", baseline=cur, ready=ready, control=control, decisions=decisions)
                    first = last = None        # the change was undone meanwhile
            elif now - T0 >= TIMEOUT:
                finish("timeout", baseline=cur)
            # wait for the next look
            if first is not None:
                budget = min(QUIET - (now - last), CAP - (now - first))
            else:
                budget = TIMEOUT - (now - T0)
            budget = max(0.05, budget)
            if mechanism == "inotify" and budget >= 1.0:
                begun = time.monotonic()
                try:
                    secs = max(1, min(2, int(math.floor(budget))))
                    child = subprocess.Popen(
                        ["inotifywait", "-q", "-r", "-t", str(secs), "-e", "close_write,moved_to,create",
                         TICKETS, CONTROL],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    CHILD[0] = child
                    if SIG[0]:
                        child.terminate()
                    while child.poll() is None:
                        time.sleep(TICK)
                    CHILD[0] = None
                    rc = child.returncode
                except OSError:
                    CHILD[0] = None
                    rc = 1
                spent = time.monotonic() - begun
                if rc not in (0, 2) and not SIG[0]:
                    nap(max(0.0, 1.0 - spent))     # inotifywait failed: do not spin
                elif rc == 0 and spent < 0.2:
                    nap(0.2 - spent)               # an event storm must not become a busy loop
            else:
                nap(min(budget, 1.0))
            if SIG[0]:
                continue
            cur = snapshot()
            key = change_key(cur, auto)
            if key != prev_key:
                prev_key = key
                if any(changes(cur, base, auto)):
                    stamp = time.monotonic()
                    if first is None:
                        first = stamp
                    last = stamp
    except SystemExit:
        raise
    except Exception as exc:
        finish("error", message="%s: %s" % (type(exc).__name__, exc))


for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(_sig, on_signal)
arm()
PY

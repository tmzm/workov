#!/usr/bin/env bash
# start-dashboard.sh: Launches the worker-fleet Fleet Control Server (:3080 by default)
# and establishes a secure tunnel via Cloudflare Tunnel (cloudflared) or ngrok.
# Several projects can each run their own dashboard (ticket 051): the script asks
# whoever holds the port who they are (GET /api/identity), reuses only its own
# project's server, and otherwise moves to the next free port and saves it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
usage: bash .claude/scripts/start-dashboard.sh [--port <port>] [--tunnel cloudflared|ngrok|local] [--stop] [--help]

  --port <port>        the dashboard port. Default: dashboard.port in specs/worker-fleet.config.json, else 3080.
                       If another process holds that port, the next free port is used and saved to the config.
                       An explicit --port is never changed: the start fails if it is taken.
  --tunnel <provider>  cloudflared, ngrok or local. cloudflared and ngrok open a PUBLIC tunnel.
                       Default: dashboard.tunnel.provider in specs/worker-fleet.config.json, else cloudflared.
  --stop               stop this project's dashboard server and the tunnels recorded in job/*.pid.
  -h, --help           print this help and exit.
USAGE
}

usage_error() {
  echo "start-dashboard.sh: error: $1" >&2
  usage >&2
  exit 2
}

# Parse every argument before any side effect (no job/ dir, config or token
# read, server or tunnel). --help / -h anywhere wins and starts nothing.
for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    usage
    exit 0
  fi
done

STOP=0
ARG_PORT=""
ARG_PROVIDER=""
HAVE_PORT=0
HAVE_PROVIDER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stop)
      STOP=1
      shift
      ;;
    --tunnel)
      [[ $# -ge 2 ]] || usage_error "--tunnel needs a value"
      ARG_PROVIDER="$2"
      HAVE_PROVIDER=1
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || usage_error "--port needs a value"
      ARG_PORT="$2"
      HAVE_PORT=1
      shift 2
      ;;
    *)
      usage_error "unknown option: $1"
      ;;
  esac
done

JOB_DIR="$REPO_ROOT/job"
mkdir -p "$JOB_DIR"

CONFIG_FILE="$REPO_ROOT/specs/worker-fleet.config.json"
# Ticket 089: the pre-rename config path. It is never read; it is only tested for
# existence, to refuse a start that would otherwise run on defaults (FR-17).
LEGACY_CONFIG_FILE="$REPO_ROOT/specs/super-agent.config.json"
PORT="3080"
PROVIDER="cloudflared"
AUTH_FILE="$JOB_DIR/dashboard-auth.json"
AUTH_TOKEN=""

# A config that exists but cannot be read (not valid JSON, or the top level,
# "dashboard" or "dashboard.tunnel" is not an object) sets CONFIG_BAD; the start
# refuses below, after the --stop block. A port or provider string holding a
# control character (Unicode Cc: newline, NUL, tab, ESC, ...) cannot be split
# safely from the two-line output, so the program exits 3 and prints the key;
# that sets CONFIG_CTRL_KEY and the start refuses the same way. The file path is
# an argument, never part of the Python source.
CONFIG_BAD=0
CONFIG_CTRL_KEY=""
if [ -f "$CONFIG_FILE" ]; then
  if CONFIG_OUT="$(python3 -I -c '
import json, sys, unicodedata
with open(sys.argv[1], encoding="utf-8") as f:
    cfg = json.load(f)
if not isinstance(cfg, dict):
    sys.exit(1)
dash = cfg.get("dashboard", {})
if not isinstance(dash, dict):
    sys.exit(1)
tun = dash.get("tunnel", {})
if not isinstance(tun, dict):
    sys.exit(1)
port = dash.get("port", 3080)
provider = tun.get("provider", "cloudflared")
for key, val in (("dashboard.port", port), ("dashboard.tunnel.provider", provider)):
    if isinstance(val, str) and any(unicodedata.category(ch) == "Cc" for ch in val):
        print(key)
        sys.exit(3)
print(port)
print(provider)
' "$CONFIG_FILE" 2>/dev/null)"; then
    PORT="${CONFIG_OUT%%$'\n'*}"
    PROVIDER=""
    case "$CONFIG_OUT" in
      *$'\n'*) PROVIDER="${CONFIG_OUT#*$'\n'}" ;;
    esac
  else
    CONFIG_RC=$?
    if [ "$CONFIG_RC" -eq 3 ] && { [ "$CONFIG_OUT" = "dashboard.port" ] || [ "$CONFIG_OUT" = "dashboard.tunnel.provider" ]; }; then
      CONFIG_CTRL_KEY="$CONFIG_OUT"
    else
      CONFIG_BAD=1
    fi
  fi
fi

# An explicit --port / --tunnel overrides the config value.
[ "$HAVE_PORT" -eq 0 ] || PORT="$ARG_PORT"
[ "$HAVE_PROVIDER" -eq 0 ] || PROVIDER="$ARG_PROVIDER"

# The dashboard auth token's single source is the gitignored
# job/dashboard-auth.json (written by apply-setup.py, or by this script after
# every refusal when it holds no usable token: see the token block below). The
# tracked specs/worker-fleet.config.json never carries the token.
if [ -f "$AUTH_FILE" ]; then
  AUTH_TOKEN=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("authToken", ""))' "$AUTH_FILE" 2>/dev/null || echo "")
fi

# ---------------------------------------------------------------------------
# Ticket 051: several projects, one dashboard each. This helper answers who
# holds a port (GET /api/identity, else this project's own pid file), picks the
# next free port, saves it to this project's config, and compares process
# command lines. It only ever reads other processes; it never signals one.
read -r -d '' SD_PY <<'PYEOF' || true
import json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.request


def listening(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", int(port))) == 0
    finally:
        s.close()


def fetch_identity(port, timeout=2):
    # Direct connection, no proxy; any failure means "no identity".
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open("http://127.0.0.1:%d/api/identity" % int(port), timeout=timeout) as r:
            if r.status != 200:
                return None
            doc = json.loads(r.read(65536).decode("utf-8"))
        return doc if isinstance(doc, dict) else None
    except Exception:
        return None


def same_root(a, b):
    return isinstance(a, str) and bool(a) and os.path.realpath(a) == os.path.realpath(b)


def clean(v):
    return re.sub(r"[\x00-\x1f\x7f]", "?", str(v))


def ps_args(pid):
    try:
        pid = int(pid)
        if pid <= 0:
            return ""
        r = subprocess.run(["ps", "-ww", "-o", "args=", "-p", str(pid)], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5)
        return r.stdout.strip()
    except Exception:
        return ""


def runs_server(args, root):
    # The command line names THIS project's dashboard-server.py as a whole path.
    path = re.escape(root + "/.claude/scripts/dashboard-server.py")
    return re.search(r"(?<!\S)" + path + r"(?!\S)", args) is not None


def proc_listen_pids(port, deadline):
    # Linux without lsof: /proc/net/tcp{,6} sockets in LISTEN state on the port,
    # matched to pids through the /proc/<pid>/fd/* socket:[inode] links.
    links = set()
    for name in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(name, "r", encoding="utf-8") as f:
                next(f, None)
                for line in f:
                    parts = line.split()
                    if len(parts) > 9 and parts[3] == "0A" and int(parts[1].rsplit(":", 1)[1], 16) == port:
                        links.add("socket:[%s]" % parts[9])
        except Exception:
            pass
    pids = []
    if not links:
        return pids
    try:
        entries = os.listdir("/proc")
    except Exception:
        return pids
    for ent in entries:
        if time.time() > deadline:
            break
        if not ent.isdigit():
            continue
        try:
            for fd in os.listdir("/proc/%s/fd" % ent):
                try:
                    if os.readlink("/proc/%s/fd/%s" % (ent, fd)) in links:
                        pids.append(int(ent))
                        break
                except Exception:
                    pass
        except Exception:
            pass
    return pids


def listen_pids(port):
    # The pids holding a listening TCP socket on the port; any failure means none.
    port = int(port)
    deadline = time.time() + 5
    pids = []
    if shutil.which("lsof"):
        try:
            r = subprocess.run(["lsof", "-nP", "-t", "-iTCP:%d" % port, "-sTCP:LISTEN"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5)
            pids = [int(x) for x in r.stdout.split() if x.isdigit()]
        except Exception:
            pids = []
    if not pids:
        pids = proc_listen_pids(port, deadline)
    seen = []
    for p in pids:
        if p not in seen:
            seen.append(p)
    return seen


def cmd_holder(port, root, pidfile):
    port = int(port)
    if not listening(port):
        print("free")
        return
    ident = fetch_identity(port)
    if ident and ident.get("app") == "worker-fleet" and isinstance(ident.get("root"), str):
        if same_root(ident["root"], root):
            print("own")
            return
        print("agent")
        print("the worker-fleet dashboard of project '%s' (%s)" % (clean(ident.get("project", "?")), clean(ident["root"])))
        return
    # A server started before ticket 051 has no /api/identity: fall back to the pid file.
    try:
        with open(pidfile, "r", encoding="utf-8") as f:
            pid = int(f.read().strip())
        args = ps_args(pid)
        if runs_server(args, root) and re.search(r"(?<!\S)--port(?:\s+|=)%d(?!\S)" % port, args):
            print("own")
            return
    except Exception:
        pass
    # A slow or paused server answers neither: the process that listens on the port
    # decides, with the same command-line test as the pid-file fallback.
    for pid in listen_pids(port):
        args = ps_args(pid)
        if runs_server(args, root) and re.search(r"(?<!\S)--port(?:\s+|=)%d(?!\S)" % port, args):
            print("own")
            print("listener %d" % pid)
            return
    print("other")
    print("a process that is not this project's dashboard")


def cmd_pick(port, config):
    port = int(port)

    def num(v, d):
        try:
            return int(v)
        except Exception:
            return d

    try:
        with open(config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    conc = cfg.get("concurrency") if isinstance(cfg, dict) else None
    conc = conc if isinstance(conc, dict) else {}
    reserved = {num(conc.get("mainPort"), 3000), num(conc.get("reproducerPort"), 3090)}
    base = num(conc.get("workerBasePort"), 3101)
    reserved.update(range(base, base + max(num(conc.get("maxParallelWorkers"), 8), 0)))
    for cand in range(port + 1, port + 11):
        if cand > 65535:
            break
        if cand in reserved or listening(cand):
            continue
        print(cand)
        return


def cmd_save(port, config):
    tmp = None
    try:
        with open(config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            raise ValueError("the config root is not a JSON object")
        for section, key in (("dashboard", "port"), ("concurrency", "dashboardPort")):
            if section not in cfg:
                cfg[section] = {}
            if not isinstance(cfg[section], dict):
                raise ValueError("%s is not an object" % section)
            cfg[section][key] = int(port)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(config), prefix=".worker-fleet.config.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        shutil.copymode(config, tmp)
        os.replace(tmp, config)
        tmp = None
    except Exception as exc:
        print(clean(exc).replace("\n", " "))
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass
        sys.exit(1)


def cmd_await(port, root, seconds):
    end = time.time() + float(seconds)
    while True:
        ident = fetch_identity(port, 1)
        if ident and ident.get("app") == "worker-fleet" and same_root(ident.get("root"), root):
            return
        if time.time() >= end:
            sys.exit(1)
        time.sleep(0.2)


def cmd_identity(port, root):
    ident = fetch_identity(port, 2)
    if ident and ident.get("app") == "worker-fleet" and same_root(ident.get("root"), root):
        print(clean(ident.get("project", "")))
        print(clean(ident["root"]))


def cmd_cmdmatch(pid, root):
    sys.exit(0 if runs_server(ps_args(pid), root) else 1)


def usable_token(doc):
    # get_auth_token()'s rule: a string that is non-empty after stripping whitespace.
    return isinstance(doc, dict) and isinstance(doc.get("authToken"), str) and bool(doc["authToken"].strip())


def cmd_token(auth_file, port, config):
    # Prints "ok" for a usable token (nothing written) or "written" after writing a
    # new one; on failure prints the reason and exits 1. The config is only read.
    tmp = None
    try:
        doc = None
        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except Exception:
            doc = None
        if usable_token(doc):
            print("ok")
            return
        remote = True
        try:
            with open(config, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            val = cfg.get("dashboard", {}).get("allowRemoteActions")
            if isinstance(val, bool):
                remote = val
        except Exception:
            pass
        token = secrets.token_hex(16)
        if isinstance(doc, dict):
            doc["authToken"] = token
        else:
            doc = {"authToken": token, "dashboardPort": int(port), "allowRemoteActions": remote}
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(auth_file), prefix=".dashboard-auth.", suffix=".tmp")
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
        os.replace(tmp, auth_file)
        tmp = None
        print("written")
    except Exception as exc:
        print(clean(getattr(exc, "strerror", None) or exc).replace("\n", " "))
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass
        sys.exit(1)


TUNNEL_RES = {
    "cloudflared": re.compile(r"(?<!\S)(?:\S*/)?cloudflared\s+tunnel\s+--url\s+http://127\.0\.0\.1:(\d+)(?!\S)"),
    "ngrok": re.compile(r"(?<!\S)(?:\S*/)?ngrok\s+http\s+(\d+)(?!\S)"),
}


def proc_cwd(pid):
    if os.path.isdir("/proc/%d" % pid):
        try:
            return os.readlink("/proc/%d/cwd" % pid)
        except Exception:
            return None
    try:
        r = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5)
        for line in r.stdout.splitlines():
            if line.startswith("n"):
                return line[1:]
    except Exception:
        pass
    return None


def cmd_tunnel(kind, pid, root):
    # Prints the port and exits 0 when the pid is THIS project's tunnel of that kind
    # (command line and working directory); otherwise prints nothing and exits 1.
    # It never signals anything.
    try:
        pid = int(pid)
        m = TUNNEL_RES[kind].search(ps_args(pid)) if pid > 0 else None
        if m and same_root(proc_cwd(pid), root):
            print(m.group(1))
            return
    except Exception:
        pass
    sys.exit(1)


def cmd_ngrokurl(log, port):
    # The public URL of THIS agent: the last "started tunnel" line for :<port>.
    url = ""
    try:
        with open(log, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if 'msg="started tunnel"' not in line:
                    continue
                addr = re.search(r'(?<!\S)addr=("?)([^"\s]*)\1', line)
                if not addr or not re.search(r":%d/?$" % int(port), addr.group(2)):
                    continue
                u = re.search(r'(?<!\S)url=("?)([^"\s]*)\1', line)
                val = u.group(2) if u else ""
                url = val if re.fullmatch(r"https://[A-Za-z0-9.-]+", val) else ""
    except Exception:
        url = ""
    if url:
        print(url)


COMMANDS = {"holder": cmd_holder, "pick": cmd_pick, "save": cmd_save, "await": cmd_await,
            "identity": cmd_identity, "cmdmatch": cmd_cmdmatch, "token": cmd_token,
            "tunnel": cmd_tunnel, "ngrokurl": cmd_ngrokurl}
COMMANDS[sys.argv[1]](*sys.argv[2:])
PYEOF

sd_py() { python3 -I -c "$SD_PY" "$@"; }

# The running pid recorded in job/<kind>.pid, or nothing (missing, non-numeric,
# zero or not running).
tunnel_pid() {
  local raw=""
  [ -f "$JOB_DIR/$1.pid" ] || return 0
  raw="$(cat "$JOB_DIR/$1.pid" 2>/dev/null || true)"
  raw="${raw//[[:space:]]/}"
  [[ "$raw" =~ ^0*[1-9][0-9]{0,8}$ ]] || return 0
  raw="$((10#$raw))"
  if kill -0 "$raw" 2>/dev/null; then echo "$raw"; fi
}

# --stop: signal job/<kind>.pid only when it is THIS project's tunnel of that kind.
stop_tunnel() {
  local kind="$1" pid=""
  [ -f "$JOB_DIR/$kind.pid" ] || return 0
  pid="$(tunnel_pid "$kind")"
  if [ -n "$pid" ]; then
    if sd_py tunnel "$kind" "$pid" "$REPO_ROOT" >/dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
    else
      echo "Notice: job/$kind.pid (pid $pid) is not this project's $kind tunnel; not stopping it."
    fi
  fi
  rm -f "$JOB_DIR/$kind.pid"
}

# Start: TUNNEL_REUSE=1 only for this project's running tunnel of that kind for $2.
# This project's tunnel for another port is stopped; another project's is left alone.
tunnel_check() {
  local kind="$1" port="$2" pid="" old="" n=0
  TUNNEL_REUSE=0
  pid="$(tunnel_pid "$kind")"
  [ -n "$pid" ] || return 0
  if old="$(sd_py tunnel "$kind" "$pid" "$REPO_ROOT" 2>/dev/null)"; then
    if [ "$old" = "$port" ]; then
      TUNNEL_REUSE=1
      return 0
    fi
    echo "Notice: this project's $kind tunnel (pid $pid) pointed at :$old; starting a new one for :$port."
    kill "$pid" 2>/dev/null || true
    while [ "$n" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1
      n=$((n + 1))
    done
  else
    echo "Notice: job/$kind.pid (pid $pid) is not this project's $kind tunnel; starting a new one."
  fi
  return 0
}

if [ "$STOP" -eq 1 ]; then
  echo "Stopping Fleet Control Dashboard services..."
  if [ -f "$JOB_DIR/dashboard-server.pid" ]; then
    OLD_PID="$(cat "$JOB_DIR/dashboard-server.pid" 2>/dev/null || true)"
    OLD_PID="${OLD_PID//[[:space:]]/}"
    # Only signal the pid when its command line is THIS project's dashboard-server.py.
    if [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
      if sd_py cmdmatch "$OLD_PID" "$REPO_ROOT" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
      else
        echo "Notice: job/dashboard-server.pid (pid $OLD_PID) is not this project's dashboard server; not stopping it."
      fi
    fi
    rm -f "$JOB_DIR/dashboard-server.pid"
  fi
  stop_tunnel cloudflared
  stop_tunnel ngrok
  echo "✔ Dashboard and tunnels stopped."
  exit 0
fi

# A legacy-only config (the new file is missing, the old one exists, whatever it
# is) must not start the dashboard on defaults such as allowRemoteActions=true and
# the default tunnel: refuse, whatever --port or --tunnel say. --stop already ran.
if [ ! -e "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] && { [ -e "$LEGACY_CONFIG_FILE" ] || [ -L "$LEGACY_CONFIG_FILE" ]; }; then
  echo "start-dashboard.sh: error: specs/worker-fleet.config.json is missing but ${LEGACY_CONFIG_FILE#"$REPO_ROOT"/} exists, and that file is no longer read. Run python3 .claude/scripts/apply-setup.py to migrate it. Nothing was started." >&2
  exit 1
fi

# An unreadable config means the port and the tunnel provider are unknown: stop
# here, before the holder check, the token block, the server and any tunnel.
if [ "$CONFIG_BAD" -eq 1 ]; then
  echo "start-dashboard.sh: error: cannot read the dashboard settings in specs/worker-fleet.config.json (it is not valid JSON, or the file, \"dashboard\" or \"dashboard.tunnel\" is not an object). Nothing was started." >&2
  exit 1
fi

# A control character in the port or the provider: refuse the same way.
if [ -n "$CONFIG_CTRL_KEY" ]; then
  echo "start-dashboard.sh: error: cannot read the dashboard settings in specs/worker-fleet.config.json ($CONFIG_CTRL_KEY contains a control character such as a newline or a tab). Nothing was started." >&2
  exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$((10#$PORT))" -lt 1 ] || [ "$((10#$PORT))" -gt 65535 ]; then
  usage_error "invalid port: $PORT"
fi
PORT="$((10#$PORT))"

# Who holds the port? free | own (this project's dashboard) | agent (another
# worker-fleet dashboard) | other (anything else).
HOLDER_OUT="$(sd_py holder "$PORT" "$REPO_ROOT" "$JOB_DIR/dashboard-server.pid" 2>/dev/null || true)"
HOLDER_KIND="${HOLDER_OUT%%$'\n'*}"
HOLDER_DESC="a process that is not this project's dashboard"
case "$HOLDER_OUT" in
  *$'\n'*) HOLDER_DESC="${HOLDER_OUT#*$'\n'}" ;;
esac
[ -n "$HOLDER_KIND" ] || HOLDER_KIND="other"

START_SERVER=0
MOVED=0
case "$HOLDER_KIND" in
  free)
    START_SERVER=1
    ;;
  own)
    case "$HOLDER_OUT" in
      own$'\n'listener\ *)
        # Found by its listening process (it did not answer /api/identity): record it.
        LISTENER_PID="${HOLDER_OUT#*$'\n'listener }"
        LISTENER_PID="${LISTENER_PID%%[!0-9]*}"
        echo "Notice: this project's dashboard server (pid $LISTENER_PID) holds :$PORT but did not answer /api/identity; reusing it."
        ;;
    esac
    echo "✔ Dashboard server already running on port :$PORT."
    ;;
  *)
    if [ "$HAVE_PORT" -eq 1 ]; then
      echo "start-dashboard.sh: error: port $PORT is in use by $HOLDER_DESC. Pick another --port, or omit --port to let start-dashboard.sh choose a free one." >&2
      exit 1
    fi
    NEW_PORT="$(sd_py pick "$PORT" "$CONFIG_FILE" 2>/dev/null || true)"
    if ! [[ "$NEW_PORT" =~ ^[0-9]+$ ]]; then
      echo "start-dashboard.sh: error: port $PORT is in use by $HOLDER_DESC, and no free port was found in $((PORT + 1))-$((PORT + 10)). Free a port or pass --port <port>." >&2
      exit 1
    fi
    echo "Port $PORT is in use by $HOLDER_DESC. Starting this project's dashboard on :$NEW_PORT instead."
    PORT="$NEW_PORT"
    MOVED=1
    START_SERVER=1
    ;;
esac

# A usable token (non-empty after stripping whitespace, the server's own rule) must
# exist before anything starts: nothing else is written, and no token means no start.
if ! TOKEN_RES="$(sd_py token "$AUTH_FILE" "$PORT" "$CONFIG_FILE")"; then
  echo "start-dashboard.sh: error: could not write the dashboard auth token to job/dashboard-auth.json: ${TOKEN_RES:-unknown error}. Run: python3 .claude/scripts/apply-setup.py" >&2
  exit 1
fi
if [ "$TOKEN_RES" = "written" ]; then
  AUTH_TOKEN=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("authToken", ""))' "$AUTH_FILE" 2>/dev/null || echo "")
  echo "Generated a dashboard auth token in job/dashboard-auth.json."
fi

# The reused server found by its listening process: record it only now, so a refused
# token write leaves no pid file behind (the next --stop then works).
if [ -n "${LISTENER_PID:-}" ]; then
  echo "$LISTENER_PID" > "$JOB_DIR/dashboard-server.pid"
fi

if [ "$START_SERVER" -eq 1 ]; then
  echo "Starting Fleet Control Dashboard server on :$PORT..."
  nohup python3 "$REPO_ROOT/.claude/scripts/dashboard-server.py" --port "$PORT" > "$JOB_DIR/dashboard-server.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$JOB_DIR/dashboard-server.pid"

  # Only /api/identity naming this project's root counts as started (a server
  # that lost a race for the port exits, and another process may now hold it).
  if ! sd_py await "$PORT" "$REPO_ROOT" 10 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    rm -f "$JOB_DIR/dashboard-server.pid"
    echo "start-dashboard.sh: error: the dashboard server did not start on :$PORT; see job/dashboard-server.log" >&2
    exit 1
  fi

  if [ "$MOVED" -eq 1 ]; then
    if SAVE_ERR="$(sd_py save "$PORT" "$CONFIG_FILE" 2>&1)"; then
      echo "Saved dashboard port $PORT to specs/worker-fleet.config.json."
    else
      echo "Warning: could not save the dashboard port to specs/worker-fleet.config.json: ${SAVE_ERR:-unknown error}. Run: python3 .claude/scripts/apply-setup.py --port $PORT"
    fi
  fi
fi

PROJECT_LINE=""
IDENT_OUT="$(sd_py identity "$PORT" "$REPO_ROOT" 2>/dev/null || true)"
case "$IDENT_OUT" in
  *$'\n'*) PROJECT_LINE=" • Project             : ${IDENT_OUT%%$'\n'*} (${IDENT_OUT#*$'\n'})" ;;
esac

LOCAL_URL="http://127.0.0.1:$PORT/"
FINAL_URL="$LOCAL_URL"

if [ "$PROVIDER" = "cloudflared" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    echo "Starting Cloudflare Quick Tunnel..."
    tunnel_check cloudflared "$PORT"
    if [ "$TUNNEL_REUSE" -eq 0 ]; then
      nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$JOB_DIR/cloudflared.log" 2>&1 &
      CF_PID=$!
      echo "$CF_PID" > "$JOB_DIR/cloudflared.pid"
    fi

    TUNNEL_URL=""
    for i in {1..30}; do
      if [ -f "$JOB_DIR/cloudflared.log" ]; then
        TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$JOB_DIR/cloudflared.log" | tail -n 1 || true)
        if [ -n "$TUNNEL_URL" ]; then
          break
        fi
      fi
      sleep 0.5
    done

    if [ -n "$TUNNEL_URL" ]; then
      FINAL_URL="$TUNNEL_URL/"
      echo "✔ Cloudflare Tunnel established!"
    else
      echo "Notice: Cloudflare quick tunnel taking longer to establish. Check job/cloudflared.log."
    fi
  else
    echo "Warning: cloudflared binary not found in PATH. Defaulting to local access."
  fi

elif [ "$PROVIDER" = "ngrok" ]; then
  if command -v ngrok >/dev/null 2>&1; then
    echo "Starting ngrok tunnel..."
    tunnel_check ngrok "$PORT"
    if [ "$TUNNEL_REUSE" -eq 0 ]; then
      nohup ngrok http "$PORT" --log=stdout --log-format=logfmt > "$JOB_DIR/ngrok.log" 2>&1 &
      NGROK_PID=$!
      echo "$NGROK_PID" > "$JOB_DIR/ngrok.pid"
    fi

    # This agent's own URL: its "started tunnel" line in this project's job/ngrok.log
    # (never ngrok's shared web API). Stop early once the agent has exited.
    NGROK_URL=""
    for i in {1..30}; do
      NGROK_URL="$(sd_py ngrokurl "$JOB_DIR/ngrok.log" "$PORT" 2>/dev/null || true)"
      [ -z "$NGROK_URL" ] || break
      [ -n "$(tunnel_pid ngrok)" ] || break
      sleep 0.5
    done
    if [ -n "$NGROK_URL" ]; then
      FINAL_URL="$NGROK_URL/"
      echo "✔ ngrok tunnel established!"
    else
      echo "Notice: ngrok did not report a public URL for :$PORT. Check job/ngrok.log."
    fi
  else
    echo "Warning: ngrok binary not found in PATH. Defaulting to local access."
  fi
fi

echo "$FINAL_URL" > "$JOB_DIR/dashboard-url.txt"

# Ticket 063: the token stays out of the output and out of dashboard-url.txt. Only the
# QR code (terminal only, fed on stdin) carries it.
if [ -n "$AUTH_TOKEN" ]; then
  PHONE_URL="$FINAL_URL?token=$AUTH_TOKEN"
else
  PHONE_URL="$FINAL_URL"
fi
if [ "${#AUTH_TOKEN}" -ge 16 ]; then
  MASKED_TOKEN="****${AUTH_TOKEN: -4}"
else
  MASKED_TOKEN="****"
fi

echo ""
echo "================================================================="
echo "   🚀 WORKER-FLEET FLEET CONTROL DASHBOARD IS LIVE             "
echo "================================================================="
[ -z "$PROJECT_LINE" ] || echo "$PROJECT_LINE"
echo " • Tunnel / Public URL : $FINAL_URL"
echo " • Localhost URL       : $LOCAL_URL"
echo " • Auth Token (PIN)    : $MASKED_TOKEN (in job/dashboard-auth.json; print it with: python3 .claude/scripts/apply-setup.py --show-token)"
echo " • Status File         : job/dashboard-url.txt"
echo "================================================================="
echo ""

if [ -t 1 ]; then
  if command -v qrencode >/dev/null 2>&1; then
    echo "Scan from Mobile Browser (the code carries the access token; never share a picture of it):"
    printf '%s' "$PHONE_URL" | qrencode -t ANSIUTF8
    echo ""
  elif (cd / && python3 -c "import qrcode") >/dev/null 2>&1; then
    echo "Scan from Mobile Browser (the code carries the access token; never share a picture of it):"
    printf '%s' "$PHONE_URL" | (cd / && python3 -c "import sys, qrcode; qr = qrcode.QRCode(); qr.add_data(sys.stdin.read()); qr.print_ascii(invert=True)")
  else
    echo "No QR code: install qrencode, or use the dashboard's Phone link button."
  fi
else
  echo "QR code skipped: the output is not a terminal (the code carries the access token). Run bash .claude/scripts/start-dashboard.sh in a terminal to show it, or use the dashboard's Phone link button."
fi

echo "To stop the dashboard anytime, run:"
echo "  .claude/scripts/start-dashboard.sh --stop"

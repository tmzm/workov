#!/usr/bin/env python3
"""selftest.py: zero-dependency self-test suite for the worker-fleet workflow.

Builds a minimal throwaway repo fixture under /tmp/opencode/selftest-* (a
copy of .claude/scripts + the dashboard UI + a fixture BOARD.md and a
fixture ticket), starts the real dashboard server on an ephemeral port in
the 20000-21000 range against that fixture, and asserts the workflow's own
plumbing with real HTTP and filesystem assertions:

  * the auth model (ticket 001): loopback reads open, POST always needs a
    token, non-loopback clients rejected, 5-strike lockout, query-string
    tokens never accepted for POST;
  * the remote gate (ticket 052): a loopback request that carries a proxy
    header is remote (auth_proxied_requires_token), remote visitors get only
    the sign-in page (signin_page_for_remote), and the lockout is keyed per
    client (auth_lockout_keyed_per_client);
  * browser-side threats (ticket 064): a loopback request whose Host is not
    localhost or an IP address is remote, the defence against DNS rebinding
    (auth_local_host_allowlist); the app page carries a strict CSP with a
    per-response nonce (app_page_csp); a local visit sets no token cookie and
    clears an old one (local_bootstrap_sets_no_cookie);
  * action validation + secret hygiene (ticket 002);
  * board parsing, evidence path safety;
  * dashboard hardening (ticket 056): actions need a header token, the
    dashboard's own origin and JSON (action_post_requires_header_token,
    action_post_cross_origin_rejected, action_post_requires_json); evidence is
    served inert (evidence_served_inert); the lockout key follows the
    configured tunnel provider (auth_lockout_provider_keyed) and the failure
    table stays bounded and expiring (auth_failure_table_bounded);
  * lockout counts attempts, not requests (ticket 057): one wrong value
    re-sent counts once (auth_repeat_counted_once) and a blank credential is
    absent (auth_blank_not_counted);
  * lockout follow-ups (ticket 058): the correct token still gets through a
    locked shared entry (auth_shared_lock_token_passes) and a success never
    resets a shared entry's count (auth_shared_success_keeps_count);
  * audit logging (ticket 015) when present;
  * apply-setup idempotency (on temp copies only);
  * no secret-shaped values in the repo's working tree;
  * no dashboard token in /api/state or in any file git would commit
    (ticket 046: state_hides_token, no_live_token_in_files).
  * no Telegram bot token, Slack webhook or URL credentials in any file git
    would commit, and apply-setup moving inline provider secrets out of the
    config (ticket 048: no_provider_secrets_in_files, notify_secrets_migrated).
  * /api/logs, /api/ticket and text evidence mask the dashboard token (ticket 063:
    api_files_hide_token), and the two file scans mask every path they print.

Every check prints exactly one line - "PASS <name> - <detail>",
"FAIL <name> - <detail>" or "SKIP <name> - <reason>" - followed by a final
"SUMMARY: N passed, M skipped, K failed" line. Exit code is 1 when any
check FAILs, 0 otherwise. CI-ready.

Usage:
  python3 .claude/scripts/selftest.py              # full suite
  python3 .claude/scripts/selftest.py --list       # print check names
  python3 .claude/scripts/selftest.py --filter auth    # run a subset
  python3 .claude/scripts/selftest.py --filter no_secrets

SKIP semantics (FR-3): a check whose feature ticket has not merged yet
auto-SKIPs with a note when the feature is absent - never FAILs - so the
suite is useful at every point of the rollout. Feature presence is
DETECTED, never assumed:

  * action_validation looks for 002's validation code in the copied
    dashboard-server.py (unknown-action guard + status enum guard);
  * no_secrets_tracked first checks for the pre-002 condition: a committed
    dashboard authToken in specs/worker-fleet.config.json means 002's
    hygiene has not landed in this branch -> SKIP with a rotation note;
  * audit_logged looks for 015's audit-logging code in the server;
  * board_parsing asserts status parsing and, unconditionally, exact prio
    values (ticket 006), including the P1 fallback for an invalid Prio value
    and for a legacy 5-column row.

Execution order: RUN_ORDER below keeps auth_lockout LAST among the
server checks. The lockout freezes the client IP for 10 minutes, and any
later token-presenting request would see 429 instead of the response it
is asserting on. --list prints the same order.

The real repo is never modified: existing scripts are exercised read-only
(apply-setup runs only on the temp fixture copies), and the fixture tree
is removed when the run ends.

Concurrent runs (ticket 086): each run picks a RANDOM free port in the
20000-21000 range and accepts a server only when GET /api/identity on that
port answers this run's own process id and fixture root. A port held by
anything else (another run's server, or any program) is never used: the run
stops its own process, picks another port, rewrites the fixture config's
ports and starts again, up to 5 attempts in all.
"""

import argparse
import hashlib
import http.client
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"

EPHEMERAL_PORT_RANGE = (20000, 21000)


# --- repo resolution (mirrors the other .claude/scripts helpers) ------------


def find_repo_root(start_dir: Path) -> Path:
    current = start_dir.resolve()
    for _ in range(5):
        if (current / ".claude").is_dir() or (current / "specs").is_dir() or (current / "README.md").is_file():
            return current
        if current.parent == current:
            break
        current = current.parent
    return start_dir.resolve()


REPO_ROOT = find_repo_root(Path(__file__).resolve().parent)


class SetupError(RuntimeError):
    """Fixture build or server startup failed before checks could run."""


# --- HTTP helper (raw http.client for exact request-line control) -----------


def http_request(port, method, path, *, token=None, headers=None, payload=None,
                 source_ip=None, host=None, timeout=10.0):
    """Issue one HTTP request and return (status, body_bytes).

    source_ip: bind the client socket to this local address before
    connecting, so the server sees a non-loopback client_address. The
    dashboard decides auth purely on the client socket address (ticket
    001), so this is how the LAN path is exercised from one machine.
    """
    host = host or source_ip or "127.0.0.1"
    hdrs = {}
    if payload is not None:
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = "Bearer {}".format(token)
    if headers:
        hdrs.update(headers)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None

    if source_ip is not None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.bind((source_ip, 0))
            sock.connect((host, port))
        except OSError:
            sock.close()
            raise
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.sock = sock  # pre-connected socket: connect() is never called
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def find_non_loopback_local_ip():
    """A local address that is NOT loopback, or None.

    Uses the UDP-connect trick (no packets ever leave the machine) to make
    the OS pick the primary route's source address, falling back to
    getaddrinfo on the hostname.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return None


def port_listening(port, host="127.0.0.1", timeout=0.2):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        except (socket.timeout, ConnectionRefusedError, OSError):
            return False


def pick_ephemeral_port():
    """A free TCP port chosen at random inside the 20000-21000 range (FR-2).

    Random, not first-free: runs that start together must not all land on
    the same port (ticket 086).
    """
    ports = list(range(EPHEMERAL_PORT_RANGE[0], EPHEMERAL_PORT_RANGE[1] + 1))
    random.shuffle(ports)
    for p in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SetupError("no free port in the 20000-21000 range")


# --- fixture -----------------------------------------------------------------


FIXTURE_BOARD_MD = """# Ticket Board (selftest fixture)

| # | Title | Status | Mode | Prio | Runs |
| --- | --- | --- | --- | --- | --- |
| 001 | auth hardening | done | solo | P0 | alongside |
| 002 | status model and secret hygiene | done | solo | P0 | alongside |
| 010 | regression sweep | Done | solo | P2 | alongside |
| 020 | self tests | ready | solo | P1 | alongside |
| 030 | invalid prio fixture | draft | solo | urgent | alongside |
| 031 | legacy five col | draft | solo | alongside |
| 032 | lowercase prio fixture | draft | solo | p0 | alongside |
| 040 | specifying fixture | specifying | solo | P1 | alongside |
| 999 | fixture ticket | draft | solo | P2 | alongside |
"""

# A PNG-shaped blob (the bytes only need to round-trip unchanged).
FIXTURE_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c63f8cfc0f01f0005000201a5f645400000000049454e44ae426082"
)

FIXTURE_TICKET_RD = """# 999: Fixture ticket (selftest)

**Status:** draft
**Mode:** solo

Throwaway fixture ticket for the selftest suite. Never merges anywhere.
"""


def fixture_config(port):
    """Fixture specs/worker-fleet.config.json - deliberately token-free."""
    return {
        "version": "2.0.0",
        "harness": "both",
        "preset": "hybrid-bridge",
        "concurrency": {
            "maxParallelWorkers": 2,
            "mainPort": 3999,
            "reproducerPort": 3998,
            "workerBasePort": 3961,
            "dashboardPort": port,
        },
        "watchdog": {
            "intervalMinutes": 10,
            "stallThresholdMinutes": 15,
            "autoCompactWindow": 150000,
        },
        "regression": {"everyNMerges": 1},
        "models": {},
        "dashboard": {
            "enabled": True,
            "autoStartWithRouter": False,
            "port": port,
            "allowRemoteActions": True,
            "tunnel": {"provider": "cloudflared", "namedTunnel": ""},
        },
    }


def run_fixture_apply_setup(fixture: Path):
    """Run the fixture's own apply-setup.py copy (never the real repo's)."""
    apply_script = fixture / ".claude" / "scripts" / "apply-setup.py"
    cfg = fixture / "specs" / "worker-fleet.config.json"
    res = subprocess.run(
        [sys.executable, str(apply_script), "--config", str(cfg)],
        cwd=str(fixture), capture_output=True, text=True, timeout=60, check=False,
    )
    if res.returncode != 0:
        tail = (res.stdout + res.stderr).strip().splitlines()[-5:]
        raise SetupError("fixture apply-setup failed: " + " | ".join(tail))
    return res


def build_fixture():
    """Create /tmp/opencode/selftest-* fixture and return (fixture, port, token)."""
    base = Path("/tmp/opencode")
    base.mkdir(parents=True, exist_ok=True)
    fixture = Path(tempfile.mkdtemp(prefix="selftest-", dir=str(base)))
    port = pick_ephemeral_port()

    # copies of the real scripts + dashboard UI (exercised read-only)
    dst_scripts = fixture / ".claude" / "scripts"
    dst_scripts.mkdir(parents=True)
    for f in sorted((REPO_ROOT / ".claude" / "scripts").iterdir()):
        if f.is_file() and f.suffix in (".py", ".sh"):
            shutil.copy2(f, dst_scripts / f.name)
    dst_dash = fixture / ".claude" / "dashboard"
    dst_dash.mkdir(parents=True)
    for f in sorted((REPO_ROOT / ".claude" / "dashboard").iterdir()):
        if f.is_file() and f.suffix in (".html", ".css", ".js"):
            shutil.copy2(f, dst_dash / f.name)

    # fixture config (token-free), board, and ticket 999 with evidence file
    cfg_dir = fixture / "specs"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "worker-fleet.config.json").write_text(
        json.dumps(fixture_config(port), indent=2) + "\n", encoding="utf-8"
    )
    tickets_dir = cfg_dir / "tickets"
    tickets_dir.mkdir()
    (tickets_dir / "BOARD.md").write_text(FIXTURE_BOARD_MD, encoding="utf-8")
    fixture_ticket = tickets_dir / "999-fixture"
    (fixture_ticket / "evidence").mkdir(parents=True)
    (fixture_ticket / "rd.md").write_text(FIXTURE_TICKET_RD, encoding="utf-8")
    (fixture_ticket / "evidence" / "fixture.txt").write_text(
        "selftest-fixture-evidence-marker\n", encoding="utf-8"
    )
    (fixture_ticket / "evidence" / "fixture.html").write_text(
        "<html><body><script>window.selftestRan = 1;</script></body></html>\n",
        encoding="utf-8",
    )
    (fixture_ticket / "evidence" / "fixture.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>window.selftestRan = 1;</script></svg>\n',
        encoding="utf-8",
    )
    (fixture_ticket / "evidence" / "fixture.png").write_bytes(FIXTURE_PNG)

    # fixture apply-setup run #1: normalizes the config and generates the
    # dashboard token into the fixture's gitignored-style job/ dir
    run_fixture_apply_setup(fixture)
    auth_file = fixture / "job" / "dashboard-auth.json"
    try:
        token = str(json.loads(auth_file.read_text(encoding="utf-8"))["authToken"]).strip()
    except Exception as e:
        raise SetupError("fixture auth file unreadable ({}): {}".format(auth_file, e))
    if not token:
        raise SetupError("fixture apply-setup produced an empty auth token")

    return fixture, port, token


SERVER_START_ATTEMPTS = 5


def retarget_fixture_port(fixture: Path, port: int):
    """Point the fixture's config (and its auth file copy) at a new port.

    Same byte format as apply-setup.py writes, so the idempotency check still
    sees a normalized tree.
    """
    cfg_path = fixture / "specs" / "worker-fleet.config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg.setdefault("concurrency", {})["dashboardPort"] = port
    cfg.setdefault("dashboard", {})["port"] = port
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    auth_path = fixture / "job" / "dashboard-auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if isinstance(auth, dict) and "dashboardPort" in auth:
        auth["dashboardPort"] = port
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(auth, fh, indent=2)


def probe_identity(port, timeout=1.0):
    """GET /api/identity on 127.0.0.1:<port> -> (status, parsed JSON or None).

    (None, None) when nothing answered HTTP on the port.
    """
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", "/api/identity", headers={"Connection": "close"})
        resp = conn.getresponse()
        raw = resp.read(65536)
        try:
            doc = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            doc = None
        return resp.status, doc
    except (OSError, http.client.HTTPException):
        return None, None
    finally:
        conn.close()


def is_own_server(doc, proc, fixture: Path):
    """True only when /api/identity names this process and this fixture."""
    if not isinstance(doc, dict) or doc.get("app") != "worker-fleet":
        return False
    try:
        same_pid = int(doc.get("pid")) == proc.pid
    except (TypeError, ValueError):
        return False
    root = doc.get("root")
    if not same_pid or not isinstance(root, str) or not root:
        return False
    return os.path.realpath(root) == os.path.realpath(str(fixture))


def start_fixture_server(fixture: Path, port: int):
    """Start the fixture's dashboard-server.py; return (proc, ok, log_path).

    ok is True only when GET /api/identity on the port answers HTTP 200 with
    this process's pid and this fixture's root (ticket 086, FR-1). Any other
    listener on the port is never accepted: the process this function started
    is stopped before it returns ok=False.
    """
    log_path = fixture / "server.log"
    log_fh = open(log_path, "wb")
    try:
        proc = subprocess.Popen(
            [sys.executable, str(fixture / ".claude" / "scripts" / "dashboard-server.py"),
             "--port", str(port)],
            cwd=str(fixture), stdout=log_fh, stderr=subprocess.STDOUT,
        )
    finally:
        log_fh.close()
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        if port_listening(port):
            status, doc = probe_identity(port)
            if status == 200 and is_own_server(doc, proc, fixture):
                return proc, True, log_path
            if status is not None:
                break  # something else answered on this port: not our server
        time.sleep(0.1)
    stop_fixture_server(proc)
    return proc, False, log_path


def stop_fixture_server(proc):
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def log_tail(log_path: Path, limit=400):
    try:
        return log_path.read_text(encoding="utf-8", errors="ignore").strip()[-limit:]
    except OSError:
        return ""


class Ctx:
    """Shared state handed to every check."""

    def __init__(self, fixture, port, token, server_ok, server_log):
        self.fixture = fixture
        self.port = port
        self.token = token
        self.server_ok = server_ok
        self.server_log = server_log
        self.server_src = (fixture / ".claude" / "scripts" / "dashboard-server.py").read_text(
            encoding="utf-8", errors="ignore"
        )


# --- secret-scan helpers (no_secrets_tracked) --------------------------------

# Named patterns for secret-shaped values. The pattern SOURCES below are
# deliberately written so that this file itself never matches them.
SECRET_PATTERNS = [
    ("hex32", re.compile(r"(?i)\b[a-f0-9]{32}\b")),
    ("hex40", re.compile(r"(?i)\b[a-f0-9]{40}\b")),
    ("api-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("google-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{10,}\b")),
    ("credential-assignment", re.compile(
        r"(?i)\b(auth[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|"
        r"passw(?:or)?d|bearer[_-]?token)\b[\"']?\s*[:=]\s*[\"']?"
        r"[A-Za-z0-9+/=_.\-]{20,}"
    )),
]

# Walk exclusions: VCS internals, the gitignored runtime dir (job/ holds the
# real dashboard token by design), bytecode caches, nested worktree
# checkouts, and evidence dirs (rd.md FR-1 #11 excludes job/, .git/ and
# evidence).
EXCLUDED_DIR_NAMES = {".git", "job", "__pycache__", "worktrees", "node_modules", "evidence"}
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".pyc",
                   ".zip", ".gz", ".tgz", ".mp4", ".woff", ".woff2", ".ttf",
                   ".otf", ".db", ".sqlite", ".pdf"}


def committed_config_token():
    """Non-empty dashboard token committed in the tracked config, if any.

    A token here is the pre-002 condition: secret hygiene has not landed in
    this branch, so no_secrets_tracked must SKIP (with a rotation note)
    instead of scanning a tree that is known-compromised.
    """
    cfg_path = REPO_ROOT / "specs" / "worker-fleet.config.json"
    if not cfg_path.is_file():
        return ""
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    if not isinstance(cfg, dict):
        return ""
    tok = str(cfg.get("authToken", "") or "")
    dash = cfg.get("dashboard")
    if isinstance(dash, dict):
        tok = tok or str(dash.get("authToken", "") or "")
        tunnel = dash.get("tunnel")
        if isinstance(tunnel, dict):
            tok = tok or str(tunnel.get("authToken", "") or "")
    return tok.strip()


def scan_repo_for_secrets():
    """Walk the real repo's working tree looking for secret-shaped values.

    Returns (scanned_file_count, hits) where each hit is
    (relative_path, line_no, pattern_name, redacted_preview).

    Ticket-spec markdown (specs/tickets/**/*.md) is excluded: those files
    legitimately QUOTE token shapes as documentation - 002's rd.md records
    the burned pre-002 token, and 020's own eval.md carries the planted
    fixture used to prove this check has teeth. They are prose, not a
    runtime surface. Everything else - all code, all config, README, and
    any file at the repo root (including an untracked PLANTED.md) - is
    scanned.
    """
    hits = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIR_NAMES)
        for fn in sorted(filenames):
            fpath = Path(dirpath) / fn
            try:
                rel = fpath.relative_to(REPO_ROOT)
            except ValueError:
                continue
            relposix = rel.as_posix()
            if rel.is_symlink() or fpath.suffix.lower() in BINARY_SUFFIXES:
                continue
            if rel.parts[:2] == ("specs", "tickets") and fpath.suffix.lower() == ".md":
                continue
            try:
                if fpath.stat().st_size > 2_000_000:
                    continue
                text = fpath.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            scanned += 1
            for pname, rx in SECRET_PATTERNS:
                for m in rx.finditer(text):
                    line_no = text.count("\n", 0, m.start()) + 1
                    hits.append((relposix, line_no, pname, m.group(0)[:6] + "..."))
    return scanned, hits


def list_git_addable_files():
    """Paths `git add -A` would add or that are tracked, relative to REPO_ROOT.

    Returns (paths, error). error is the first stderr line when git fails.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "-z", "--cached", "--others",
             "--exclude-standard"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return [], str(e).splitlines()[0] if str(e) else "git unavailable"
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip().splitlines()
        return [], err[0] if err else "exit {}".format(proc.returncode)
    names = [n for n in proc.stdout.decode("utf-8", errors="surrogateescape").split("\0") if n]
    return names, ""


def read_live_dashboard_token():
    """authToken from job/dashboard-auth.json (read like get_auth_token), or ''."""
    auth_file = REPO_ROOT / "job" / "dashboard-auth.json"
    if auth_file.is_file():
        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                return str(json.load(f).get("authToken", "")).strip()
        except Exception:
            pass
    return ""


TOKEN_PARAM_RE = re.compile(r"token=[0-9a-f]{32}")

# Ticket 048: notification provider secret shapes (kind, regex), in report order.
# The pattern SOURCES are written so that this file itself never matches them
# (no run of digits before a colon, an escaped dot in the Slack host, an
# optional "s" in the URL scheme).
PROVIDER_SECRET_PATTERNS = [
    ("telegram-bot-token", re.compile(r"(?<![A-Za-z0-9_])(?:bot)?[0-9]{6,}:[A-Za-z0-9_-]{30,}")),
    ("slack-webhook", re.compile(
        r"hooks\.slack\.com/services/T[A-Za-z0-9]{6,}/B[A-Za-z0-9]{6,}/[A-Za-z0-9]{16,}")),
    ("url-credentials", re.compile(r"https?://[^/@\s<>*]+:[^/@\s<>*]+@")),
]


# Ticket 063: the file scans report a file NAME that carries a secret and never print one.
TOKEN_PARAM_MASK_RE = re.compile(r"token=[0-9a-f]{32,}")


def mask_token_in_path(path, live):
    """path with each occurrence of the live token and each token=<32+ hex> masked."""
    if live:
        path = path.replace(live, "****")
    return TOKEN_PARAM_MASK_RE.sub("token=****", path)


def mask_provider_secrets_in_path(path):
    """path with each provider-secret match replaced by ****."""
    for _kind, rx in PROVIDER_SECRET_PATTERNS:
        path = rx.sub("****", path)
    return path


# --- checks (each returns (status, detail)) ----------------------------------


def check_auth_loopback_read_open(ctx: Ctx):
    status, body = http_request(ctx.port, "GET", "/api/state")
    if status != 200:
        return FAIL, "loopback GET /api/state without token returned {} (expected 200)".format(status)
    try:
        data = json.loads(body)
    except Exception:
        return FAIL, "loopback GET /api/state returned 200 but a non-JSON body"
    if "tickets" not in data:
        return FAIL, "loopback GET /api/state 200 but the state payload has no tickets key"
    return PASS, ("loopback GET /api/state without token -> 200 with {} tickets "
                  "(frictionless loopback read while a token IS configured)".format(len(data["tickets"])))


def check_state_hides_token(ctx: Ctx):
    """Ticket 046: /api/state never serves the dashboard token in tunnelUrl."""
    url_file = ctx.fixture / "job" / "dashboard-url.txt"
    expected = "http://127.0.0.1:{}/".format(ctx.port)
    try:
        url_file.parent.mkdir(parents=True, exist_ok=True)
        url_file.write_text("http://127.0.0.1:{}/?token={}".format(ctx.port, ctx.token),
                            encoding="utf-8")
        try:
            status, body = http_request(ctx.port, "GET", "/api/state")
        finally:
            try:
                url_file.unlink()
            except OSError:
                pass
    except Exception as e:
        return FAIL, "could not run the /api/state request: {}".format(type(e).__name__)
    if status != 200:
        return FAIL, "loopback GET /api/state returned {} (expected 200)".format(status)
    problems = []
    if ctx.token.encode("utf-8") in body:
        problems.append("the body contains the dashboard token")
    try:
        tunnel = json.loads(body).get("tunnelUrl")
    except Exception:
        return FAIL, "loopback GET /api/state returned 200 but a non-JSON body"
    if tunnel != expected:
        if isinstance(tunnel, str) and ctx.token in tunnel:
            problems.append("tunnelUrl still carries the token")
        else:
            problems.append("tunnelUrl is not the token-free URL {}".format(expected))
    if problems:
        return FAIL, "/api/state leaks the dashboard token: " + "; ".join(problems)
    return PASS, ("/api/state without a credential: 200, the body has no dashboard token, "
                  "tunnelUrl is {}".format(expected))


def check_api_files_hide_token(ctx: Ctx):
    """Ticket 063: /api/logs, /api/ticket and text evidence mask the dashboard token."""
    marker_line = "selftest scrub marker {}\n".format(ctx.token)
    planted = [
        ctx.fixture / "job" / "logs" / "999-selftest-scrub.log",
        ctx.fixture / "specs" / "tickets" / "999-fixture" / "evidence" / "scrub.log",
        ctx.fixture / "specs" / "tickets" / "999-fixture" / "results.md",
    ]
    for f in planted:
        if f.exists():
            return FAIL, "a planted file already exists: {}".format(f.name)
    created = []
    try:
        try:
            for f in planted:
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(marker_line, encoding="utf-8")
                created.append(f)
            responses = [(path, http_request(ctx.port, "GET", path)) for path in (
                "/api/logs?ticket=999", "/api/ticket/999", "/api/evidence/999/scrub.log")]
        except Exception as e:
            return FAIL, "could not run the file requests: {}".format(type(e).__name__)
    finally:
        for f in created:
            try:
                f.unlink()
            except OSError:
                pass
    masked = "****" + ctx.token[-2:]
    problems = []
    for path, (status, body) in responses:
        if status != 200:
            problems.append("{} returned {}".format(path.split("?")[0], status))
        elif ctx.token.encode("utf-8") in body or masked.encode("utf-8") not in body:
            problems.append("{} serves the dashboard token".format(path.split("?")[0]))
    if problems:
        return FAIL, "; ".join(problems)
    return PASS, "/api/logs, /api/ticket and /api/evidence (text) mask the dashboard token"


def check_auth_post_requires_token(ctx: Ctx):
    s1, _ = http_request(ctx.port, "POST", "/api/action",
                         payload={"action": "set_ticket_status", "ticket": "999", "status": "ready"})
    if s1 != 401:
        return FAIL, "loopback POST /api/action without token returned {} (expected 401)".format(s1)
    # the same endpoint WITH a valid Bearer token must authorize past auth
    # (400 unknown action), proving the 401 above was the auth gate
    s2, _ = http_request(ctx.port, "POST", "/api/action", token=ctx.token,
                         payload={"action": "selftest_probe_action"})
    if s2 == 401:
        return FAIL, "POST with a valid Bearer token still returned 401 (valid token rejected)"
    if s2 != 400:
        return FAIL, "POST with a valid Bearer token returned {} (expected 400 unknown action)".format(s2)
    return PASS, "POST /api/action without token -> 401; with valid Bearer token -> 400 unknown action (authorized past auth)"


def check_auth_lan_spoof_rejected(ctx: Ctx):
    lan = find_non_loopback_local_ip()
    if not lan:
        return SKIP, ("no non-loopback local address exists in this environment - "
                      "the LAN client path cannot be exercised here")
    try:
        # request whose client socket address is the LAN address: the server
        # must demand a token (auth decides on client_address, not the Host header)
        s1, _ = http_request(ctx.port, "GET", "/api/state", source_ip=lan, host=lan)
        # loopback request wearing a spoofed Host header that claims to be the
        # LAN address: must stay open, the Host header is never consulted
        s2, _ = http_request(ctx.port, "GET", "/api/state",
                             headers={"Host": "{}:{}".format(lan, ctx.port)})
    except OSError as e:
        return SKIP, "could not connect via local non-loopback address {}: {}".format(lan, e)
    if s1 != 401:
        return FAIL, "GET /api/state from non-loopback local address {} without token returned {} (expected 401)".format(lan, s1)
    if s2 != 200:
        return FAIL, "loopback GET with spoofed Host header returned {} (expected 200 - Host header must never be consulted)".format(s2)
    return PASS, ("GET via non-loopback local address {} without token -> 401; "
                  "loopback GET with spoofed Host: {} -> 200 (auth uses the client "
                  "socket address (client_address), never the Host header)".format(lan, lan))


def check_auth_local_host_allowlist(ctx: Ctx):
    # ticket 064: a loopback request is local only when its Host names localhost
    # or an IP address (a DNS-rebinding page arrives under its own domain name)
    port = ctx.port
    rebind = {"Host": "rebind.test:{}".format(port)}
    s1, _ = http_request(ctx.port, "GET", "/api/state", headers=rebind)
    if s1 != 401:
        return FAIL, "GET /api/state with Host rebind.test and no token returned {} (expected 401)".format(s1)
    for host in ("localhost:{}".format(port), "[::1]:{}".format(port), "LOCALHOST."):
        s, _ = http_request(ctx.port, "GET", "/api/state", headers={"Host": host})
        if s != 200:
            return FAIL, "GET /api/state with Host {} and no token returned {} (expected 200)".format(host, s)
    s2, _ = http_request(ctx.port, "GET", "/api/state", headers=rebind, token=ctx.token)
    if s2 != 200:
        return FAIL, "GET /api/state with Host rebind.test and the Bearer token returned {} (expected 200)".format(s2)
    s3, _, body = http_request_full(ctx.port, "/", rebind)
    text = body.decode("utf-8", "replace")
    if s3 != 401 or 'id="signin-form"' not in text or 'id="project-name"' in text:
        return FAIL, ("GET / with Host rebind.test returned {} (expected the 401 sign-in page "
                      "without id=\"project-name\")".format(s3))
    return PASS, ("Host rebind.test: no token -> 401 (also GET / -> 401 sign-in page), with the token -> 200; "
                  "Host localhost, [::1] and LOCALHOST. without a token -> 200")


def check_auth_query_token_post_rejected(ctx: Ctx):
    # even a VALID token in the query string must not authenticate a POST
    s, _ = http_request(ctx.port, "POST", "/api/action?token=" + ctx.token,
                        payload={"action": "set_ticket_status", "ticket": "999", "status": "ready"})
    if s != 401:
        return FAIL, ("POST /api/action?token=<valid> without a header credential returned {} "
                      "(expected 401 - the query string is not an accepted POST channel)").format(s)
    return PASS, "POST /api/action?token=<valid-token> without a header credential -> 401 (query-string token rejected for POST)"


def check_action_post_requires_header_token(ctx: Ctx):
    body = {"action": "selftest_probe_action"}
    s1, _ = http_request(ctx.port, "POST", "/api/action", payload=body,
                         headers={"Cookie": "wf_session=" + ctx.token})
    if s1 != 401:
        return FAIL, "cookie-only POST /api/action returned {} (expected 401)".format(s1)
    s2, _ = http_request(ctx.port, "POST", "/api/action", payload=body, token=ctx.token)
    if s2 != 400:
        return FAIL, "POST with Authorization: Bearer returned {} (expected 400 unknown action)".format(s2)
    s3, _ = http_request(ctx.port, "POST", "/api/action", payload=body,
                         headers={"X-Auth-Token": ctx.token})
    if s3 != 400:
        return FAIL, "POST with X-Auth-Token returned {} (expected 400 unknown action)".format(s3)
    return PASS, ("cookie-only POST -> 401; Authorization: Bearer -> 400 and X-Auth-Token -> 400 "
                  "(unknown action, authorized past auth)")


def check_action_post_cross_origin_rejected(ctx: Ctx):
    body = {"action": "selftest_probe_action"}
    own = "http://127.0.0.1:{}".format(ctx.port)
    for label, hdrs, want in [
        ("Origin of another port", {"Origin": "http://127.0.0.1:{}".format(ctx.port + 1)}, 403),
        ("Origin: null", {"Origin": "null"}, 403),
        ("Sec-Fetch-Site: same-site", {"Sec-Fetch-Site": "same-site"}, 403),
        ("Sec-Fetch-Site: cross-site", {"Sec-Fetch-Site": "cross-site"}, 403),
        ("own Origin + Sec-Fetch-Site: same-origin",
         {"Origin": own, "Sec-Fetch-Site": "same-origin"}, 400),
    ]:
        s, _ = http_request(ctx.port, "POST", "/api/action", payload=body,
                            token=ctx.token, headers=hdrs)
        if s != want:
            return FAIL, "POST with {} returned {} (expected {})".format(label, s, want)
    return PASS, ("foreign Origin, Origin: null, same-site and cross-site -> 403; the dashboard's own "
                  "Origin with same-origin -> 400")


def check_action_post_requires_json(ctx: Ctx):
    raw = json.dumps({"action": "selftest_probe_action"})
    for label, ctype, want in [
        ("text/plain", "text/plain", 415),
        ("no Content-Type", None, 415),
        ("application/json; charset=utf-8", "application/json; charset=utf-8", 400),
    ]:
        conn = http.client.HTTPConnection("127.0.0.1", ctx.port, timeout=10.0)
        try:
            conn.putrequest("POST", "/api/action", skip_accept_encoding=True)
            conn.putheader("Authorization", "Bearer " + ctx.token)
            if ctype is not None:
                conn.putheader("Content-Type", ctype)
            conn.putheader("Content-Length", str(len(raw)))
            conn.endheaders(raw.encode("utf-8"))
            status = conn.getresponse().status
        finally:
            conn.close()
        if status != want:
            return FAIL, "POST with {} returned {} (expected {})".format(label, status, want)
    return PASS, "text/plain -> 415; no Content-Type -> 415; application/json; charset=utf-8 -> 400"


def check_action_validation(ctx: Ctx):
    # feature-absence detection (ticket 002): if the copied server has no
    # validation code, the feature has not merged in this branch -> SKIP.
    has_unknown_action_guard = "Unknown action" in ctx.server_src
    has_status_guard = ("not in TICKET_STATUSES" in ctx.server_src) or ("Invalid status" in ctx.server_src)
    if not (has_unknown_action_guard and has_status_guard):
        return SKIP, ("action validation not present in dashboard-server.py "
                      "(ticket 002 not merged in this branch) - nothing to enforce yet")

    board_path = ctx.fixture / "specs" / "tickets" / "BOARD.md"
    board_before = board_path.read_text(encoding="utf-8")

    s1, b1 = http_request(ctx.port, "POST", "/api/action", token=ctx.token,
                          payload={"action": "selftest_definitely_not_an_action", "ticket": "999"})
    if s1 != 400:
        return FAIL, "unknown action returned {} (expected 400)".format(s1)
    if b"Unknown action" not in b1:
        return FAIL, "unknown action returned 400 but without the Unknown-action error body"

    s2, b2 = http_request(ctx.port, "POST", "/api/action", token=ctx.token,
                          payload={"action": "set_ticket_status", "ticket": "999",
                                   "status": "definitely-bogus-status"})
    if s2 != 400:
        return FAIL, "set_ticket_status with bogus status returned {} (expected 400)".format(s2)
    if b"Invalid status" not in b2:
        return FAIL, "bogus status returned 400 but without the Invalid-status error body"
    if b"specifying" not in b2:
        return FAIL, "bogus status returned 400 but its body does not list specifying among the valid statuses"

    board_after = board_path.read_text(encoding="utf-8")
    if board_after != board_before:
        return FAIL, "a rejected (400) action still modified specs/tickets/BOARD.md"
    return PASS, "unknown action -> 400 'Unknown action'; bogus status -> 400 'Invalid status'; BOARD.md untouched by rejected requests; the 400 lists specifying among the valid statuses"


def check_board_parsing(ctx: Ctx):
    status, body = http_request(ctx.port, "GET", "/api/state")
    if status != 200:
        return FAIL, "GET /api/state returned {} (expected 200)".format(status)
    try:
        tickets = {t.get("id"): t for t in json.loads(body).get("tickets", [])}
    except Exception:
        return FAIL, "GET /api/state returned a non-JSON or ticket-less body"

    expected = {"001": "done", "002": "done", "010": "done", "020": "ready", "040": "specifying",
                "999": "draft"}
    for tid, want in expected.items():
        got = tickets.get(tid, {}).get("status")
        if got != want:
            return FAIL, "ticket {} parsed as status {!r} (expected {!r})".format(tid, got, want)

    # prio (ticket 006): asserted unconditionally with exact, case-sensitive
    # values. The parser must surface `prio` on every ticket; an invalid
    # value (030 'urgent') and a legacy 5-column row (031, no Prio cell) fall
    # back to P1, and a lowercase cell (032 'p0') is normalized to P0.
    expected_prio = {"001": "P0", "002": "P0", "010": "P2", "020": "P1",
                     "030": "P1", "031": "P1", "032": "P0", "999": "P2"}
    for tid, t in tickets.items():
        if "prio" not in t:
            return FAIL, "ticket {} is missing 'prio' in GET /api/state".format(tid)
    for tid, want in expected_prio.items():
        if tid not in tickets:
            return FAIL, "fixture ticket {} missing from GET /api/state".format(tid)
        got_prio = tickets[tid].get("prio")
        if got_prio != want:
            return FAIL, "ticket {} prio parsed as {!r} (expected {!r})".format(tid, got_prio, want)
    return PASS, ("fixture BOARD.md parsed via GET /api/state: statuses "
                  "done/done/done (normalized from 'Done')/ready/specifying/draft; prio asserted exactly "
                  "(001/002 -> P0, 010/999 -> P2, 020 -> P1) incl. fallback to P1 for an invalid "
                  "value and a legacy 5-column row, and p0 -> P0 normalization")


def check_evidence_path_safety(ctx: Ctx):
    # control: the legitimate evidence file IS served
    s0, b0 = http_request(ctx.port, "GET", "/api/evidence/999/fixture.txt")
    if s0 != 200 or b"selftest-fixture-evidence-marker" not in b0:
        return FAIL, "control request for the real evidence file returned {} (expected 200)".format(s0)

    traversals = [
        "/api/evidence/999/..%2F..%2Fspecs",                                    # rd.md example
        "/api/evidence/999/..%2F..%2F..%2Fjob%2Fdashboard-auth.json",           # would exfiltrate the token
        "/api/evidence/999/../../../job/dashboard-auth.json",                  # raw dot-segments
        "/api/evidence/999/%2e%2e%2f%2e%2e%2fjob%2fdashboard-auth.json",        # lowercase-encoded
    ]
    for path in traversals:
        s, _ = http_request(ctx.port, "GET", path)
        if s != 404:
            return FAIL, "traversal request {} returned {} (expected 404)".format(path, s)
    return PASS, ("control file served (200); 4 traversal attempts "
                  "(..%2F-encoded and raw ../, incl. job/dashboard-auth.json) all -> 404")


def check_evidence_served_inert(ctx: Ctx):
    expected = [
        ("fixture.html", "text/plain; charset=utf-8"),
        ("fixture.svg", "text/plain; charset=utf-8"),
        ("fixture.txt", "text/plain; charset=utf-8"),
        ("fixture.png", "image/png"),
    ]
    for name, want_type in expected:
        conn = http.client.HTTPConnection("127.0.0.1", ctx.port, timeout=10.0)
        try:
            conn.request("GET", "/api/evidence/999/" + name)
            resp = conn.getresponse()
            resp.read()
            status = resp.status
            ctype = resp.getheader("Content-Type", "")
            nosniff = resp.getheader("X-Content-Type-Options", "")
            csp = resp.getheader("Content-Security-Policy", "")
        finally:
            conn.close()
        if status != 200:
            return FAIL, "{} returned {} (expected 200)".format(name, status)
        if ctype != want_type:
            return FAIL, "{} Content-Type is {!r} (expected {!r})".format(name, ctype, want_type)
        if nosniff.lower() != "nosniff":
            return FAIL, "{} has X-Content-Type-Options {!r} (expected nosniff)".format(name, nosniff)
        if csp != "default-src 'none'; sandbox":
            return FAIL, "{} has Content-Security-Policy {!r}".format(name, csp)
    return PASS, ("fixture.html, fixture.svg and fixture.txt -> text/plain; charset=utf-8, fixture.png -> "
                  "image/png, each with nosniff and default-src 'none'; sandbox")


def check_audit_logged(ctx: Ctx):
    # feature-absence detection (ticket 015): no audit code in the server
    # means the feature has not merged in this branch -> SKIP, not FAIL.
    if "audit" not in ctx.server_src.lower():
        return SKIP, ("audit logging not present in dashboard-server.py "
                      "(ticket 015 not merged) - no audit code path to exercise")

    def snapshot():
        snap = {}
        job_dir = ctx.fixture / "job"
        if job_dir.is_dir():
            for f in job_dir.rglob("*"):
                if f.is_file():
                    snap[str(f.relative_to(ctx.fixture))] = hashlib.sha256(
                        f.read_bytes()).hexdigest()
        for f in ctx.fixture.rglob("*.log"):
            if f.is_file():
                snap[str(f.relative_to(ctx.fixture))] = hashlib.sha256(
                    f.read_bytes()).hexdigest()
        return snap

    before = snapshot()
    s, _ = http_request(ctx.port, "POST", "/api/action", token=ctx.token,
                        payload={"action": "set_ticket_status", "ticket": "999",
                                 "status": "in-progress"})
    if s != 200:
        return FAIL, "set_ticket_status (valid) returned {} (expected 200)".format(s)
    after = snapshot()
    changed = [k for k in set(before) | set(after)
               if before.get(k) != after.get(k)]
    if not changed:
        return FAIL, "action succeeded but no audit record appeared anywhere in the fixture"
    return PASS, "action appended an audit record ({})".format(", ".join(sorted(changed)[:3]))


def check_auth_proxied_requires_token(ctx: Ctx):
    # a loopback request that carries a proxy header is remote (ticket 052)
    hdr = {"X-Forwarded-For": "203.0.113.7"}
    s1, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr)
    if s1 != 401:
        return FAIL, "GET /api/state with X-Forwarded-For and no token returned {} (expected 401)".format(s1)
    s2, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr, token=ctx.token)
    if s2 != 200:
        return FAIL, "GET /api/state with X-Forwarded-For and the token returned {} (expected 200)".format(s2)
    s3, _ = http_request(ctx.port, "GET", "/api/state")
    if s3 != 200:
        return FAIL, "plain loopback GET /api/state without token returned {} (expected 200)".format(s3)
    return PASS, ("loopback + X-Forwarded-For: no token -> 401, with token -> 200; "
                  "plain loopback without token -> 200")


def http_request_full(port, path, headers):
    """GET path with extra headers; return (status, content_type, body_bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10.0)
    try:
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.getheader("Content-Type", ""), resp.read()
    finally:
        conn.close()


def check_signin_page_for_remote(ctx: Ctx):
    s, ctype, body = http_request_full(ctx.port, "/", {"CF-Connecting-IP": "203.0.113.7"})
    if s != 401:
        return FAIL, "remote GET / without token returned {} (expected 401)".format(s)
    if "text/html" not in ctype:
        return FAIL, "remote GET / Content-Type is {!r} (expected text/html)".format(ctype)
    text = body.decode("utf-8", "replace")
    if 'id="signin-form"' not in text:
        return FAIL, "remote GET / body has no id=\"signin-form\""
    for leak in ("Fleet Control", "<script", "project-name"):
        if leak in text:
            return FAIL, "remote GET / body leaks {!r}".format(leak)
    s2, _, body2 = http_request_full(ctx.port, "/", {})
    if s2 != 200 or b'id="project-name"' not in body2:
        return FAIL, "plain loopback GET / returned {} or lacks id=\"project-name\"".format(s2)
    return PASS, ("remote GET / -> 401 text/html sign-in page (form present, no Fleet Control, "
                  "<script or project-name); plain loopback GET / -> 200 app")


APP_CSP_RE = re.compile(
    r"^default-src 'self'; script-src 'nonce-([0-9a-f]{32})'; style-src 'self' 'unsafe-inline'; "
    r"img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    r"form-action 'self'; frame-ancestors 'none'$"
)


def http_get_headers(port, path, headers=None):
    """GET path with extra headers; return (status, [(name, value), ...], body_bytes).
    Repeated headers (Set-Cookie) all stay in the list."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10.0)
    try:
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, resp.getheaders(), resp.read()
    finally:
        conn.close()


def _header_values(hdrs, name):
    return [v for k, v in hdrs if k.lower() == name.lower()]


def check_app_page_csp(ctx: Ctx):
    # ticket 064 FR-1: the app page carries a strict CSP with a fresh nonce
    nonces = []
    for _ in range(2):
        s, hdrs, body = http_get_headers(ctx.port, "/")
        if s != 200:
            return FAIL, "local GET / returned {} (expected 200)".format(s)
        csps = _header_values(hdrs, "Content-Security-Policy")
        m = APP_CSP_RE.match(csps[0]) if len(csps) == 1 else None
        if m is None:
            return FAIL, "GET / Content-Security-Policy {!r} is not the app template with a 32-hex nonce".format(csps)
        nonce = m.group(1)
        text = body.decode("utf-8", "replace")
        tags = re.findall(r"<script[^>]*>", text, flags=re.IGNORECASE)
        if not tags:
            return FAIL, "GET / body has no <script tag"
        for tag in tags:
            if not tag.startswith('<script nonce="{}"'.format(nonce)):
                return FAIL, "script tag {!r} does not start <script nonce=\"<the response nonce>\"".format(tag)
        if _header_values(hdrs, "X-Frame-Options") != ["DENY"]:
            return FAIL, "GET / X-Frame-Options is {!r} (expected DENY)".format(_header_values(hdrs, "X-Frame-Options"))
        if _header_values(hdrs, "X-Content-Type-Options") != ["nosniff"]:
            return FAIL, "GET / X-Content-Type-Options is {!r} (expected nosniff)".format(
                _header_values(hdrs, "X-Content-Type-Options"))
        nonces.append(nonce)
    if nonces[0] == nonces[1]:
        return FAIL, "two GET / responses carried the same nonce {}".format(nonces[0])
    return PASS, ("GET / -> 200 with the strict CSP and a 32-hex nonce on every <script tag, "
                  "X-Frame-Options DENY, nosniff; a second GET / has a different nonce")


# Ticket 089: the cookie name the dashboard used before the rename. It is never accepted;
# the server only expires it.
LEGACY_SESSION_COOKIE = "sa_session"


def check_local_bootstrap_sets_no_cookie(ctx: Ctx):
    # ticket 064 FR-2 + ticket 089 FR-7: a local visit sets no wf_session cookie, clears an
    # old one, and always expires the pre-rename cookie
    s1, h1, _ = http_get_headers(ctx.port, "/?token=" + ctx.token)
    if s1 != 200:
        return FAIL, "local GET /?token=<token> returned {} (expected 200)".format(s1)
    if _header_values(h1, "Set-Cookie"):
        return FAIL, "local GET /?token=<token> set a cookie: {!r}".format(_header_values(h1, "Set-Cookie"))
    s2, h2, _ = http_get_headers(ctx.port, "/", {"Cookie": "wf_session=stale-selftest"})
    clear = "wf_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    legacy_clear = LEGACY_SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    if s2 != 200 or _header_values(h2, "Set-Cookie") != [clear, legacy_clear]:
        return FAIL, ("local GET / with a stale wf_session cookie returned {} with Set-Cookie {!r} "
                      "(expected 200 and {!r})".format(s2, _header_values(h2, "Set-Cookie"), [clear, legacy_clear]))
    s2b, h2b, _ = http_get_headers(ctx.port, "/", {"Cookie": LEGACY_SESSION_COOKIE + "=stale-selftest"})
    if s2b != 200 or _header_values(h2b, "Set-Cookie") != [legacy_clear]:
        return FAIL, ("local GET / with only the pre-rename cookie returned {} with Set-Cookie {!r} "
                      "(expected 200 and {!r})".format(s2b, _header_values(h2b, "Set-Cookie"), [legacy_clear]))
    s3, h3, _ = http_get_headers(ctx.port, "/?token=" + ctx.token, {"X-Forwarded-For": "203.0.113.7"})
    cookies = _header_values(h3, "Set-Cookie")
    want = "wf_session={}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax".format(ctx.token)
    if s3 != 200 or len(cookies) != 1 or not cookies[0].startswith(want):
        return FAIL, "proxied GET /?token=<token> returned {} with a Set-Cookie that does not start with the bootstrap cookie".format(s3)
    return PASS, ("local GET /?token= -> 200 with no Set-Cookie; local GET / with a stale cookie -> both clearing "
                  "Set-Cookie headers; local GET / with only the pre-rename cookie -> its clearing header; "
                  "proxied GET /?token= -> 200 with the bootstrap cookie")


def check_auth_lockout_keyed_per_client(ctx: Ctx):
    hdr_a = {"CF-Connecting-IP": "203.0.113.99"}
    for i in range(5):
        s, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr_a,
                            token="selftest-invalid-token-key-{}".format(i))
        if s != 401:
            return FAIL, "tunnel visitor wrong-token attempt {} returned {} (expected 401)".format(i + 1, s)
    s6, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr_a, token=ctx.token)
    if s6 != 429:
        return FAIL, "locked tunnel visitor with the right token returned {} (expected 429)".format(s6)
    s_local, _ = http_request(ctx.port, "POST", "/api/action", token=ctx.token,
                              payload={"action": "selftest_probe_action"})
    if s_local != 400:
        return FAIL, ("local POST with the token after a tunnel visitor was locked returned {} "
                      "(expected 400, not 429)").format(s_local)
    s_other, _ = http_request(ctx.port, "GET", "/api/state",
                              headers={"CF-Connecting-IP": "203.0.113.98"}, token=ctx.token)
    if s_other != 200:
        return FAIL, "other tunnel visitor with the token returned {} (expected 200)".format(s_other)
    return PASS, ("5 wrong tokens from tunnel visitor A -> 401 x5, then 429; local POST with the "
                  "token -> 400 (not locked); tunnel visitor B with the token -> 200")


def check_auth_lockout_provider_keyed(ctx: Ctx):
    cfg_path = ctx.fixture / "specs" / "worker-fleet.config.json"
    original = cfg_path.read_bytes()
    try:
        cfg = json.loads(original.decode("utf-8"))
        cfg["dashboard"]["tunnel"]["provider"] = "ngrok"
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        for i in range(5):
            s, _ = http_request(ctx.port, "GET", "/api/state", token="selftest-invalid-token-prov-{}".format(i),
                                headers={"X-Forwarded-For": "198.51.100.7",
                                         "CF-Connecting-IP": "203.0.113.{}".format(150 + i)})
            if s != 401:
                return FAIL, "ngrok visitor wrong-token attempt {} returned {} (expected 401)".format(i + 1, s)
        s6, _ = http_request(ctx.port, "GET", "/api/state", token=ctx.token,
                             headers={"X-Forwarded-For": "198.51.100.7",
                                      "CF-Connecting-IP": "203.0.113.160"})
        if s6 != 429:
            return FAIL, ("right token with a new forged CF-Connecting-IP returned {} "
                          "(expected 429: under ngrok the key is X-Forwarded-For)").format(s6)
        s7, _ = http_request(ctx.port, "GET", "/api/state", token=ctx.token,
                             headers={"X-Forwarded-For": "198.51.100.8"})
        if s7 != 200:
            return FAIL, "other X-Forwarded-For visitor with the token returned {} (expected 200)".format(s7)
    finally:
        cfg_path.write_bytes(original)
    return PASS, ("provider ngrok: 5 wrong tokens with rotating forged CF-Connecting-IP -> 401 x5, then 429 "
                  "with a new forged value; another X-Forwarded-For visitor -> 200")


def check_auth_repeat_counted_once(ctx: Ctx):
    hdr = {"CF-Connecting-IP": "203.0.113.97"}
    for i in range(10):
        s, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr,
                            token="selftest-stale-token-repeat")
        if s != 401:
            return FAIL, "stale token re-sent, request {} returned {} (expected 401)".format(i + 1, s)
    s_ok, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr, token=ctx.token)
    if s_ok != 200:
        return FAIL, ("right token after the same wrong token was sent 10 times returned {} "
                      "(expected 200: a repeat counts once)").format(s_ok)
    return PASS, ("one wrong token sent 10 times from a tunnel visitor -> 401 x10, then the right "
                  "token -> 200 (a repeat counts once)")


def check_auth_blank_not_counted(ctx: Ctx):
    hdr = {"CF-Connecting-IP": "203.0.113.96"}
    probes = (
        ("empty cookie", "/api/state", dict(hdr, Cookie="wf_session=")),
        ("blank Bearer", "/api/state", dict(hdr, Authorization="Bearer     ")),
        ("blank ?token=", "/?token=%20", dict(hdr)),
    )
    for label, path, headers in probes:
        for i in range(6):
            s, _ = http_request(ctx.port, "GET", path, headers=headers)
            if s != 401:
                return FAIL, "{} request {} returned {} (expected 401)".format(label, i + 1, s)
    s_ok, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr, token=ctx.token)
    if s_ok != 200:
        return FAIL, ("right token after 18 blank-credential requests returned {} "
                      "(expected 200: blank is absent, never counted)").format(s_ok)
    return PASS, ("empty cookie, blank Bearer and blank ?token= x6 each from a tunnel visitor -> 401 "
                  "every time, then the right token -> 200 (blank credentials are never counted)")


def check_auth_shared_lock_token_passes(ctx: Ctx):
    cfg_path = ctx.fixture / "specs" / "worker-fleet.config.json"
    original = cfg_path.read_bytes()
    try:
        cfg = json.loads(original.decode("utf-8"))
        cfg["dashboard"]["tunnel"]["provider"] = "local"
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        hdr_a = {"CF-Connecting-IP": "203.0.113.171"}
        hdr_b = {"CF-Connecting-IP": "203.0.113.172"}
        for i in range(5):
            s, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr_a,
                                token="selftest-shared-wrong-token-{}".format(i))
            if s != 401:
                return FAIL, "provider local, visitor A wrong token {} returned {} (expected 401)".format(i + 1, s)
        s_ok, _ = http_request(ctx.port, "GET", "/api/state", headers=hdr_b, token=ctx.token)
        if s_ok != 200:
            return FAIL, ("provider local, other address with the correct token returned {} "
                          "(expected 200: a locked shared entry lets the correct token through)").format(s_ok)
        conn = http.client.HTTPConnection("127.0.0.1", ctx.port, timeout=10.0)
        try:
            conn.request("GET", "/api/state", headers=dict(
                hdr_b, Authorization="Bearer selftest-shared-wrong-token-final"))
            resp = conn.getresponse()
            resp.read()
            s6, retry = resp.status, resp.getheader("Retry-After")
        finally:
            conn.close()
        if s6 != 429 or not retry:
            return FAIL, ("a sixth wrong token on the locked shared entry returned {} "
                          "Retry-After={!r} (expected 429 with Retry-After)").format(s6, retry)
    finally:
        cfg_path.write_bytes(original)
    return PASS, ("provider local: 5 wrong tokens from visitor A -> 401 x5; the correct token from another "
                  "address -> 200; a sixth wrong token -> 429 with Retry-After {}".format(retry))


def check_auth_lockout(ctx: Ctx):
    # threshold is read from the server source so the check tracks the
    # server's own configuration instead of a hardcoded guess
    m = re.search(r"AUTH_FAILURE_THRESHOLD\s*=\s*(\d+)", ctx.server_src)
    threshold = int(m.group(1)) if m else 5

    for i in range(threshold):
        s, _ = http_request(ctx.port, "POST", "/api/action",
                            token="selftest-invalid-token-{}".format(i),
                            payload={"action": "selftest_probe_action"})
        if s != 401:
            return FAIL, "invalid-token attempt {} returned {} (expected 401)".format(i + 1, s)
    s_next, _ = http_request(ctx.port, "POST", "/api/action",
                             token="selftest-invalid-token-final",
                             payload={"action": "selftest_probe_action"})
    if s_next != 429:
        return FAIL, ("attempt {} with another invalid token returned {} "
                      "(expected 429 lockout)").format(threshold + 1, s_next)
    # loopback reads without a token stay frictionless DURING the lockout
    s_read, _ = http_request(ctx.port, "GET", "/api/state")
    if s_read != 200:
        return FAIL, "loopback GET without token during lockout returned {} (expected 200)".format(s_read)
    return PASS, ("AUTH_FAILURE_THRESHOLD={}: {} invalid tokens -> 401 x{}, attempt {} -> 429 "
                  "(IP locked out); loopback read without token stays 200 during lockout"
                  ).format(threshold, threshold, threshold, threshold + 1)


def check_auth_failure_table_bounded(ctx: Ctx):
    import importlib.util
    path = ctx.fixture / ".claude" / "scripts" / "dashboard-server.py"
    spec = importlib.util.spec_from_file_location("selftest_dash_bounded", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for helper in ("auth_register_failure", "auth_is_locked", "auth_register_success",
                   "auth_failure_table_size"):
        if not hasattr(mod, helper):
            return FAIL, "dashboard-server.py has no {}()".format(helper)
    cap = mod.AUTH_FAILURE_MAX_KEYS
    threshold = mod.AUTH_FAILURE_THRESHOLD
    seconds = mod.AUTH_LOCKOUT_SECONDS
    t0 = 1_000_000.0

    # per visitor only: 30 distinct proxied keys, one failure each, share no limit
    for i in range(30):
        mod.auth_register_failure("proxied:203.0.113.{}".format(i), "proxied", now=t0)
    if mod.auth_is_locked("proxied:198.51.100.200", "proxied", now=t0):
        return FAIL, "a never-seen proxied key is locked after 30 other keys failed once"

    # an early lock, then 10,000 distinct LAN keys and 10,000 proxied keys
    for _ in range(threshold):
        mod.auth_register_failure("10.0.0.1", "lan", now=t0)
    if not mod.auth_is_locked("10.0.0.1", "lan", now=t0):
        return FAIL, "the early LAN key is not locked after {} failures".format(threshold)
    for i in range(10000):
        mod.auth_register_failure("10.{}.{}.{}".format(1 + i // 65536, (i // 256) % 256, i % 256),
                                  "lan", now=t0)
        mod.auth_register_failure("proxied:2001:db8::{:x}".format(i), "proxied", now=t0)
    size = mod.auth_failure_table_size()
    if size > cap + 2:
        return FAIL, "table size {} exceeds AUTH_FAILURE_MAX_KEYS + 2 = {}".format(size, cap + 2)
    if not mod.auth_is_locked("10.0.0.1", "lan", now=t0):
        return FAIL, "the early LAN lock was evicted by the flood"
    if mod.auth_is_locked("127.0.0.1", "local", now=t0):
        return FAIL, "127.0.0.1 is locked by LAN/tunnel traffic"

    # 2000 s later one new failure prunes everything expired
    mod.auth_register_failure("10.99.99.99", "lan", now=t0 + 2000)
    size2 = mod.auth_failure_table_size()
    if size2 > 2:
        return FAIL, "table size {} after 2000 s (expected at most 2)".format(size2)
    if mod.auth_is_locked("10.0.0.1", "lan", now=t0 + 2000):
        return FAIL, "the early lock did not expire after 2000 s"
    return PASS, ("30 distinct proxied keys with one failure each lock nothing; after 10,000 LAN and "
                  "10,000 proxied keys the table holds {} entries (cap {} + 2), the early lock survives, "
                  "127.0.0.1 is free; 2000 s later it holds {} and the early lock has expired"
                  ).format(size, cap, size2)


def check_auth_shared_success_keeps_count(ctx: Ctx):
    import importlib.util
    path = ctx.fixture / ".claude" / "scripts" / "dashboard-server.py"
    spec = importlib.util.spec_from_file_location("selftest_dash_shared", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for helper in ("auth_register_failure", "auth_is_locked", "auth_register_success",
                   "auth_lock_is_shared"):
        if not hasattr(mod, helper):
            return FAIL, "dashboard-server.py has no {}()".format(helper)
    t0 = 2_000_000.0

    # a shared key: 4 failures, a success, 1 more failure -> locked
    for _ in range(4):
        mod.auth_register_failure("proxied:unknown", "proxied", now=t0)
    mod.auth_register_success("proxied:unknown")
    mod.auth_register_failure("proxied:unknown", "proxied", now=t0)
    if not mod.auth_is_locked("proxied:unknown", "proxied", now=t0):
        return FAIL, "proxied:unknown is not locked after 4 failures, a success and 1 more failure"

    # a per-visitor key: 4 failures, a success, 4 more failures -> not locked
    key = "proxied:203.0.113.180"
    for _ in range(4):
        mod.auth_register_failure(key, "proxied", now=t0)
    mod.auth_register_success(key)
    for _ in range(4):
        mod.auth_register_failure(key, "proxied", now=t0)
    if mod.auth_is_locked(key, "proxied", now=t0):
        return FAIL, "a per-visitor key is locked after 4 failures, a success and 4 more failures"

    if not mod.auth_lock_is_shared("proxied:unknown", "proxied", now=t0):
        return FAIL, "auth_lock_is_shared is false for the locked proxied:unknown"
    mod.auth_register_failure(key, "proxied", now=t0 + 1)
    if not mod.auth_is_locked(key, "proxied", now=t0 + 1):
        return FAIL, "the per-visitor key did not lock after a fifth failure"
    if mod.auth_lock_is_shared(key, "proxied", now=t0 + 1):
        return FAIL, "auth_lock_is_shared is true for a locked per-visitor key"
    return PASS, ("proxied:unknown: 4 failures, a success, 1 more -> locked; a per-visitor key: 4, a success, "
                  "4 more -> not locked; auth_lock_is_shared true for proxied:unknown, false for a locked "
                  "per-visitor key")


# Gitignored runtime paths that a live dashboard scheduler (or Python itself)
# rewrites while the idempotence check runs; they are not apply-setup output.
RUNTIME_SNAPSHOT_SUFFIXES = (".pyc", ".pyo", ".pyd", ".log", ".tmp")
RUNTIME_SNAPSHOT_EXCLUDES = "job/, __pycache__/, *.pyc, *.log, *.tmp"


def tree_snapshot(root: Path):
    """relpath -> sha256(content) for every regular file under root, skipping
    runtime artifacts (top-level job/, __pycache__/, bytecode, *.log, *.tmp).
    A file that vanishes between listing and reading is skipped."""
    snap = {}
    for dirpath, dirnames, filenames in os.walk(root):
        skip = {"__pycache__", ".git", "worktrees"}
        if Path(dirpath) == root:
            skip.add("job")
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        for fn in sorted(filenames):
            fpath = Path(dirpath) / fn
            if fpath.suffix.lower() in RUNTIME_SNAPSHOT_SUFFIXES:
                continue
            try:
                if fpath.is_symlink():
                    continue
                digest = hashlib.sha256(fpath.read_bytes()).hexdigest()
            except (FileNotFoundError, NotADirectoryError):
                continue
            snap[str(fpath.relative_to(root))] = digest
    return snap


def check_apply_setup_idempotent(ctx: Ctx):
    before = tree_snapshot(ctx.fixture)
    run_fixture_apply_setup(ctx.fixture)   # run A
    after_a = tree_snapshot(ctx.fixture)
    run_fixture_apply_setup(ctx.fixture)   # run B (the "second run")
    after_b = tree_snapshot(ctx.fixture)

    diff_a = [k for k in set(before) | set(after_a) if before.get(k) != after_a.get(k)]
    diff_b = [k for k in set(after_a) | set(after_b) if after_a.get(k) != after_b.get(k)]
    if diff_a or diff_b:
        changed = sorted(set(diff_a) | set(diff_b))[:5]
        return FAIL, ("apply-setup is not idempotent - files changed across consecutive "
                      "runs: {}").format(", ".join(changed))

    auth_file = ctx.fixture / "job" / "dashboard-auth.json"
    try:
        tok_now = str(json.loads(auth_file.read_text(encoding="utf-8"))["authToken"]).strip()
    except Exception:
        return FAIL, "fixture auth file unreadable after apply-setup runs"
    if tok_now != ctx.token:
        return FAIL, "apply-setup rotated the dashboard token on a re-run (token must be stable)"
    return PASS, ("two consecutive apply-setup runs on the temp fixture produced zero diff "
                  "across {} files (runtime paths excluded: {}); dashboard auth token "
                  "unchanged").format(len(after_b), RUNTIME_SNAPSHOT_EXCLUDES)


def check_no_secrets_tracked(ctx: Ctx):
    # feature-absence detection (pre-002 condition): a committed dashboard
    # token in the tracked config means 002's hygiene has not landed here.
    committed = committed_config_token()
    if committed:
        return SKIP, ("specs/worker-fleet.config.json still carries a committed dashboard "
                      "authToken (pre-002 secret hygiene; ticket 002 not merged in this "
                      "branch) - rotate it via apply-setup.py once 002 lands, then re-run")

    scanned, hits = scan_repo_for_secrets()
    if hits:
        shown = ", ".join("{}:{} [{} {}]".format(p, ln, pn, pv)
                          for p, ln, pn, pv in hits[:5])
        more = " (+{} more)".format(len(hits) - 5) if len(hits) > 5 else ""
        return FAIL, "secret-shaped value(s) in the working tree: {}{}".format(shown, more)
    return PASS, ("no secret-shaped values in {} scanned files "
                  "(excluded: job/, .git/, evidence dirs, nested worktrees, "
                  "ticket-spec markdown)").format(scanned)


def check_no_live_token_in_files(ctx: Ctx):
    """Ticket 046: the live token and token=<32 hex> never sit in a committable file."""
    names, err = list_git_addable_files()
    if err:
        return SKIP, "cannot list files: git ls-files failed ({})".format(err)
    paths = []
    seen = set()
    for n in names:
        if n not in seen:
            seen.add(n)
            paths.append(n)
    evidence_dir = REPO_ROOT / "specs" / "regression-evidence"
    if evidence_dir.is_dir():
        for dirpath, _dirnames, filenames in os.walk(evidence_dir):
            for fn in filenames:
                try:
                    rel = (Path(dirpath) / fn).relative_to(REPO_ROOT).as_posix()
                except ValueError:
                    continue
                if rel not in seen:
                    seen.add(rel)
                    paths.append(rel)
    live = read_live_dashboard_token()
    entries = {}
    scanned = 0
    for rel in paths:
        name_kinds = []
        if live and live in rel:
            name_kinds.append("live-token")
        if TOKEN_PARAM_RE.search(rel):
            name_kinds.append("token-param")
        if name_kinds:
            entries[(rel, 0)] = name_kinds
        fpath = REPO_ROOT / rel
        try:
            if fpath.is_symlink() or not fpath.is_file():
                continue
            if fpath.suffix.lower() in BINARY_SUFFIXES or fpath.stat().st_size > 2_000_000:
                continue
            text = fpath.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        for line_no, line in enumerate(text.split("\n"), 1):
            kinds = []
            if live and live in line:
                kinds.append("live-token")
            if TOKEN_PARAM_RE.search(line):
                kinds.append("token-param")
            if kinds:
                entries[(rel, line_no)] = kinds
    if entries:
        ordered = sorted(entries)
        shown = ", ".join("{}:{} [{}]".format(mask_token_in_path(p, live), ln,
                                              ", ".join(entries[(p, ln)]))
                          for p, ln in ordered[:10])
        more = " (+{} more)".format(len(ordered) - 10) if len(ordered) > 10 else ""
        return FAIL, "token found in {} place(s): {}{}".format(len(ordered), shown, more)
    return PASS, ("no live dashboard token and no token=<32 hex> in {} files "
                  "(git-addable files plus specs/regression-evidence/); "
                  "live token: {}".format(scanned, "checked" if live else "none configured"))


def check_no_provider_secrets_in_files(ctx: Ctx):
    """Ticket 048: no Telegram bot token, Slack webhook or URL credentials in a committable file."""
    names, err = list_git_addable_files()
    if err:
        return SKIP, "cannot list files: git ls-files failed ({})".format(err)
    paths = []
    seen = set()
    for n in names:
        if n not in seen:
            seen.add(n)
            paths.append(n)
    entries = {}
    scanned = 0
    for rel in paths:
        name_kinds = [kind for kind, rx in PROVIDER_SECRET_PATTERNS if rx.search(rel)]
        if name_kinds:
            entries[(rel, 0)] = name_kinds
        fpath = REPO_ROOT / rel
        try:
            if fpath.is_symlink() or not fpath.is_file():
                continue
            if fpath.suffix.lower() in BINARY_SUFFIXES or fpath.stat().st_size > 2_000_000:
                continue
            text = fpath.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        for line_no, line in enumerate(text.split("\n"), 1):
            kinds = [kind for kind, rx in PROVIDER_SECRET_PATTERNS if rx.search(line)]
            if kinds:
                entries[(rel, line_no)] = kinds
    if entries:
        ordered = sorted(entries)
        shown = ", ".join("{}:{} [{}]".format(mask_provider_secrets_in_path(p), ln,
                                              ", ".join(entries[(p, ln)]))
                          for p, ln in ordered[:10])
        more = " (+{} more)".format(len(ordered) - 10) if len(ordered) > 10 else ""
        return FAIL, "provider secret found in {} place(s): {}{}".format(len(ordered), shown, more)
    return PASS, ("no Telegram bot token, Slack webhook or URL credentials in {} git-addable files "
                  "(gitignored paths such as job/ are not scanned)").format(scanned)


def check_notify_secrets_migrated(ctx: Ctx):
    """Ticket 048: apply-setup moves inline provider secrets into job/notify-secrets.json."""
    base = Path("/tmp/opencode")
    base.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="selftest-notify-", dir=str(base)))
    try:
        # Fake values, assembled at runtime so no literal here has a secret shape.
        fake_tg = "".join(["9876", "54321"]) + ":" + "selftest_" * 4 + "tg"
        fake_slack = "".join(["https:", "//", "hooks", ".slack", ".com", "/services/"]) + \
            "TSELFTEST1/BSELFTEST1/" + "selftestwebhook" * 2
        fake_user, fake_pass = "selftestuser", "".join(["Selftest", "Pass", "9"])
        fake_cred = fake_user + ":" + fake_pass
        fake_ntfy = "".join(["https:", "//"]) + fake_cred + "".join(["@", "ntfy.example/selftest-topic"])
        values = [fake_tg, fake_slack, fake_cred, fake_pass]

        scripts = work / ".claude" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy2(ctx.fixture / ".claude" / "scripts" / "apply-setup.py", scripts / "apply-setup.py")
        cfg_path = work / "specs" / "worker-fleet.config.json"
        cfg_path.parent.mkdir(parents=True)
        config = fixture_config(ctx.port)
        config["notifications"] = {"providers": [
            {"type": "telegram", "botToken": fake_tg, "chatId": "-100123", "events": "all"},
            {"type": "slack", "webhook": fake_slack, "events": ["ticket_done"]},
            {"type": "ntfy", "target": fake_ntfy, "events": "all"},
        ]}
        cfg_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        secrets_path = work / "job" / "notify-secrets.json"

        def run_apply():
            return subprocess.run(
                [sys.executable, str(scripts / "apply-setup.py"), "--config", str(cfg_path)],
                cwd=str(work), capture_output=True, text=True, timeout=60, check=False)

        def leaks(text):
            return any(v in text for v in values)

        run1 = run_apply()
        if run1.returncode != 0:
            return FAIL, "apply-setup run 1 exited {} (expected 0)".format(run1.returncode)
        cfg_text = cfg_path.read_text(encoding="utf-8")
        if leaks(cfg_text):
            return FAIL, "the config still holds an inline provider secret after run 1"
        try:
            providers = json.loads(cfg_text)["notifications"]["providers"]
            tg_ref, slack_ref = providers[0]["botToken"], providers[1]["webhook"]
            ntfy_ref, ntfy_target = providers[2]["auth"], providers[2]["target"]
        except (KeyError, IndexError, TypeError, ValueError):
            return FAIL, "the config providers lost their reference fields after run 1"
        refs = [tg_ref, slack_ref, ntfy_ref]
        if not all(isinstance(r, dict) and list(r) == ["secretRef"] for r in refs) or "@" in str(ntfy_target):
            return FAIL, "the three secret fields are not {\"secretRef\": ...} references (or the ntfy target kept credentials)"
        try:
            mode = secrets_path.stat().st_mode & 0o777
            stored = json.loads(secrets_path.read_text(encoding="utf-8"))["secrets"]
        except (OSError, KeyError, TypeError, ValueError):
            return FAIL, "job/notify-secrets.json is missing or unreadable after run 1"
        if mode != 0o600:
            return FAIL, "job/notify-secrets.json has mode {:o} (expected 600)".format(mode)
        if [stored.get(r["secretRef"]) for r in refs] != [fake_tg, fake_slack, fake_cred]:
            return FAIL, "job/notify-secrets.json does not map each reference to its value"
        if leaks(run1.stdout + run1.stderr):
            return FAIL, "apply-setup run 1 printed a provider secret"
        before_cfg, before_sec = cfg_path.read_bytes(), secrets_path.read_bytes()
        run2 = run_apply()
        if run2.returncode != 0:
            return FAIL, "apply-setup run 2 exited {} (expected 0)".format(run2.returncode)
        if leaks(run2.stdout + run2.stderr):
            return FAIL, "apply-setup run 2 printed a provider secret"
        if cfg_path.read_bytes() != before_cfg or secrets_path.read_bytes() != before_sec:
            return FAIL, "a second apply-setup run changed the config or the secrets file"
        return PASS, ("apply-setup moved 3 inline provider secrets (telegram botToken, slack webhook, "
                      "ntfy URL credentials) into job/notify-secrets.json (mode 0600), left references "
                      "in the config, printed none of them, and a second run changed nothing")
    finally:
        shutil.rmtree(work, ignore_errors=True)


# Ticket 077 / 086: find every python3 command in a shell script line and
# judge whether it is isolated (python3 -I, run from /, or a script by path).
#
# A command position is the start of the line, or the point after ; & | ( {
# $( or a backtick. Any run of prefixes may follow it: the keywords if, then,
# do, else, elif, while, until and !; NAME=value assignments; the wrappers
# exec, nohup, command; env and sudo (with flag groups); timeout (with flag
# groups and a duration). Text in single quotes, text in double quotes (except
# inside a $( ... ) there) and a trailing comment are masked before the match,
# at the same offsets, so the match positions index the original line.
_PY_KEYWORD = r"(?:if|then|do|else|elif|while|until|!)"
_PY_ASSIGN = (r"[A-Za-z_][A-Za-z0-9_]*="
              r"(?:\"[^\"]*\"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|[^\s;&|()`'\"]*)")
_PY_WRAPPER = (r"(?:exec|nohup|command"
               r"|env(?:\s+-[A-Za-z]+)*"
               r"|sudo(?:\s+-[A-Za-z]+)*"
               r"|timeout(?:\s+-[A-Za-z]+)*\s+[0-9]+(?:\.[0-9]+)?[smhd]?)")
PYTHON_CMD_RE = re.compile(
    r"(?:^|[;&|({`]|\$\()\s*"
    r"(?:(?:" + _PY_KEYWORD + "|" + _PY_ASSIGN + "|" + _PY_WRAPPER + r")\s+)*"
    r"(?P<py>python3?)(?=[\s;&|)`]|$)")

_PY_OPTION_RE = re.compile(r"\s+-([A-Za-z]+)(?=[\s;&|)`]|$)")
_PY_SCRIPT_PATH_RE = re.compile(r"\s+\"?[^\s\"-][^\s\"]*\.py\"?(\s|$)")


def mask_shell_line(line):
    """Blank the text that is not a command: same length, same offsets.

    Single-quoted text and double-quoted text become spaces (the quote marks
    stay); a $( ... ) inside double quotes stays visible, it is a real
    command; an unquoted # at the start of a word masks the rest of the line
    ($# and ${#x} are not comments).
    """
    out = list(line)
    n = len(line)
    stack = []  # "dq" inside "...", "sub" inside $( ), "paren" inside ( ) in a $( )
    i = 0
    while i < n:
        c = line[i]
        top = stack[-1] if stack else None
        if top == "dq":
            if c == "\\":
                for k in (i, i + 1):
                    if k < n:
                        out[k] = " "
                i += 2
            elif c == '"':
                stack.pop()
                i += 1
            elif c == "$" and line[i + 1:i + 2] == "(":
                stack.append("sub")
                i += 2
            else:
                out[i] = " "
                i += 1
            continue
        if c == "\\":
            i += 2
        elif c == "'":
            j = line.find("'", i + 1)
            end = n if j < 0 else j
            for k in range(i + 1, end):
                out[k] = " "
            i = end + 1
        elif c == '"':
            stack.append("dq")
            i += 1
        elif c == "$" and line[i + 1:i + 2] == "(":
            stack.append("sub")
            i += 2
        elif c == "(" and top in ("sub", "paren"):
            stack.append("paren")
            i += 1
        elif c == ")" and top in ("sub", "paren"):
            stack.pop()
            i += 1
        elif c == "#" and (i == 0 or line[i - 1].isspace() or line[i - 1] in ";&|(`"):
            for k in range(i, n):
                out[k] = " "
            break
        else:
            i += 1
    return "".join(out)


def python_option_isolates(rest):
    """True when -I is in the leading option groups of a python3 command.

    `rest` is the original text after the interpreter word. An I counts only
    before any c or m letter and before the first word that is not a
    single-dash option: -I -c, -Ic, -sI -c and -E -I count; -c -I, -cI,
    -m json.tool -I and `- -I` do not (there -I is the program's argument).
    """
    pos = 0
    while True:
        m = _PY_OPTION_RE.match(rest, pos)
        if not m:
            return False
        for letter in m.group(1):
            if letter == "I":
                return True
            if letter in "cm":
                return False
        pos = m.end()


def python_invocations(path):
    """Every python3 command in one shell script: [(line_no, line, verdict)].

    verdict is None when the command is not isolated, else the reason it is.
    """
    out = []
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    for n, line in enumerate(lines, 1):
        if line.lstrip().startswith("#"):
            continue
        masked = mask_shell_line(line)
        for m in PYTHON_CMD_RE.finditer(masked):
            start = m.start("py")
            rest = line[m.end("py"):]
            if python_option_isolates(rest):
                verdict = "isolated (-I)"
            elif "cd / &&" in line[:start]:
                verdict = "isolated (runs from /)"
            elif _PY_SCRIPT_PATH_RE.match(rest):
                verdict = "script by path (its own directory, not the working directory, is on sys.path)"
            else:
                verdict = None
            out.append((n, line, verdict))
    return out


def check_scripts_python_isolated(ctx: Ctx):
    """Ticket 077: every python3 command in .claude/scripts/*.sh is isolated."""
    scripts_dir = REPO_ROOT / ".claude" / "scripts"
    total, bad = 0, []
    for sh in sorted(scripts_dir.glob("*.sh")):
        try:
            found = python_invocations(sh)
        except (OSError, UnicodeDecodeError):
            return FAIL, "cannot read {}".format(sh.name)
        for n, _line, verdict in found:
            total += 1
            if verdict is None:
                loc = "{}:{}".format(sh.name, n)
                if loc not in bad:
                    bad.append(loc)
    if bad:
        return FAIL, ("python3 without -I, a script path or a (cd / && ...) subshell: {}"
                      .format(", ".join(bad)))
    return PASS, "{} python3 commands in .claude/scripts/*.sh are isolated".format(total)


# --- runner ------------------------------------------------------------------
# FR-1 inventory. Execution order matters: auth_lockout runs LAST among the
# server checks (it locks the client IP for 10 minutes), and apply-setup /
# secret-scan need no server at all.

RUN_ORDER = [
    ("auth_loopback_read_open", check_auth_loopback_read_open),
    ("state_hides_token", check_state_hides_token),
    ("api_files_hide_token", check_api_files_hide_token),
    ("auth_post_requires_token", check_auth_post_requires_token),
    ("auth_lan_spoof_rejected", check_auth_lan_spoof_rejected),
    ("auth_local_host_allowlist", check_auth_local_host_allowlist),
    ("auth_query_token_post_rejected", check_auth_query_token_post_rejected),
    ("action_post_requires_header_token", check_action_post_requires_header_token),
    ("action_post_cross_origin_rejected", check_action_post_cross_origin_rejected),
    ("action_post_requires_json", check_action_post_requires_json),
    ("action_validation", check_action_validation),
    ("board_parsing", check_board_parsing),
    ("evidence_path_safety", check_evidence_path_safety),
    ("evidence_served_inert", check_evidence_served_inert),
    ("audit_logged", check_audit_logged),
    ("auth_proxied_requires_token", check_auth_proxied_requires_token),
    ("signin_page_for_remote", check_signin_page_for_remote),
    ("app_page_csp", check_app_page_csp),
    ("local_bootstrap_sets_no_cookie", check_local_bootstrap_sets_no_cookie),
    ("auth_lockout_keyed_per_client", check_auth_lockout_keyed_per_client),
    ("auth_lockout_provider_keyed", check_auth_lockout_provider_keyed),
    ("auth_repeat_counted_once", check_auth_repeat_counted_once),
    ("auth_blank_not_counted", check_auth_blank_not_counted),
    ("auth_shared_lock_token_passes", check_auth_shared_lock_token_passes),
    ("auth_lockout", check_auth_lockout),
    ("auth_failure_table_bounded", check_auth_failure_table_bounded),
    ("auth_shared_success_keeps_count", check_auth_shared_success_keeps_count),
    ("apply_setup_idempotent", check_apply_setup_idempotent),
    ("notify_secrets_migrated", check_notify_secrets_migrated),
    ("no_secrets_tracked", check_no_secrets_tracked),
    ("no_live_token_in_files", check_no_live_token_in_files),
    ("no_provider_secrets_in_files", check_no_provider_secrets_in_files),
    ("scripts_python_isolated", check_scripts_python_isolated),
]
CHECK_NAMES = [name for name, _ in RUN_ORDER]
SERVER_CHECKS = {
    "auth_loopback_read_open", "state_hides_token", "api_files_hide_token",
    "auth_post_requires_token",
    "auth_lan_spoof_rejected",
    "auth_query_token_post_rejected", "action_validation", "board_parsing",
    "evidence_path_safety", "audit_logged",
    "auth_proxied_requires_token", "signin_page_for_remote",
    "auth_lockout_keyed_per_client", "auth_lockout",
    "action_post_requires_header_token", "action_post_cross_origin_rejected",
    "action_post_requires_json", "evidence_served_inert",
    "auth_lockout_provider_keyed", "auth_repeat_counted_once", "auth_blank_not_counted",
    "auth_shared_lock_token_passes",
    "auth_local_host_allowlist", "app_page_csp", "local_bootstrap_sets_no_cookie",
}


def run_checks(selected):
    fixture = None
    server_proc = None
    counts = {PASS: 0, SKIP: 0, FAIL: 0}
    try:
        try:
            fixture, port, token = build_fixture()
        except SetupError as e:
            print("ERROR: fixture setup failed: {}".format(e), file=sys.stderr)
            return 1

        needs_server = any(name in SERVER_CHECKS for name, _ in selected)
        server_ok, server_log = False, fixture / "server.log"
        if needs_server:
            tried = {port}
            for attempt in range(1, SERVER_START_ATTEMPTS + 1):
                server_proc, server_ok, server_log = start_fixture_server(fixture, port)
                if server_ok:
                    break
                stop_fixture_server(server_proc)
                if attempt < SERVER_START_ATTEMPTS:
                    # another run (or program) holds this port: take a new one
                    try:
                        for _ in range(20):
                            port = pick_ephemeral_port()
                            if port not in tried:
                                break
                        tried.add(port)
                        retarget_fixture_port(fixture, port)
                    except (SetupError, OSError, ValueError) as e:
                        print("ERROR: fixture setup failed: {}".format(e), file=sys.stderr)
                        return 1
            print("# server: http://127.0.0.1:{} (ephemeral port in the {}-{} range)".format(
                port, *EPHEMERAL_PORT_RANGE))
        print("# fixture: {} (removed on exit)".format(fixture))

        ctx = Ctx(fixture, port, token, server_ok, server_log)
        for name, fn in selected:
            if name in SERVER_CHECKS and not server_ok:
                tail = log_tail(server_log)
                detail = "server did not start on port {}".format(port)
                if tail:
                    detail += " - log tail: " + tail.replace("\n", " | ")
                status, detail = FAIL, detail
            else:
                try:
                    status, detail = fn(ctx)
                except Exception as e:  # a crashed check is a failed check
                    status, detail = FAIL, "check raised {!r}".format(e)
            print("{} {} - {}".format(status, name, detail))
            counts[status] += 1
    finally:
        stop_fixture_server(server_proc)
        if fixture is not None:
            shutil.rmtree(fixture, ignore_errors=True)
            print("# cleanup: removed fixture {}".format(fixture))

    print("SUMMARY: {} passed, {} skipped, {} failed".format(
        counts[PASS], counts[SKIP], counts[FAIL]))
    return 1 if counts[FAIL] else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="worker-fleet workflow self-test suite (zero dependencies)")
    parser.add_argument("--list", action="store_true",
                        help="print the check names and exit")
    parser.add_argument("--filter", metavar="SUBSTRING", default=None,
                        help="run only checks whose name contains SUBSTRING")
    args = parser.parse_args(argv)

    if args.list:
        for name in CHECK_NAMES:
            print(name)
        return 0

    if args.filter is not None:
        needle = args.filter.lower()
        selected = [(n, f) for n, f in RUN_ORDER if needle in n]
        if not selected:
            print("FAIL filter-match - no checks matched filter '{}' "
                  "(use --list to see the available checks)".format(args.filter))
            print("SUMMARY: 0 passed, 0 skipped, 1 failed")
            return 1
    else:
        selected = list(RUN_ORDER)

    return run_checks(selected)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""dashboard-server.py: Fleet Control Dashboard server (:3080) for the
Claude Code / OpenCode / Codex worker-fleet Workflow v3.

Zero-dependency standard library Python 3 HTTP + JSON API server.
Provides real-time worktree status, ticket board inspection, visual evidence gallery,
multi-harness token telemetry (Claude Code, OpenCode, and Codex CLI), and PIN-protected remote actions.
"""

import argparse
from datetime import datetime, timezone
import glob
import hashlib
import hmac
import html
import http.server
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import secrets
import select
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse

# telemetry.py sits next to this script (ticket 014).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import telemetry as telemetry_mod  # noqa: E402


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def find_repo_root(start_dir: Path) -> Path:
    current = start_dir.resolve()
    for _ in range(5):
        if (current / ".claude").is_dir() or (current / "specs").is_dir() or (current / "README.md").is_file():
            return current
        if current.parent == current:
            break
        current = current.parent
    return start_dir.resolve()


REPO_ROOT = find_repo_root(Path(__file__).parent)

# Ticket 089: names this project used before the rename. Neither is ever honoured.
# The cookie is never accepted as a credential: it is only EXPIRED (FR-7), so an
# old token does not stay in browsers. The config path is only tested for
# existence, to refuse a start on defaults (FR-17).
LEGACY_SESSION_COOKIE = "sa_session"
LEGACY_CONFIG_REL = "specs/super-agent.config.json"

# --- Auth hardening (ticket 001) -------------------------------------------------
# Deny-by-default: authentication is decided by the CLIENT SOCKET ADDRESS; the
# Host header can only make a request stricter (ticket 064), never more trusted.
# Loopback may read without a token; every other client — and every POST
# /api/action — requires the token.
AUTH_FAILURE_THRESHOLD = 5       # failed credential attempts before lockout
AUTH_LOCKOUT_SECONDS = 600       # lockout duration (10 minutes, in-memory)

# Ticket 052: a request is LOCAL only when it comes from a loopback socket AND
# carries none of these proxy headers. cloudflared and ngrok reach the server
# from loopback but always add forwarding headers; a header can only make a
# request stricter (remote), never more trusted.
PROXY_HEADER_NAMES = (
    "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
    "X-Real-IP", "CF-Connecting-IP", "CF-Ray", "CDN-Loop", "True-Client-IP", "Via",
)

# Sign-in page (ticket 052): the message shown for each state, and its CSP.
SIGNIN_MESSAGES = {
    "signed-out": "",
    "invalid": "That token was not accepted. Check it and try again.",
    "locked": "Too many failed attempts. Sign-in is locked for up to 10 minutes; try again later.",
}
SIGNIN_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
    "frame-ancestors 'none'; base-uri 'none'"
)

# Ticket 056: the failure table is capped. Once it holds AUTH_FAILURE_MAX_KEYS
# entries, keys it has not seen share one overflow entry per kind (never a
# local key). An entry expires AUTH_LOCKOUT_SECONDS after its last failure.
AUTH_FAILURE_MAX_KEYS = 1024
AUTH_OVERFLOW_LAN_KEY = "overflow:lan"
AUTH_OVERFLOW_PROXIED_KEY = "proxied:overflow"

# Ticket 058: shared entries. These table keys are shared by many visitors (the
# two overflow entries, and the one key every tunnel visitor shares when the
# provider is local or unknown). While one is locked, the correct token of at
# least AUTH_BYPASS_MIN_TOKEN_LENGTH characters still gets in; wrong credentials
# are refused with 429, not counted.
AUTH_SHARED_KEYS = (AUTH_OVERFLOW_LAN_KEY, AUTH_OVERFLOW_PROXIED_KEY, "proxied:unknown")
AUTH_BYPASS_MIN_TOKEN_LENGTH = 32

# Ticket 058: the [auth] log lines hash the address with a per-process random
# salt, so the same address hashes differently after a restart and a logged
# hash cannot be reversed by enumerating addresses. The path is capped.
AUTH_LOG_SALT = secrets.token_bytes(16)
AUTH_LOG_PATH_MAX = 200

# POST /api/action (ticket 056): the token must arrive in a header.
ACTION_HEADER_TOKEN_ERROR = (
    "Unauthorized. Actions need the token in an Authorization: Bearer or "
    "X-Auth-Token header."
)

# Evidence is served inert (ticket 056): allow-listed raster images as images,
# everything else as plain text, always nosniff + sandbox CSP + no-store.
EVIDENCE_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
EVIDENCE_TEXT_TYPE = "text/plain; charset=utf-8"
EVIDENCE_CSP = "default-src 'none'; sandbox"

# Ticket 064: the app page's Content-Security-Policy. {nonce} is a fresh
# secrets.token_hex(16) per response; the page's own <script> tags carry it, so
# no other script (injected or inline handler) runs, and the page connects to and
# loads images from the dashboard origin only. It cannot be framed.
APP_CSP_TEMPLATE = (
    "default-src 'self'; script-src 'nonce-{nonce}'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "form-action 'self'; frame-ancestors 'none'"
)

_HOST_HEADER_RE = re.compile(
    r"(?P<host>\[[^\[\]]*\]|[^:\[\]]+)(?::[0-9]{1,5})?"
)


def host_is_local_name(host) -> bool:
    """Ticket 064 (DNS rebinding): True when a Host header names this computer
    in a way a web page cannot fake. That is no Host at all (or a blank one),
    `localhost` (one trailing dot allowed), an IPv4 address, or a bracketed IPv6
    address, each with an optional :port. Any other name (rebind.test,
    127.0.0.1.nip.io, app.localhost, ...) is False. A DNS rebinding page needs a
    DNS name, so an IP literal cannot be rebound."""
    if host is None:
        return True
    text = str(host).strip().lower()
    if not text:
        return True
    m = _HOST_HEADER_RE.fullmatch(text)
    if m is None:
        return False
    name = m.group("host")
    if name in ("localhost", "localhost."):
        return True
    try:
        if name.startswith("["):
            if not name.endswith("]"):
                return False
            ipaddress.IPv6Address(name[1:-1])
        else:
            ipaddress.IPv4Address(name)
    except ValueError:
        return False
    return True

# client key -> {"count": <failed attempts>, "lockedUntil": <unix ts>,
# "last": <unix ts of the latest failure>, "seen": <fingerprints counted>}
# Plain in-memory dict: intentional reset on server restart.
_auth_failures = {}
_auth_state_lock = threading.Lock()


def _auth_overflow_key(kind: str) -> str:
    return AUTH_OVERFLOW_LAN_KEY if kind == "lan" else AUTH_OVERFLOW_PROXIED_KEY


def auth_register_failure(key, kind, now=None, fingerprint=None):
    """Count one failed credential under `key` (ticket 056, FR-2). Prunes
    expired entries first; when the table is full, a non-local key without an
    entry is counted under its kind's overflow entry instead.

    Ticket 057, FR-1: a wrong value counts once. `fingerprint` is the first 16
    hex chars of sha256(value); when the picked entry has already counted it,
    nothing changes and 0 is returned. Otherwise the failure counts and the
    count after it is returned. With fingerprint=None it always counts."""
    now = time.time() if now is None else now
    with _auth_state_lock:
        for k in [
            k for k, e in _auth_failures.items()
            if e["lockedUntil"] <= now and now - e["last"] >= AUTH_LOCKOUT_SECONDS
        ]:
            del _auth_failures[k]
        table_key = key
        if (
            key not in _auth_failures
            and kind != "local"
            and len(_auth_failures) >= AUTH_FAILURE_MAX_KEYS
        ):
            table_key = _auth_overflow_key(kind)
        entry = _auth_failures.setdefault(
            table_key, {"count": 0, "lockedUntil": 0.0, "last": now, "seen": []}
        )
        seen = entry.setdefault("seen", [])
        if fingerprint is not None and fingerprint in seen:
            return 0
        entry["count"] += 1
        entry["last"] = now
        if entry["count"] >= AUTH_FAILURE_THRESHOLD:
            entry["lockedUntil"] = now + AUTH_LOCKOUT_SECONDS
        if fingerprint is not None and len(seen) < AUTH_FAILURE_THRESHOLD:
            seen.append(fingerprint)
        return entry["count"]


def auth_is_locked(key, kind, now=None):
    """True while the key's entry is locked. A non-local key with no entry
    while the table is full is judged by its kind's overflow entry."""
    now = time.time() if now is None else now
    with _auth_state_lock:
        entry = _auth_failures.get(key)
        if (
            entry is None
            and kind != "local"
            and len(_auth_failures) >= AUTH_FAILURE_MAX_KEYS
        ):
            entry = _auth_failures.get(_auth_overflow_key(kind))
        return bool(entry and entry["lockedUntil"] > now)


def auth_lock_seconds_left(key, kind, now=None):
    """Whole seconds until the lock that refuses this key ends (ticket 057,
    FR-5), rounded up and clamped to 1..AUTH_LOCKOUT_SECONDS; 0 when
    auth_is_locked(key, kind, now) is false. Judges the key exactly as
    auth_is_locked does: its own entry, or its kind's overflow entry."""
    now = time.time() if now is None else now
    with _auth_state_lock:
        entry = _auth_failures.get(key)
        if (
            entry is None
            and kind != "local"
            and len(_auth_failures) >= AUTH_FAILURE_MAX_KEYS
        ):
            entry = _auth_failures.get(_auth_overflow_key(kind))
        if not entry or entry["lockedUntil"] <= now:
            return 0
        left = entry["lockedUntil"] - now
        whole = int(left)
        if left > whole:
            whole += 1
        return max(1, min(whole, AUTH_LOCKOUT_SECONDS))


def auth_lock_is_shared(key, kind, now=None):
    """True exactly when auth_is_locked(key, kind, now) is true and the entry
    that judges the key has its table key in AUTH_SHARED_KEYS (ticket 058,
    FR-1). That entry is the key's own entry or, for a non-local key with no
    entry while the table is full, its kind's overflow entry."""
    now = time.time() if now is None else now
    with _auth_state_lock:
        table_key = key
        entry = _auth_failures.get(key)
        if (
            entry is None
            and kind != "local"
            and len(_auth_failures) >= AUTH_FAILURE_MAX_KEYS
        ):
            table_key = _auth_overflow_key(kind)
            entry = _auth_failures.get(table_key)
        return bool(
            entry and entry["lockedUntil"] > now and table_key in AUTH_SHARED_KEYS
        )


def auth_register_success(key):
    """Forget this key's failures, except a shared entry (ticket 058, FR-4):
    the overflow entries and proxied:unknown are never reset by a success, so
    one visitor's valid requests never hand fresh guesses to the others who
    share the entry."""
    if key in AUTH_SHARED_KEYS:
        return
    with _auth_state_lock:
        _auth_failures.pop(key, None)


def auth_failure_table_size():
    with _auth_state_lock:
        return len(_auth_failures)


# --- Audit trail (ticket 015) -----------------------------------------------------
# Every POST /api/action call — success or failure — appends exactly one JSON
# line to job/audit.jsonl: {"ts","action","ticket","params","clientIpHash",
# "outcome","userAgent"}. The client IP is stored ONLY as sha256(ip)[:12];
# plaintext IPs never touch the file (FR-5). The file is created on demand,
# bounded to the last AUDIT_MAX_ENTRIES entries (FR-4), and audit-write
# failures are logged to stderr and never block the action (FR-1).

AUDIT_LOG_PATH = REPO_ROOT / "job" / "audit.jsonl"
AUDIT_MAX_ENTRIES = 5000
_audit_lock = threading.Lock()


def hash_client_ip(ip: str) -> str:
    """sha256 of the client IP, first 12 hex chars (FR-5). IPv4-mapped IPv6
    socket addresses are normalized so one client always hashes identically."""
    ip = (ip or "").strip()
    if ip.lower().startswith("::ffff:"):
        ip = ip[7:]
    if not ip:
        return ""
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:12]


def hash_auth_log_addr(ip: str) -> str:
    """Salted address hash for [auth] log lines (ticket 058, FR-5): normalized
    like hash_client_ip(), sha256(AUTH_LOG_SALT + address)[:12]. The audit
    log keeps the unsalted hash_client_ip()."""
    ip = (ip or "").strip()
    if ip.lower().startswith("::ffff:"):
        ip = ip[7:]
    if not ip:
        return ""
    return hashlib.sha256(AUTH_LOG_SALT + ip.encode("utf-8")).hexdigest()[:12]


def safe_auth_log_path(path: str) -> str:
    """A request path made safe to log (ticket 058, FR-6): U+0000-U+001F and
    U+007F-U+009F removed, then cut to AUTH_LOG_PATH_MAX characters plus
    '...' when longer."""
    path = "".join(
        ch for ch in (path or "")
        if not (ord(ch) <= 0x1F or 0x7F <= ord(ch) <= 0x9F)
    )
    if len(path) > AUTH_LOG_PATH_MAX:
        path = path[:AUTH_LOG_PATH_MAX] + "..."
    return path


def append_audit_entry(action, ticket, params, client_ip, outcome, user_agent):
    """Append one audit line; bound the file to the last AUDIT_MAX_ENTRIES
    entries via the atomic temp-file + rename pattern (FR-4). Never raises:
    write failures are logged to stderr and never block the action (FR-1)."""
    entry = {
        "ts": utc_now_iso(),
        "action": str(action or ""),
        "ticket": str(ticket or ""),
        "params": params if isinstance(params, dict) else {},
        "clientIpHash": hash_client_ip(client_ip),
        "outcome": str(outcome or ""),
        "userAgent": str(user_agent or ""),
    }
    line = json.dumps(entry) + "\n"
    try:
        with _audit_lock:
            AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            # Tolerate a pre-existing file without a trailing newline (e.g.
            # hand-seeded): never concatenate two JSON objects onto one line.
            if AUDIT_LOG_PATH.is_file() and AUDIT_LOG_PATH.stat().st_size > 0:
                with open(AUDIT_LOG_PATH, "rb") as f:
                    f.seek(-1, os.SEEK_END)
                    if f.read(1) != b"\n":
                        line = "\n" + line
            with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line)
            # Bounding (FR-4): when the file exceeds the cap, rewrite it with
            # only the newest entries; os.replace makes the swap atomic.
            with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > AUDIT_MAX_ENTRIES:
                tmp_path = AUDIT_LOG_PATH.parent / (AUDIT_LOG_PATH.name + ".tmp")
                with open(tmp_path, "w", encoding="utf-8") as f:
                    f.writelines(lines[-AUDIT_MAX_ENTRIES:])
                os.replace(tmp_path, AUDIT_LOG_PATH)
    except Exception as e:
        print(f"[audit] failed to append audit entry: {e}", file=sys.stderr)


def read_audit_tail(tail: int):
    """Last `tail` audit entries in file order — oldest first, newest last
    (FR-2). A missing file yields []; malformed lines are skipped."""
    if tail < 1:
        return []
    try:
        with _audit_lock:
            if not AUDIT_LOG_PATH.is_file():
                return []
            with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()
    except Exception as e:
        print(f"[audit] failed to read audit log: {e}", file=sys.stderr)
        return []
    entries = []
    for raw in lines[-tail:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            entries.append(json.loads(raw))
        except Exception:
            continue
    return entries


# --- Remote control intents (ticket 013) -------------------------------------------
# The dashboard server stays non-privileged: remote control actions only
# validate the request and write ONE intent file per ticket under
# job/control/. The router's observe->reconcile->dispatch cycle (003) is the
# sole consumer: it executes each intent, then deletes the file. One intent
# per ticket at a time — a new intent overwrites the file and refreshes
# issuedAt.

CONTROL_DIR = REPO_ROOT / "job" / "control"
CONTROL_ACTIONS = ("pause_ticket", "resume_ticket", "stop_worker", "rerun_checker")


# Ticket ids are ASCII digits only (>= 3, "013"); [0-9] on purpose, so Unicode
# digits ("\u0661\u0663\u0663") are malformed, not merely unknown.
TICKET_ID_RE = re.compile(r"[0-9]{3,}")


def is_valid_ticket_id(ticket_id) -> bool:
    return isinstance(ticket_id, str) and TICKET_ID_RE.fullmatch(ticket_id) is not None


def resolve_ticket_dir(ticket_id):
    """Resolve a ticket id to its specs/tickets/NNN-* DIRECTORY, or None.

    The single resolver for every handler that reads or writes a ticket
    folder. Exact resolution only: the id must be 3+ ASCII digits, only
    directories named `{id}-*` match (sorted, first wins), and the result must
    live inside specs/tickets. Files (BOARD.md), bare prefixes ("01" vs
    013-*), full slugs, and traversal ("../../x") never resolve, so callers
    can answer 400 (malformed, see is_valid_ticket_id) or 404 (no folder)."""
    if not is_valid_ticket_id(ticket_id):
        return None
    try:
        root = (REPO_ROOT / "specs" / "tickets").resolve()
        for m in sorted(root.glob(f"{ticket_id}-*")):
            if m.is_dir() and m.resolve().is_relative_to(root):
                # Hand back the path under REPO_ROOT as configured (not the
                # symlink-resolved one) so relative_to(REPO_ROOT) keeps working.
                return REPO_ROOT / "specs" / "tickets" / m.name
    except Exception:
        return None
    return None


def find_ticket_folder(ticket_id: str):
    """Back-compat name for resolve_ticket_dir (control-action handlers)."""
    return resolve_ticket_dir(ticket_id)


def _ticket_num(entry) -> str:
    """Leading digit id of a ledger/intent entry ("013-remote-control" -> "013")."""
    m = re.match(r"\d+", str(entry).strip())
    return m.group(0) if m else ""


def get_paused_tickets() -> list:
    """Ticket ids in the router ledger's `paused` set (job/router-state.json).
    The key may be absent or the file missing/corrupt -> []. Entries may be
    "NNN" or "NNN-slug"; both normalize to NNN."""
    try:
        ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        return []
    paused = ledger.get("paused") if isinstance(ledger, dict) else None
    if not isinstance(paused, list):
        return []
    out = []
    for e in paused:
        n = _ticket_num(e)
        if n and n not in out:
            out.append(n)
    return out


# Ticket 047: router pipeline stage of in-progress tickets, read-only.
PIPELINE_LEGACY_PHASES = {
    "reading-spec": "building", "implementing": "building", "delegating": "building",
    "testing": "building", "fixing": "building",
    "done": "worker-done", "blocked": "awaiting-user",
}
PIPELINE_LABELS = {
    "building": "building",
    "worker-done": "awaiting review",
    "reviewing": "in review",
    "changes-requested": "changes requested",
    "approved-awaiting-merge": "approved · awaiting merge",
    "merging": "merging",
    "held": "held",
    "paused": "paused",
    "awaiting-user": "needs your decision",
}


def get_pipeline_state() -> dict:
    """Read-only pipeline map from job/router-state.json (ticket 047):
    {"NNN": {"phase", "label", "heldReason", "updatedAt"}}. Only these four
    fields leave the ledger. Never raises; a missing/unreadable/invalid ledger
    gives {}. Legacy heartbeat-style lastPhase values are mapped; tickets in
    `pendingDecisions` are always `awaiting-user`; unknown phases get no entry."""
    try:
        ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
        if not isinstance(ledger, dict):
            return {}
        top_at = ledger.get("updatedAt")
        top_at = top_at.strip() if isinstance(top_at, str) else ""
        entries = {}
        dispatched = ledger.get("dispatched")
        if isinstance(dispatched, list):
            for e in dispatched:
                if not isinstance(e, dict):
                    continue
                n = _ticket_num(e.get("ticket"))
                if n:
                    entries[n] = e  # last entry wins
        phases = {}
        for n, e in entries.items():
            raw = e.get("lastPhase")
            phase = raw.strip().lower() if isinstance(raw, str) else ""
            phases[n] = PIPELINE_LEGACY_PHASES.get(phase, phase)
        pending = ledger.get("pendingDecisions")
        if isinstance(pending, list):
            for p in pending:
                if isinstance(p, str):
                    n = _ticket_num(p)
                    if n:
                        phases[n] = "awaiting-user"
        out = {}
        for n, phase in phases.items():
            if phase not in PIPELINE_LABELS:
                continue
            e = entries.get(n, {})
            held = ""
            if phase == "held":
                hr = e.get("heldReason")
                if isinstance(hr, str):
                    held = " ".join(hr.split())[:120].strip()
            label = PIPELINE_LABELS[phase]
            if phase == "held" and held:
                label = "held: " + held
            at = e.get("lastPhaseAt")
            at = at.strip() if isinstance(at, str) else ""
            at = (at or top_at)[:40].strip()
            out[n] = {"phase": phase, "label": label, "heldReason": held, "updatedAt": at}
        return out
    except Exception:
        return {}


def get_pending_intents() -> dict:
    """Not-yet-consumed intents: {ticketId: action} from job/control/*.json."""
    out = {}
    try:
        files = sorted(CONTROL_DIR.glob("*.json")) if CONTROL_DIR.is_dir() else []
    except Exception:
        return out
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            action = data.get("action") if isinstance(data, dict) else None
        except Exception:
            continue
        if action in CONTROL_ACTIONS:
            out[f.stem] = action
    return out


DISPATCH_INTENT_MAX_AGE_SECONDS = 3600
_DISPATCH_ISSUED_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def get_dispatch_intent() -> "dict | None":
    """Ticket 080 (FR-4): the queued Dispatch now intent, for /api/state.

    None unless job/control/_dispatch.json exists and parses as a JSON object
    whose action is "dispatch". Otherwise {"issuedAt", "stale"}; stale mirrors
    the router's rule: issuedAt missing, not YYYY-MM-DDTHH:MM:SSZ, or more than
    3600 s old."""
    try:
        data = json.loads((CONTROL_DIR / "_dispatch.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("action") != "dispatch":
        return None
    issued = data.get("issuedAt")
    issued = issued if isinstance(issued, str) else ""
    stale = True
    if _DISPATCH_ISSUED_AT_RE.match(issued):
        try:
            when = datetime.strptime(issued, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            stale = (datetime.now(timezone.utc) - when).total_seconds() > DISPATCH_INTENT_MAX_AGE_SECONDS
        except Exception:
            stale = True
    return {"issuedAt": issued, "stale": stale}


def get_ticket_status_for_control(ticket_id: str) -> str:
    """Current canonical status of a ticket, for control-action rules.

    BOARD.md is the single source of truth; the ticket rd.md Status line is
    the fallback when the ticket has no board row yet."""
    for t in parse_board_md():
        if t.get("id") == ticket_id:
            return str(t.get("status", "")).lower()
    folder = find_ticket_folder(ticket_id)
    if folder:
        rd_path = folder / "rd.md"
        if rd_path.is_file():
            try:
                content = rd_path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                return ""
            m = re.search(r"\*\*Status:\*\*\s*([A-Za-z0-9_-]+)", content)
            if m:
                return m.group(1).lower()
    return ""


def write_control_intent(ticket_id: str, action: str) -> Path:
    """Write (or overwrite) the single intent file for a ticket (FR-2):
    the latest intent wins and refreshes issuedAt."""
    intent = {"action": action, "issuedAt": utc_now_iso(), "by": "dashboard"}
    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
    path = CONTROL_DIR / f"{ticket_id}.json"
    # Atomic: temp file in the same dir, then os.replace — the router can
    # never read a half-written intent.
    fd, tmp = tempfile.mkstemp(dir=str(CONTROL_DIR), prefix=f".{ticket_id}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(intent) + "\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


# --- Watchdog scheduler (ticket 017) ------------------------------------------------
# Script-mode watchdog: a daemon thread runs watchdog-check.sh --json on
# startup and every watchdog.intervalSeconds (default 60, from
# specs/worker-fleet.config.json), parses the output and atomically rewrites
# job/watchdog-report.json:
#   {"ts": "<ISO-8601>", "stalls": [{"file","ageSec","ticket"}],
#    "ports": [{"port","listening"}], "decisions": ["<paths>"],
#    "anomalies": ["<strings>"]}
# That file is the contract between the scheduler and the router (router.md
# Step 0, script mode) and is served read-only by GET /api/watchdog.
# Any tick failure is logged to stderr and retried on the next tick — the
# scheduler can never crash the server (FR-1).
# Ticket 062: in script mode each tick also pushes new stall episodes through
# notify.sh (watchdog_stall), once per episode, remembered in
# job/watchdog-stall-pushes.json; in agent mode the analyst pushes instead.

WATCHDOG_REPORT_PATH = REPO_ROOT / "job" / "watchdog-report.json"
WATCHDOG_SCRIPT_PATH = REPO_ROOT / ".claude" / "scripts" / "watchdog-check.sh"
WATCHDOG_STALL_PUSHES_PATH = REPO_ROOT / "job" / "watchdog-stall-pushes.json"
NOTIFY_SCRIPT_PATH = REPO_ROOT / ".claude" / "scripts" / "notify.sh"
_watchdog_report_lock = threading.Lock()


def _empty_watchdog_report() -> dict:
    return {
        "ts": utc_now_iso(),
        "stalls": [],
        "ports": [],
        "decisions": [],
        "anomalies": [],
    }


def run_watchdog_check() -> dict:
    """Run watchdog-check.sh --json and return the parsed report.
    The script is committed executable (apply-setup.py re-asserts the +x
    bit), so it is invoked directly; a lost exec bit surfaces as a tick
    failure that is retried next tick (FR-1) rather than being silently
    papered over. Raises on any failure — callers handle the retry."""
    if not WATCHDOG_SCRIPT_PATH.is_file():
        raise FileNotFoundError(f"watchdog script missing: {WATCHDOG_SCRIPT_PATH}")
    res = subprocess.run(
        [str(WATCHDOG_SCRIPT_PATH), "--json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"watchdog-check.sh --json exited {res.returncode}: {(res.stderr or '').strip()[:300]}"
        )
    report = json.loads(res.stdout)
    if not isinstance(report, dict):
        raise ValueError("watchdog-check.sh --json did not emit a JSON object")
    # Normalize the five-key contract defensively: the schema is the
    # interface to the router and the UI, so a missing key is filled in
    # rather than propagated.
    normalized = _empty_watchdog_report()
    normalized["ts"] = str(report.get("ts") or normalized["ts"])
    for key in ("stalls", "ports", "decisions", "anomalies"):
        value = report.get(key)
        normalized[key] = value if isinstance(value, list) else []
    return normalized


def write_watchdog_report(report: dict):
    """Atomically rewrite job/watchdog-report.json (temp file + rename) so
    a crash mid-write can never leave a half-written report behind."""
    with _watchdog_report_lock:
        WATCHDOG_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = WATCHDOG_REPORT_PATH.parent / (WATCHDOG_REPORT_PATH.name + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        os.replace(tmp_path, WATCHDOG_REPORT_PATH)


def read_watchdog_report():
    """The last parsed report, or None when no tick has completed yet."""
    try:
        with _watchdog_report_lock:
            if not WATCHDOG_REPORT_PATH.is_file():
                return None
            with open(WATCHDOG_REPORT_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as e:
        print(f"[watchdog] failed to read report: {e}", file=sys.stderr)
        return None


def get_watchdog_interval_seconds() -> int:
    """watchdog.intervalSeconds from config, re-read every cycle so live
    config edits (e.g. a short test interval) take effect on the next tick."""
    try:
        interval = int(get_config().get("watchdog", {}).get("intervalSeconds", 60))
    except Exception:
        interval = 60
    return max(1, interval)


def get_watchdog_mode() -> str:
    """watchdog.mode from config, re-read every tick: "agent" when the value,
    stripped and lower-cased, is "agent"; anything else (including a missing
    key) is "script" (ticket 062 FR-5)."""
    try:
        wd = get_config().get("watchdog", {})
        mode = str(wd.get("mode", "")) if isinstance(wd, dict) else ""
    except Exception:
        mode = ""
    return "agent" if mode.strip().lower() == "agent" else "script"


def _get_stall_threshold_seconds() -> float:
    try:
        wd = get_config().get("watchdog", {})
        minutes = float(wd.get("stallThresholdMinutes", 15)) if isinstance(wd, dict) else 15.0
    except Exception:
        minutes = 15.0
    return minutes * 60


def stall_push_candidates(report: dict, now: float, threshold_sec: float) -> dict:
    """The report's stalls that still deserve a push (ticket 062 FR-2), keyed
    by the report's `file`: {file: {"mtime": int, "idleMin": int, "ticket": "NNN"|""}}.
    The heartbeat is re-read from disk: it must still be older than the
    threshold, and its phase must be active and not blocked."""
    out = {}
    stalls = report.get("stalls") if isinstance(report, dict) else None
    for entry in stalls if isinstance(stalls, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
            continue
        rel = entry["file"]
        if not rel or os.path.isabs(rel) or ".." in Path(rel).parts:
            continue
        path = REPO_ROOT / rel
        try:
            st = path.stat()
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not path.is_file() or not isinstance(data, dict):
            continue
        if not (now - st.st_mtime > threshold_sec):
            continue
        phase = data.get("phase")
        if not is_active_phase(phase) or str(phase).strip().lower() == "blocked":
            continue
        m = re.match(r"^(\d{1,3})(?:-|$)", str(entry.get("ticket") or ""))
        out[rel] = {
            "mtime": int(st.st_mtime),
            "idleMin": int((now - st.st_mtime) // 60),
            "ticket": m.group(1).zfill(3) if m else "",
        }
    return out


def _read_stall_pushes():
    """(episodes, unreadable_reason). A missing file is an empty state."""
    try:
        raw = WATCHDOG_STALL_PUSHES_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, None
    except Exception as e:
        return {}, str(e)
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("episodes"), dict):
            raise ValueError('expected an object with an "episodes" object')
    except Exception as e:
        return {}, str(e)
    return {k: v for k, v in data["episodes"].items() if isinstance(v, dict)}, None


def _write_stall_pushes(episodes: dict):
    """Atomically rewrite job/watchdog-stall-pushes.json (temp file + rename)."""
    WATCHDOG_STALL_PUSHES_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = WATCHDOG_STALL_PUSHES_PATH.parent / (WATCHDOG_STALL_PUSHES_PATH.name + ".tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"episodes": episodes}, f, indent=2)
        os.replace(tmp_path, WATCHDOG_STALL_PUSHES_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _send_stall_push(rel: str, message: str, ticket: str):
    """Run notify.sh watchdog_stall (no shell, stdin closed, 60 s timeout).
    Runs in a daemon thread; every failure is logged, never raised."""
    cmd = ["bash", str(NOTIFY_SCRIPT_PATH), "watchdog_stall", message]
    if ticket:
        cmd.append(ticket)
    try:
        res = subprocess.run(
            cmd,
            cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if res.returncode != 0:
            reason = f"notify.sh exited {res.returncode}: {(res.stderr or '').strip()[:300]}"
            print(f"[watchdog] stall push failed: {rel}: {reason}", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print(f"[watchdog] stall push failed: {rel}: notify.sh timed out after 60s", file=sys.stderr)
    except Exception as e:
        print(f"[watchdog] stall push failed: {rel}: {str(e)[:300]}", file=sys.stderr)


def push_watchdog_stalls(report: dict):
    """Push each new stall episode once (ticket 062). Script mode only: in
    agent mode the watchdog analyst pushes, so this neither pushes nor
    touches the state file. An episode is one heartbeat file plus its
    whole-second mtime; it is recorded before its push starts and forgotten
    on the first tick where the file is no longer a pushable stall."""
    if get_watchdog_mode() == "agent":
        return
    now = time.time()
    current = stall_push_candidates(report, now, _get_stall_threshold_seconds())
    episodes, unreadable = _read_stall_pushes()
    if unreadable is not None:
        print(f"[watchdog] stall push state unreadable, starting empty: {unreadable}", file=sys.stderr)
    before = json.dumps(episodes, sort_keys=True)
    for rel in [k for k in episodes if k not in current]:
        del episodes[rel]
    fresh = []
    for rel, cand in current.items():
        prev = episodes.get(rel)
        if prev is not None and prev.get("mtime") == cand["mtime"]:
            continue
        episodes[rel] = {"mtime": cand["mtime"], "ticket": cand["ticket"], "pushedAt": utc_now_iso()}
        fresh.append((rel, cand))
    if unreadable is not None or json.dumps(episodes, sort_keys=True) != before:
        _write_stall_pushes(episodes)
    for rel, cand in fresh:
        idle = cand["idleMin"]
        if cand["ticket"]:
            message = f"Ticket {cand['ticket']} stalled: heartbeat idle {idle} min"
            label = f"(ticket {cand['ticket']})"
        else:
            message = f"Worker stalled: {rel} heartbeat idle {idle} min"
            label = "(no ticket)"
        print(f"[watchdog] stall push: {rel} {label}, heartbeat idle {idle} min", file=sys.stderr)
        threading.Thread(
            target=_send_stall_push,
            args=(rel, message, cand["ticket"]),
            name="watchdog-stall-push",
            daemon=True,
        ).start()


def watchdog_scheduler_loop():
    while True:
        interval = get_watchdog_interval_seconds()
        try:
            report = run_watchdog_check()
            write_watchdog_report(report)
        except Exception as e:
            # Never crash the server: log and retry on the next tick (FR-1).
            print(f"[watchdog] scheduler tick failed (retrying next tick): {e}", file=sys.stderr)
        else:
            try:
                push_watchdog_stalls(report)
            except Exception as e:
                print(f"[watchdog] stall push failed: {e}", file=sys.stderr)
        time.sleep(interval)


def start_watchdog_scheduler():
    thread = threading.Thread(
        target=watchdog_scheduler_loop, name="watchdog-scheduler", daemon=True
    )
    thread.start()
    return thread


def get_config():
    cfg_path = REPO_ROOT / "specs" / "worker-fleet.config.json"
    if cfg_path.is_file():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def clean_project_name(raw):
    """Ticket 051 FR-1: plain ASCII, at most 40 characters, safe in HTML and
    in an HTTP header. Identical to notify.sh's helper of the same name."""
    if not isinstance(raw, str):
        return ""
    s = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^A-Za-z0-9._ -]+", "-", s)
    s = re.sub(r"-{2,}", "-", s)
    s = s.strip(" -.")
    return s[:40].strip(" -.")


def get_project_identity():
    """Ticket 051 FR-1: (name, source) for this project. The config's
    project.name wins when it cleans to something; otherwise the directory
    name of REPO_ROOT; otherwise 'project'. Read on every call."""
    cfg = get_config()
    project = cfg.get("project") if isinstance(cfg, dict) else None
    if isinstance(project, dict):
        name = clean_project_name(project.get("name"))
        if name:
            return name, "config"
    return clean_project_name(REPO_ROOT.name) or "project", "directory"


def _mask_secret(value) -> str:
    """Mask a secret as '****' plus its last 2 characters ('****' if too short)."""
    s = str(value) if value is not None else ""
    return "****" + s[-2:] if len(s) >= 4 else "****"


_SECRET_NAME_PARTS = ("secret", "password", "passwd", "webhook", "apikey")
# Ticket 063: the password in <scheme>://<user>:<password>@ (the user is kept).
# Ticket 075: a match starts only at the beginning of a run of scheme characters
# and the whole run is the scheme, so a long run is scanned once (linear time).
_USERINFO_PASSWORD_RE = re.compile(r"(?<![A-Za-z0-9+.-])([A-Za-z0-9+.-]+://[^/@:\s]+:)([^/@\s]+)(@)")


def is_secret_key(name) -> bool:
    """Ticket 046: True when a config key name looks like it holds a secret."""
    n = str(name).lower().replace("_", "").replace("-", "")
    return n.endswith("token") or any(p in n for p in _SECRET_NAME_PARTS)


def _mask_all_values(obj):
    """Mask every string and number inside obj (bools, None and "" are kept)."""
    if isinstance(obj, dict):
        return {k: _mask_all_values(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask_all_values(v) for v in obj]
    if isinstance(obj, str):
        return _mask_secret(obj) if obj else obj
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        return _mask_secret(str(obj))
    return obj


def _mask_secret_params(s: str) -> str:
    """Ticket 082: mask the value of every secret-named `<delim><name>=<value>`.

    Gives exactly what re.sub with ([?&;#])([^&;#=\\s]+)=([^&;#\\s]+) gave: a
    parameter starts at ? & ; or #, its name runs to the first & ; # = or
    whitespace (so it may contain "?"), the value runs to the next & ; # or
    whitespace, and parameters are taken left to right without overlap. A plain
    forward scan, linear time: the end of the current name run is cached, so
    the starts inside one run of name characters reuse it.
    """
    n = len(s)
    out = []
    last = 0
    i = 0
    name_end = -1
    while i < n:
        if s[i] not in "?&;#":
            i += 1
            continue
        p = i + 1
        if p > name_end:
            e = p
            while e < n and s[e] not in "&;#=" and not s[e].isspace():
                e += 1
            name_end = e
        else:
            e = name_end
        if e > p and e < n and s[e] == "=":
            v = e + 1
            while v < n and s[v] not in "&;#" and not s[v].isspace():
                v += 1
            if v > e + 1:
                if is_secret_key(urllib.parse.unquote(s[p:e])):
                    out.append(s[last : e + 1])
                    out.append(_mask_secret(s[e + 1 : v]))
                    last = v
                i = v
                continue
        i += 1
    if not out:
        return s
    out.append(s[last:])
    return "".join(out)


def _mask_secret_queries(s: str) -> str:
    s = _USERINFO_PASSWORD_RE.sub(
        lambda m: m.group(1) + _mask_secret(m.group(2)) + m.group(3), s
    )
    return _mask_secret_params(s)


def redact_secrets(obj):
    """Ticket 046: copy of obj with secret-looking values masked (never mutates)."""
    if isinstance(obj, dict):
        return {
            k: (_mask_all_values(v) if is_secret_key(k) else redact_secrets(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact_secrets(v) for v in obj]
    if isinstance(obj, str):
        return _mask_secret_queries(obj)
    return obj


def scrub_live_token(obj, token):
    """Ticket 046: copy of obj with every occurrence of the live token masked."""
    if not token:
        return obj
    masked = _mask_secret(token)
    if isinstance(obj, dict):
        return {k: scrub_live_token(v, token) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub_live_token(v, token) for v in obj]
    if isinstance(obj, str):
        return obj.replace(token, masked)
    return obj


def strip_token_param(url) -> str:
    """Ticket 046: drop every query parameter named exactly `token` from url."""
    s = str(url).strip() if url else ""
    if not s:
        return ""
    try:
        u = urllib.parse.urlsplit(s)
        kept = [p for p in u.query.split("&") if p and p.split("=", 1)[0] != "token"]
        return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, "&".join(kept), u.fragment))
    except Exception:
        return ""


# Ticket 063 FR-12: a hand-set token that does not look generated gets one warning.
GENERATED_TOKEN_RE = re.compile(r"[0-9a-f]{32,}")
WEAK_TOKEN_WARNING = (
    "the dashboard token in job/dashboard-auth.json does not look randomly generated "
    "(apply-setup.py generates 32 lowercase hex characters). A guessable token can be "
    "guessed through the tunnel, so regenerate it: "
    "python3 .claude/scripts/apply-setup.py --regenerate-token"
)
_weak_token_lock = threading.Lock()
_weak_token_last_digest = None


def token_looks_generated(token) -> bool:
    """True when the stripped token is 32 or more lowercase hex characters."""
    return GENERATED_TOKEN_RE.fullmatch(str(token).strip() if token is not None else "") is not None


def warn_if_weak_token(token) -> None:
    """Print WEAK_TOKEN_WARNING to stderr once per distinct weak token value. Never raises.

    Only the sha256 digest of the last non-empty token checked is kept, in memory.
    The token, any part of it and its length are never printed.
    """
    global _weak_token_last_digest
    try:
        t = str(token).strip() if token is not None else ""
        if not t:
            return
        digest = hashlib.sha256(t.encode("utf-8")).hexdigest()
        with _weak_token_lock:
            if digest == _weak_token_last_digest:
                return
            _weak_token_last_digest = digest
        if not token_looks_generated(t):
            print(f"[auth] warning: {WEAK_TOKEN_WARNING}", file=sys.stderr, flush=True)
    except Exception:
        pass


# Ticket 063 FR-1: one masking pass for every JSON response and every text evidence file.
SCRUB_MIN_SECRET_LENGTH = 8
_TOKEN_HEX_RE = re.compile(r"(token=)([0-9a-fA-F]{32,})", re.IGNORECASE)
_TOKEN_HEX_BYTES_RE = re.compile(rb"(token=)([0-9a-fA-F]{32,})", re.IGNORECASE)


def live_secret_values() -> list:
    """Live secrets to mask: the dashboard token and the resolved notification secrets.

    Returns a new list on every call, never raises. Values shorter than
    SCRUB_MIN_SECRET_LENGTH are dropped; each value is listed once, longest first
    (equal lengths in ascending order).
    """
    found = []
    try:
        token = get_auth_token()
        warn_if_weak_token(token)
        found.append(token)
        cfg = get_config()
        raw = cfg.get("notifications", {}).get("providers", []) if isinstance(cfg, dict) else []
        if isinstance(raw, list):
            for p in raw:
                if isinstance(p, dict):
                    found.append(resolve_notify_secret(p.get("botToken")))
                    found.append(resolve_notify_secret(p.get("webhook")))
    except Exception:
        pass
    values = {v for v in found if isinstance(v, str) and len(v) >= SCRUB_MIN_SECRET_LENGTH}
    return sorted(values, key=lambda v: (-len(v), v))


# Ticket 082 FR-4/FR-5: the shared pass also masks the password of every
# <scheme>://<user>:<password>@ (same span as _USERINFO_PASSWORD_RE). A password
# that already looks like a mask is kept, so masking twice equals masking once.
_USERINFO_PASSWORD_BYTES_RE = re.compile(
    rb"(?<![A-Za-z0-9+.-])([A-Za-z0-9+.-]+://[^/@:\s]+:)([^/@\s]+)(@)"
)
_ALREADY_MASKED_RE = re.compile(r"\*{4}.{0,2}")


def _mask_userinfo_password(m):
    password = m.group(2)
    if _ALREADY_MASKED_RE.fullmatch(password):
        return m.group(0)
    return m.group(1) + _mask_secret(password) + m.group(3)


def _mask_userinfo_password_bytes(m):
    password = m.group(2).decode("utf-8", "surrogateescape")
    if _ALREADY_MASKED_RE.fullmatch(password):
        return m.group(0)
    return m.group(1) + _mask_secret(password).encode("utf-8", "surrogateescape") + m.group(3)


def _scrub_string(s: str, secrets_list) -> str:
    for value in secrets_list:
        if value:
            s = s.replace(value, _mask_secret(value))
    s = _TOKEN_HEX_RE.sub(lambda m: m.group(1) + _mask_secret(m.group(2)), s)
    return _USERINFO_PASSWORD_RE.sub(_mask_userinfo_password, s)


def scrub_secrets(obj, secrets):
    """Copy of obj with every live secret, `token=<32+ hex>` value and credential-URL
    password masked, keys included."""
    if isinstance(obj, str):
        return _scrub_string(obj, secrets)
    if isinstance(obj, dict):
        return {
            (_scrub_string(k, secrets) if isinstance(k, str) else k): scrub_secrets(v, secrets)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [scrub_secrets(v, secrets) for v in obj]
    return obj


def scrub_secret_bytes(data: bytes, secrets) -> bytes:
    """Bytes version of scrub_secrets: every other byte (invalid UTF-8 too) is kept."""
    for value in secrets:
        if value:
            data = data.replace(value.encode("utf-8"), _mask_secret(value).encode("utf-8"))
    data = _TOKEN_HEX_BYTES_RE.sub(
        lambda m: m.group(1) + _mask_secret(m.group(2).decode("ascii")).encode("ascii"), data
    )
    return _USERINFO_PASSWORD_BYTES_RE.sub(_mask_userinfo_password_bytes, data)


def _ntfy_display_target(target) -> str:
    """ntfy topic or URL as configured; URL userinfo and query string are dropped."""
    s = str(target) if target is not None else ""
    if s.startswith(("http://", "https://")):
        try:
            u = urllib.parse.urlsplit(s)
            host = u.hostname or ""
            if ":" in host:
                host = f"[{host}]"
            if u.port:
                host += f":{u.port}"
            return urllib.parse.urlunsplit((u.scheme, host, u.path, "", ""))
        except Exception:
            return "****"
    return s


_NOTIFY_SECRET_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
_NOTIFY_SECRET_ENV_RE = re.compile(r"WORKER_FLEET_[A-Z0-9_]{1,64}")


def resolve_notify_secret(value) -> str:
    """Ticket 048: resolve a notification secret field to its value, or "" when it cannot be.

    value is an inline non-empty string/int, {"secretRef": "<id>"} (looked up in
    REPO_ROOT/job/notify-secrets.json on each call) or {"env": "WORKER_FLEET_<NAME>"} (this
    process's environment). Anything unresolvable or invalid gives "". Never raises.
    """
    try:
        if isinstance(value, dict):
            if len(value) != 1:
                return ""
            ref = value.get("secretRef")
            if isinstance(ref, str) and _NOTIFY_SECRET_ID_RE.fullmatch(ref):
                with open(REPO_ROOT / "job" / "notify-secrets.json", "r", encoding="utf-8") as fh:
                    found = json.load(fh).get("secrets", {}).get(ref)
                return found.strip() if isinstance(found, str) else ""
            name = value.get("env")
            if isinstance(name, str) and _NOTIFY_SECRET_ENV_RE.fullmatch(name):
                return os.environ.get(name, "").strip()
            return ""
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            return ""
        return str(value).strip()
    except Exception:
        return ""


def get_notifications_summary(cfg) -> dict:
    """Ticket 012 FR-6: masked view of notifications.providers[] for /api/state.

    botToken, webhook and chatId are never returned. Malformed entries never raise.
    Ticket 048: a secretRef/env secret is resolved first, so the mask shows the real last 2 characters.
    """
    providers = []
    try:
        raw = cfg.get("notifications", {}).get("providers", []) if isinstance(cfg, dict) else []
        if not isinstance(raw, list):
            raw = []
        for p in raw:
            try:
                if not isinstance(p, dict):
                    providers.append({"type": "unknown", "target": "****", "events": "all"})
                    continue
                ptype = p.get("type")
                events = p.get("events", "all")
                if events != "all" and not (isinstance(events, list) and all(isinstance(e, str) for e in events)):
                    events = "all"
                if ptype == "ntfy":
                    target = _ntfy_display_target(p.get("target"))
                elif ptype == "telegram":
                    target = _mask_secret(resolve_notify_secret(p.get("botToken")))
                elif ptype == "slack":
                    target = _mask_secret(resolve_notify_secret(p.get("webhook")))
                else:
                    providers.append({"type": "unknown", "target": "****", "events": events})
                    continue
                providers.append({"type": ptype, "target": target, "events": events})
            except Exception:
                providers.append({"type": "unknown", "target": "****", "events": "all"})
    except Exception:
        providers = []
    return {"providers": providers}


def get_auth_token():
    """Read the dashboard auth token.

    The token's single source is the gitignored `job/dashboard-auth.json`
    (written by `apply-setup.py`). The tracked `specs/worker-fleet.config.json`
    never carries the token; any value previously committed there is burned
    and rotated by `apply-setup.py`.
    """
    auth_file = REPO_ROOT / "job" / "dashboard-auth.json"
    if auth_file.is_file():
        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("authToken", "").strip()
        except Exception:
            pass
    return ""


def get_tunnel_url():
    url_file = REPO_ROOT / "job" / "dashboard-url.txt"
    if url_file.is_file():
        try:
            return strip_token_param(url_file.read_text(encoding="utf-8").strip())
        except Exception:
            pass
    return ""


def get_tunnel_provider() -> str:
    """The configured tunnel provider (ticket 056): "cloudflared" or "ngrok",
    else "local". Read on every call; never raises."""
    try:
        provider = get_config().get("dashboard", {}).get("tunnel", {}).get("provider")
        if isinstance(provider, str):
            name = provider.strip().lower()
            if name in ("cloudflared", "ngrok"):
                return name
    except Exception:
        pass
    return "local"


def check_port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.15) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        except (socket.timeout, ConnectionRefusedError, OSError):
            return False


# --- Dev Ports worker rows (ticket 045) ----------------------------------------
def _ticket_number(ticket) -> str:
    """Leading digits of a heartbeat ticket; else the stripped string; else '?'."""
    s = str(ticket if ticket is not None else "").strip()
    m = re.match(r"^(\d+)", s)
    return m.group(1) if m else (s or "?")


def _valid_port(value):
    """An int, or a string of digits, in 1-65535 (a bool does not count); else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        port = value
    elif isinstance(value, str) and value.isascii() and value.isdigit():
        port = int(value)
    else:
        return None
    return port if 1 <= port <= 65535 else None


def _ledger_ports() -> dict:
    """Ticket number -> port of the first `dispatched` ledger entry that has one.

    The ledger is only a port fallback: a missing or unreadable file gives {}.
    """
    ports = {}
    try:
        raw = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
        entries = raw.get("dispatched") if isinstance(raw, dict) else None
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            num = _ticket_number(entry.get("ticket"))
            if num in ports:
                continue
            ports[num] = _valid_port(entry.get("port"))
    except Exception:
        return {}
    return ports


def build_worker_port_rows(workers) -> list:
    """One Dev Ports row per active heartbeat. Whether the port listens only
    sets `online` (dev server up); it never decides whether the row exists."""
    ledger = _ledger_ports()
    rows = []
    for w in workers:
        if not isinstance(w, dict) or not w.get("isActive"):
            continue
        if w.get("role") == "writer":
            continue  # a ticket writer has no dev port (ticket 070)
        num = _ticket_number(w.get("ticket"))
        port = _valid_port(w.get("port"))
        if port is None:
            port = ledger.get(num)
        label = f"Worker {num} ({port})" if port is not None else f"Worker {num} (no port)"
        rows.append((num, str(w.get("file") or ""), {
            "kind": "worker",
            "ticket": num,
            "phase": str(w.get("phase") if w.get("phase") is not None else ""),
            "port": port,
            "label": label,
            "online": check_port_listening(port) if port is not None else False,
            "running": True,
            "stalled": bool(w.get("isStalled")),
            "heartbeatAgeSec": w.get("heartbeatAgeSec"),
        }))
    rows.sort(key=lambda r: (r[0], r[1]))
    return [r[2] for r in rows]


# Canonical ticket status enum — the single source of truth is the
# `Status` column of specs/tickets/BOARD.md. Every surface (board, agents,
# dashboard server, UI) must use exactly these values. Derived display state
# (e.g. a stalled-worker badge) may be computed for rendering but is never
# persisted to the board. `/write-tickets` writes `specifying` while a ticket
# writer is writing the ticket, and flips it to `draft` when the writer finishes.
TICKET_STATUSES = (
    "specifying",
    "draft",
    "ready",
    "in-progress",
    "blocked",
    "done",
    "failed",
    "budget-exceeded",
    "in-review",
)

# Ticket priority enum (ticket 006). P1 is the default: a missing or
# malformed Prio value on a board row degrades to P1 so legacy 5-column
# boards keep working.
TICKET_PRIORITIES = ("P0", "P1", "P2")
DEFAULT_TICKET_PRIORITY = "P1"


def normalize_ticket_priority(raw: str) -> str:
    """Return a canonical priority for a raw Prio cell: `P0|P1|P2`, or the
    default `P1` when the value is missing or not in the enum."""
    value = str(raw or "").strip().upper()
    return value if value in TICKET_PRIORITIES else DEFAULT_TICKET_PRIORITY


# A markdown table separator row such as `| --- | :---: | --- |`. Matching the
# whole row (not just a `---` substring) keeps a ticket title containing `---`
# from being mistaken for the separator and skipped.
BOARD_SEPARATOR_RE = re.compile(r"^\|[\s:-]+(\|[\s:-]+)+\|?$")

# Serializes every read-modify-write of specs/tickets/BOARD.md performed by the
# dashboard's action handlers (set_ticket_status, set_ticket_priority).
_board_lock = threading.Lock()


def write_board_atomic(board_path, text: str) -> None:
    """Replace the board file atomically: write a temp file in the same
    directory, fsync, then `os.replace` so readers never see a partial board."""
    board_path = Path(board_path)
    tmp = board_path.with_name(f".{board_path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, board_path.stat().st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp, board_path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


_RD_HEADER_STATUS_RE = re.compile(r"\*\*Status:\*\* [A-Za-z0-9_-]+")


def set_rd_header_status(rd_path, new_status: str) -> bool:
    """Set the status word on the header status line of a ticket's rd.md.

    The header line is the first line starting with `**Status:** ` at column 1
    that comes before the first `## ` heading. Only the status word on that
    line changes; every other byte stays the same. When there is no such line
    (or the text is already right) the file is not written. Returns True when
    the file was rewritten (atomically, via write_board_atomic)."""
    rd_path = Path(rd_path)
    # Bytes in, str out: no newline translation, so line endings survive.
    text = rd_path.read_bytes().decode("utf-8")
    pos = 0
    for line in text.split("\n"):
        if line.startswith("## "):
            return False
        if line.startswith("**Status:** "):
            m = _RD_HEADER_STATUS_RE.match(line)
            if not m:
                return False
            new_text = text[:pos] + f"**Status:** {new_status}" + text[pos + m.end():]
            if new_text == text:
                return False
            write_board_atomic(rd_path, new_text)
            return True
        pos += len(line) + 1
    return False


# --- Dependency graph parsing (ticket 016) ---------------------------------------
# The `Runs` column of the board encodes dependency edges. Normalized syntax:
#   alongside                     -> no dependencies
#   after: 003, 005 — reason      -> depends on 003 and 005
# Legacy syntax parses as equivalent (backward compatible):
#   waits for 003: reason         -> depends on 003
#   waits for 001+005: reason     -> depends on 001 and 005
_RUNS_AFTER_RE = re.compile(r"^after\s*:\s*(\d{3}(?:\s*[+,]\s*\d{3})*)", re.IGNORECASE)
_RUNS_WAITS_RE = re.compile(r"^waits\s+for\s+(\d{3}(?:\s*[+,]\s*\d{3})*)", re.IGNORECASE)


def parse_runs_deps(runs):
    """Extract the direct dependency ticket ids from a Runs cell.

    Returns [] for `alongside` and for anything unparseable: board parsing
    is deliberately tolerant and never raises on odd input (a cyclic or
    dangling reference is a write-time concern, not a parse-time one).
    """
    text = (runs or "").strip()
    m = _RUNS_AFTER_RE.match(text) or _RUNS_WAITS_RE.match(text)
    if not m:
        return []
    # Dedupe while preserving the written order.
    return list(dict.fromkeys(re.findall(r"\d{3}", m.group(1))))


def parse_board_md():
    """Parse specs/tickets/BOARD.md rows.

    The board file is the single source of truth for ticket status: the
    status recorded here is one of the canonical `TICKET_STATUSES` values
    and is passed through verbatim (lowercased) so every consumer sees the
    same vocabulary. The optional `Prio` column (`P0|P1|P2`, between `Mode`
    and `Runs`) defaults to `P1` when missing or invalid.

    Each ticket also carries the dependency edges parsed from its Runs
    cell: `deps` lists the ticket ids this row runs after (direct edges,
    exactly as written — dangling references are kept verbatim), and
    `dependents` lists the ids of the rows that run after this one.
    Both are direct edges only; no transitive closure is computed.
    """
    board_path = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
    if not board_path.is_file():
        return []

    tickets = []
    with open(board_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    in_table = False
    for line in lines:
        line_clean = line.strip()
        if BOARD_SEPARATOR_RE.match(line_clean):
            in_table = True
            continue
        if in_table and line_clean.startswith("|"):
            parts = [p.strip() for p in line_clean.split("|")[1:-1]]
            if len(parts) >= 5:
                tid, title, status, mode = parts[0], parts[1], parts[2], parts[3]
                # Prio sits between Mode and Runs; legacy 5-column rows
                # simply have no such cell and degrade to the default P1.
                prio = normalize_ticket_priority(parts[4]) if len(parts) >= 6 else DEFAULT_TICKET_PRIORITY
                # Runs is the LAST column of the row, so extra middle
                # columns (e.g. a priority column) are tolerated and the
                # dependency text is still found.
                runs = parts[-1]
                if tid and tid != "#":
                    tdir_found = resolve_ticket_dir(tid)
                    folders = [tdir_found] if tdir_found else []
                    folder_name = folders[0].name if folders else f"{tid}-{title.lower().replace(' ', '-')}"
                    tickets.append({
                        "id": tid,
                        "title": title,
                        "status": status.lower(),
                        "mode": mode.lower(),
                        "prio": prio,
                        "runs": runs,
                        "folder": folder_name,
                        "hasFolder": bool(folders),
                    })

    # Dependency edges (ticket 016): direct edges only, as written.
    by_id = {t["id"]: t for t in tickets}
    for t in tickets:
        t["deps"] = parse_runs_deps(t["runs"])
        t["dependents"] = []
    for t in tickets:
        for dep in t["deps"]:
            parent = by_id.get(dep)
            if parent is not None and t["id"] not in parent["dependents"]:
                parent["dependents"].append(t["id"])
    return tickets


# Ticket 092: the done time of a finished ticket is the `finishedAt` of its results.json (read only).
DONE_AT_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", re.ASCII)
_DONE_AT_CACHE: dict = {}
_DONE_AT_CACHE_MAX = 1024


def read_done_at(ticket):
    """`finishedAt` of the ticket's results.json when it is a strict UTC time, else None.

    Valid only for a done ticket whose folder holds a results.json that is a JSON
    object with a `finishedAt` of exactly the form YYYY-MM-DDTHH:MM:SSZ that is a
    real date and time. Never raises; writes nothing. A parsed file is cached by
    its path, size and modification time."""
    try:
        if str(ticket.get("status", "")).lower() != "done" or not ticket.get("hasFolder"):
            return None
        path = REPO_ROOT / "specs" / "tickets" / str(ticket.get("folder", "")) / "results.json"
        st = path.stat()
        if not path.is_file():
            return None
        key = str(path)
        sig = (st.st_size, st.st_mtime_ns)
        hit = _DONE_AT_CACHE.get(key)
        if hit and hit[0] == sig:
            return hit[1]
        value = None
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            raw = doc.get("finishedAt") if isinstance(doc, dict) else None
            if isinstance(raw, str) and DONE_AT_RE.fullmatch(raw):
                datetime(int(raw[0:4]), int(raw[5:7]), int(raw[8:10]), int(raw[11:13]), int(raw[14:16]), int(raw[17:19]))
                value = raw
        except Exception:
            value = None
        if len(_DONE_AT_CACHE) >= _DONE_AT_CACHE_MAX:
            _DONE_AT_CACHE.clear()
        _DONE_AT_CACHE[key] = (sig, value)
        return value
    except Exception:
        return None


def get_worktrees():
    worktrees = []
    try:
        res = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode == 0:
            current_wt = {}
            for line in res.stdout.splitlines():
                line = line.strip()
                if line.startswith("worktree "):
                    if current_wt:
                        worktrees.append(current_wt)
                    current_wt = {"path": line.split(" ", 1)[1]}
                elif line.startswith("HEAD "):
                    current_wt["commit"] = line.split(" ", 1)[1][:8]
                elif line.startswith("branch "):
                    current_wt["branch"] = line.split(" ", 1)[1].replace("refs/heads/", "")
                elif line == "bare":
                    current_wt["bare"] = True
            if current_wt:
                worktrees.append(current_wt)
    except Exception:
        pass
    return worktrees


def parse_worktree_ticket_id(branch: str, wt_path: str) -> str:
    """Parse a 3-digit ticket id from a worktree's branch or directory name."""
    for source in (branch or "", Path(wt_path).name if wt_path else ""):
        m = re.search(r"(\d{3})", source or "")
        if m:
            return m.group(1)
    return ""


def is_active_phase(phase) -> bool:
    """A heartbeat is active unless its phase is terminal (done/failed) or empty."""
    return str(phase or "").strip().lower() not in ("done", "failed", "")


def get_swarm_state() -> dict:
    """Swarm-wide status from job/swarm-state.json; defaults to running."""
    default = {"status": "running", "cause": "", "since": ""}
    try:
        raw = json.loads((REPO_ROOT / "job" / "swarm-state.json").read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return default
        raw_status = str(raw.get("status", "")).lower()
        status = raw_status if raw_status in ("degraded", "paused") else "running"
        return {
            "status": status,
            "cause": str(raw.get("cause") or ""),
            "since": str(raw.get("since") or ""),
        }
    except Exception:
        return default


def get_worker_statuses():
    statuses = []
    now = datetime.now(timezone.utc).timestamp()

    # resolved status file -> owning worktree path (or None for legacy globs)
    candidate_files = {}

    patterns = [
        str(REPO_ROOT / ".claude" / "worktrees" / "*" / "job" / "status.json"),
        str(REPO_ROOT / "job" / "status-*.json"),
        str(REPO_ROOT / "job" / "status.json"),
    ]
    for p in patterns:
        for fpath_str in glob.glob(p):
            try:
                candidate_files[Path(fpath_str).resolve()] = None
            except Exception:
                pass

    # Also discover heartbeats in ALL registered git worktrees, including
    # sibling dirs outside this checkout (e.g. <repo>-wt-001) that the
    # REPO_ROOT-relative globs above can never see.
    wt_by_path = {}
    for wt in get_worktrees():
        wt_path = wt.get("path") or ""
        if not wt_path:
            continue
        wt_by_path[wt_path] = wt
        status_file = Path(wt_path) / "job" / "status.json"
        if status_file.is_file():
            try:
                candidate_files[status_file.resolve()] = wt_path
            except Exception:
                pass

    for fpath in sorted(candidate_files.keys(), key=str):
        wt_path = candidate_files[fpath]
        if not fpath.is_file():
            continue
        try:
            mtime = fpath.stat().st_mtime
            age = max(0, int(now - mtime))
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            try:
                data["file"] = str(fpath.relative_to(REPO_ROOT))
            except ValueError:
                # Worktree outside this checkout: render a worktree-relative
                # label based on the worktree's directory basename.
                data["file"] = (
                    f"{Path(wt_path).name}/job/status.json" if wt_path else fpath.name
                )
            if wt_path:
                data["worktree"] = wt_path
                if not str(data.get("ticket", "")).strip():
                    wt = wt_by_path.get(wt_path, {})
                    data["ticket"] = parse_worktree_ticket_id(
                        wt.get("branch", ""), wt_path
                    )
            data["heartbeatAgeSec"] = age
            data["isActive"] = is_active_phase(data.get("phase"))
            # Ticket 070: the file name decides the role (a `role` field inside
            # the file is ignored). A writer goes quiet after 2 x the watchdog
            # stall threshold, and never while it waits for the user.
            is_writer = (
                fpath.name.startswith("status-writer-")
                and fpath.parent == (REPO_ROOT / "job").resolve()
            )
            data["role"] = "writer" if is_writer else "worker"
            if is_writer:
                phase_l = str(data.get("phase") or "").strip().lower()
                data["isStalled"] = (
                    phase_l not in ("done", "waiting-user", "")
                    and age > 2 * _get_stall_threshold_seconds()
                )
            else:
                data["isStalled"] = (age > 900) and data["isActive"]
            statuses.append(data)
        except Exception:
            pass

    # One row per ticket, latest wins (FR-4): a `failed` heartbeat is
    # superseded once the same ticket has any non-failed heartbeat (the
    # re-dispatched worker).
    def _tid(w):
        t = str(w.get("ticket", "")).strip()
        m = re.match(r"^(\d+)(?:-|$)", t)
        return m.group(1) if m else t

    # Writer rows (ticket 070) neither supersede nor are superseded by worker rows.
    live_tickets = {
        _tid(w) for w in statuses
        if w.get("role") != "writer"
        and str(w.get("phase", "")).strip().lower() != "failed" and _tid(w)
    }
    for w in statuses:
        w["superseded"] = (
            w.get("role") != "writer"
            and str(w.get("phase", "")).strip().lower() == "failed"
            and _tid(w) in live_tickets
        )
    return statuses


# --- Telemetry (ticket 014) ---------------------------------------------------
# All scanning / pricing / windowing logic lives in telemetry.py; the server is
# a thin caller. `get_telemetry_data()["byTicket"]` keeps the shape the router
# reads for budget enforcement: {"NNN": {"tokens": N, "cost": USD}}.
TELEMETRY_HISTORY_INTERVAL_SECONDS = 3600


def get_telemetry_data(window: str = "all") -> dict:
    return telemetry_mod.get_telemetry(window=window, repo_root=REPO_ROOT)


def _num(*values):
    """First value that is a finite non-negative number, else None."""
    for v in values:
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and v >= 0:
            return v
    return None


def merge_worker_budget(worker: dict, dispatched: list, defaults: dict, by_ticket: dict,
                        by_ticket_budget: dict = None) -> dict:
    """Live burn for one worker heartbeat (ticket 014, FR-6): merge the router
    ledger entry's budget block, the heartbeat's best-effort turnsUsed /
    estCostUsd, and telemetry's counted per-ticket cost. The used counters are
    monotonic, so the largest value wins.

    Ticket 050: `estCostUsd` is the figure the router enforces, the spend
    counted since the ticket's first dispatch (`byTicketBudget`), so
    `byTicket` (the ticket's total recorded spend) no longer feeds it; it is
    reported separately as `totalCostUsd`, with `countedSince`."""
    tid = _ticket_num(worker.get("ticket", ""))
    entry = next(
        (e for e in dispatched if isinstance(e, dict) and tid and _ticket_num(e.get("ticket", "")) == tid),
        {},
    )
    lb = entry.get("budget") if isinstance(entry.get("budget"), dict) else {}
    counted = by_ticket_budget if isinstance(by_ticket_budget, dict) else {}
    cb = counted.get(tid) if isinstance(counted.get(tid), dict) else {}
    tele = by_ticket.get(tid) if isinstance(by_ticket.get(tid), dict) else {}
    return {
        "turnsUsed": max(_num(worker.get("turnsUsed")) or 0, _num(lb.get("turnsUsed")) or 0),
        "turnsBudget": _num(lb.get("turns"), defaults.get("turns")),
        "estCostUsd": round(
            max(_num(worker.get("estCostUsd")) or 0, _num(lb.get("estCostUsd")) or 0,
                _num(cb.get("cost")) or 0), 4),
        "totalCostUsd": round(_num(tele.get("cost")) or 0, 4),
        "countedSince": cb.get("since") if isinstance(cb.get("since"), str) else None,
        "usdBudget": _num(lb.get("usd"), defaults.get("usd")),
    }


# Ticket 093: `run` on each ticket of /api/state (read only, writes nothing).
RUN_STATUSES = ("in-progress", "blocked", "in-review", "failed", "budget-exceeded")
RD_BUDGET_USD_RE = re.compile(r"^- USD:\s*([0-9]+(\.[0-9]+)?)\s*$")
_RD_BUDGET_CACHE: dict = {}
_RD_BUDGET_CACHE_MAX = 1024


def _pos(value):
    """The value when it is a finite number above 0 (a boolean is not a number), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if value == value and value != float("inf") and value > 0 else None
    except Exception:
        return None


def read_rd_budget_usd(tid: str):
    """The `- USD:` value of the `## Budget` section of the ticket's rd.md, or None.
    The section starts at a line that is exactly `## Budget` and ends at the next
    line that starts with `## `. Never raises. A parsed file is cached by its
    path, size and modification time."""
    try:
        tdir = resolve_ticket_dir(tid)
        if not tdir:
            return None
        path = tdir / "rd.md"
        st = path.stat()
        key = str(path)
        sig = (st.st_size, st.st_mtime_ns)
        hit = _RD_BUDGET_CACHE.get(key)
        if hit and hit[0] == sig:
            return hit[1]
        value = None
        try:
            in_section = False
            for line in path.read_text(encoding="utf-8").splitlines():
                if in_section:
                    if line.startswith("## "):
                        break
                    m = RD_BUDGET_USD_RE.match(line)
                    if m:
                        value = float(m.group(1))
                        break
                elif line == "## Budget":
                    in_section = True
        except Exception:
            value = None
        if len(_RD_BUDGET_CACHE) >= _RD_BUDGET_CACHE_MAX:
            _RD_BUDGET_CACHE.clear()
        _RD_BUDGET_CACHE[key] = (sig, value)
        return value
    except Exception:
        return None


def build_ticket_run(ticket: dict, dispatched, workers, by_ticket_budget, defaults) -> object:
    """The `run` object of one ticket (ticket 093, FR-1): null unless the ticket's
    status is one of RUN_STATUSES. Never raises."""
    try:
        if str(ticket.get("status", "")).lower() not in RUN_STATUSES:
            return None
        tid = _ticket_num(ticket.get("id", ""))
        entry = None
        if isinstance(dispatched, list):
            for e in dispatched:
                if isinstance(e, dict) and tid and _ticket_num(e.get("ticket", "")) == tid:
                    entry = e  # last entry wins, as get_pipeline_state() finds it
        e = entry if entry is not None else {}
        lb = e.get("budget") if isinstance(e.get("budget"), dict) else {}
        attempt = e.get("attempt")
        attempt = attempt if isinstance(attempt, int) and not isinstance(attempt, bool) and attempt >= 1 else None
        retries = e.get("maxRetries")
        retries = retries if isinstance(retries, int) and not isinstance(retries, bool) and retries >= 0 else None

        figures = []
        counted = by_ticket_budget if isinstance(by_ticket_budget, dict) else {}
        cb = counted.get(tid) if isinstance(counted.get(tid), dict) else None
        if cb is not None:
            c = _num(cb.get("cost"))
            if c is not None:
                figures.append(c)  # telemetry counted: 0 is a figure
        for v in (lb.get("estCostUsd"),):
            if _pos(v) is not None:
                figures.append(v)
        for w in workers or []:
            if (w.get("role") != "writer" and not w.get("superseded")
                    and tid and _ticket_num(w.get("ticket", "")) == tid and _pos(w.get("estCostUsd")) is not None):
                figures.append(w.get("estCostUsd"))
        spend = round(float(max(figures)), 4) if figures else None

        cap = _pos(lb.get("usd"))
        if cap is None:
            cap = _pos(read_rd_budget_usd(tid))
        if cap is None:
            cap = _pos((defaults or {}).get("usd")) if isinstance(defaults, dict) else None
        return {
            "dispatched": entry is not None,
            "attempt": attempt,
            "maxRetries": retries,
            "spendUsd": spend,
            "capUsd": float(cap) if cap is not None else None,
        }
    except Exception:
        return {"dispatched": False, "attempt": None, "maxRetries": None, "spendUsd": None, "capUsd": None}


def telemetry_history_loop():
    while True:
        try:
            telemetry_mod.snapshot_history(REPO_ROOT)
        except Exception as e:
            print(f"telemetry history snapshot failed: {e}", file=sys.stderr)
        time.sleep(TELEMETRY_HISTORY_INTERVAL_SECONDS)


def start_telemetry_history():
    """Snapshot on startup, then hourly (daemon thread; never blocks serving)."""
    thread = threading.Thread(target=telemetry_history_loop, name="telemetry-history", daemon=True)
    thread.start()
    return thread


# --- SSE event stream (ticket 027) ------------------------------------------------
# GET /api/events streams typed `state` events ({"kind","ts"} deltas only) so
# the UI refetches instantly instead of waiting for its 3s poll. A daemon
# watcher thread polls file mtimes once per second; the 3s poll in the UI
# stays as the fallback path. Stdlib only.

SSE_MAX_CONNECTIONS = 10
SSE_PING_SECONDS = 15
SSE_WATCH_INTERVAL = 1.0
SSE_WORKTREE_REFRESH_TICKS = 10   # re-run `git worktree list` every N ticks

_sse_lock = threading.Lock()
_sse_clients = set()   # set of queue.Queue, one per connected stream


def sse_register_client():
    """Reserve a stream slot. Returns the client's queue, or None when the
    SSE_MAX_CONNECTIONS cap is reached."""
    with _sse_lock:
        if len(_sse_clients) >= SSE_MAX_CONNECTIONS:
            return None
        q = queue.Queue()
        _sse_clients.add(q)
        return q


def sse_unregister_client(q):
    with _sse_lock:
        _sse_clients.discard(q)


def sse_broadcast(kind: str):
    msg = "event: state\ndata: " + json.dumps({"kind": kind, "ts": utc_now_iso()}) + "\n\n"
    with _sse_lock:
        clients = list(_sse_clients)
    for q in clients:
        q.put(msg)


def sse_peer_closed(sock):
    """True when the client closed its end (FIN/RST), detected without
    writing: a readable socket whose MSG_PEEK returns b"" (or raises) is
    gone. An SSE client sends nothing after the request, so readable
    normally means closed. A transient BlockingIOError (EAGAIN) or
    InterruptedError (EINTR) means alive, and MSG_DONTWAIT keeps the
    peek from blocking the handler thread."""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        flags = socket.MSG_PEEK | getattr(socket, "MSG_DONTWAIT", 0)
        return sock.recv(1, flags) == b""
    except (BlockingIOError, InterruptedError):
        return False
    except (OSError, ValueError):
        return True


def _file_sig(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _watched_status_files(worktree_paths):
    """Heartbeat files the watcher follows: the same locations
    get_worker_statuses() reads (REPO_ROOT globs + every registered worktree)."""
    files = set()
    for p in (
        str(REPO_ROOT / ".claude" / "worktrees" / "*" / "job" / "status.json"),
        str(REPO_ROOT / "job" / "status-*.json"),
        str(REPO_ROOT / "job" / "status.json"),
    ):
        files.update(glob.glob(p))
    for wt_path in worktree_paths:
        files.add(str(Path(wt_path) / "job" / "status.json"))
    return sorted(files)


def compute_watch_signatures(worktree_paths):
    """One signature per event kind; a changed signature means that kind
    changed since the previous tick."""
    return {
        "board": _file_sig(REPO_ROOT / "specs" / "tickets" / "BOARD.md"),
        "config": _file_sig(REPO_ROOT / "specs" / "worker-fleet.config.json"),
        "worker": tuple((f, _file_sig(f)) for f in _watched_status_files(worktree_paths)),
        "audit": _file_sig(AUDIT_LOG_PATH),
        "swarm": _file_sig(REPO_ROOT / "job" / "swarm-state.json"),
        "ledger": _file_sig(REPO_ROOT / "job" / "router-state.json"),
        "control": tuple((f, _file_sig(f)) for f in sorted(glob.glob(str(CONTROL_DIR / "*.json")))),
    }


def sse_watcher_loop():
    prev = None
    wt_paths = []
    tick = 0
    while True:
        try:
            if tick % SSE_WORKTREE_REFRESH_TICKS == 0:
                wt_paths = [w.get("path") for w in get_worktrees() if w.get("path")]
            tick += 1
            cur = compute_watch_signatures(wt_paths)
            if prev is not None:
                for kind in ("board", "worker", "audit", "config", "swarm", "ledger", "control"):
                    if cur[kind] != prev[kind]:
                        sse_broadcast(kind)
            prev = cur
        except Exception as e:
            # Never crash the server: the UI's poll fallback keeps working.
            print(f"[sse-watcher] error: {e}", file=sys.stderr)
        time.sleep(SSE_WATCH_INTERVAL)


def start_sse_watcher():
    t = threading.Thread(target=sse_watcher_loop, name="sse-watcher", daemon=True)
    t.start()
    return t


class FleetControlHandler(http.server.BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        # Same-origin UI only: no CORS headers are ever emitted (FR-4).
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    # --- Auth helpers (ticket 001) ---

    def _client_ip(self) -> str:
        try:
            return str(self.client_address[0])
        except Exception:
            return ""

    def _is_loopback(self) -> bool:
        """True when the CLIENT SOCKET ADDRESS is loopback: 127.0.0.0/8,
        ::1, or an IPv4-mapped ::ffff:127.0.0.1. The Host header is
        deliberately never consulted (FR-1)."""
        ip = self._client_ip().strip()
        if ip.lower().startswith("::ffff:"):
            ip = ip[7:]
        try:
            return ipaddress.ip_address(ip).is_loopback
        except ValueError:
            return False

    def _is_proxied(self) -> bool:
        """True when the request carries any proxy header (ticket 052). Names
        match case-insensitively; the value does not matter."""
        return any(self.headers.get(name) is not None for name in PROXY_HEADER_NAMES)

    def _is_local(self) -> bool:
        """Local = loopback socket AND no proxy header AND a Host that names
        localhost, an IP address or nothing (ticket 064: a DNS-rebinding page
        reaches loopback under its own domain name). Everything else (LAN,
        tunnel visitors, header-carrying loopback, a foreign Host) is remote.
        Ticket 075: a request with more than one Host header is invalid
        (RFC 9112 3.2) and is never local. Ticket 081: a request whose header
        block Python could not parse cleanly (a parser defect, or lines left
        in the payload such as after ``Host : evil``) is never local either;
        the malformed line would also hide later proxy headers."""
        headers = self.headers
        defects = getattr(headers, "defects", None)
        if defects is None or defects:
            return False
        get_payload = getattr(headers, "get_payload", None)
        if get_payload is None or get_payload():
            return False
        return (
            self._is_loopback()
            and not self._is_proxied()
            and len(self.headers.get_all("Host") or []) <= 1
            and host_is_local_name(self.headers.get("Host"))
        )

    def _forwarded_client_ip(self) -> str:
        """The visitor address the configured tunnel reports (ticket 056):
        CF-Connecting-IP for cloudflared, the right-most X-Forwarded-For entry
        for ngrok, nothing for local or an unknown provider. Only a value that
        parses as an IP counts, else "unknown"."""
        provider = get_tunnel_provider()
        if provider == "cloudflared":
            raw = self.headers.get("CF-Connecting-IP")
        elif provider == "ngrok":
            xff = self.headers.get("X-Forwarded-For")
            raw = xff.split(",")[-1] if xff is not None else None
        else:
            raw = None
        if raw is None:
            return "unknown"
        cand = raw.strip()
        try:
            ipaddress.ip_address(cand)
        except ValueError:
            return "unknown"
        return cand

    def _auth_kind(self) -> str:
        """Failure-table kind (ticket 056): proxied tunnel visitor, local
        host, or LAN."""
        if self._is_loopback():
            return "proxied" if self._is_proxied() else "local"
        return "lan"

    def _cookie_secure_suffix(self) -> str:
        """"; Secure" for a proxied loopback request that came in over https
        (X-Forwarded-Proto), else "" (ticket 056)."""
        if self._is_loopback() and self._is_proxied():
            proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
            if proto == "https":
                return "; Secure"
        return ""

    def _client_key(self) -> str:
        """Lockout key. Tunnel visitors (proxy headers from a loopback socket)
        are keyed by their forwarded address; everyone else by the socket
        address. Proxy headers from non-loopback sockets are never trusted."""
        if self._is_loopback() and self._is_proxied():
            return "proxied:" + self._forwarded_client_ip()
        return self._client_ip()

    def _audit_client_ip(self) -> str:
        if self._is_loopback() and self._is_proxied():
            return self._forwarded_client_ip()
        return self._client_ip()

    def _send_signin(self, status: int, state: str, clear_cookie: bool = False):
        """Answer with the minimal sign-in page (ticket 052). Never serves the
        app, the project name or any data."""
        signin_path = REPO_ROOT / ".claude" / "dashboard" / "signin.html"
        try:
            content = signin_path.read_bytes()
        except OSError:
            self._send_signin_fallback(status, state, clear_cookie)
            return
        if state not in SIGNIN_MESSAGES:
            state = "signed-out"
        content = content.replace(
            b'data-signin-state="signed-out"',
            b'data-signin-state="' + state.encode("ascii") + b'"',
            1,
        )
        message = html.escape(SIGNIN_MESSAGES[state]).encode("utf-8")
        content = content.replace(
            b'<p id="signin-error" role="alert"></p>',
            b'<p id="signin-error" role="alert">' + message + b"</p>",
            1,
        )
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", SIGNIN_CSP)
        if clear_cookie:
            self.send_header("Set-Cookie", self._clear_cookie_value())
        if status == 429:
            self.send_header("Retry-After", str(self._retry_after_seconds()))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _send_signin_fallback(self, status: int, state: str, clear_cookie: bool):
        """Ticket 063: signin.html is missing. Answer the status the gate counted, as
        plain text, with the page's headers (never the app)."""
        if state not in SIGNIN_MESSAGES:
            state = "signed-out"
        text = "Sign-in page unavailable."
        if SIGNIN_MESSAGES[state]:
            text += " " + SIGNIN_MESSAGES[state]
        content = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", SIGNIN_CSP)
        if clear_cookie:
            self.send_header("Set-Cookie", self._clear_cookie_value())
        if status == 429:
            self.send_header("Retry-After", str(self._retry_after_seconds()))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _clear_cookie_value(self) -> str:
        """The Set-Cookie value that clears a rejected wf_session cookie."""
        return (
            "wf_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            + self._cookie_secure_suffix()
        )

    def _has_wf_session_cookie(self) -> bool:
        """True when the Cookie header holds a wf_session entry, whatever its
        value (a blank one included). Ticket 064: a local visit clears it."""
        cookie_header = self.headers.get("Cookie", "")
        for part in (cookie_header or "").split(";"):
            name, sep, _value = part.strip().partition("=")
            if sep and name == "wf_session":
                return True
        return False

    def _legacy_clear_cookie_value(self) -> str:
        """The Set-Cookie value that expires the pre-rename session cookie (ticket
        089, FR-7). Same attributes and the same Secure rule as the wf_session
        clearing value."""
        return (
            f"{LEGACY_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            + self._cookie_secure_suffix()
        )

    def _has_legacy_session_cookie(self) -> bool:
        """True when the Cookie header holds a pre-rename session entry, whatever
        its value (a blank one included). It is never a credential."""
        headers = getattr(self, "headers", None)
        if headers is None:
            return False
        for cookie_header in headers.get_all("Cookie") or []:
            for part in (cookie_header or "").split(";"):
                name, sep, _value = part.strip().partition("=")
                if sep and name == LEGACY_SESSION_COOKIE:
                    return True
        return False

    def send_response(self, code, message=None):
        # Ticket 089: start a fresh record of the Set-Cookie headers of THIS response.
        self._set_cookie_values = []
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "set-cookie":
            if not hasattr(self, "_set_cookie_values"):
                self._set_cookie_values = []
            self._set_cookie_values.append(value)
        super().send_header(keyword, value)

    def end_headers(self):
        """Ticket 089, FR-7: every response to a request that carries the old
        session cookie, and every response that clears wf_session, also expires the
        old cookie, once, as the last Set-Cookie header."""
        try:
            sent = getattr(self, "_set_cookie_values", [])
            if getattr(self, "headers", None) is not None:
                legacy_clear = self._legacy_clear_cookie_value()
                if legacy_clear not in sent and (
                    self._has_legacy_session_cookie() or self._clear_cookie_value() in sent
                ):
                    self.send_header("Set-Cookie", legacy_clear)
        except Exception:
            pass
        super().end_headers()

    def _retry_after_seconds(self) -> int:
        """Retry-After for a 429 (ticket 057, FR-5): seconds until the lock
        that refused this request ends, 1..AUTH_LOCKOUT_SECONDS."""
        left = auth_lock_seconds_left(self._client_key(), self._auth_kind())
        return left if left > 0 else 1

    def _query_token(self):
        """Token carried in the query string (?token=...). Only ever honored
        by the one-time GET bootstrap on / — never for POST, and never as an
        API credential channel (FR-3). Surrounding whitespace is stripped and
        a blank value is absent (ticket 057, FR-2)."""
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if "token" in qs and qs["token"]:
            return qs["token"][0].strip() or None
        return None

    def _header_credential(self):
        """(value, channel) of a non-blank Authorization: Bearer or
        X-Auth-Token, else None (tickets 056, 057 FR-2)."""
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ", 1)[1].strip()
            if token:
                return token, "bearer"
        custom_token = self.headers.get("X-Auth-Token", "").strip()
        if custom_token:
            return custom_token, "x-auth-token"
        return None

    def _presented_credential(self):
        """(value, channel) presented through an accepted credential channel:
        Authorization: Bearer, X-Auth-Token, or the wf_session cookie; else
        None. The query string is intentionally NOT an accepted channel here.
        A blank value is absent, and a local request never uses the cookie
        (ticket 057, FR-2, FR-4)."""
        cred = self._header_credential()
        if cred is not None:
            return cred
        if self._is_local():
            return None
        cookie_header = self.headers.get("Cookie", "")
        if cookie_header:
            for part in cookie_header.split(";"):
                name, sep, value = part.strip().partition("=")
                if sep and name == "wf_session":
                    value = urllib.parse.unquote(value.strip()).strip()
                    if value:
                        return value, "cookie"
        return None

    def _presented_token(self):
        cred = self._presented_credential()
        return cred[0] if cred else None

    def _header_token(self):
        """Token presented in a header only (ticket 056): a non-blank
        Authorization: Bearer or X-Auth-Token. The cookie is ignored."""
        cred = self._header_credential()
        return cred[0] if cred else None

    def _is_locked_out(self) -> bool:
        return auth_is_locked(self._client_key(), self._auth_kind())

    def _register_auth_failure(self, value=None, via=""):
        """Count a presented-but-invalid credential. The 5th failure locks
        the key out; the lockout takes effect on subsequent requests (FR-5).
        Absent credentials are not counted — there is nothing to brute-force.
        A wrong value counts once per client (ticket 057, FR-1); a counted
        failure writes one log line (FR-6). Returns the count, 0 for a repeat."""
        fingerprint = None
        if value is not None:
            fingerprint = hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
        count = auth_register_failure(
            self._client_key(), self._auth_kind(), fingerprint=fingerprint
        )
        if count:
            addr = hash_auth_log_addr(self._audit_client_ip())
            path = safe_auth_log_path(urllib.parse.urlparse(self.path).path)
            print(
                f"[auth] failure addr={addr} count={count}/{AUTH_FAILURE_THRESHOLD} "
                f"{self.command} {path} via={via}",
                file=sys.stderr,
                flush=True,
            )
            if count >= AUTH_FAILURE_THRESHOLD:
                print(
                    f"[auth] locked addr={addr} for {AUTH_LOCKOUT_SECONDS}s",
                    file=sys.stderr,
                    flush=True,
                )
        return count

    def _register_auth_success(self):
        auth_register_success(self._client_key())

    def _shared_lock_accepts(self, presented) -> bool:
        """Ticket 058, FR-2/FR-3: True when this client is refused only by a
        locked shared entry, the configured token has at least
        AUTH_BYPASS_MIN_TOKEN_LENGTH characters and `presented` equals it.
        Nothing is counted and no lock changes. A per-visitor or local lock
        never accepts."""
        if not presented or len(get_auth_token() or "") < AUTH_BYPASS_MIN_TOKEN_LENGTH:
            return False
        if not auth_lock_is_shared(self._client_key(), self._auth_kind()):
            return False
        return self._token_matches(presented)

    def _token_matches(self, presented: str) -> bool:
        expected = get_auth_token()
        if not expected:
            return True
        return hmac.compare_digest(presented, expected)

    def _check_auth(
        self,
        require_token: bool,
        header_only: bool = False,
        audit_rejection: bool = False,
    ) -> bool:
        """Deny-by-default auth gate (FR-1/FR-2/FR-5).

        Decides purely on the client socket address. Loopback GETs without
        any credential stay frictionless; every other request needs a valid
        token via Bearer / X-Auth-Token / wf_session cookie. Returns True
        when the request may proceed; otherwise the 401/429 response has
        already been sent.

        Ticket 081: with ``audit_rejection`` set (only the POST /api/action
        path), the ``error:429`` / ``error:401`` audit line is written right
        before the refusal is sent, so the line is in job/audit.jsonl by the
        time the client sees the reply.
        """
        if not get_auth_token():
            # No token configured (setup never run): nothing to enforce.
            return True

        if self._presented_token() is None and not require_token and self._is_local():
            # Frictionless loopback reads stay open even while the IP is
            # locked out — the lockout targets credential guessing (FR-5).
            return True

        cred = self._header_credential() if header_only else self._presented_credential()

        if self._is_locked_out():
            if self._shared_lock_accepts(cred[0] if cred else None):
                return True
            if audit_rejection:
                self._audit_action(None, "error:429")
            self._send_json(
                429,
                {"error": "locked out"},
                [("Retry-After", str(self._retry_after_seconds()))],
            )
            return False

        if cred is None:
            # No credential on a request that needs one (POST from anywhere,
            # or any non-loopback access): reject, but not a counted failure.
            message = (
                ACTION_HEADER_TOKEN_ERROR if header_only
                else "Unauthorized. Invalid or missing authentication token."
            )
            if audit_rejection:
                self._audit_action(None, "error:401")
            self._send_json(401, {"error": message})
            return False

        presented, via = cred
        if self._token_matches(presented):
            self._register_auth_success()
            return True

        self._register_auth_failure(presented, via)
        # A rejected cookie is cleared on every 401 it decides (FR-3); a 401
        # decided by a header token never clears the cookie.
        extra = [("Set-Cookie", self._clear_cookie_value())] if via == "cookie" else None
        if audit_rejection:
            self._audit_action(None, "error:401")
        self._send_json(
            401,
            {"error": "Unauthorized. Invalid or missing authentication token."},
            extra,
        )
        return False

    @staticmethod
    def _normalize_netloc(netloc: str) -> str:
        n = (netloc or "").strip().lower()
        for suffix in (":80", ":443"):
            if n.endswith(suffix):
                n = n[: -len(suffix)]
                break
        return n

    def _post_origin_allowed(self) -> bool:
        """Origin gate for POST /api/action (ticket 056, FR-4). Refuses a
        Sec-Fetch-Site of same-site / cross-site and an Origin that is not
        this dashboard's own (Host, X-Forwarded-Host for a proxied request,
        or the tunnel URL). A missing Origin passes (curl, scripts)."""
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site in ("cross-site", "same-site"):
            return False
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        try:
            parts = urllib.parse.urlsplit(origin.strip())
            scheme, netloc = parts.scheme.lower(), parts.netloc
        except ValueError:
            return False
        if scheme not in ("http", "https") or not netloc:
            return False
        origin_host = self._normalize_netloc(netloc)
        allowed = {self._normalize_netloc(self.headers.get("Host") or "")}
        if self._is_loopback() and self._is_proxied():
            xfh = (self.headers.get("X-Forwarded-Host") or "").split(",")[0]
            allowed.add(self._normalize_netloc(xfh))
        tunnel_url = get_tunnel_url()
        if tunnel_url:
            try:
                allowed.add(self._normalize_netloc(urllib.parse.urlsplit(tunnel_url).netloc))
            except ValueError:
                pass
        allowed.discard("")
        return origin_host in allowed

    def _is_authenticated(self) -> bool:
        """Whether this request presented a VALID token through an accepted
        credential channel (Bearer / X-Auth-Token / wf_session cookie). Used
        for the UI auth badge; a valid token is what unlocks POST actions."""
        if not get_auth_token():
            return True
        presented = self._presented_token()
        return bool(presented) and self._token_matches(presented)

    # --- Audit trail hook (ticket 015) ---

    def _audit_action(self, req, outcome: str):
        """Record one POST /api/action call in job/audit.jsonl (FR-1/FR-5).
        `req` is the parsed JSON body when it was readable, else None (the
        body of a request rejected before parsing is never read). The client
        IP is stored only as a sha256[:12] hash — plaintext IPs never appear
        in the file. Never raises and never blocks the action:
        append_audit_entry swallows its own failures."""
        if isinstance(req, dict):
            action = str(req.get("action") or "")
            ticket = str(req.get("ticket") or "").strip()
            params = {k: v for k, v in req.items() if k not in ("action", "ticket")}
        else:
            action, ticket, params = "", "", {}
        append_audit_entry(
            action=action,
            ticket=ticket,
            params=params,
            client_ip=self._audit_client_ip(),
            outcome=outcome,
            user_agent=self.headers.get("User-Agent", ""),
        )

    def _send_json(self, status: int, data: dict, headers=None):
        data = scrub_secrets(data, live_secret_values())
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers or ():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _handle_events(self):
        """GET /api/events: Server-Sent-Events stream (ticket 027, FR-1).
        Auth already passed in do_GET (loopback open, else wf_session cookie
        or Bearer). Holds the connection until the client disconnects."""
        if self.command == "HEAD":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        q = sse_register_client()
        if q is None:
            self._send_json(503, {"error": "Too many event streams."})
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(
                ("event: hello\ndata: " + json.dumps({"ts": utc_now_iso()}) + "\n\n").encode("utf-8")
            )
            self.wfile.flush()
            last_write = time.time()
            while True:
                try:
                    msg = q.get(timeout=1.0)
                except queue.Empty:
                    msg = None
                if sse_peer_closed(self.connection):
                    break  # dead client: free the slot now, not after a failed write
                if msg is None:
                    if time.time() - last_write < SSE_PING_SECONDS:
                        continue
                    msg = ": ping\n\n"
                self.wfile.write(msg.encode("utf-8"))
                self.wfile.flush()
                last_write = time.time()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass  # client went away: release the slot quietly
        finally:
            sse_unregister_client(q)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            html_path = REPO_ROOT / ".claude" / "dashboard" / "index.html"
            if not html_path.is_file():
                self.send_error(404, "Dashboard index.html not found.")
                return

            # Remote gate (ticket 052). Local clients (loopback socket, no
            # proxy header) get the app without a token. Every remote client
            # (LAN, tunnel, or any request carrying a proxy header) gets only
            # the sign-in page unless it presents a valid token.
            #
            # One-time token bootstrap (FR-3): a GET carrying ?token=<valid>
            # sets an HttpOnly wf_session cookie and serves the page; the
            # client then strips the query parameter. A query-string token is
            # never accepted anywhere else (especially not for POST).
            set_cookie = None
            if get_auth_token():
                q_token = self._query_token()
                if q_token:
                    locked = self._is_locked_out()
                    if locked and not self._shared_lock_accepts(q_token):
                        self._send_signin(429, "locked")
                        return
                    if not locked and not self._token_matches(q_token):
                        self._register_auth_failure(q_token, "query")
                        self._send_signin(401, "invalid")
                        return
                    if not locked:
                        self._register_auth_success()
                    # Ticket 064: a local visit sets no cookie (cookies are not
                    # separated by port, so every server on 127.0.0.1 would get
                    # it); a local visit clears one an earlier version set.
                    if not self._is_local():
                        set_cookie = (
                            f"wf_session={q_token}; Path=/; Max-Age=2592000; "
                            f"HttpOnly; SameSite=Lax" + self._cookie_secure_suffix()
                        )
                    elif self._has_wf_session_cookie():
                        set_cookie = self._clear_cookie_value()
                elif self._is_local():
                    if self._has_wf_session_cookie():
                        set_cookie = self._clear_cookie_value()
                else:
                    cred = self._presented_credential()
                    if self._is_locked_out():
                        # A locked shared entry still admits the correct
                        # token (ticket 058); anything else gets the 429.
                        if not self._shared_lock_accepts(cred[0] if cred else None):
                            self._send_signin(429, "locked")
                            return
                    elif cred is None:
                        self._send_signin(401, "signed-out")
                        return
                    else:
                        presented, via = cred
                        if not self._token_matches(presented):
                            self._register_auth_failure(presented, via)
                            # Clear the cookie only when the cookie decided
                            # (ticket 058, FR-7), as the JSON 401 does.
                            self._send_signin(401, "invalid", clear_cookie=(via == "cookie"))
                            return
                        self._register_auth_success()

            with open(html_path, "rb") as f:
                content = f.read()
            # Show the project name and the port this server is actually
            # bound to in the page title (the static file keeps its (:3080)
            # default), and fill the header's empty #project-name span
            # (ticket 051 FR-2). The name is cleaned ASCII, escaped anyway.
            project_name = html.escape(get_project_identity()[0]).encode("ascii")
            content = re.sub(
                rb"(<title>)([^<]*?)\(:\d+\)",
                lambda m: m.group(1) + project_name + b" - " + m.group(2)
                + b"(:%d)" % self.server.server_address[1],
                content,
                count=1,
            )
            content = content.replace(
                b'<span id="project-name" class="project-name"></span>',
                b'<span id="project-name" class="project-name">' + project_name + b"</span>",
                1,
            )
            # Ticket 064 (FR-1): mark the page's own <script> tags with a fresh
            # nonce and send the strict policy. The file on disk is not edited.
            nonce = secrets.token_hex(16)
            content = re.sub(
                rb"<script(?=[\s/>])",
                b'<script nonce="' + nonce.encode("ascii") + b'"',
                content,
                flags=re.IGNORECASE,
            )
            self.send_response(200)
            if set_cookie:
                self.send_header("Set-Cookie", set_cookie)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", APP_CSP_TEMPLATE.format(nonce=nonce))
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)
            return

        if path == "/api/audit":
            # Audit trail admin view (ticket 015, FR-2): the token is
            # required ALWAYS — even from loopback. This is an explicit
            # exception to the loopback-read-open rule below, mirroring
            # how POST actions are treated.
            if not self._check_auth(require_token=True):
                return
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                tail = int(qs.get("tail", ["100"])[0])
            except (ValueError, IndexError):
                tail = 100
            tail = max(1, min(tail, AUDIT_MAX_ENTRIES))
            self._send_json(200, {"entries": read_audit_tail(tail)})
            return

        # Every API/data endpoint is deny-by-default: loopback may read
        # without a token; anything else needs a valid token (FR-1).
        if not self._check_auth(require_token=False):
            return

        if path == "/api/events":
            self._handle_events()
            return

        if path == "/api/identity":
            # Ticket 051 FR-3: who this dashboard serves. It carries no
            # token, config or other data.
            name, source = get_project_identity()
            self._send_json(200, {
                "app": "worker-fleet",
                "project": name,
                "projectSource": source,
                "root": str(REPO_ROOT),
                "port": self.server.server_address[1],
                "pid": os.getpid(),
            })
            return

        if path == "/api/state":
            cfg = get_config()
            c_concur = cfg.get("concurrency", {})
            main_port = c_concur.get("mainPort", 3000)
            rep_port = c_concur.get("reproducerPort", 3090)
            dash_port = cfg.get("dashboard", {}).get("port", 3080)

            # Fixed rows only; one row per running worker is added below
            # from the heartbeats (ticket 045).
            ports_to_check = [
                {"port": main_port, "label": f"Main ({main_port})", "online": check_port_listening(main_port)},
                {"port": dash_port, "label": f"Dashboard ({dash_port})", "online": True},
                {"port": rep_port, "label": f"Reproducer ({rep_port})", "online": check_port_listening(rep_port)},
            ]

            tickets = parse_board_md()
            workers = get_worker_statuses()
            ports_to_check.extend(build_worker_port_rows(workers))
            worktrees = get_worktrees()

            # Annotate each registered worktree with its ticket id and display
            # phase (heartbeat phase when a status file exists, else "building").
            main_first_parent = None
            for wt in worktrees:
                wt_path = wt.get("path") or ""
                try:
                    is_main = bool(wt_path) and Path(wt_path).resolve() == REPO_ROOT
                except Exception:
                    is_main = False
                if wt.get("branch") in ("main", "master"):
                    is_main = True
                wt["isMain"] = is_main
                wt["ticket"] = parse_worktree_ticket_id(wt.get("branch", ""), wt_path)
                phase = ""
                if wt_path:
                    matching = [w for w in workers if w.get("worktree") == wt_path]
                    if matching:
                        phase = str(matching[0].get("phase") or "")
                wt["displayPhase"] = phase or ("" if is_main else "building")
                # Ticket 026: for a worktree with no live heartbeat, say whether
                # its HEAD is landed work (an ancestor of main that is NOT on
                # main's first-parent chain). The UI falls back to the board
                # status only for such worktrees; a fresh fix/NNN-* rework
                # branch cut from main is not landed and stays Active.
                wt["merged"] = False
                if not is_main and not phase and wt.get("commit"):
                    try:
                        if main_first_parent is None:
                            fp = subprocess.run(
                                ["git", "rev-list", "--first-parent", "main"],
                                cwd=REPO_ROOT, capture_output=True, text=True, check=False,
                            )
                            main_first_parent = {x[:8] for x in fp.stdout.split()} if fp.returncode == 0 else set()
                        anc = subprocess.run(
                            ["git", "merge-base", "--is-ancestor", wt["commit"], "main"],
                            cwd=REPO_ROOT, capture_output=True, text=True, check=False,
                        )
                        wt["merged"] = anc.returncode == 0 and wt["commit"][:8] not in main_first_parent
                    except Exception:
                        wt["merged"] = False

            for t in tickets:
                tid = t["id"]
                matching_workers = [
                    w for w in workers
                    if w.get("role") != "writer"
                    and (str(w.get("ticket", "")) == tid or str(w.get("ticket", "")).startswith(f"{tid}-"))
                ]
                if matching_workers and t["status"] != "done":
                    phases = [str(w.get("phase", "")).lower() for w in matching_workers]
                    if "blocked" in phases:
                        t["status"] = "blocked"
                    elif any(p not in ("done", "failed", "") for p in phases):
                        t["status"] = "in-progress"

            # Ticket 092: the done time (null unless the ticket is done and its results.json says when).
            for t in tickets:
                t["doneAt"] = read_done_at(t)

            # Remote-control pause state (ticket 013): the router ledger's
            # `paused` set is the server-side truth; pending (unconsumed)
            # intents are shown separately.
            paused_ids = get_paused_tickets()
            pending_ids = get_pending_intents()
            for t in tickets:
                t["paused"] = t["id"] in paused_ids
                if t["id"] in pending_ids:
                    t["pendingIntent"] = pending_ids[t["id"]]

            # Live burn (ticket 014, FR-6): every worker gains a `budget`
            # block merged from the ledger, its heartbeat and telemetry.
            try:
                ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
                dispatched = ledger.get("dispatched", []) if isinstance(ledger, dict) else []
            except Exception:
                dispatched = []
            try:
                tele_doc = get_telemetry_data("all")
                by_ticket = tele_doc.get("byTicket", {})
                by_ticket_budget = tele_doc.get("byTicketBudget", {})
            except Exception:
                by_ticket, by_ticket_budget = {}, {}
            budget_defaults = cfg.get("budget", {}).get("defaults", {})
            for w in workers:
                if w.get("role") == "writer":
                    w["budget"] = None  # a writer has no budget meter (ticket 070)
                    continue
                w["budget"] = merge_worker_budget(w, dispatched, budget_defaults, by_ticket, by_ticket_budget)

            # Ticket 093: the live-run figures of each Building ticket (null for every other status).
            for t in tickets:
                t["run"] = build_ticket_run(t, dispatched, workers, by_ticket_budget, budget_defaults)

            # Ticket 012: never serve raw provider secrets, not even via `config`.
            notif_summary = get_notifications_summary(cfg)
            cfg_public = dict(cfg)
            if "notifications" in cfg_public:
                cfg_public["notifications"] = notif_summary

            state = {
                "paused": paused_ids,
                "pendingIntents": pending_ids,
                "dispatchIntent": get_dispatch_intent(),
                "timestamp": utc_now_iso(),
                "config": redact_secrets(cfg_public),
                "notifications": notif_summary,
                "authenticated": self._is_authenticated(),
                "tunnelUrl": get_tunnel_url(),
                "tickets": tickets,
                "workers": workers,
                "worktrees": worktrees,
                "ports": ports_to_check,
                "swarm": get_swarm_state(),
                "pipeline": get_pipeline_state(),
            }
            state = scrub_live_token(state, get_auth_token())
            self._send_json(200, state)
            return

        if path.startswith("/api/ticket/"):
            tid = path.split("/api/ticket/")[1].split("/")[0].strip()
            if not is_valid_ticket_id(tid):
                self._send_json(400, {"error": "Invalid ticket parameter: a numeric ticket id (e.g. 013) is required."})
                return
            tdir = resolve_ticket_dir(tid)
            if not tdir:
                self._send_json(404, {"error": f"Ticket {tid} not found"})
                return

            def read_file_safe(p: Path):
                return p.read_text(encoding="utf-8", errors="ignore") if p.is_file() else None

            evidence_files = []
            ev_dir = tdir / "evidence"
            if ev_dir.is_dir():
                for ef in sorted(ev_dir.iterdir()):
                    if ef.is_file():
                        is_img = ef.suffix.lower() in EVIDENCE_IMAGE_TYPES
                        evidence_files.append({
                            "name": ef.name,
                            "url": f"/api/evidence/{tid}/{ef.name}",
                            "isImage": is_img,
                            "size": ef.stat().st_size,
                        })

            git_info = None
            try:
                res = subprocess.run(
                    ["git", "log", "--all", "-n", "5", "--oneline", f"--grep={tid}"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if res.returncode == 0 and res.stdout.strip():
                    git_info = res.stdout.strip()
            except Exception:
                pass

            # results.json (ticket 007): parsed object, or None when absent / corrupt / not an object.
            results_json = None
            try:
                rj_path = tdir / "results.json"
                if rj_path.is_file():
                    parsed = json.loads(rj_path.read_text(encoding="utf-8"))
                    if isinstance(parsed, dict):
                        results_json = parsed
            except (OSError, ValueError):
                results_json = None

            res_data = {
                "id": tid,
                "folder": tdir.name,
                "rd": read_file_safe(tdir / "rd.md"),
                "eval": read_file_safe(tdir / "eval.md"),
                "contract": read_file_safe(tdir / "contract.md"),
                "results": read_file_safe(tdir / "results.md"),
                "resultsJson": results_json,
                "decision": read_file_safe(tdir / "user-decision.md"),
                "evidence": evidence_files,
                "git": git_info,
            }
            self._send_json(200, res_data)
            return

        if path.startswith("/api/evidence/"):
            parts = path.split("/api/evidence/")[1].split("/")
            if len(parts) >= 2:
                tid, filename = parts[0], parts[1]
                tdir_ev = resolve_ticket_dir(tid)
                if tdir_ev:
                    efile = tdir_ev / "evidence" / filename
                    if efile.is_file() and efile.resolve().is_relative_to(REPO_ROOT):
                        mime_type = EVIDENCE_IMAGE_TYPES.get(
                            efile.suffix.lower(), EVIDENCE_TEXT_TYPE
                        )
                        with open(efile, "rb") as f:
                            content = f.read()
                        if mime_type == EVIDENCE_TEXT_TYPE:
                            content = scrub_secret_bytes(content, live_secret_values())
                        self.send_response(200)
                        self.send_header("Content-Type", mime_type)
                        self.send_header("Content-Length", str(len(content)))
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.send_header("Content-Security-Policy", EVIDENCE_CSP)
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(content)
                        return
            self.send_error(404, "Evidence file not found")
            return

        if path == "/api/telemetry/history":
            # Hourly trend snapshots (ticket 014, FR-4).
            self._send_json(200, {"entries": telemetry_mod.read_history(REPO_ROOT)})
            return

        if path == "/api/telemetry":
            qs = urllib.parse.parse_qs(parsed.query)
            window = (qs.get("window", ["all"])[0] or "all").lower()
            if window not in telemetry_mod.WINDOWS:
                self._send_json(400, {"error": "Invalid window: use run, today or all."})
                return
            self._send_json(200, get_telemetry_data(window))
            return

        if path == "/api/watchdog":
            # Parsed script-mode watchdog report (ticket 017, FR-5).
            # GET semantics per 001: loopback reads open (the deny-by-default
            # gate above already ran), token required from elsewhere.
            report = read_watchdog_report()
            if report is None:
                # No completed tick yet (e.g. first request racing the
                # startup tick): run one synchronous check so the caller
                # never gets an empty-handed 200. Failure still answers 200
                # with the empty five-key schema — the report is a health
                # view, not an action.
                try:
                    report = run_watchdog_check()
                    write_watchdog_report(report)
                except Exception as e:
                    print(f"[watchdog] synchronous check failed: {e}", file=sys.stderr)
                    report = _empty_watchdog_report()
                    report["anomalies"] = [f"watchdog check unavailable: {e}"]
            self._send_json(200, report)
            return

        if path == "/api/logs":
            # Ticket 011: bounded worker log streaming (FR-3).
            # The ticket parameter is sanitized to a strict charset
            # (alphanumeric + dash) so the job/logs glob can never be
            # turned into a path traversal; anything else is a 400.
            qs = urllib.parse.parse_qs(parsed.query)
            ticket_params = qs.get("ticket", [])
            ticket = ticket_params[0].strip() if ticket_params else ""
            if not is_valid_ticket_id(ticket):
                self._send_json(400, {"error": "Invalid ticket parameter: a numeric ticket id (e.g. 013) is required."})
                return

            tail_n = 200
            tail_params = qs.get("tail", [])
            if tail_params:
                try:
                    tail_n = int(tail_params[0])
                except ValueError:
                    self._send_json(400, {"error": "Invalid tail parameter: a positive integer is required."})
                    return
                if tail_n < 1 or tail_n > 10000:
                    self._send_json(400, {"error": "Invalid tail parameter: must be between 1 and 10000."})
                    return

            logs_dir = REPO_ROOT / "job" / "logs"
            matches = sorted(logs_dir.glob(f"{ticket}-*.log")) if logs_dir.is_dir() else []
            if not matches:
                self._send_json(404, {"error": f"No log files found for ticket {ticket}"})
                return

            # Chronological order (oldest first, name as tie-break): for a
            # live ticket this surfaces the phase logs in the order they
            # were created — dev, then tester, then reviewer.
            def _log_sort_key(p: Path):
                try:
                    return (p.stat().st_mtime, p.name)
                except OSError:
                    return (0.0, p.name)

            files = []
            for lf in sorted(matches, key=_log_sort_key):
                entry = {"name": lf.name, "lines": []}
                try:
                    with open(lf, "r", encoding="utf-8", errors="ignore") as f:
                        all_lines = f.readlines()
                    entry["lines"] = [ln.rstrip("\r\n") for ln in all_lines[-tail_n:]]
                except OSError:
                    pass  # unreadable file: still listed, with empty lines
                files.append(entry)
            self._send_json(200, {"ticket": ticket, "files": files})
            return

        self.send_error(404, "Endpoint not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/action":
            # POST actions ALWAYS require a valid token — including from
            # loopback (FR-2). A query-string token is never accepted here:
            # _presented_token() only reads Bearer / X-Auth-Token / cookie.
            #
            # Audit trail (ticket 015): every /api/action call — success or
            # failure — leaves exactly one line in job/audit.jsonl. Calls
            # rejected at the auth gate are recorded without action/params:
            # the body of a request rejected before parsing is never read.
            #
            # Ticket 056: the origin gate runs first (a cross-origin POST is
            # 403 with or without a credential, never an auth failure); the
            # token must be in a header (the wf_session cookie alone is not
            # accepted); and the body must be application/json.
            if not self._post_origin_allowed():
                self._audit_action(None, "error:403")
                self._send_json(403, {"error": "Cross-origin request rejected."})
                return

            # Ticket 081: _check_auth writes the error:401 / error:429 audit
            # line itself, before it sends the refusal.
            if not self._check_auth(require_token=True, header_only=True, audit_rejection=True):
                return

            cfg = get_config()
            if not cfg.get("dashboard", {}).get("allowRemoteActions", True):
                self._audit_action(None, "error:403")
                self._send_json(403, {"error": "Remote actions are disabled in specs/worker-fleet.config.json"})
                return

            media_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if media_type != "application/json":
                self._audit_action(None, "error:415")
                self._send_json(415, {"error": "Content-Type must be application/json."})
                return

            try:
                content_len = int(self.headers.get("Content-Length", 0))
                post_data = self.rfile.read(content_len)
                req = json.loads(post_data.decode("utf-8"))
            except Exception as e:
                self._audit_action(None, "error:400")
                self._send_json(400, {"error": f"Invalid JSON payload: {e}"})
                return

            action = req.get("action")
            ticket_id = str(req.get("ticket", "")).strip()

            if action == "set_ticket_status":
                new_status = str(req.get("status", "ready")).lower()
                if new_status not in TICKET_STATUSES:
                    self._audit_action(req, "error:400")
                    self._send_json(
                        400,
                        {
                            "error": (
                                f"Invalid status '{new_status}'. "
                                f"Valid statuses: {', '.join(TICKET_STATUSES)}."
                            )
                        },
                    )
                    return
                # Malformed id (BOARD, "01", traversal, Unicode digits) -> 400.
                if not is_valid_ticket_id(ticket_id):
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": "Invalid ticket parameter: a numeric ticket id of at least 3 digits (e.g. 013) is required."})
                    return
                board_path = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
                tdir = resolve_ticket_dir(ticket_id)
                if board_path.is_file():
                    rd_unreadable = False
                    with _board_lock:
                        # Check rd.md first (ticket 083): a file that cannot be read as
                        # UTF-8 text refuses the change before the board is written.
                        if tdir and (tdir / "rd.md").is_file():
                            try:
                                (tdir / "rd.md").read_bytes().decode("utf-8")
                            except (OSError, UnicodeDecodeError):
                                rd_unreadable = True
                        lines = [] if rd_unreadable else board_path.read_text(encoding="utf-8").splitlines()
                        new_lines = []
                        updated = False
                        for line in lines:
                            stripped = line.strip()
                            # Only data rows: skip the header (`#`) and separator rows.
                            if stripped.startswith("|") and not BOARD_SEPARATOR_RE.match(stripped):
                                parts = [p.strip() for p in stripped.split("|")[1:-1]]
                                if len(parts) >= 3 and parts[0] != "#" and parts[0] == ticket_id:
                                    parts[2] = new_status
                                    new_lines.append("| " + " | ".join(parts) + " |")
                                    updated = True
                                    continue
                            new_lines.append(line)
                        # Never touch the board when nothing matched.
                        if updated:
                            write_board_atomic(board_path, "\n".join(new_lines) + "\n")

                    if rd_unreadable:
                        self._audit_action(req, "error:409")
                        self._send_json(
                            409,
                            {
                                "error": (
                                    f"Ticket {ticket_id}: specs/tickets/{tdir.name}/rd.md "
                                    "is not readable UTF-8 text, so the status was not changed. "
                                    "Fix the file, then try again."
                                )
                            },
                        )
                        return

                    # rd.md is touched only inside the exactly-resolved folder.
                    if not updated and not tdir:
                        self._audit_action(req, "error:404")
                        self._send_json(404, {"error": f"Ticket {ticket_id} not found"})
                        return
                    if tdir:
                        rd_path = tdir / "rd.md"
                        if rd_path.is_file():
                            set_rd_header_status(rd_path, new_status)

                    self._audit_action(req, "ok")
                    self._send_json(200, {"ok": True, "ticket": ticket_id, "newStatus": new_status, "updated": updated})
                    return

            elif action == "set_ticket_priority":
                new_prio = str(req.get("prio", "")).strip().upper()
                if new_prio not in TICKET_PRIORITIES:
                    self._audit_action(req, "error:400")
                    self._send_json(
                        400,
                        {
                            "error": (
                                f"Invalid priority '{new_prio}'. "
                                f"Valid priorities: {', '.join(TICKET_PRIORITIES)}."
                            )
                        },
                    )
                    return
                # Ticket ids are numeric; reject anything else (notably the
                # `#` header cell) before the board is even opened.
                if not re.fullmatch(r"\d+", ticket_id):
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": "Invalid ticket id: expected digits only."})
                    return
                board_path = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
                updated = False
                with _board_lock:
                    if board_path.is_file():
                        lines = board_path.read_text(encoding="utf-8").splitlines()
                        new_lines = []
                        for line in lines:
                            stripped = line.strip()
                            # Only data rows: skip the header (`#`) and separator rows.
                            if stripped.startswith("|") and not BOARD_SEPARATOR_RE.match(stripped):
                                parts = [p.strip() for p in stripped.split("|")[1:-1]]
                                if len(parts) >= 5 and parts[0] != "#" and parts[0] == ticket_id:
                                    if len(parts) >= 6:
                                        # 6-column row: Prio is the 5th cell.
                                        parts[4] = new_prio
                                    else:
                                        # Legacy 5-column row: insert Prio
                                        # between Mode and Runs.
                                        parts.insert(4, new_prio)
                                    new_lines.append("| " + " | ".join(parts) + " |")
                                    updated = True
                                    continue
                            new_lines.append(line)
                        # Never touch the board when nothing matched.
                        if updated:
                            write_board_atomic(board_path, "\n".join(new_lines) + "\n")
                if not updated:
                    self._audit_action(req, "error:404")
                    self._send_json(404, {"error": f"Ticket '{ticket_id}' not found on the board."})
                    return
                self._audit_action(req, "ok")
                self._send_json(200, {"ok": True, "ticket": ticket_id, "prio": new_prio, "updated": True})
                return

            elif action == "submit_decision":
                decision_text = str(req.get("decision", "")).strip()
                if decision_text and not is_valid_ticket_id(ticket_id):
                    # BOARD, "01", "../../x", Unicode digits: never reaches the filesystem.
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": "Invalid ticket parameter: a numeric ticket id of at least 3 digits (e.g. 013) is required."})
                    return
                if ticket_id and decision_text:
                    tdir_dec = resolve_ticket_dir(ticket_id)
                    if not tdir_dec:
                        self._audit_action(req, "error:404")
                        self._send_json(404, {"error": f"Ticket {ticket_id} not found"})
                        return
                    if tdir_dec:
                        dec_path = tdir_dec / "user-decision.md"
                        content = (
                            f"# User Decision for Ticket {ticket_id}\n\n"
                            f"**Submitted:** {utc_now_iso()}\n\n"
                            f"## Instructions\n{decision_text}\n"
                        )
                        dec_path.write_text(content, encoding="utf-8")

                        patterns = [
                            str(REPO_ROOT / ".claude" / "worktrees" / "*" / "job" / "status.json"),
                            str(REPO_ROOT / "job" / "status-*.json"),
                            str(REPO_ROOT / "job" / "status.json"),
                        ]
                        found_files = []
                        for p in patterns:
                            found_files.extend(glob.glob(p))
                        for fpath_str in set(found_files):
                            fpath = Path(fpath_str)
                            try:
                                wdata = json.loads(fpath.read_text(encoding="utf-8"))
                                wticket = str(wdata.get("ticket", ""))
                                if wticket == ticket_id or wticket.startswith(f"{ticket_id}-"):
                                    if wdata.get("phase") == "blocked":
                                        wdata["phase"] = "implementing"
                                        wdata["updatedAt"] = utc_now_iso()
                                        wdata["note"] = f"Unblocked via Fleet Control: {decision_text[:80]}"
                                        fpath.write_text(json.dumps(wdata, indent=2) + "\n", encoding="utf-8")
                            except Exception:
                                pass

                        self._audit_action(req, "ok")
                        self._send_json(200, {"ok": True, "ticket": ticket_id, "file": str(dec_path.relative_to(REPO_ROOT))})
                        return

            elif action == "reset_telemetry":
                # Ticket 014 (FR-3): record a baseline instead of deleting
                # any data; telemetry views then count from this instant.
                try:
                    stamp = telemetry_mod.write_baseline(REPO_ROOT)
                except Exception as e:
                    self._audit_action(req, "error:500")
                    self._send_json(500, {"error": str(e)})
                    return
                self._audit_action(req, "ok")
                self._send_json(200, {"ok": True, "baseline": stamp})
                return

            elif action == "trigger_watchdog":
                script = REPO_ROOT / ".claude" / "scripts" / "watchdog-check.sh"
                if script.is_file():
                    try:
                        res = subprocess.run(["bash", str(script)], cwd=REPO_ROOT, capture_output=True, text=True, timeout=15)
                        self._audit_action(req, "ok")
                        self._send_json(200, {"ok": True, "output": res.stdout, "errors": res.stderr})
                        return
                    except Exception as e:
                        self._audit_action(req, "error:500")
                        self._send_json(500, {"error": str(e)})
                        return

            elif action == "reap_completed":
                # Ticket 026 (FR-4): run the completed-worktree reaper with
                # --apply and return its JSON report (same pattern as
                # trigger_watchdog above; the 015 audit hook wraps this like
                # every other action). The optional "path" parameter scopes
                # the reap to exactly one worktree directory for safe
                # testing — without it the full-registry reap runs, which is
                # the router's post-merge job. The script itself enforces
                # the four-gate safety check (done + merged + evidence +
                # clean) and never removes anything that fails a gate.
                script = REPO_ROOT / ".claude" / "scripts" / "watchdog-check.sh"
                if script.is_file():
                    scope_path = str(req.get("path", "") or "").strip()
                    cmd = ["bash", str(script), "--reap-completed", "--apply"]
                    if scope_path:
                        cmd += ["--path", scope_path]
                    try:
                        res = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=120)
                        if res.returncode != 0:
                            self._audit_action(req, "error:500")
                            self._send_json(500, {"error": (res.stderr or res.stdout or "watchdog-check.sh failed").strip()})
                            return
                        try:
                            report = json.loads(res.stdout)
                        except Exception:
                            report = res.stdout
                        self._audit_action(req, "ok")
                        self._send_json(200, {"ok": True, "report": report, "errors": res.stderr})
                        return
                    except Exception as e:
                        self._audit_action(req, "error:500")
                        self._send_json(500, {"error": str(e)})
                        return
            elif action == "resume_swarm":
                # Ticket 028 (FR-1): queue a swarm-wide resume intent at
                # job/control/_swarm.json (the leading underscore can never
                # collide with a ticket id file, and it is NOT the stray
                # `.continue` opencode CLI artifact). The server stays
                # non-privileged: the router consumes + deletes it.
                try:
                    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
                    intent = {"action": "resume", "issuedAt": utc_now_iso(), "by": "dashboard"}
                    fd, tmp = tempfile.mkstemp(dir=str(CONTROL_DIR), prefix="._swarm.", suffix=".tmp")
                    try:
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(json.dumps(intent) + "\n")
                        os.replace(tmp, CONTROL_DIR / "_swarm.json")
                    except Exception:
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        raise
                except Exception as e:
                    self._audit_action(req, "error:500")
                    self._send_json(500, {"error": str(e)})
                    return
                self._audit_action(req, "ok")
                self._send_json(200, {"ok": True, "action": action, "queued": True, "intentFile": "job/control/_swarm.json"})
                return
            elif action == "dispatch_now":
                # Ticket 080 (FR-1..FR-3): queue a Dispatch now intent at
                # job/control/_dispatch.json, same atomic pattern as
                # resume_swarm. Any other body field is ignored; the router
                # consumes + deletes the file.
                try:
                    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
                    intent = {"action": "dispatch", "issuedAt": utc_now_iso(), "by": "dashboard"}
                    fd, tmp = tempfile.mkstemp(dir=str(CONTROL_DIR), prefix="._dispatch.", suffix=".tmp")
                    try:
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(json.dumps(intent) + "\n")
                        os.replace(tmp, CONTROL_DIR / "_dispatch.json")
                    except Exception:
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        raise
                except Exception as e:
                    self._audit_action(req, "error:500")
                    self._send_json(500, {"error": str(e)})
                    return
                self._audit_action(req, "ok")
                self._send_json(200, {"ok": True, "action": action, "queued": True, "intentFile": "job/control/_dispatch.json"})
                return
            elif action in CONTROL_ACTIONS:
                # Remote control intents (ticket 013, FR-1/FR-2/FR-5): the
                # server never touches agents — it validates the request and
                # queues a job/control/<ticket>.json intent file for the
                # router's next cycle. POST auth was already enforced above
                # (001: POSTs ALWAYS require the token, even loopback).
                if not is_valid_ticket_id(ticket_id):
                    # FR-1: malformed ids (BOARD, "01", "013-remote-control")
                    # are a 400; only a well-formed NNN can then 404.
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": "Invalid ticket parameter: a numeric ticket id of at least 3 digits (e.g. 013) is required."})
                    return
                if not find_ticket_folder(ticket_id):
                    # Well-formed id with no specs/tickets/NNN-* directory.
                    self._audit_action(req, "error:404")
                    self._send_json(404, {"error": f"Ticket {ticket_id} not found"})
                    return
                ticket_status = get_ticket_status_for_control(ticket_id)
                if action == "pause_ticket" and ticket_status == "done":
                    # FR-2: pausing a finished ticket is meaningless — reject.
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": f"Cannot pause ticket {ticket_id}: it is already done."})
                    return
                if action == "stop_worker" and ticket_status == "done":
                    # Finished work must never be stopped/reset to ready.
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": f"Cannot stop ticket {ticket_id}: it is already done."})
                    return
                if action == "stop_worker" and ticket_status == "budget-exceeded":
                    # FR-5: budget enforcement already stopped this worker —
                    # friendly no-op, no intent file written.
                    self._audit_action(req, "ok")
                    self._send_json(200, {"ok": True, "ticket": ticket_id, "action": action, "note": "already stopped"})
                    return
                intent_path = write_control_intent(ticket_id, action)
                self._audit_action(req, "ok")
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "ticket": ticket_id,
                        "action": action,
                        "queued": True,
                        "intentFile": str(intent_path.relative_to(REPO_ROOT)),
                    },
                )
                return

            self._audit_action(req, "error:400")
            self._send_json(400, {"error": f"Unknown action '{action}' or missing parameters."})
            return

        self.send_error(404, "Endpoint not found")

    def log_message(self, format, *args):
        pass


class FleetControlServer(http.server.ThreadingHTTPServer):
    """Dual-stack server: binds IPv6 `::` with V6ONLY disabled so both IPv6
    clients (`::1`) and IPv4 clients (arriving as ::ffff:127.0.0.1 etc.)
    reach the same listener — required for address-based loopback auth to
    treat both families correctly (FR-1)."""

    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


def run_server(port: int = 3080):
    try:
        httpd = FleetControlServer(("::", port), FleetControlHandler)
    except OSError:
        # No IPv6 in this environment — fall back to IPv4-only.
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), FleetControlHandler)
    print(f"🚀 worker-fleet Fleet Control Dashboard server listening on http://127.0.0.1:{port}")
    warn_if_weak_token(get_auth_token())
    # Script-mode watchdog scheduler (ticket 017, FR-1): runs the first
    # watchdog-check.sh --json immediately on startup, then every
    # watchdog.intervalSeconds. Daemon thread — it can never block or crash
    # the HTTP server, and tick failures retry on the next tick.
    start_watchdog_scheduler()
    # Telemetry history ring (ticket 014, FR-4): snapshot now, then hourly.
    start_telemetry_history()
    # SSE file-watcher (ticket 027): daemon thread, failures never crash the server.
    start_sse_watcher()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down worker-fleet Fleet Control Dashboard server...")
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="worker-fleet Fleet Control Server")
    parser.add_argument("--port", type=int, default=3080, help="Server port (default: 3080)")
    args = parser.parse_args()
    # Ticket 089, FR-17: a legacy-only config would make get_config() fall back to
    # defaults (allowRemoteActions on, the default tunnel). Refuse before any
    # socket is bound or any scheduler is started.
    if (
        not os.path.lexists(REPO_ROOT / "specs" / "worker-fleet.config.json")
        and os.path.lexists(REPO_ROOT / LEGACY_CONFIG_REL)
    ):
        print(
            "dashboard-server.py: error: specs/worker-fleet.config.json is missing but "
            f"{LEGACY_CONFIG_REL} exists, and that file is no longer read. Run "
            "python3 .claude/scripts/apply-setup.py to migrate it. Nothing was started.",
            file=sys.stderr,
        )
        sys.exit(1)
    run_server(args.port)

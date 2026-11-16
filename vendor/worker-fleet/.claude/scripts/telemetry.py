#!/usr/bin/env python3
"""telemetry.py - token / cost telemetry for the worker-fleet (ticket 014).

Public API
----------
get_telemetry(window="all", run_id=None, repo_root=None) -> dict
    Scan Claude Code, OpenCode and Codex CLI usage logs and return the
    dashboard telemetry document. `window` is one of:

      "run"    since the current job/router-state.json `startedAt`
               (`run_id`, when given, must match the ledger's `runId`)
      "today"  since local midnight
      "all"    everything on disk

    A reset baseline (job/telemetry-baseline.json, written by
    write_baseline()) is a lower bound for EVERY window's totals, so "Reset"
    makes all views start counting from that instant. `byTicket` deliberately
    ignores the baseline: the router reads it for budget enforcement and a
    cosmetic dashboard reset must never zero a ticket's spend.

read_history(repo_root=None) / snapshot_history(repo_root=None)
    Hourly trend ring buffer in job/telemetry-history.json (30 days).

read_baseline() / write_baseline()
    The reset baseline (`{"baseline": "<ISO-8601>"}`).

Every cost figure is an ESTIMATE: tokens x the rates in
specs/worker-fleet.config.json `telemetry.rates` (USD per 1M tokens, keys are
matched as substrings of the model name, longest key first). A model that
matches no key is priced at the CHEAPEST configured rate and reported with
`"rate": "unknown"` in `byModel` (and listed in `unknownModels`) - it is never
dropped. Costs a harness itself reports (OpenCode `cost`) are used verbatim.

Attribution
-----------
Claude Code : the record's own `attributionAgent` / `subagent_type`, else the
              sub-agent sidecar `agent-*.meta.json` `agentType`, else the main
              session's `agent-setting` record. Only when none exists does
              filename / entrypoint guessing apply (last resort), and unknown
              roles land in "other". Records are de-duplicated on
              (message id, request id) because one API response is logged once
              per content block.
OpenCode    : `message` joined to `session` on the real session id; role is the
              message's own `agent`; only sessions whose directory is the
              repo, inside it, or a sibling worktree (<repo>-wt-*) are counted.
Codex       : per session, from the recorded invoking context - a read-only
              sandbox or review-style prompt is "reviewer", a reproduction
              prompt is "reproducer", everything else (and anything unknown)
              is "delegate". Never blanket-attributed to one role. Usage is
              taken as deltas of the cumulative `total_token_usage`.
Ticket      : strict branch names (feat|fix|ticket/NNN-...), sub-agent
              description ("ticket NNN"), worktree path, or the
              `specs/tickets/NNN-` path a prompt mentions.

Scan bound (no silent truncation)
---------------------------------
Every session file is parsed (there is no file-count cap), but at most the
NEWEST 50,000 lines (MAX_LINES_PER_FILE) of any single file are scanned.
The response reports `truncatedFiles` so a clipped scan is visible.

Budget counting (ticket 050)
----------------------------
`byTicketBudget` is the spend the router enforces against a ticket's USD cap:
`{"NNN": {"tokens": N, "cost": USD, "since": "<YYYY-MM-DDTHH:MM:SSZ>"}}`.
There is one entry per key of the ledger's `budgetSince` map
(job/router-state.json, written by the router at a ticket's first dispatch in
the run). Each entry sums the same records `byTicket["NNN"]` sums (same
de-duplication, attribution and current-rate pricing) restricted to records at
or after `since` (inclusive; a record without a timestamp is not counted), so
spend before the first dispatch (writing or planning the ticket, earlier runs)
stays in `byTicket` but never counts here. It is the same for every window,
ignores the reset baseline, and is `{}` when the ledger or its `budgetSince`
is missing or unusable. Keys `NNN-slug` read as `NNN`; other keys and values
that are not ISO-8601 strings are skipped. A stamp later than the time of the
call is skipped too (ticket 065): that ticket has no `byTicketBudget` entry
until the router replaces the stamp, so a future stamp never shows a counted
$0.00 that would keep the USD cap from triggering. A stamp equal to the time of
the call counts.
"""

import collections
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_LINES_PER_FILE = 50_000
HISTORY_DAYS = 30
HISTORY_MAX_ENTRIES = HISTORY_DAYS * 24 * 4
RESULT_TTL_SECONDS = 5.0
CACHE_WRITE_MULTIPLIER = 1.25  # Anthropic prompt-cache writes cost 1.25x input

ROLES = (
    "router", "worker", "teammate", "reviewer", "reproducer", "tester",
    "merger", "checker", "watchdog", "delegate", "other",
)
WINDOWS = ("run", "today", "all")

# Used ONLY when specs/worker-fleet.config.json carries no usable
# telemetry.rates block (apply-setup.py writes the user-editable copy).
_FALLBACK_RATES = {
    "opus": {"in": 15.0, "out": 75.0, "cache": 1.5},
    "sonnet": {"in": 3.0, "out": 15.0, "cache": 0.3},
    "haiku": {"in": 0.8, "out": 4.0, "cache": 0.08},
    "gpt-5": {"in": 5.0, "out": 20.0, "cache": 1.25},
    "o3": {"in": 10.0, "out": 40.0, "cache": 2.5},
    "gpt-4.1-mini": {"in": 0.15, "out": 0.6, "cache": 0.075},
    "gpt-4.1": {"in": 2.0, "out": 8.0, "cache": 0.5},
    "deepseek": {"in": 0.14, "out": 0.28, "cache": 0.014},
}

_lock = threading.RLock()
_file_cache = {}    # path str -> (mtime_ns, size, payload)
_result_cache = {}  # args tuple -> (expires, result)
_history_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _default_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _resolve_root(repo_root) -> Path:
    return Path(repo_root).resolve() if repo_root else _default_root()


def _home(home) -> Path:
    return Path(home) if home else Path.home()


def _parse_ts(value):
    """ISO-8601 string / epoch seconds / epoch millis -> epoch seconds."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v / 1000.0 if v > 1e11 else v
    try:
        s = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        return None


def _iso(epoch) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _int(v) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _tail_lines(path: Path):
    """Return (newest MAX_LINES_PER_FILE lines, truncated?)."""
    dq = collections.deque(maxlen=MAX_LINES_PER_FILE)
    total = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            dq.append(line)
            total += 1
    return list(dq), total > MAX_LINES_PER_FILE


def _norm_role(raw, default="other") -> str:
    r = str(raw or "").strip().lower()
    return r if r in ROLES else default


# --------------------------------------------------------------------------- #
# ticket attribution helpers
# --------------------------------------------------------------------------- #

_BRANCH_TICKET = re.compile(r"(?:feat|fix|ticket|wt|chore)[/_-](\d{3})(?!\d)")
_DESC_TICKET = re.compile(r"ticket\s*#?\s*(\d{3})(?!\d)|(?<![\w/])(\d{3})-[a-z]", re.I)
_PATH_TICKET = re.compile(r"specs/tickets/(\d{3})-")
_DIR_TICKET = re.compile(r"(?:-wt-|/)(\d{3})(?:-[a-z][\w-]*)?(?:/|$)")


def _ticket_from_branch(branch) -> str:
    m = _BRANCH_TICKET.search(str(branch or ""))
    return m.group(1) if m else ""


def _ticket_from_desc(desc) -> str:
    m = _DESC_TICKET.search(str(desc or ""))
    return (m.group(1) or m.group(2)) if m else ""


def _ticket_from_dir(path) -> str:
    m = _DIR_TICKET.search(str(path or ""))
    return m.group(1) if m else ""


# --------------------------------------------------------------------------- #
# per-file parse cache
# --------------------------------------------------------------------------- #

def _cached(path: Path, parser):
    """Parse `path` with parser(path) -> payload, cached on (mtime, size)."""
    try:
        st = path.stat()
    except OSError:
        return None
    key = str(path)
    sig = (st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _file_cache.get(key)
        if hit and hit[0] == sig:
            return hit[1]
    try:
        payload = parser(path)
    except Exception:
        payload = None
    with _lock:
        _file_cache[key] = (sig, payload)
    return payload


# --------------------------------------------------------------------------- #
# Claude Code
# --------------------------------------------------------------------------- #

def _claude_project_dirs(root: Path, home: Path):
    base = home / ".claude" / "projects"
    if not base.is_dir():
        return []
    enc = re.sub(r"[^A-Za-z0-9]", "-", str(root))
    dirs = [d for d in base.iterdir()
            if d.is_dir() and (d.name == enc or d.name.startswith(enc + "-"))]
    if not dirs:
        dirs = [d for d in base.glob(f"*{root.name}*") if d.is_dir()]
    return sorted(dirs)


def _parse_meta(path: Path):
    data = _read_json(path)
    if not isinstance(data, dict):
        return {}
    ticket = (_ticket_from_branch(data.get("worktreeBranch"))
              or _ticket_from_desc(data.get("description")))
    return {
        "agentType": data.get("agentType") or "",
        "ticket": ticket,
        "worktreePath": data.get("worktreePath") or "",
    }


def _parse_claude_file(path: Path):
    lines, truncated = _tail_lines(path)
    meta = {}
    if path.name.startswith("agent-"):
        meta = _cached(path.with_suffix(".meta.json"), _parse_meta) or {}

    session_role = ""
    for line in lines:
        if '"agentSetting"' in line:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("type") == "agent-setting" and rec.get("agentSetting"):
                session_role = str(rec["agentSetting"])

    groups = {}  # (msg id, request id) -> record dict (max per field)
    out = []
    for line in lines:
        if '"usage"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        usage = msg.get("usage") or rec.get("usage")
        if not isinstance(usage, dict):
            continue
        i, o = _int(usage.get("input_tokens")), _int(usage.get("output_tokens"))
        cr = _int(usage.get("cache_read_input_tokens"))
        cc = _int(usage.get("cache_creation_input_tokens"))
        if not (i or o or cr or cc):
            continue

        role = (rec.get("attributionAgent") or rec.get("subagent_type")
                or rec.get("agent_type") or meta.get("agentType") or session_role)
        if not role:
            # Last resort only: guess from the entrypoint / file name.
            hint = f"{rec.get('entrypoint', '')} {path.name}".lower()
            role = "router" if "router" in hint else ("watchdog" if "watchdog" in hint else "other")

        ticket = (_ticket_from_branch(rec.get("gitBranch")) or meta.get("ticket")
                  or _ticket_from_dir(rec.get("cwd")))
        mid, rid = msg.get("id"), rec.get("requestId")
        item = {
            "k": f"claude:{mid}:{rid}" if (mid or rid) else None,
            "ts": _parse_ts(rec.get("timestamp")),
            "h": "claude",
            "role": _norm_role(role),
            "ticket": ticket,
            "cwd": str(rec.get("cwd") or ""),
            "model": str(msg.get("model") or "").lower(),
            "in": i, "out": o, "cr": cr, "cc": cc, "cost": None,
            "sid": str(rec.get("sessionId") or path.stem),
        }
        if item["k"] is None:
            out.append(item)
            continue
        prev = groups.get(item["k"])
        if prev is None:
            groups[item["k"]] = item
        else:
            for f in ("in", "out", "cr", "cc"):
                prev[f] = max(prev[f], item[f])
    out.extend(groups.values())
    return {"records": out, "truncated": truncated,
            "worktree": meta.get("worktreePath", ""), "ticket": meta.get("ticket", "")}


def _collect_claude(root: Path, home: Path):
    records, truncated, files = [], 0, 0
    cwd_ticket = {}
    payloads = []
    for pdir in _claude_project_dirs(root, home):
        for jf in pdir.rglob("*.jsonl"):
            payload = _cached(jf, _parse_claude_file)
            if not payload:
                continue
            files += 1
            payloads.append(payload)
            if payload["worktree"] and payload["ticket"]:
                cwd_ticket[payload["worktree"]] = payload["ticket"]
    for payload in payloads:
        truncated += 1 if payload["truncated"] else 0
        for rec in payload["records"]:
            if not rec["ticket"] and rec["cwd"]:
                for wt, tkt in cwd_ticket.items():
                    if rec["cwd"] == wt or rec["cwd"].startswith(wt + os.sep):
                        rec = dict(rec, ticket=tkt)
                        break
            records.append(rec)
    return records, truncated


# --------------------------------------------------------------------------- #
# OpenCode
# --------------------------------------------------------------------------- #

def _collect_opencode(root: Path, home: Path):
    db = home / ".local" / "share" / "opencode" / "opencode.db"
    if not db.is_file():
        return [], 0
    sig = tuple(
        (p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else (0, 0)
        for p in (db, Path(str(db) + "-wal"))
    )
    key = f"opencode:{db}:{root}"
    with _lock:
        hit = _file_cache.get(key)
        if hit and hit[0] == sig:
            return hit[1], 0
    records = []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(session)")}
            agent_col = "s.agent" if "agent" in cols else "NULL"
            parent_col = "s.parent_id" if "parent_id" in cols else "NULL"
            prefix = str(root) + os.sep
            wt_prefix = str(root) + _WT_SUFFIX
            # Join message -> session on the real session id (no LIKE-scraping
            # of free text); the directory filter keeps it to this repo.
            sql = (
                "SELECT m.id, m.session_id, m.time_created, m.data, s.directory, "
                f"{agent_col}, {parent_col} FROM message m "
                "JOIN session s ON s.id = m.session_id "
                "WHERE {tok} "
                "AND (s.directory = ? OR substr(s.directory, 1, ?) = ? "
                "OR substr(s.directory, 1, ?) = ?)"
            )
            args = (str(root), len(prefix), prefix, len(wt_prefix), wt_prefix)
            try:
                rows = conn.execute(
                    sql.format(tok="json_extract(m.data, '$.tokens') IS NOT NULL"), args
                ).fetchall()
            except sqlite3.OperationalError:  # SQLite built without JSON1
                rows = conn.execute(
                    sql.format(tok="instr(m.data, 'tokens') > 0"), args
                ).fetchall()
            for mid, sid, tcreated, data, directory, s_agent, parent in rows:
                try:
                    d = json.loads(data)
                except Exception:
                    continue
                toks = d.get("tokens") or {}
                if not isinstance(toks, dict):
                    continue
                cache = toks.get("cache") if isinstance(toks.get("cache"), dict) else {}
                i, o = _int(toks.get("input")), _int(toks.get("output"))
                cr, cw = _int(cache.get("read")), _int(cache.get("write"))
                if not (i or o or cr or cw):
                    continue
                try:
                    cost = float(d.get("cost") or 0.0)
                except Exception:
                    cost = 0.0
                tm = d.get("time") if isinstance(d.get("time"), dict) else {}
                role = d.get("agent") or d.get("mode") or s_agent
                records.append({
                    "k": f"opencode:{mid}",
                    "ts": _parse_ts(tm.get("created") or tcreated),
                    "h": "opencode",
                    "role": _norm_role(role),
                    "ticket": _ticket_from_dir(directory),
                    "cwd": str(directory or ""),
                    "model": str(d.get("modelID") or "").lower(),
                    "in": i, "out": o, "cr": cr, "cc": cw,
                    "cost": cost if cost > 0 else None,
                    "sid": str(sid),
                })
        finally:
            conn.close()
    except Exception:
        records = []
    with _lock:
        _file_cache[key] = (sig, records)
    return records, 0


# --------------------------------------------------------------------------- #
# Codex CLI
# --------------------------------------------------------------------------- #

_REPRODUCE_HINT = re.compile(r"reproduc", re.I)
_REVIEW_HINT = re.compile(
    r"--- CONTEXT / CODE DIFF ---|check (?:the )?diff|"
    r"\breview (?:the|this|my|a) (?:diff|code|changes|branch|patch)",
    re.I,
)


def _codex_role(prompt_text: str, sandbox: str) -> str:
    """Classify a Codex session by its recorded invoking context."""
    # A read-only sandbox is the review invocation (delegate-task.sh review);
    # check it first so a diff that merely mentions "reproduce" stays a review.
    if "read-only" in sandbox or "readonly" in sandbox:
        return "reviewer"
    if _REPRODUCE_HINT.search(prompt_text):
        return "reproducer"
    if _REVIEW_HINT.search(prompt_text):
        return "reviewer"
    return "delegate"


def _msg_text(payload) -> str:
    content = payload.get("content")
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                parts.append(c["text"])
    if isinstance(payload.get("message"), str):
        parts.append(payload["message"])
    return "\n".join(parts)


_CODEX_FIELDS = ("input_tokens", "output_tokens", "cached_input_tokens")


def _codex_usage(u):
    inp = _int(u.get("input_tokens") or u.get("prompt_tokens"))
    out = _int(u.get("output_tokens") or u.get("completion_tokens"))
    cached = _int(u.get("cached_input_tokens") or u.get("cache_read_input_tokens"))
    return inp, out, cached


def _parse_codex_file(path: Path):
    lines, truncated = _tail_lines(path)
    cwd, model, sandbox, sid = "", "", "", path.stem
    prompt_parts = []
    events = []  # (ts, in, out, cached)
    prev_total = None
    for line in lines:
        if not ("token" in line or "usage" in line or '"cwd"' in line
                or '"model"' in line or "sandbox" in line
                or '"role":"user"' in line or '"role": "user"' in line
                or "user_message" in line):
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        rtype = rec.get("type")
        if rtype in ("session_meta", "turn_context"):
            cwd = str(payload.get("cwd") or cwd)
            model = str(payload.get("model") or model)
            sp = payload.get("sandbox_policy") or payload.get("sandbox") or ""
            if isinstance(sp, dict):
                sp = sp.get("type") or sp.get("mode") or ""
            sandbox = str(sp or sandbox).lower()
            sid = str(payload.get("id") or sid)
        ptype = payload.get("type")
        if ((rtype == "response_item" and ptype == "message" and payload.get("role") == "user")
                or (rtype == "event_msg" and ptype == "user_message")) and len("".join(prompt_parts)) < 8000:
            prompt_parts.append(_msg_text(payload))

        ts = _parse_ts(rec.get("timestamp"))
        info = payload.get("info") if isinstance(payload.get("info"), dict) else None
        if info and isinstance(info.get("total_token_usage"), dict):
            tot = _codex_usage(info["total_token_usage"])
            if prev_total is None:
                delta = tot
            elif all(t >= p for t, p in zip(tot, prev_total)):
                delta = tuple(t - p for t, p in zip(tot, prev_total))
            else:
                delta = tot  # counter reset
            prev_total = tot
            if any(delta):
                events.append((ts, *delta))
            continue
        flat = rec.get("usage") or rec.get("token_usage") or payload.get("usage")
        if isinstance(flat, dict):
            d = _codex_usage(flat)
            if any(d):
                events.append((ts, *d))

    prompt = "\n".join(prompt_parts)
    role = _codex_role(prompt, sandbox)
    ticket = ""
    m = _PATH_TICKET.search(prompt)
    if m:
        ticket = m.group(1)
    ticket = ticket or _ticket_from_dir(cwd)
    records = []
    for n, (ts, inp, out, cached) in enumerate(events):
        records.append({
            "k": None,
            "ts": ts, "h": "codex", "role": role, "ticket": ticket, "cwd": cwd,
            "model": model.lower(),
            # Codex input_tokens INCLUDES the cached subset: bill only the
            # uncached part at the input rate.
            "in": max(0, inp - cached), "out": out, "cr": cached, "cc": 0,
            "cost": None, "sid": sid,
        })
    return {"records": records, "truncated": truncated, "cwd": cwd}


# Sibling worktrees are named "<repo>-wt-<name>" next to the repo root.
_WT_SUFFIX = "-wt-"


def _in_repo_scope(path, root) -> bool:
    """True when `path` (a Codex cwd / OpenCode directory) belongs to `root`:
    the root itself, anything under it (incl. .claude/worktrees/*), or a
    sibling worktree `<root>-wt-*` (or anything under one). Empty -> False."""
    if not path:
        return False
    r = str(root)
    return path == r or path.startswith(r + os.sep) or path.startswith(r + _WT_SUFFIX)


def _collect_codex(root: Path, home: Path):
    base = home / ".codex" / "sessions"
    if not base.is_dir():
        return [], 0
    records, truncated = [], 0
    for rf in base.rglob("*.jsonl"):
        payload = _cached(rf, _parse_codex_file)
        if not payload:
            continue
        cwd = payload["cwd"]
        # Only sessions that provably belong to this repo count (an empty cwd
        # proves nothing, so it is excluded rather than counted everywhere).
        if not _in_repo_scope(cwd, root):
            continue
        truncated += 1 if payload["truncated"] else 0
        records.extend(payload["records"])
    return records, truncated


# --------------------------------------------------------------------------- #
# rates
# --------------------------------------------------------------------------- #

def load_rates(repo_root=None):
    """Return (rates dict in USD/token, source label)."""
    root = _resolve_root(repo_root)
    cfg = _read_json(root / "specs" / "worker-fleet.config.json")
    raw = ((cfg or {}).get("telemetry") or {}).get("rates") if isinstance(cfg, dict) else None
    rates, source = {}, "config"
    if isinstance(raw, dict):
        for name, r in raw.items():
            if isinstance(r, dict):
                try:
                    rates[str(name).lower()] = {
                        "in": float(r["in"]) / 1e6,
                        "out": float(r["out"]) / 1e6,
                        "cache": float(r.get("cache", r["in"])) / 1e6,
                    }
                except Exception:
                    continue
    if not rates:
        source = "builtin-fallback"
        rates = {k: {f: v / 1e6 for f, v in r.items()} for k, r in _FALLBACK_RATES.items()}
    return rates, source


def _price(model: str, rates: dict):
    """Return (matched key or "unknown", rate dict)."""
    m = (model or "").lower()
    for key in sorted(rates, key=len, reverse=True):
        if key in m:
            return key, rates[key]
    cheapest = min(rates.values(), key=lambda r: r["in"] + r["out"])
    return "unknown", cheapest


# --------------------------------------------------------------------------- #
# baseline / windows
# --------------------------------------------------------------------------- #

def _baseline_path(root: Path) -> Path:
    return root / "job" / "telemetry-baseline.json"


def read_baseline(repo_root=None):
    data = _read_json(_baseline_path(_resolve_root(repo_root)))
    return str(data["baseline"]) if isinstance(data, dict) and data.get("baseline") else None


def write_baseline(repo_root=None, now=None) -> str:
    """Write the reset baseline (now, ISO-8601 UTC) and return it."""
    root = _resolve_root(repo_root)
    stamp = _iso(now if now is not None else time.time())
    _atomic_write_json(_baseline_path(root), {"baseline": stamp})
    with _lock:
        _result_cache.clear()
    return stamp


def _window_start(window, run_id, root: Path, now: float):
    """Return (start epoch or None, note or None)."""
    if window == "today":
        local = datetime.fromtimestamp(now).astimezone()
        return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp(), None
    if window == "run":
        ledger = _read_json(root / "job" / "router-state.json")
        if not isinstance(ledger, dict):
            return None, "no job/router-state.json - showing all"
        if run_id and str(ledger.get("runId")) != str(run_id):
            return None, f"run {run_id} is not the current run - showing all"
        started = _parse_ts(ledger.get("startedAt"))
        if started is None:
            return None, "router-state.json has no startedAt - showing all"
        return started, None
    return None, None


# --------------------------------------------------------------------------- #
# budget stamps (ticket 050)
# --------------------------------------------------------------------------- #

_BUDGET_KEY = re.compile(r"^(\d{3})(?:-.*)?$", re.S)


def _read_budget_since(root: Path, now_ts=None) -> dict:
    """Ledger `budgetSince` -> {"NNN": epoch}; {} when missing or unusable.

    Only ISO-8601 strings that parse count; a `NNN-slug` key reads as `NNN`
    (the earliest stamp wins if both forms are present). A stamp later than
    `now_ts` (epoch seconds; `time.time()` when None) is skipped like an
    unparseable one, before the earliest-stamp rule (ticket 065); a stamp
    equal to `now_ts` counts. Never raises.
    """
    try:
        ledger = _read_json(root / "job" / "router-state.json")
        raw = ledger.get("budgetSince") if isinstance(ledger, dict) else None
        if not isinstance(raw, dict):
            return {}
        if now_ts is None:
            now_ts = time.time()
        out = {}
        for key, value in raw.items():
            m = _BUDGET_KEY.match(key) if isinstance(key, str) else None
            if not m or not isinstance(value, str):
                continue
            ts = _parse_ts(value)
            if ts is None or ts > now_ts:
                continue
            tid = m.group(1)
            if tid not in out or ts < out[tid]:
                out[tid] = ts
        return out
    except Exception:
        return {}


# --------------------------------------------------------------------------- #
# aggregation
# --------------------------------------------------------------------------- #

def _empty_result():
    return {
        "totalTokens": 0,
        "totalCost": 0.0,
        "cacheSavings": 0.0,
        "cacheHitRate": 0.0,
        "harnesses": {
            "claude": {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
                       "cacheCreateTokens": 0, "cost": 0.0, "sessions": 0},
            "opencode": {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
                         "cost": 0.0, "sessions": 0},
            "codex": {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
                      "cost": 0.0, "sessions": 0},
        },
        "byRole": {r: {"tokens": 0, "cost": 0.0} for r in ROLES},
        "byTicket": {},
        "byTicketBudget": {},
        "byModel": {},
        "unknownModels": [],
    }


def get_telemetry(window="all", run_id=None, repo_root=None, *, home=None,
                  apply_baseline=True, now=None):
    """Return the telemetry document for `window` (see module docstring)."""
    if window not in WINDOWS:
        raise ValueError(f"window must be one of {WINDOWS}, got {window!r}")
    root = _resolve_root(repo_root)
    home_dir = _home(home)
    now_ts = time.time() if now is None else float(now)
    cache_key = (window, run_id, str(root), str(home_dir), bool(apply_baseline))
    if now is None:
        with _lock:
            hit = _result_cache.get(cache_key)
            if hit and hit[0] > time.monotonic():
                return json.loads(json.dumps(hit[1]))

    rates, rates_source = load_rates(root)
    win_start, note = _window_start(window, run_id, root, now_ts)
    baseline_iso = read_baseline(root) if apply_baseline else None
    baseline_ts = _parse_ts(baseline_iso) if baseline_iso else None
    totals_start = max([t for t in (win_start, baseline_ts) if t is not None], default=None)
    budget_since = _read_budget_since(root, now_ts)

    c_recs, c_trunc = _collect_claude(root, home_dir)
    o_recs, _ = _collect_opencode(root, home_dir)
    x_recs, x_trunc = _collect_codex(root, home_dir)

    out = _empty_result()
    sessions = {"claude": set(), "opencode": set(), "codex": set()}
    seen = set()
    unknown = {}
    price_cache = {}
    tot_in = tot_out = tot_cache = 0

    for rec in c_recs + o_recs + x_recs:
        if rec["k"]:
            if rec["k"] in seen:
                continue
            seen.add(rec["k"])
        ts = rec["ts"]
        in_totals = totals_start is None or (ts is not None and ts >= totals_start)
        # byTicket honours the window but NOT the reset baseline (budget
        # enforcement must stay honest).
        in_tickets = win_start is None or (ts is not None and ts >= win_start)
        # byTicketBudget ignores the window and the baseline: records of a
        # ticket at or after its ledger `budgetSince` stamp (ticket 050).
        since_ts = budget_since.get(rec["ticket"]) if rec["ticket"] else None
        in_budget = since_ts is not None and ts is not None and ts >= since_ts
        if not (in_totals or in_tickets or in_budget):
            continue

        i, o, cr, cc = rec["in"], rec["out"], rec["cr"], rec["cc"]
        pk = rec["model"]
        if pk not in price_cache:
            price_cache[pk] = _price(pk, rates)
        rate_key, r = price_cache[pk]
        if rec["cost"] is not None:
            cost, rate_key, savings = float(rec["cost"]), "reported", 0.0
        else:
            cost = i * r["in"] + o * r["out"] + cr * r["cache"] + cc * r["in"] * CACHE_WRITE_MULTIPLIER
            savings = max(0.0, (i + cr) * r["in"] + o * r["out"] - cost)
        toks = i + o + cr

        if in_tickets and rec["ticket"]:
            te = out["byTicket"].setdefault(rec["ticket"], {"tokens": 0, "cost": 0.0})
            te["tokens"] += toks
            te["cost"] += cost
        if in_budget:
            be = out["byTicketBudget"].setdefault(rec["ticket"], {"tokens": 0, "cost": 0.0})
            be["tokens"] += toks
            be["cost"] += cost
        if not in_totals:
            continue

        h = out["harnesses"][rec["h"]]
        h["inputTokens"] += i
        h["outputTokens"] += o
        h["cacheReadTokens"] += cr
        if rec["h"] == "claude":
            h["cacheCreateTokens"] += cc
        h["cost"] += cost
        out["cacheSavings"] += savings
        tot_in, tot_out, tot_cache = tot_in + i, tot_out + o, tot_cache + cr
        sessions[rec["h"]].add(rec["sid"])

        br = out["byRole"][rec["role"]]
        br["tokens"] += toks
        br["cost"] += cost

        bm = out["byModel"].setdefault(rec["model"] or "unknown",
                                       {"tokens": 0, "cost": 0.0, "rate": rate_key})
        bm["tokens"] += toks
        bm["cost"] += cost
        if rate_key == "unknown":
            unknown[rec["model"] or "unknown"] = True

    for name, ids in sessions.items():
        out["harnesses"][name]["sessions"] = len(ids)
        out["harnesses"][name]["cost"] = round(out["harnesses"][name]["cost"], 4)
    out["totalTokens"] = tot_in + tot_out + tot_cache
    out["totalCost"] = round(sum(h["cost"] for h in out["harnesses"].values()), 4)
    out["cacheSavings"] = round(out["cacheSavings"], 4)
    if tot_in + tot_cache > 0:
        out["cacheHitRate"] = round(tot_cache / (tot_in + tot_cache) * 100, 1)
    for tid, ts_since in budget_since.items():
        be = out["byTicketBudget"].get(tid, {"tokens": 0, "cost": 0.0})
        out["byTicketBudget"][tid] = {"tokens": be["tokens"], "cost": round(be["cost"], 4),
                                      "since": _iso(ts_since)}
    out["byTicketBudget"] = dict(sorted(out["byTicketBudget"].items()))
    for d in list(out["byRole"].values()) + list(out["byTicket"].values()) + list(out["byModel"].values()):
        d["cost"] = round(d["cost"], 4)
    out["unknownModels"] = sorted(unknown)
    out.update({
        "window": window,
        "windowStart": _iso(win_start) if win_start is not None else None,
        "windowNote": note,
        "baseline": baseline_iso,
        "estimate": True,
        "ratesSource": rates_source,
        "truncatedFiles": c_trunc + x_trunc,
        "maxLinesPerFile": MAX_LINES_PER_FILE,
    })

    if now is None:
        with _lock:
            _result_cache[cache_key] = (time.monotonic() + RESULT_TTL_SECONDS,
                                        json.loads(json.dumps(out)))
    return out


# --------------------------------------------------------------------------- #
# history ring buffer
# --------------------------------------------------------------------------- #

def _history_path(root: Path) -> Path:
    return root / "job" / "telemetry-history.json"


def read_history(repo_root=None):
    data = _read_json(_history_path(_resolve_root(repo_root)))
    entries = data.get("entries") if isinstance(data, dict) else data
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def snapshot_history(repo_root=None, *, home=None, now=None) -> dict:
    """Append one {ts, totalTokens, totalCost, byRole} snapshot (30-day ring)."""
    root = _resolve_root(repo_root)
    now_ts = time.time() if now is None else float(now)
    # Cumulative lifetime figures, independent of the dashboard reset baseline.
    t = get_telemetry("all", repo_root=root, home=home, apply_baseline=False, now=now_ts)
    entry = {
        "ts": _iso(now_ts),
        "totalTokens": t["totalTokens"],
        "totalCost": t["totalCost"],
        "byRole": {k: dict(v) for k, v in t["byRole"].items()},
    }
    cutoff = now_ts - HISTORY_DAYS * 86400
    with _history_lock:
        entries = [e for e in read_history(root)
                   if (_parse_ts(e.get("ts")) or 0) >= cutoff]
        # A restart storm replaces the last entry instead of piling up.
        if entries and now_ts - (_parse_ts(entries[-1].get("ts")) or 0) < 60:
            entries[-1] = entry
        else:
            entries.append(entry)
        entries = entries[-HISTORY_MAX_ENTRIES:]
        _atomic_write_json(_history_path(root), {"entries": entries})
    return entry


if __name__ == "__main__":
    import sys
    win = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(json.dumps(get_telemetry(win), indent=2))

// Ejad: telemetry reads OpenCode 2 (apply after ejad-dashboard.cjs; runs on .claude/scripts/telemetry.py).
// Found by comparing Telemetry with the OpenCode database: the "opencode" harness showed 0 sessions and 0 tokens while
// the router and workers had used millions. Three causes:
//  1. OpenCode 2 keeps usage in session_v2 (tokens in/out/reasoning/cache and the agent per session); the collector read the
//     old message/session tables, failed, and swallowed the error, so every OpenCode agent was invisible.
//  2. worktrees were matched only by the "-wt-" naming; the fleet's are "<fleet folder>-<NNN-slug>".
//  3. "ejad-planner" and "ejad-designer" (Claude Code jobs) were not roles, so all of their tokens landed in "other".
// Per-session totals are cumulative, so a long session counts at its last activity time: the "today" window is approximate.
const fs = require('fs');
const T = '.claude/scripts/telemetry.py';
let s = fs.readFileSync(T, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
if (!s.includes('_opencode_v2_records')) {
  const sub = (a, b) => { must(a); s = s.replace(a, () => b); };
  sub('    "merger", "checker", "watchdog", "delegate", "other",\n)', '    "merger", "checker", "watchdog", "planner", "designer", "delegate", "other",\n)');
  sub('def _norm_role(raw, default="other") -> str:\n    r = str(raw or "").strip().lower()\n    return r if r in ROLES else default',
    'ROLE_ALIASES = {"ejad-planner": "planner", "ejad-designer": "designer", "ejad-reviewer": "reviewer", "ticket-writer": "planner"}\n\n\ndef _norm_role(raw, default="other") -> str:\n    r = str(raw or "").strip().lower()\n    r = ROLE_ALIASES.get(r, r)\n    return r if r in ROLES else default');
  sub('def _collect_opencode(root: Path, home: Path):', String.raw`def _opencode_v2_records(conn, root: Path):
    """One record per OpenCode 2 session (cumulative totals, stamped at its last activity); None when the DB is not v2."""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'session_v2'").fetchone():
        return None
    base = str(root).replace("\\", "/").rstrip("/").lower()
    rows = conn.execute(
        "SELECT id, parent_id, title, agent, model, directory, time_created, time_updated, tokens_input, tokens_output, "
        "tokens_reasoning, tokens_cache_read, tokens_cache_write, cost FROM session_v2 "
        "WHERE (COALESCE(tokens_input,0) + COALESCE(tokens_output,0) + COALESCE(tokens_cache_read,0) + COALESCE(tokens_cache_write,0)) > 0"
    ).fetchall()
    by_id = {r[0]: r for r in rows}
    title_ticket = re.compile(r"(?:ticket|dispatch)\s*#?\s*0*(\d+)", re.I)
    dir_ticket = re.compile(r"-(\d{3})-[a-z][\w-]*$")

    def ticket_of(r, depth=0):
        d = str(r[5] or "").replace("\\", "/").rstrip("/")
        m = dir_ticket.search(d.rsplit("/", 1)[-1])
        if m:
            return m.group(1)
        m = title_ticket.search(r[2] or "")
        if m:
            return m.group(1).zfill(3)
        if r[1] and depth < 4:
            p = by_id.get(r[1])
            if p:
                return ticket_of(p, depth + 1)
        return ""
    out = []
    for r in rows:
        d = str(r[5] or "").replace("\\", "/").rstrip("/").lower()
        if not (d == base or d.startswith(base + "/") or d.startswith(base + "-")):
            continue
        model, free = "", False
        try:
            mj = json.loads(r[4]) if isinstance(r[4], str) and r[4].strip().startswith("{") else r[4]
            model = str((mj.get("id") if isinstance(mj, dict) else mj) or "").lower()
            prov = str(mj.get("providerID") if isinstance(mj, dict) else "").lower()
            free = model.endswith(":free") or model.endswith("-free") or "/free" in model or prov == "opencode" and "free" in model
        except Exception:
            model = str(r[4] or "").lower()
        try:
            cost = float(r[13] or 0.0)
        except Exception:
            cost = 0.0
        out.append({
            "k": "opencode:" + str(r[0]), "ts": _parse_ts(r[7] or r[6]), "h": "opencode", "role": _norm_role(r[3]),
            "ticket": ticket_of(r), "cwd": str(r[5] or ""), "model": model,
            "in": _int(r[8]), "out": _int(r[9]) + _int(r[10]), "cr": _int(r[11]), "cc": _int(r[12]),
            "cost": cost if cost > 0 else (0.0 if free else None), "sid": str(r[0]),
        })
    return out


def _collect_opencode(root: Path, home: Path):`);
  sub('        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)\n        try:\n', '        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)\n        try:\n            v2 = _opencode_v2_records(conn, root)\n            if v2 is not None:\n                with _lock:\n                    _file_cache[key] = (sig, v2)\n                return v2, 0\n');
  fs.writeFileSync(T, s);
}
console.log('telemetry v2 patch applied');

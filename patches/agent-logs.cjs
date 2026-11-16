// Workerov: show OpenCode agent logs in the dashboard ticket view. worker-fleet's /api/logs reads only
// job/logs/<ticket>-*.log, which Claude Code workers write. OpenCode workers run as router subagents and keep their
// conversation in OpenCode's database, so the Logs tab stayed empty. The server now also reads, read-only, every
// OpenCode session of the ticket (the worker named in job/router-state.json or titled "... ticket NNN ...", plus its
// tester/reviewer sub-sessions) and returns an "all agents" timeline and one log per agent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_opencode_db():
    """OpenCode's session database (override with OPENCODE_DB)."""
    p = os.environ.get("OPENCODE_DB") or str(Path.home() / ".local" / "share" / "opencode" / "opencode.db")
    return p if os.path.isfile(p) else None


def _wv_clip(text, n):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def wv_opencode_logs(ticket, tail_n):
    """The ticket's OpenCode sessions as log files: [{"name", "lines"}], the combined timeline first."""
    db = wv_opencode_db()
    if not db:
        return []
    ids = set()
    try:
        state = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
        for d in state.get("dispatched", []) or []:
            if str(d.get("ticket", "")).startswith(ticket) and d.get("agentId"):
                ids.add(str(d["agentId"]))
    except Exception:
        pass
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=2)
    except Exception:
        return []
    try:
        root = str(REPO_ROOT).replace("\\", "/").rstrip("/")
        pat = re.compile(r"\bticket\s+0*" + str(int(ticket)) + r"\b", re.I)
        for sid, title, agent, directory in con.execute("SELECT id, title, agent, directory FROM session_v2 WHERE parent_id IS NOT NULL OR agent != 'router'"):
            d = (directory or "").replace("\\", "/")
            if agent != "router" and title and pat.search(title) and (d == root or d.startswith(root)):
                ids.add(sid)
        frontier = list(ids)
        while frontier:
            q = ",".join("?" * len(frontier))
            kids = [r[0] for r in con.execute(f"SELECT id FROM session_v2 WHERE parent_id IN ({q})", frontier)]
            frontier = [k for k in kids if k not in ids]
            ids.update(frontier)
        if not ids:
            return []
        # Only sessions started after the ticket folder was created: an older, removed ticket may have used the number.
        born = 0
        for rd in glob.glob(str(REPO_ROOT / "specs" / "tickets" / f"{ticket}-*" / "rd.md")):
            st = os.stat(rd)
            born = max(born, getattr(st, "st_birthtime", st.st_ctime if os.name == "nt" else 0))
        if born:
            q = ",".join("?" * len(ids))
            ids = {r[0] for r in con.execute(f"SELECT id FROM session_v2 WHERE id IN ({q}) AND time_created >= ?", list(ids) + [int((born - 60) * 1000)])}
            if not ids:
                return []
        q = ",".join("?" * len(ids))
        sessions = {r[0]: r for r in con.execute(f"SELECT id, title, agent, time_created FROM session_v2 WHERE id IN ({q})", list(ids))}
        per, allrows = {}, []
        for sid, typ, data in con.execute(f"SELECT session_id, type, data FROM session_message WHERE session_id IN ({q}) ORDER BY time_created, seq", list(ids)):
            try:
                m = json.loads(data)
            except Exception:
                continue
            ts = (m.get("time") or {}).get("created") or 0
            hhmm = datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S") if ts else "--:--:--"
            agent = m.get("agent") or (sessions.get(sid) or (0, 0, ""))[2] or "agent"
            out = []
            if typ == "user":
                out.append(f"▶ task: {_wv_clip(m.get('text', ''), 300)}")
            elif typ == "synthetic":
                out += ["  ⎿ " + _wv_clip(ln, 200) for ln in str(m.get("text", "")).splitlines()[:3] if ln.strip()]
            else:
                for it in m.get("content", []) or []:
                    k = it.get("type")
                    if k == "reasoning" and it.get("text", "").strip():
                        out.append("  · " + _wv_clip(it["text"], 300))
                    elif k == "text" and it.get("text", "").strip():
                        out += [ln for ln in it["text"].splitlines() if ln.strip()]
                    elif k == "tool":
                        st = it.get("state") or {}
                        out.append(f"→ {it.get('name', 'tool')} {_wv_clip(json.dumps(st.get('input', {}), ensure_ascii=False), 200)} [{st.get('status', '?')}]")
                        res = st.get("content") or []
                        txt = "\n".join(c.get("text", "") for c in res if isinstance(c, dict)) if isinstance(res, list) else str(res)
                        out += ["  ⎿ " + _wv_clip(ln, 200) for ln in txt.splitlines()[:3] if ln.strip()]
            lines = [f"[{hhmm}] {ln}" for ln in out]
            per.setdefault(sid, []).extend(lines)
            allrows += [f"[{hhmm}] {agent}: {ln[11:]}" for ln in lines]
        files = [{"name": f"all agents ({len(per)} session{'s' if len(per) != 1 else ''}, live)", "lines": allrows[-tail_n:]}] if per else []
        for sid in sorted(per, key=lambda x: (sessions.get(x) or (0, 0, 0, 0))[3] or 0):
            _, title, agent, _t = sessions.get(sid) or (sid, sid, "agent", 0)
            files.append({"name": f"{agent or 'agent'} · {_wv_clip(title or sid, 60)}", "lines": per[sid][-tail_n:]})
        return files
    except Exception as e:
        print(f"[wv] opencode logs failed: {e}", file=sys.stderr)
        return []
    finally:
        con.close()

`;
if (!s.includes('def wv_opencode_logs')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const a = '            if not matches:\n                self._send_json(404, {"error": f"No log files found for ticket {ticket}"})';
  must(a);
  s = s.replace(a, () => '            wv_oc = wv_opencode_logs(ticket, tail_n)\n' + a.replace('if not matches:', 'if not matches and not wv_oc:'));
  const b = '            self._send_json(200, {"ticket": ticket, "files": files})';
  must(b);
  s = s.replace(b, () => '            files = wv_oc + files\n' + b);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: OpenCode agent logs');

// The page: follow live by default, show more lines, and say where logs come from when there are none.
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
h = h.replace('const LOGS_TAIL_LINES = 200;', 'const LOGS_TAIL_LINES = 600;');
h = h.replace("'Workers tee dev/tester/reviewer output to job/logs/<ticket>-*.log via .claude/scripts/log.sh.'",
  "'Logs appear here once a worker starts: OpenCode agent sessions of this ticket, or job/logs/<ticket>-*.log.'");
fs.writeFileSync(H, h);
console.log('index.html: logs tab');

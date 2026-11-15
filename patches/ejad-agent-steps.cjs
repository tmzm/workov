// Ejad: structured agent steps for the dashboard (apply after ejad-agent-logs.cjs).
// GET /api/ejad/steps?ticket=NNN  : every OpenCode session of the ticket (worker, tester, reviewer ...), grouped by agent
// GET /api/ejad/steps?router=1    : the router's current session
// Each step is {t, k: user|note|think|text|tool, ...}; a tool step carries name (Bash, Read, Edit, Write, Grep ...), its
// input with the chat's key names (file_path, old_string, new_string, command), status and a clipped output.
// The dashboard draws them like the chat does: command and output, diffs, reads, plans. Read-only, from OpenCode's database.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
const sub = (a, b) => { must(a); s = s.replace(a, () => b); };

if (!s.includes('def ejad_opencode_steps')) {
  sub('\nEJAD_PROVIDERS = {', String.raw`
EJAD_TOOL_NAMES = {"bash": "Bash", "read": "Read", "edit": "Edit", "write": "Write", "grep": "Grep", "glob": "Glob", "list": "Glob", "webfetch": "WebFetch", "websearch": "WebSearch", "todowrite": "TodoWrite", "task": "Task", "patch": "Edit", "shell": "Bash", "execute": "Script", "subagent": "Task", "find": "Glob"}
EJAD_TOOL_KEYS = {"filePath": "file_path", "oldString": "old_string", "newString": "new_string", "path": "path"}


def ejad_step_list(m, typ):
    ts = (m.get("time") or {}).get("created") or 0
    out = []
    if typ == "user":
        out.append({"t": ts, "k": "user", "text": _ejad_clip(m.get("text", ""), 4000)})
    elif typ == "synthetic":
        out.append({"t": ts, "k": "note", "text": _ejad_clip(m.get("text", ""), 1500)})
    else:
        for it in m.get("content", []) or []:
            k = it.get("type")
            if k == "reasoning" and str(it.get("text", "")).strip():
                out.append({"t": ts, "k": "think", "text": _ejad_clip(it["text"], 3000)})
            elif k == "text" and str(it.get("text", "")).strip():
                out.append({"t": ts, "k": "text", "text": _ejad_clip(it["text"], 6000)})
            elif k == "tool":
                st = it.get("state") or {}
                raw = st.get("input") or {}
                name = EJAD_TOOL_NAMES.get(str(it.get("name", "")).lower(), str(it.get("name", "tool")))
                inp = {EJAD_TOOL_KEYS.get(a, a): (_ejad_clip(v, 6000) if isinstance(v, str) else v) for a, v in raw.items()} if isinstance(raw, dict) else {}
                res = st.get("content") or []
                txt = "\n".join(c.get("text", "") for c in res if isinstance(c, dict)) if isinstance(res, list) else str(res)
                if name in ("Read", "Edit", "Write") and "file_path" not in inp and "path" in inp:
                    inp["file_path"] = inp["path"]
                out.append({"t": ts, "k": "tool", "id": it.get("id") or it.get("callId") or "", "name": name, "input": inp, "status": st.get("status", "?"), "out": _ejad_clip(txt, 3000)})
    return out


def ejad_opencode_steps(ticket, router, limit=300):
    """The ticket's (or the router's) OpenCode sessions as structured steps, grouped per agent session."""
    db = ejad_opencode_db()
    if not db:
        return {"agents": []}
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=2)
    except Exception:
        return {"agents": []}
    try:
        ids = set()
        root = str(REPO_ROOT).replace("\\", "/").rstrip("/")
        if router:
            for sid, d in con.execute("SELECT id, directory FROM session_v2 WHERE agent = 'router' ORDER BY time_created DESC LIMIT 12"):
                if (d or "").replace("\\", "/").startswith(root):
                    ids.add(sid)
                    break
        else:
            try:
                state = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
                for d in state.get("dispatched", []) or []:
                    if str(d.get("ticket", "")).startswith(ticket) and d.get("agentId"):
                        ids.add(str(d["agentId"]))
            except Exception:
                pass
            pat = re.compile(r"\bticket\s+0*" + str(int(ticket)) + r"\b|\bdispatch\s+0*" + str(int(ticket)) + r"\b", re.I)
            for sid, title, agent, directory in con.execute("SELECT id, title, agent, directory FROM session_v2 WHERE parent_id IS NOT NULL OR agent != 'router'"):
                d = (directory or "").replace("\\", "/")
                if agent != "router" and title and pat.search(title) and (d == root or d.startswith(root) or "-" + str(ticket) + "-" in d):
                    ids.add(sid)
            frontier = list(ids)
            while frontier:
                q = ",".join("?" * len(frontier))
                kids = [r[0] for r in con.execute(f"SELECT id FROM session_v2 WHERE parent_id IN ({q})", frontier)]
                frontier = [k for k in kids if k not in ids]
                ids.update(frontier)
            born = 0
            for rd in glob.glob(str(REPO_ROOT / "specs" / "tickets" / f"{ticket}-*" / "rd.md")):
                st = os.stat(rd)
                born = max(born, getattr(st, "st_birthtime", st.st_ctime if os.name == "nt" else 0))
            if ids and born:
                q = ",".join("?" * len(ids))
                ids = {r[0] for r in con.execute(f"SELECT id FROM session_v2 WHERE id IN ({q}) AND time_created >= ?", list(ids) + [int((born - 60) * 1000)])}
        if not ids:
            return {"agents": []}
        q = ",".join("?" * len(ids))
        sessions = {r[0]: r for r in con.execute(f"SELECT id, title, agent, time_created FROM session_v2 WHERE id IN ({q})", list(ids))}
        per = {}
        for sid, typ, data in con.execute(f"SELECT session_id, type, data FROM session_message WHERE session_id IN ({q}) ORDER BY time_created, seq", list(ids)):
            try:
                m = json.loads(data)
            except Exception:
                continue
            per.setdefault(sid, []).extend(ejad_step_list(m, typ))
        agents = []
        for sid in sorted(sessions, key=lambda x: sessions[x][3] or 0):
            _id, title, agent, created = sessions[sid]
            steps = per.get(sid, [])
            agents.append({"id": sid, "agent": agent or "agent", "title": _ejad_clip(title or sid, 90), "since": created or 0, "total": len(steps), "steps": steps[-limit:]})
        return {"agents": agents}
    except Exception as e:
        print(f"[ejad] opencode steps failed: {e}", file=sys.stderr)
        return {"agents": []}
    finally:
        con.close()

` + '\nEJAD_PROVIDERS = {');
  sub('        if path == "/api/logs":\n', String.raw`        if path == "/api/ejad/steps":
            qs = urllib.parse.parse_qs(parsed.query)
            if qs.get("router", [""])[0] == "1":
                self._send_json(200, ejad_opencode_steps(None, True))
                return
            t = (qs.get("ticket", [""])[0] or "").strip()
            if not is_valid_ticket_id(t):
                self._send_json(400, {"error": "A numeric ticket id is required."})
                return
            self._send_json(200, ejad_opencode_steps(t, False))
            return

        if path == "/api/logs":
`);
  fs.writeFileSync(S, s);
}
console.log('agent steps patch applied');

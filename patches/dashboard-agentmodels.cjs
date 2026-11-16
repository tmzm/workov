// Workerov: every agent card on the Board shows the model that agent is really using (apply after dashboard-claude.cjs).
//  - GET /api/wv/agent-models: for each ticket, the newest OpenCode session of every agent (worker, tester, reviewer...)
//    with the model OpenCode recorded on that session (what it is REALLY using, which can differ from the config after a
//    mid-run switch), plus the router's session model and the planner/designer choices (they run on Claude Code).
//  - buildWorkerCard shows them as "agent: provider/model" lines under the phase; ticket writers show the planner choice.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def wv_agent_models')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('\ndef wv_run_action(action, req, tid):', String.raw`
def wv_session_model(raw):
    """provider/model from OpenCode's session model field (JSON or plain text)."""
    if not raw:
        return ""
    try:
        d = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return str(raw)
    if isinstance(d, dict):
        mid, prov = str(d.get("id") or ""), str(d.get("providerID") or "")
        return (prov + "/" + mid) if prov and not mid.startswith(prov + "/") else mid
    return str(d)


def wv_claude_role_label(cfg, role):
    p = (cfg.get("models") or {}).get(role) or {}
    if p.get("runtime") == "opencode" and (p.get("opencode") or {}).get("model"):
        return p["opencode"]["model"]
    return "Claude " + ((p.get("claude") or {}).get("model") or "sonnet") + " (your plan)"


def wv_agent_models():
    out = {"tickets": {}, "router": None, "planner": "", "designer": ""}
    try:
        cfg = json.loads(wv_config_path().read_text(encoding="utf-8"))
        out["planner"], out["designer"] = wv_claude_role_label(cfg, "planner"), wv_claude_role_label(cfg, "designer")
    except Exception:
        pass
    db = wv_opencode_db()
    if not db:
        return out
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=2)
    except Exception:
        return out
    try:
        root = str(REPO_ROOT).replace("\\", "/").rstrip("/").lower()
        now = time.time()
        rows = con.execute("SELECT id, parent_id, title, agent, model, time_updated, directory FROM session_v2 WHERE time_updated >= ? ORDER BY time_updated DESC", (int((now - 6 * 3600) * 1000),)).fetchall()
        by_id = {r[0]: r for r in rows}

        def ticket_of(r, depth=0):
            m = re.search(r"(?:ticket|dispatch)\s+#?0*(\d+)", r[2] or "", re.I)
            if m:
                return m.group(1).zfill(3)
            if r[1] and depth < 4:
                parent = by_id.get(r[1]) or con.execute("SELECT id, parent_id, title, agent, model, time_updated, directory FROM session_v2 WHERE id = ?", (r[1],)).fetchone()
                return ticket_of(parent, depth + 1) if parent else None
            return None
        for r in rows:
            if not (r[6] or "").replace("\\", "/").lower().startswith(root):
                continue
            agent, model, ago = r[3] or "agent", wv_session_model(r[4]), int(now - (r[5] or 0) / 1000)
            if not model:
                row = con.execute("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created DESC LIMIT 1", (r[0],)).fetchone()
                try:
                    model = wv_session_model(json.loads(row[0]).get("model")) if row else ""
                except ValueError:
                    model = ""
            if agent == "router" and not r[1]:
                if out["router"] is None:
                    out["router"] = {"model": model, "agoSec": ago}
                continue
            t = ticket_of(r)
            if t:
                out["tickets"].setdefault(t, {}).setdefault(agent, {"agent": agent, "model": model, "agoSec": ago})
        out["tickets"] = {t: sorted(v.values(), key=lambda x: x["agoSec"]) for t, v in out["tickets"].items()}
    except Exception as e:
        print(f"[wv] agent models failed: {e}", file=sys.stderr)
    finally:
        con.close()
    return out

` + '\ndef wv_run_action(action, req, tid):');
  sub('        if path == "/api/wv/router":', '        if path == "/api/wv/agent-models":\n            self._send_json(200, wv_agent_models())\n            return\n\n        if path == "/api/wv/router":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('id="wv-agentmodels-js"')) {
  // tolerant of reformatting: these are single-line statements
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub('function renderAgents(rows) {', 'function renderAgents(rows) {\n        if (window.wvAttachModels) window.wvAttachModels(rows);');
  sub('const kids = [top, metric];', 'const kids = [top, metric];\n        if (r.models && r.models.length && window.wvModelEl) kids.push(window.wvModelEl(r.models));');
  const CSS = `<style id="wv-agentmodels-css">
.worker-models { display: grid; gap: 2px; margin: 6px 0 0; font-size: var(--fs-label); line-height: 1.4; }
.worker-models .wm { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.worker-models .wm-a { color: var(--text-3); min-width: 5.5em; }
.worker-models .wm-m { font-family: var(--font-mono); color: var(--text); overflow-wrap: anywhere; }
.worker-models .wm-old { color: var(--text-3); }
</style>
`;
  must(h, '</head>');
  h = h.replace('</head>', () => CSS + '</head>');
  const JS = `<script id="wv-agentmodels-js">
(function () {
  var data = null, loading = false;
  function load() {
    if (document.hidden || loading) return; loading = true;
    fetch('/api/wv/agent-models', { headers: getAuthHeaders() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) data = d; }).catch(function () { /* keep the last */ }).then(function () { loading = false; });
  }
  window.wvAttachModels = function (rows) {
    if (!data) return;
    rows.forEach(function (r) {
      if (r.where === 'Ticket writer') r.models = [{ agent: 'planner', model: data.planner, agoSec: 0 }];
      else r.models = (data.tickets && data.tickets[r.num]) || [];
    });
  };
  window.wvModelEl = function (list) {
    var box = document.createElement('div'); box.className = 'worker-models'; box.setAttribute('aria-label', 'Models in use');
    list.forEach(function (m) {
      var row = document.createElement('div'); row.className = 'wm';
      var a = document.createElement('span'); a.className = 'wm-a'; a.textContent = m.agent;
      var mo = document.createElement('span'); mo.className = 'wm-m' + (m.agoSec > 900 ? ' wm-old' : ''); mo.textContent = m.model || 'unknown';
      if (m.agoSec > 900) mo.title = 'Last used ' + Math.round(m.agoSec / 60) + ' min ago';
      row.append(a, mo); box.append(row);
    });
    return box;
  };
  load(); setInterval(load, 10000);
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('agent models patch applied');

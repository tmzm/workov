// Workov: settings layers on the dashboard. Under the Agents roster, a "Settings layers" section lists every project with the
// worker runtime and model it really runs with (and which layer set it: kit, global, project or ticket), a "Use custom settings"
// switch for the project's layer, and the worker runtime and model that layer sets. A change applies from the next agent start,
// never mid-run, and the page says so. The resolver is wv-settings.py (installed in ~/.wv-bin); this patch only reads and writes
// through it. Builds on agent-roster.cjs and dashboard-run.cjs (apply them first).
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_settings_mod():
    import importlib.util
    spec = importlib.util.spec_from_file_location("wv_settings", Path.home() / ".wv-bin" / "wv-settings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def wv_settings_projects():
    try:
        rows = json.loads((Path.home() / ".workov" / "fleets.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("name") and r.get("root")] if isinstance(rows, list) else []


def wv_settings_view():
    """Per project: the effective worker runtime and model with the layer each came from, and the project's own layer."""
    w = wv_settings_mod()
    hub = str(REPO_ROOT)
    out = []
    for p in wv_settings_projects():
        res = w.load(hub, p["name"], p["root"])
        layer = (w._project_entry(hub, p["name"]).get("fleet") or {}).get("settings") or {}
        mw = ((layer.get("models") or {}).get("worker")) or {}
        out.append({
            "name": p["name"],
            "runtime": w.get(res, "models.worker.runtime") or "opencode",
            "runtimeSource": res["sources"].get("models.worker.runtime", ""),
            "model": w.get(res, "models.worker.opencode.model") or "",
            "modelSource": res["sources"].get("models.worker.opencode.model", ""),
            "claudeModel": w.get(res, "models.worker.claude.model") or "",
            "hasLayer": bool(layer),
            "enabled": bool(layer) and layer.get("enabled", True) is not False,
            "layerRuntime": mw.get("runtime") or "",
            "layerModel": ((mw.get("opencode") or {}).get("model")) or "",
        })
    return {"projects": out, "note": "A change applies from the next agent start, never mid-run."}


WV_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]{0,120}$")


def wv_settings_layer(req):
    """Switch a project's layer on or off and set its worker runtime and OpenCode model. Only projects the app knows can be edited."""
    name = str(req.get("project") or "")
    proj = next((p for p in wv_settings_projects() if p["name"] == name), None)
    if not proj:
        return 404, {"error": "Unknown project."}
    values = {}
    if "runtime" in req:
        rt = str(req.get("runtime") or "")
        if rt not in ("", "claude", "opencode"):
            return 400, {"error": "The runtime is claude or opencode."}
        values.setdefault("models", {}).setdefault("worker", {})["runtime"] = rt or None
    if "model" in req:
        m = str(req.get("model") or "").strip()
        if m and not WV_MODEL_RE.match(m):
            return 400, {"error": "That model name has characters a model name does not have."}
        values.setdefault("models", {}).setdefault("worker", {}).setdefault("opencode", {})["model"] = m or None
    enabled = req.get("enabled")
    w = wv_settings_mod()
    w.set_project_layer(str(REPO_ROOT), name, proj["root"], values, None if enabled is None else bool(enabled))
    return 200, {"ok": True, **wv_settings_view()}

`;
if (!s.includes('def wv_settings_view')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const g = '        if path == "/api/logs":';
  must(g);
  s = s.replace(g, () => '        if path == "/api/wv/settings":\n            self._send_json(200, wv_settings_view())\n            return\n\n' + g);
  const a = 'WV_ACTIONS = ("';
  must(a);
  s = s.replace(a, () => 'WV_ACTIONS = ("wv_settings_layer", "');
  const r = '    if action == "wv_fleet_start":';
  must(r);
  s = s.replace(r, () => '    if action == "wv_settings_layer":\n        return wv_settings_layer(req)\n' + r);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: /api/wv/settings');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="wv-layers"')) {
  const mark = '        <details id="wv-roster"';
  if (!h.includes(mark)) throw new Error('anchor missing: wv-roster (apply agent-roster.cjs first)');
  h = h.replace(mark, () => `        <details id="wv-layers" class="wv-roster" style="margin-bottom:12px;">
          <summary>Settings layers: the model each project really runs with <span id="wv-layers-note" class="note-s"></span></summary>
          <div id="wv-layers-body" style="padding:6px 0;"></div>
        </details>
` + mark);
  const call = h.match(/^[ 	]*wvLoadRoster\(\);[ 	]*$/m);
  if (!call) throw new Error('anchor missing: wvLoadRoster() (apply agent-roster.cjs first)');
  h = h.replace(call[0], () => `    async function wvLoadLayers() {
      const body = document.getElementById('wv-layers-body'); if (!body) return;
      try {
        const res = await fetch('/api/wv/settings', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('wv-layers-note').textContent = '(' + data.note + ')';
        body.textContent = '';
        const badge = (src) => { const b = document.createElement('span'); b.textContent = src || 'kit'; b.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line, #8884);margin-left:6px;opacity:.85'; return b; };
        (data.projects || []).forEach(p => {
          const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line, #8884)';
          const name = document.createElement('strong'); name.textContent = p.name; name.style.minWidth = '9em';
          const eff = document.createElement('span'); eff.className = 'mono';
          eff.textContent = p.runtime === 'claude' ? 'Claude ' + p.claudeModel : p.model || 'pool default';
          eff.append(badge(p.runtime === 'claude' ? p.runtimeSource : p.modelSource));
          const sw = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.enabled; sw.append(cb, document.createTextNode(' Use custom settings'));
          const rt = document.createElement('select'); [['', 'runtime: inherit'], ['opencode', 'OpenCode'], ['claude', 'Claude']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; rt.append(o); }); rt.value = p.layerRuntime;
          const md = document.createElement('input'); md.type = 'text'; md.placeholder = 'OpenCode model (provider/model)'; md.value = p.layerModel; md.size = 34; md.setAttribute('aria-label', 'OpenCode model for ' + p.name);
          const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save'; save.className = 'btn';
          const msg = document.createElement('span'); msg.className = 'note-s';
          save.onclick = async () => {
            msg.textContent = 'Saving...';
            try {
              const r = await fetch('/api/action', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()), body: JSON.stringify({ action: 'wv_settings_layer', project: p.name, enabled: cb.checked, runtime: rt.value, model: md.value }) });
              const j = await r.json(); if (!r.ok) { msg.textContent = j.error || 'Could not save.'; return; }
              msg.textContent = 'Saved. Applies from the next agent start.'; wvLoadLayers();
            } catch (e) { msg.textContent = 'Could not save.'; }
          };
          row.append(name, eff, sw, rt, md, save, msg); body.append(row);
        });
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    wvLoadLayers();
` + call[0]);
  fs.writeFileSync(H, h);
}
console.log('index.html: settings layers');

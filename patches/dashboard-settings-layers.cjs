// Workov: settings layers on the dashboard. Under the Agents roster, a "Settings layers" editor for every agent role (router, worker,
// teammate, reviewer, reproducer, tester, merger, checker, watchdog, planner, designer) in every layer:
//   Global  - the hub's models (the same file the Providers tab edits)
//   Project - one project's layer (specs/projects.json), with a "Use custom settings" switch
//   Ticket  - one ticket's layer (job/stage/<NNN>.json), with the same switch
// Each row shows what the role really runs with and which layer set it (kit, global, project, ticket). Blank = inherit; only the fields
// you change are sent. Roles that run once for the whole fleet (router, watchdog, designer) can only be set globally. A change applies
// from the next agent start, never mid-run. The resolver is wv-settings.py (in ~/.wv-bin); this patch only reads and writes through it.
// Builds on agent-roster.cjs and dashboard-run.cjs (apply them first).
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
WV_ALL_ROLES = ("router", "worker", "teammate", "reviewer", "reproducer", "tester", "merger", "checker", "watchdog", "planner", "designer")


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


def wv_settings_target(w, scope, project, ticket):
    """(project row, ticket id) a request is about; ValueError with a sentence for the UI when it names something that is not there."""
    if scope not in ("global", "project", "ticket"):
        raise ValueError("The scope is global, project or ticket.")
    proj = None
    if scope != "global":
        proj = next((p for p in wv_settings_projects() if p["name"] == project), None)
        if not proj:
            raise ValueError("Unknown project.")
    if scope == "ticket":
        if not re.fullmatch(r"\d{3}(-[a-z0-9-]+)?", ticket or "") or not list((Path(proj["root"]) / "specs" / "tickets").glob(ticket.split("-")[0] + "-*")):
            raise ValueError("Unknown ticket.")
        ticket = ticket.split("-")[0]
    return proj, ticket


def wv_settings_view(scope="project", project="", ticket=""):
    """The roles with their effective value and source in one scope, the stored layer, and the projects and tickets to pick from."""
    w = wv_settings_mod()
    hub = str(REPO_ROOT)
    proj, ticket = wv_settings_target(w, scope, project, ticket)
    cfg = w.read_json(Path(hub) / "specs" / "worker-fleet.config.json")
    if scope == "global":
        res, layer = w.resolve(cfg), {"enabled": True, "models": cfg.get("models") or {}}
    elif scope == "project":
        res = w.load(hub, proj["name"], proj["root"])
        layer = (w._project_entry(hub, proj["name"]).get("fleet") or {}).get("settings") or {}
    else:
        res = w.load(hub, proj["name"], proj["root"], ticket)
        layer = w.read_json(Path(proj["root"]) / "job" / "stage" / (ticket + ".json")).get("settings") or {}
    models = res["effective"].get("models") or {}
    names = list(WV_ALL_ROLES) + sorted(k for k in set(models) | set((layer.get("models") or {})) if k not in WV_ALL_ROLES)
    tickets = []
    if proj:
        tickets = sorted(d.name for d in (Path(proj["root"]) / "specs" / "tickets").glob("[0-9][0-9][0-9]-*") if d.is_dir())
    return {
        "scope": scope, "project": proj["name"] if proj else "", "ticket": ticket or "",
        "projects": [p["name"] for p in wv_settings_projects()], "tickets": tickets,
        "roles": [{"name": r, "globalOnly": r in w.GLOBAL_ONLY_ROLES} for r in names],
        "efforts": list(w.EFFORTS),
        "layer": {"enabled": scope == "global" or (bool(layer) and layer.get("enabled", True) is not False), "exists": bool(layer), "models": layer.get("models") or {}},
        "effective": models, "sources": {k: v for k, v in res["sources"].items() if k.startswith("models.")},
        "note": "A change applies from the next agent start, never mid-run.",
    }


def wv_settings_layer(req):
    """Edit one layer: validated by the resolver, written through it. Global writes the hub config, project and ticket write their layer."""
    w = wv_settings_mod()
    scope, project, ticket = str(req.get("scope") or "project"), str(req.get("project") or ""), str(req.get("ticket") or "")
    try:
        proj, ticket = wv_settings_target(w, scope, project, ticket)
        models = w.clean_models(req.get("models") or {}, scope)
    except ValueError as e:
        return 400, {"error": str(e)}
    enabled = req.get("enabled")
    enabled = None if enabled is None else bool(enabled)
    if scope == "global":
        w.set_global(str(REPO_ROOT), models)
    elif scope == "project":
        w.set_project_layer(str(REPO_ROOT), proj["name"], proj["root"], {"models": models} if models else {}, enabled)
    else:
        w.set_ticket_layer(proj["root"], ticket, {"models": models} if models else {}, enabled)
    return 200, {"ok": True, **wv_settings_view(scope, project, ticket)}

`;
if (!s.includes('def wv_settings_view')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const g = '        if path == "/api/logs":';
  must(g);
  s = s.replace(g, () => `        if path == "/api/wv/settings":
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                self._send_json(200, wv_settings_view((qs.get("scope") or ["project"])[0], (qs.get("project") or [""])[0], (qs.get("ticket") or [""])[0]))
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            return

` + g);
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
          <summary>Settings layers: every agent, in every layer <span id="wv-layers-note" class="note-s"></span></summary>
          <div id="wv-layers-body" style="padding:8px 0;overflow-x:auto;"></div>
        </details>
` + mark);
  const call = h.match(/^[ \t]*wvLoadRoster\(\);[ \t]*$/m);
  if (!call) throw new Error('anchor missing: wvLoadRoster() (apply agent-roster.cjs first)');
  h = h.replace(call[0], () => `    var wvLayerState = { scope: 'project', project: '', ticket: '' };
    async function wvLoadLayers() {
      const body = document.getElementById('wv-layers-body'); if (!body) return;
      const st = wvLayerState;
      try {
        const q = '?scope=' + encodeURIComponent(st.scope) + '&project=' + encodeURIComponent(st.project) + '&ticket=' + encodeURIComponent(st.ticket);
        let res = await fetch('/api/wv/settings' + q, { headers: getAuthHeaders() });
        if (res.status === 400 && st.scope !== 'global') { st.project = ''; st.ticket = ''; res = await fetch('/api/wv/settings?scope=' + st.scope, { headers: getAuthHeaders() }); }
        const d = await res.json();
        if (!res.ok) { body.textContent = d.error || 'Settings are not available.'; return; }
        if (st.scope !== 'global' && !st.project && d.projects.length) { st.project = d.projects[0]; return wvLoadLayers(); }
        if (st.scope === 'ticket' && !st.ticket && d.tickets.length) { st.ticket = d.tickets[0].split('-')[0]; return wvLoadLayers(); }
        document.getElementById('wv-layers-note').textContent = '(' + d.note + ')';
        body.textContent = '';
        const el = (tag, text, css) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (css) e.style.cssText = css; return e; };
        const bar = el('div', null, 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px');
        [['global', 'Global'], ['project', 'Project'], ['ticket', 'Ticket']].forEach(([k, t]) => { const b = el('button', t); b.type = 'button'; b.className = 'btn btn-sm' + (st.scope === k ? ' btn-primary' : ''); b.setAttribute('aria-pressed', String(st.scope === k)); b.onclick = () => { st.scope = k; wvLoadLayers(); }; bar.append(b); });
        const pick = (label, items, cur, set) => { const sel = el('select'); sel.setAttribute('aria-label', label); items.forEach(v => { const o = el('option', v); o.value = v; sel.append(o); }); sel.value = cur; sel.onchange = () => { set(sel.value); wvLoadLayers(); }; return sel; };
        if (st.scope !== 'global') bar.append(pick('Project', d.projects, d.project, v => { st.project = v; st.ticket = ''; }));
        if (st.scope === 'ticket') bar.append(pick('Ticket', d.tickets, d.tickets.find(t => t.startsWith(d.ticket)) || '', v => { st.ticket = v.split('-')[0]; }));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = d.layer.enabled; cb.disabled = st.scope === 'global';
        const sw = el('label', null, 'display:flex;gap:6px;align-items:center'); sw.append(cb, document.createTextNode(st.scope === 'global' ? 'The global layer is always on' : 'Use custom settings'));
        bar.append(sw); body.append(bar);
        const table = el('table', null, 'width:100%;border-collapse:collapse;font-size:13px'); const head = el('tr');
        ['Agent', 'Runs with now', 'OpenCode model', 'Claude model', 'Effort'].concat(st.scope !== 'global' ? [] : []).forEach(t => { const th = el('th', t, 'text-align:left;padding:4px 8px'); head.append(th); }); table.append(head);
        const inputs = [];
        const badge = (k) => { const src = d.sources[k]; if (!src) return null; const b = el('span', src, 'font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line, #8884);margin-left:6px;opacity:.85'); return b; };
        const get = (o, path) => path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
        d.roles.forEach(r => {
          const tr = el('tr'); tr.style.borderTop = '1px solid var(--line, #8884)';
          const locked = r.globalOnly && st.scope !== 'global';
          const nameTd = el('td', r.name, 'padding:6px 8px;font-weight:600'); if (locked) { nameTd.title = 'Runs once for the whole fleet: set it in the Global scope.'; nameTd.append(el('span', ' (global only)', 'font-weight:400;opacity:.7')); }
          const eff = d.effective[r.name] || {}; const effTd = el('td', null, 'padding:6px 8px');
          const ocm = get(eff, ['opencode', 'model']), clm = get(eff, ['claude', 'model']);
          const rt = r.name === 'worker' || r.name === 'planner' ? get(eff, ['runtime']) || (r.name === 'planner' ? 'claude' : 'opencode') : null;
          effTd.append(el('span', rt === 'claude' ? 'Claude ' + (clm || 'sonnet') : (ocm || (clm ? 'Claude ' + clm : 'default')), 'font-family:monospace'));
          const bk = rt === 'claude' ? 'models.' + r.name + '.claude.model' : 'models.' + r.name + '.opencode.model'; const bd = badge(bk) || badge('models.' + r.name + '.claude.model'); if (bd) effTd.append(bd);
          tr.append(nameTd, effTd);
          const field = (path, kind, ph) => {
            const td = el('td', null, 'padding:4px 8px'); const cur = get(d.layer.models[r.name] || {}, path) || '';
            let inp;
            if (kind === 'effort') { inp = el('select'); [''].concat(d.efforts).forEach(v => { const o = el('option', v || 'inherit'); o.value = v; inp.append(o); }); inp.value = cur; }
            else { inp = el('input'); inp.type = 'text'; inp.size = 26; inp.value = cur; inp.placeholder = ph; }
            inp.disabled = locked; inp.setAttribute('aria-label', r.name + ' ' + path.join(' ')); td.append(inp); tr.append(td); inputs.push({ role: r.name, path, inp, initial: cur });
          };
          field(['opencode', 'model'], 'text', get(eff, ['opencode', 'model']) || 'provider/model'); field(['claude', 'model'], 'text', get(eff, ['claude', 'model']) || 'sonnet'); field(['claude', 'effort'], 'effort');
          table.append(tr);
          if (r.name === 'worker' || r.name === 'planner') {
            const tr2 = el('tr'); const td0 = el('td', r.name + ' runtime', 'padding:2px 8px 6px;opacity:.8'); const td1 = el('td'); const sel = el('select');
            [['', 'inherit'], ['opencode', 'OpenCode'], ['claude', 'Claude']].forEach(([v, t]) => { const o = el('option', t); o.value = v; sel.append(o); }); const cr = get(d.layer.models[r.name] || {}, ['runtime']) || ''; sel.value = cr; sel.setAttribute('aria-label', r.name + ' runtime');
            td1.append(sel); tr2.append(td0, td1); table.append(tr2); inputs.push({ role: r.name, path: ['runtime'], inp: sel, initial: cr });
          }
        });
        body.append(table);
        const foot = el('div', null, 'display:flex;gap:10px;align-items:center;margin-top:10px'); const save = el('button', 'Save'); save.type = 'button'; save.className = 'btn btn-primary'; const msg = el('span', null); msg.className = 'note-s'; foot.append(save, msg); body.append(foot);
        save.onclick = async () => {
          const models = {};
          inputs.forEach(i => { const v = i.inp.value.trim(); if (v === i.initial || i.inp.disabled) return; const m = models[i.role] = models[i.role] || {}; if (i.path.length === 1) m[i.path[0]] = v; else { (m[i.path[0]] = m[i.path[0]] || {})[i.path[1]] = v; } });
          const enabledChanged = st.scope !== 'global' && cb.checked !== d.layer.enabled;
          if (!Object.keys(models).length && !enabledChanged) { msg.textContent = 'Nothing changed.'; return; }
          msg.textContent = 'Saving...';
          try {
            const r = await fetch('/api/action', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()), body: JSON.stringify({ action: 'wv_settings_layer', scope: st.scope, project: st.project, ticket: st.ticket, enabled: st.scope === 'global' ? undefined : (Object.keys(models).length && !d.layer.exists ? true : cb.checked), models: models }) });
            const j = await r.json(); if (!r.ok) { msg.textContent = j.error || 'Could not save.'; return; }
            await wvLoadLayers(); const m2 = document.querySelector('#wv-layers-body .note-s:last-child'); if (m2) m2.textContent = 'Saved. Applies from the next agent start.';
          } catch (e) { msg.textContent = 'Could not save.'; }
        };
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    wvLoadLayers();
` + call[0]);
  fs.writeFileSync(H, h);
}
console.log('index.html: settings layers');

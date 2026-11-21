// Workov: settings layers on the dashboard. A models editor for every agent role (router, worker,
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
const fail = (m) => { throw new Error('anchor missing: ' + m); };
const REV = 'data-rev="7"';
if (!h.includes(REV)) {
  // 0. the first version put this editor under the Agents roster: it moves to where it is used
  h = h.replace(/\n[ \t]*<details id="wv-layers"[\s\S]*?<\/details>\n/, '\n');
  h = h.replace(/    var wvLayerState = [\s\S]*?\n    wvLoadLayers\(\);\n/, '');

  // 1. a "Models" tab and panel in the ticket drawer
  if (!h.includes('data-dtab="models"')) {
    const tabs = /(Logs\s*<\/button>)(\s*<\/div>\s*<div class="drawer-body" id="drawer-body">)/.exec(h) || fail('drawer tabs');
    h = h.replace(tabs[0], () => tabs[1] + `
          <button type="button" class="d-tab-btn" role="tab" id="dtab-models" data-dtab="models" aria-selected="false" aria-controls="d-tab-content-models" tabindex="-1">Models</button>` + tabs[2]);
    const panelEnd = /(Loading logs…<\/pre>\s*<\/div>)/.exec(h) || fail('logs panel');
    h = h.replace(panelEnd[0], () => panelEnd[1] + `
          <div id="d-tab-content-models" class="d-tab-content" role="tabpanel" aria-labelledby="dtab-models" style="display: none"><div id="d-models-box"></div></div>`);
    const sw = "if (tabName === 'logs') loadTicketLogs();";
    if (!h.includes(sw)) fail('switchDrawerTab');
    h = h.replace(sw, () => sw + "\n        if (tabName === 'models' && window.wvDrawerModels) window.wvDrawerModels();");
  }

  // 2. a gear on every project card of the Projects page
  if (!h.includes('wvModelsGear')) {
    const card = /(else if \(p\.router\) head\.append\([^\n]*\n)(\s*)(card\.append\(head\);)/.exec(h) || fail('project card head');
    h = h.replace(card[0], () => card[1] + card[2] + "if (window.wvOpenModelsDialog) head.append(window.wvModelsGear(p.name));\n" + card[2] + card[3]);
  }

  // 3. styles, the dialog and the editor (replaced as a whole when an older revision is installed)
  h = h.replace(/<style id="wv-models-v2"[\s\S]*?<\/style>\n?/, '');
  h = h.replace(/<dialog id="wv-models-dialog"[\s\S]*?<script id="wv-models-v2"[\s\S]*?<\/script>\n?/, '');
  h = h.replace('</head>', () => `<style id="wv-models-v2" ${REV}>
.wv-gear { margin-left: auto; width: 32px; height: 32px; display: inline-grid; place-items: center; padding: 0; color: var(--text-2); background: transparent; border: 1px solid var(--line-strong, #8886); border-radius: 999px; cursor: pointer; transition: color .18s ease, border-color .18s ease, transform .2s cubic-bezier(.16, 1, .3, 1); }
.wv-gear:hover { color: var(--text); transform: rotate(40deg); }
.wv-gear:focus-visible, .wv-md-x:focus-visible, .wv-switch input:focus-visible + .track { outline: 2px solid var(--btn-primary-bg, currentColor); outline-offset: 2px; }
.wv-gear svg, .wv-md-x svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
dialog.wv-models-dialog { position: fixed; inset: 0; margin: auto; width: min(960px, calc(100vw - 32px)); height: fit-content; max-height: min(86vh, 800px); padding: 0; overflow: hidden; color: var(--text); background: var(--surface-1); border: 1px solid var(--line-strong, #8886); border-radius: 14px; box-shadow: 0 30px 80px -20px rgb(0 0 0 / .6), 0 4px 14px rgb(0 0 0 / .18); }
dialog.wv-models-dialog[open] { display: flex; flex-direction: column; animation: wv-md-in .2s cubic-bezier(.16, 1, .3, 1); }
dialog.wv-models-dialog::backdrop { background: rgb(8 8 12 / .55); backdrop-filter: blur(2px); }
@keyframes wv-md-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.wv-md-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line, #8884); flex: none; }
.wv-md-head h2 { margin: 0; font-size: var(--fs-h3, 17px); flex: 1; text-wrap: balance; }
.wv-md-x { width: 34px; height: 34px; display: inline-grid; place-items: center; padding: 0; color: var(--text-2); background: transparent; border: 1px solid transparent; border-radius: 999px; cursor: pointer; }
.wv-md-x:hover { color: var(--text); background: var(--surface-2); }
.wv-md-body { padding: 16px 20px 0; overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 0; }
#wv-models-box { display: flex; flex-direction: column; flex: 1; min-height: 0; }
#wv-models-box > * { flex: none; }
#wv-models-box > .wv-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0 -20px; padding: 0 20px; }
.wv-me .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.wv-me .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--surface-2, #8882); border-radius: 999px; }
.wv-me .seg button { min-height: 0; padding: 5px 16px; font: inherit; font-size: 13px; color: var(--text-2); background: transparent; border: 0; border-radius: 999px; cursor: pointer; transition: background .15s ease, color .15s ease; }
.wv-me .seg button:hover { color: var(--text); }
.wv-me .seg button[aria-pressed="true"] { color: var(--text); background: var(--surface-1); box-shadow: 0 1px 3px rgb(0 0 0 / .25); font-weight: 600; }
.wv-me select, .wv-me input[type=text] { min-height: 34px; height: 34px; padding: 4px 10px; font-size: 13px; }
.wv-me .card { display: flex; align-items: center; gap: 14px; padding: 12px 14px; margin-bottom: 12px; border: 1px solid var(--line, #8884); border-radius: 10px; background: var(--surface-2, #8881); }
.wv-me .card .txt { flex: 1; min-width: 0; } .wv-me .card .txt b { display: block; } .wv-me .card .txt span { color: var(--text-2); font-size: 13px; }
.wv-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex: none; }
.wv-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.wv-switch .track { width: 42px; height: 24px; border-radius: 999px; background: var(--line-strong, #8888); transition: background .18s ease; position: relative; }
.wv-switch .track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / .35); transition: transform .2s cubic-bezier(.16, 1, .3, 1); }
.wv-switch input:checked + .track { background: var(--ok, #2f9e60); }
.wv-switch input:checked + .track::after { transform: translateX(18px); }
.wv-me .hint { margin: 0 0 12px; color: var(--text-2); max-width: 74ch; font-size: 13px; }
.wv-me .grid { width: 100%; border-collapse: collapse; font-size: 13px; }
.wv-me .grid th { background: var(--surface-1); text-align: left; padding: 6px 8px; font-weight: 600; color: var(--text-2); border-bottom: 1px solid var(--line, #8884); }
.wv-me .grid td { padding: 6px 8px; border-top: 1px solid var(--line, #8883); vertical-align: middle; }
.wv-me .grid td:first-child { white-space: nowrap; font-weight: 600; }
.wv-me .grid .sub td { border-top: 0; padding-top: 0; color: var(--text-2); }
.wv-me .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.wv-me .src { font-size: 11px; padding: 1px 7px; margin-left: 6px; border: 1px solid var(--line, #8884); border-radius: 999px; opacity: .85; font-family: inherit; }
.wv-me .foot { display: flex; gap: 12px; align-items: center; padding: 14px 0; margin-top: 4px; border-top: 1px solid var(--line, #8884); background: var(--surface-1); }
.wv-me .grid th { position: static; }
#wv-models-box .grid th { position: sticky; top: 0; z-index: 1; }
.wv-me .empty { padding: 18px 4px; color: var(--text-2); }
@media (max-width: 767px) { .wv-me .grid, .wv-me .grid tbody, .wv-me .grid tr, .wv-me .grid td { display: block; } .wv-me .grid tr:first-child { display: none; } .wv-me .grid td { border: 0; padding: 2px 0; } .wv-me .grid tr { padding: 8px 0; border-top: 1px solid var(--line, #8883); } .wv-me input[type=text], .wv-me select { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .wv-gear, .wv-switch .track, .wv-switch .track::after, .wv-me .seg button { transition: none; } .wv-gear:hover { transform: none; } dialog.wv-models-dialog[open] { animation: none; } }
</style>
</head>`);
  const JS = `<dialog id="wv-models-dialog" class="wv-models-dialog" aria-labelledby="wv-models-title">
  <div class="wv-md-head"><h2 id="wv-models-title">Models</h2><button type="button" class="wv-md-x" id="wv-models-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="wv-md-body"><div id="wv-models-box"></div></div>
</dialog>
<script id="wv-models-v2" ${REV}>
(function () {
  function hdr(extra) { var h = Object.assign({}, extra || {}); try { var t = localStorage.getItem('worker_fleet_token'); if (t) h.Authorization = 'Bearer ' + t; } catch (e) { /* none */ } return h; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  var get = function (o, path) { return path.reduce(function (a, k) { return a && typeof a === 'object' ? a[k] : undefined; }, o); };
  var SCOPE_LABEL = { global: 'Global', project: 'Project', ticket: 'Ticket' };
  var SWITCH = {
    project: ['Use custom models for this project', 'Off: the project follows the global models.', 'On: the models below apply to every ticket of this project.'],
    ticket: ['Use custom models for this ticket', 'Off: the ticket follows its project and the global models.', 'On: the models below apply to this ticket only.']
  };
  var HINT = {
    global: 'The default for every project. The Providers tab edits the same values.',
    project: 'These override the global models for every ticket of this project.',
    ticket: 'These override the project and global models for this one ticket.'
  };
  // The models editor: every agent role, one scope at a time. opts: scopes, scope, project, ticket, fixedProject, fixedTicket.
  function editor(box, opts) {
    var st = { scope: opts.scope || 'project', project: opts.project || '', ticket: opts.ticket || '' };
    var scopes = opts.scopes || ['global', 'project', 'ticket'];
    box.classList.add('wv-me');
    async function load(message) {
      try { await load1(message); } catch (e) { box.textContent = 'Could not show the models: ' + (e && e.message ? e.message : e); }
    }
    async function load1(message) {
      var q = '?scope=' + encodeURIComponent(st.scope) + '&project=' + encodeURIComponent(st.project) + '&ticket=' + encodeURIComponent(st.ticket);
      var res, d;
      try { res = await fetch('/api/wv/settings' + q, { headers: hdr() }); d = await res.json(); } catch (e) { box.textContent = 'Could not reach the dashboard.'; return; }
      if (!res.ok) { box.textContent = ''; box.append(makeBar({ projects: [], tickets: [] }), el('p', d.error || 'Settings are not available.', 'empty')); return; }
      if (st.scope !== 'global' && !st.project && d.projects.length) { st.project = d.projects[0]; return load(message); }
      if (st.scope === 'ticket' && !st.ticket && d.tickets.length) { st.ticket = d.tickets[0].split('-')[0]; return load(message); }
      render(d, message);
    }
    function makeBar(d) {
      var bar = el('div', null, 'bar'), seg = el('div', null, 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Scope');
      scopes.forEach(function (k) { var b = el('button', SCOPE_LABEL[k]); b.type = 'button'; b.setAttribute('aria-pressed', String(st.scope === k)); b.onclick = function () { st.scope = k; load(); }; seg.append(b); });
      bar.append(seg);
      function pick(label, items, cur, set) { var sel = el('select'); sel.setAttribute('aria-label', label); items.forEach(function (v) { var o = el('option', v); o.value = v; sel.append(o); }); sel.value = cur; sel.onchange = function () { set(sel.value); load(); }; return sel; }
      if (st.scope !== 'global' && !opts.fixedProject) bar.append(pick('Project', d.projects, st.project, function (v) { st.project = v; st.ticket = ''; }));
      if (st.scope === 'ticket' && !opts.fixedTicket) bar.append(pick('Ticket', d.tickets, (d.tickets.filter(function (t) { return t.indexOf(st.ticket) === 0; })[0]) || '', function (v) { st.ticket = v.split('-')[0]; }));
      return bar;
    }
    function render(d, message) {
      box.textContent = '';
      var isGlobal = st.scope === 'global';
      box.append(makeBar(d));
      var tableWrap = el('div', null, 'wv-scroll'), sw = null;
      if (!isGlobal) {
        var card = el('div', null, 'card'), txt = el('div', null, 'txt'), lab = el('label', null, 'wv-switch'), cb = el('input'), track = el('span', null, 'track');
        var sub = el('span', SWITCH[st.scope][d.layer.enabled ? 2 : 1]); txt.append(el('b', SWITCH[st.scope][0]), sub);
        cb.type = 'checkbox'; cb.setAttribute('role', 'switch'); cb.checked = !!d.layer.enabled; cb.setAttribute('aria-label', SWITCH[st.scope][0]);
        lab.append(cb, track); card.append(txt, lab); box.append(card); sw = cb;
        cb.onchange = function () { sub.textContent = SWITCH[st.scope][cb.checked ? 2 : 1]; show(); };
      }
      var hint = el('p', (st.scope === 'ticket' ? 'Ticket ' + d.ticket + ' of ' + d.project + '. ' : st.scope === 'project' ? d.project + '. ' : '') + HINT[st.scope] + ' ' + d.note, 'hint');
      var off = el('p', 'This ' + st.scope + ' follows the models above it. Switch custom models on to change them here.', 'empty');
      box.append(hint, tableWrap, off);
      var table = el('table', null, 'grid'), head = el('tr');
      ['Agent', 'Runs with now', 'OpenCode model', 'Claude model', 'Effort'].forEach(function (t) { head.append(el('th', t)); }); table.append(head);
      var inputs = [];
      d.roles.forEach(function (r) {
        var tr = el('tr'), locked = r.globalOnly && !isGlobal;
        var nameTd = el('td', r.name);
        if (locked) { nameTd.title = 'Runs once for the whole fleet: set it in the Global scope.'; var g = el('span', ' (global only)'); g.style.cssText = 'font-weight:400;opacity:.7'; nameTd.append(g); }
        var eff = d.effective[r.name] || {}, hasRt = r.name === 'worker' || r.name === 'planner';
        var rt = hasRt ? get(eff, ['runtime']) || (r.name === 'planner' ? 'claude' : 'opencode') : null;
        var ocm = get(eff, ['opencode', 'model']), clm = get(eff, ['claude', 'model']);
        var effTd = el('td'), effTxt = el('span', rt === 'claude' ? 'Claude ' + (clm || 'sonnet') : (ocm || (clm ? 'Claude ' + clm : 'default')), 'mono'); effTd.append(effTxt);
        var key = rt === 'claude' ? 'models.' + r.name + '.claude.model' : 'models.' + r.name + '.opencode.model';
        var src = d.sources[key] || d.sources['models.' + r.name + '.claude.model']; if (src) effTd.append(el('span', src, 'src'));
        tr.append(nameTd, effTd);
        function field(path, kind, ph) {
          var td = el('td'), cur = get(d.layer.models[r.name] || {}, path) || '', inp;
          if (kind === 'effort') { inp = el('select'); [''].concat(d.efforts).forEach(function (v) { var o = el('option', v || 'inherit'); o.value = v; inp.append(o); }); inp.value = cur; }
          else { inp = el('input'); inp.type = 'text'; inp.value = cur; inp.placeholder = ph; inp.size = 28; }
          inp.disabled = locked; inp.setAttribute('aria-label', r.name + ' ' + path.join(' ')); td.append(inp); tr.append(td); inputs.push({ role: r.name, path: path, inp: inp, initial: cur });
        }
        field(['opencode', 'model'], 'text', get(eff, ['opencode', 'model']) || 'provider/model'); field(['claude', 'model'], 'text', get(eff, ['claude', 'model']) || 'sonnet'); field(['claude', 'effort'], 'effort');
        table.append(tr);
        if (hasRt) {
          var tr2 = el('tr', null, 'sub'), sel = el('select'), cr = get(d.layer.models[r.name] || {}, ['runtime']) || '';
          [['', 'inherit'], ['opencode', 'OpenCode'], ['claude', 'Claude']].forEach(function (p) { var o = el('option', p[1]); o.value = p[0]; sel.append(o); }); sel.value = cr; sel.setAttribute('aria-label', r.name + ' runtime');
          var td0 = el('td', r.name + ' runtime'), td1 = el('td'); td0.style.fontWeight = '400'; td1.append(sel); tr2.append(td0, td1); table.append(tr2); inputs.push({ role: r.name, path: ['runtime'], inp: sel, initial: cr });
        }
      });
      tableWrap.append(table);
      var foot = el('div', null, 'foot'), save = el('button', 'Save changes', 'btn btn-primary'), msg = el('span', message || '', 'note-s'); save.type = 'button'; foot.append(save, msg); box.append(foot);
      function show() { var on = isGlobal || sw.checked; tableWrap.hidden = !on; hint.hidden = !on; off.hidden = on; }
      show();
      save.onclick = async function () {
        var models = {};
        inputs.forEach(function (i) { var v = i.inp.value.trim(); if (v === i.initial || i.inp.disabled) return; var m = models[i.role] = models[i.role] || {}; if (i.path.length === 1) m[i.path[0]] = v; else (m[i.path[0]] = m[i.path[0]] || {})[i.path[1]] = v; });
        var changed = Object.keys(models).length > 0, enabledChanged = !isGlobal && sw.checked !== !!d.layer.enabled;
        if (!changed && !enabledChanged) { msg.textContent = 'Nothing changed.'; return; }
        msg.textContent = 'Saving...';
        try {
          var r = await fetch('/api/action', { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'wv_settings_layer', scope: st.scope, project: st.project, ticket: st.ticket, enabled: isGlobal ? undefined : (changed && !d.layer.exists && sw.checked === false ? true : sw.checked), models: models }) });
          var j = await r.json(); if (!r.ok) { msg.textContent = j.error || 'Could not save.'; return; }
          load('Saved. Applies from the next agent start.');
        } catch (e) { msg.textContent = 'Could not save.'; }
      };
    }
    load();
  }
  window.wvModelsEditor = editor;

  // the gear on a project card, and the dialog it opens
  var GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  window.wvModelsGear = function (project) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'wv-gear'; b.innerHTML = GEAR;
    b.setAttribute('aria-label', 'Models of ' + project); b.title = 'Models of ' + project;
    b.addEventListener('click', function () { window.wvOpenModelsDialog(project); });
    return b;
  };
  var dlg = document.getElementById('wv-models-dialog');
  window.wvOpenModelsDialog = function (project) {
    document.getElementById('wv-models-title').textContent = 'Models: ' + project;
    var box = document.getElementById('wv-models-box'); box.textContent = '';
    editor(box, { scope: 'project', project: project, fixedProject: true, scopes: ['project', 'ticket', 'global'] });
    if (!dlg.open) dlg.showModal();
  };
  document.getElementById('wv-models-close').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });

  // the Models tab of the ticket drawer: this ticket, its project, or global
  window.wvDrawerModels = function () {
    var box = document.getElementById('d-models-box'); if (!box) return;
    var id = typeof currentTicket !== 'undefined' ? currentTicket : null;
    var f = id && window.wvForeignById ? window.wvForeignById(id) : null;
    box.textContent = '';
    if (!f || !f.wvProject) { box.append(el('p', 'Models are set per project and ticket. Open a ticket of a project to edit its models.')); return; }
    editor(box, { scope: 'ticket', project: f.wvProject, ticket: String(f.wvRaw || '').split('-')[0], fixedProject: true, fixedTicket: true, scopes: ['ticket', 'project', 'global'] });
  };
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  if (i < 0) fail('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('index.html: models editor (project dialog, ticket drawer tab)');

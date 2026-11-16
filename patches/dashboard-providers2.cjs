// Workerov: Providers panel, round two (apply after dashboard-insight.cjs).
//  - "Switch all agents to free models" (opencode/*-free: they are not counted against the OpenCode Go monthly cap) and
//    "Restore previous models", which puts back exactly what was set before. One OpenCode reload for the whole change.
//  - Connected providers are listed (opencode auth list) and "Refresh model list" re-reads opencode models, so a provider
//    connected with `opencode auth login` in a terminal shows up without restarting anything. API keys are never typed
//    into the dashboard: OpenCode itself only accepts a key in an interactive terminal, and this dashboard can be
//    reached from the internet.
//  - The panel says what went wrong (not signed in, server error) instead of staying empty, and the banner's
//    "Open Providers" button switches to the Board tab, opens the panel and says so.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };

const FN = String.raw`
WV_FREE = {
    "router": "opencode/glm-5.3-flash-free", "tester": "opencode/glm-5.3-flash-free", "merger": "opencode/glm-5.3-flash-free",
    "checker": "opencode/glm-5.3-flash-free", "watchdog": "opencode/glm-5.3-flash-free",
    "worker": "opencode/deepseek-v4.1-flash-free", "teammate": "opencode/deepseek-v4.1-flash-free", "reproducer": "opencode/deepseek-v4.1-flash-free",
    "reviewer": "opencode/minimax-m3.1-flash-free",
}


def wv_opencode_reload():
    try:
        subprocess.run(["opencode", "reload"], capture_output=True, timeout=30, shell=(os.name == "nt"), creationflags=WV_NOWIN)
    except Exception:
        pass


def wv_connected():
    try:
        out = subprocess.run(["opencode", "auth", "list"], capture_output=True, text=True, timeout=30, shell=(os.name == "nt"), creationflags=WV_NOWIN).stdout
    except Exception:
        return []
    names = []
    for ln in WV_ANSI_RE.sub("", out).splitlines():
        ln = ln.strip()
        if ln:
            names.append(re.split(r"\s{2,}", ln)[0])
    return names


def wv_models_preset(preset):
    backup = REPO_ROOT / "job" / "models-backup.json"
    cfg = json.loads(wv_config_path().read_text(encoding="utf-8"))
    cur = {r: ((v.get("opencode") or {}).get("model") or "") for r, v in cfg.get("models", {}).items() if isinstance(v, dict)}
    known = wv_model_list()
    if preset == "free":
        mapping = {r: m for r, m in WV_FREE.items() if r in cur and (not known or m in known)}
        if not mapping:
            return 409, {"error": "None of the free models are available from opencode models."}
        if not backup.exists():
            backup.write_text(json.dumps(cur), encoding="utf-8")
    elif preset == "restore":
        if not backup.exists():
            return 409, {"error": "There is no saved set of models to restore."}
        mapping = {r: m for r, m in json.loads(backup.read_text(encoding="utf-8")).items() if r in cur and m}
    else:
        return 400, {"error": "preset must be free or restore"}
    done = []
    for role, model in mapping.items():
        code, _res = wv_set_model(role, model, reload=False)
        if code == 200:
            done.append(role)
    wv_opencode_reload()
    if preset == "restore":
        backup.unlink(missing_ok=True)
    return 200, {"ok": True, "preset": preset, "roles": done, "note": "Applies from the next agent start."}

`;

if (!s.includes('def wv_models_preset')) {
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);

  must(s, 'def wv_set_model(role, model):');
  s = s.replace('def wv_set_model(role, model):', () => 'def wv_set_model(role, model, reload=True):');

  const rl = '    try:\n        subprocess.run(["opencode", "reload"], capture_output=True, timeout=30, shell=(os.name == "nt"), creationflags=WV_NOWIN)\n    except Exception:\n        pass\n    return 200, {"ok": True, "role": role,';
  must(s, rl);
  s = s.replace(rl, () => '    if reload:\n        wv_opencode_reload()\n    return 200, {"ok": True, "role": role,');

  const a1 = 'WV_ACTIONS = (';
  s = s.replace(a1, () => 'WV_ACTIONS = ("wv_models_preset", "wv_refresh_models", ');

  const a2 = '    if action == "wv_set_model":\n';
  must(s, a2);
  s = s.replace(a2, () => '    if action == "wv_models_preset":\n        return wv_models_preset(str(req.get("preset", "")))\n    if action == "wv_refresh_models":\n        _wv_models_cache[0] = 0.0\n        return 200, {"ok": True, "models": len(wv_model_list())}\n' + a2);

  const a3 = '"harness": cfg.get("harness", "")}';
  must(s, a3);
  s = s.replace(a3, () => '"harness": cfg.get("harness", ""), "connected": wv_connected(), "backup": (REPO_ROOT / "job" / "models-backup.json").exists()}');
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: free-model preset, connected providers, refresh');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('wvProvidersFail')) {
  // the banner button
  const goOld = "go.onclick = () => { const d = document.getElementById('wv-providers'); d.open = true; d.scrollIntoView({ block: 'center' }); };";
  must(h, goOld);
  h = h.replace(goOld, () => "go.onclick = () => { const tab = document.querySelector('.tab-btn[data-tab=\"kanban\"]'); if (tab && !tab.classList.contains('active')) tab.click(); const d = document.getElementById('wv-providers'); d.open = true; wvLoadProviders(); d.scrollIntoView({ block: 'start' }); showToast('Providers panel opened below the Fleet and delivery section'); };");

  // the panel
  const i = h.indexOf('    async function wvLoadProviders() {');
  const j = h.indexOf("    document.getElementById('wv-timeline').addEventListener");
  if (i < 0 || j < i) throw new Error('anchor missing (apply dashboard-insight.cjs first): wvLoadProviders');
  const fn = `    function wvProvidersFail(box, res) {
      box.textContent = res.status === 401 ? 'Not signed in. Sign in with the dashboard PIN, then open this panel again.' : 'Could not load the providers (HTTP ' + res.status + ').';
      if (res.status === 401) openAuthModal();
    }
    async function wvLoadProviders() {
      const box = document.getElementById('wv-pv-body');
      try {
        const res = await fetch('/api/wv/providers', { headers: getAuthHeaders() });
        if (!res.ok) { wvProvidersFail(box, res); return; }
        const d = await res.json();
        document.getElementById('wv-pv-note').textContent = '(runtime: ' + d.harness + ')';
        box.textContent = '';
        const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
        const act = (label, body, okText) => { const b = mk('button', label, 'btn btn-sm'); b.type = 'button'; b.onclick = async () => { b.disabled = true; const x = await wvPost(body); b.disabled = false; showToast(x.ok ? okText(x.j) : (x.j.error || 'Failed'), x.ok ? undefined : 'bad'); if (x.ok) wvLoadProviders(); }; return b; };
        box.append(mk('p', 'Connected: ' + (d.connected.length ? d.connected.join(', ') : 'none') + '. All opencode-go models share one monthly cap; the opencode/*-free models do not.', 'note-s'));
        const bar = mk('div'); bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px;';
        bar.append(
          act('Switch all agents to free models', { action: 'wv_models_preset', preset: 'free' }, j => j.roles.length + ' agents now use free models (next agent start)'),
          act('Restore previous models', { action: 'wv_models_preset', preset: 'restore' }, j => 'Previous models restored (' + j.roles.length + ' agents)'),
          act('Refresh model list', { action: 'wv_refresh_models' }, j => j.models + ' models available'));
        bar.children[1].disabled = !d.backup;
        box.append(bar);
        box.append(mk('p', 'To connect another provider (Anthropic, OpenAI, OpenRouter, Google...) run opencode auth login in a terminal on the laptop and paste the key there; then press Refresh model list. Keys are never entered here: this dashboard can be opened from the internet.', 'note-s'));
        const tbl = document.createElement('table'); tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
        const head = tbl.createTHead().insertRow();
        ['Agent', 'Model (provider/model)', ''].forEach(x => { const th = document.createElement('th'); th.align = 'left'; th.style.padding = '4px 8px'; th.textContent = x; head.append(th); });
        const cell = (tr, node) => { const td = tr.insertCell(); td.style.cssText = 'padding:4px 8px;border-top:1px solid var(--line, #8884);'; td.append(node); return td; };
        d.roles.forEach(r => {
          const tr = tbl.insertRow();
          cell(tr, document.createTextNode(r.role));
          const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Model of ' + r.role); sel.style.maxWidth = '320px';
          const list = d.models.length ? d.models : [r.model];
          (list.includes(r.model) ? list : [r.model].concat(list)).forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m + (m.endsWith('-free') ? '  (free)' : ''); if (m === r.model) o.selected = true; sel.append(o); });
          cell(tr, sel);
          const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = 'Apply';
          b.onclick = async () => { const x = await wvPost({ action: 'wv_set_model', role: r.role, model: sel.value }); showToast(x.ok ? r.role + ' now uses ' + sel.value + ' (next agent start)' : (x.j.error || 'Could not change the model'), x.ok ? undefined : 'bad'); };
          cell(tr, b);
        });
        const tr = tbl.insertRow();
        cell(tr, document.createTextNode('Implementer'));
        const isel = document.createElement('select'); isel.setAttribute('aria-label', 'Implementer CLI');
        [['none', 'None: the worker builds it itself']].concat(Object.keys(d.clis).map(k => [k, k + (d.clis[k] ? '' : '  (not installed)')])).forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === d.implementer) o.selected = true; isel.append(o); });
        cell(tr, isel);
        const ib = document.createElement('button'); ib.type = 'button'; ib.className = 'btn btn-sm'; ib.textContent = 'Apply';
        ib.onclick = async () => { const x = await wvPost({ action: 'wv_set_implementer', cli: isel.value }); showToast(x.ok ? 'Implementer is now ' + isel.value + ' (next worker)' : (x.j.error || 'Could not change the implementer'), x.ok ? undefined : 'bad'); };
        cell(tr, ib);
        box.append(tbl);
      } catch (e) { box.textContent = 'Could not load the providers: ' + e; }
    }
`;
  h = h.slice(0, i) + fn + h.slice(j);
  const tl = "const res = await fetch('/api/wv/timeline', { headers: getAuthHeaders() });\n        if (!res.ok) return;";
  if (h.includes(tl)) h = h.replace(tl, () => "const res = await fetch('/api/wv/timeline', { headers: getAuthHeaders() });\n        if (!res.ok) { box.textContent = res.status === 401 ? 'Not signed in. Sign in with the dashboard PIN.' : 'Could not load the time per step (HTTP ' + res.status + ').'; return; }");
  fs.writeFileSync(H, h);
}
console.log('index.html: providers panel with free preset, connected list, clear errors');

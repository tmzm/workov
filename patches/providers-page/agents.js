/* Agents tab: pick the provider, then the model, of every agent (worker first), and the implementer CLI. */
(function () {
  var body = document.getElementById('pvp-agents-body');
  if (!body) return;
  var ROLE = {
    worker: ['Worker', 'Builds the code of a ticket'], router: ['Router', 'Runs the loop and hands out tickets'],
    reviewer: ['Reviewer', 'Reviews the diff before it lands'], tester: ['Tester', 'Runs the checks and the browser tests'],
    teammate: ['Teammate', 'Second builder on large tickets'], reproducer: ['Reproducer', 'Reproduces a bug before the fix'],
    merger: ['Merger', 'Lands the merge'], checker: ['Checker', 'Regression sweeps after merges'], watchdog: ['Watchdog', 'Catches stuck workers']
  };
  var ORDER = ['worker', 'router', 'reviewer', 'tester', 'teammate', 'reproducer', 'merger', 'checker', 'watchdog'];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(m, bad) { showToast(m, bad ? 'bad' : undefined); }
  function provOf(m) { return String(m).split('/')[0]; }

  async function load() {
    body.textContent = 'Loading…';
    try {
      var res = await fetch('/api/ejad/providers', { headers: getAuthHeaders() });
      if (res.status === 401) { openAuthModal(); body.textContent = 'Sign in with the dashboard PIN, then open this tab again.'; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
    } catch (e) {
      body.textContent = ''; var p = el('p', '', 'Could not load the agents: ' + e.message + '. '); var b = el('button', 'btn btn-sm', 'Try again'); b.type = 'button'; b.onclick = load; p.append(b); body.append(p);
    }
  }

  function act(label, payload, ok, after) {
    var b = el('button', 'btn btn-sm', label); b.type = 'button';
    b.onclick = async function () { b.disabled = true; var x = await ejadPost(payload); b.disabled = false; toast(x.ok ? ok(x.j) : (x.j.error || 'Failed'), !x.ok); if (x.ok) load(); };
    if (after) after(b); return b;
  }

  function render(d) {
    body.textContent = '';
    var models = d.models || [], connected = d.connected || [];
    var byProv = {}; models.forEach(function (m) { (byProv[provOf(m)] = byProv[provOf(m)] || []).push(m); });
    var usable = connected.filter(function (p) { return byProv[p]; });

    var intro = el('p', 'pvp-note');
    intro.append(document.createTextNode('Runtime: ' + d.harness + '. Pick a provider, then one of its models, for each agent. To use a provider that is not listed, connect it in the '));
    var lk = el('button', 'btn btn-sm', 'Providers tab'); lk.type = 'button'; lk.onclick = function () { document.getElementById('pvp-tab-providers').click(); };
    intro.append(lk, document.createTextNode('. The runtime itself (OpenCode or Claude Code) is chosen when the fleet is set up.'));
    body.append(intro);

    var bar = el('div', 'pvp-row'); bar.style.margin = 'var(--s3) 0';
    bar.append(
      act('Switch all agents to free models', { action: 'ejad_models_preset', preset: 'free' }, function (j) { return j.roles.length + ' agents now use free models (next agent start)'; }),
      act('Restore previous models', { action: 'ejad_models_preset', preset: 'restore' }, function (j) { return 'Previous models restored (' + j.roles.length + ' agents)'; }, function (b) { b.disabled = !d.backup; }),
      act('Refresh model list', { action: 'ejad_refresh_models' }, function (j) { return j.models + ' models available'; }));
    body.append(bar);

    var tbl = el('table', 'pvp-agents');
    var hd = tbl.createTHead().insertRow(); ['Agent', 'Provider', 'Model', ''].forEach(function (h) { var th = document.createElement('th'); th.scope = 'col'; th.textContent = h; hd.append(th); });
    var tb = tbl.createTBody();
    var roles = d.roles.filter(function (r) { return r.role !== 'planner'; }).sort(function (a, b) { var i = ORDER.indexOf(a.role), j = ORDER.indexOf(b.role); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
    roles.forEach(function (r) {
      var tr = tb.insertRow(); if (r.role === 'worker') tr.className = 'pvp-agent-hl';
      var td0 = tr.insertCell(); var nm = el('div', 'pvp-role', (ROLE[r.role] || [r.role])[0]); if (ROLE[r.role]) nm.append(el('small', '', ROLE[r.role][1])); td0.append(nm);
      var cur = r.model, curProv = provOf(cur);
      var ps = el('select'); ps.setAttribute('aria-label', 'Provider of ' + r.role);
      var provs = usable.slice(); if (provs.indexOf(curProv) < 0) provs.unshift(curProv);
      provs.forEach(function (p) { var o = el('option', '', p + (connected.indexOf(p) < 0 ? '  (not connected)' : '')); o.value = p; ps.append(o); });
      ps.value = curProv;
      var ms = el('select'); ms.setAttribute('aria-label', 'Model of ' + r.role);
      function fill() {
        ms.textContent = ''; var list = (byProv[ps.value] || []).slice();
        if (ps.value === curProv && list.indexOf(cur) < 0) list.unshift(cur);
        if (!list.length) { var o0 = el('option', '', 'No models listed'); o0.value = ''; ms.append(o0); return; }
        list.forEach(function (m) { var o = el('option', '', m.slice(ps.value.length + 1) + (/-free$/.test(m) ? '  (free)' : '')); o.value = m; ms.append(o); });
        ms.value = list.indexOf(cur) >= 0 && ps.value === curProv ? cur : list[0];
      }
      fill(); ps.onchange = fill;
      tr.insertCell().append(ps); tr.insertCell().append(ms);
      var ac = tr.insertCell(); var row = el('div', 'pvp-row');
      var ap = el('button', 'btn btn-sm btn-primary', 'Apply'); ap.type = 'button';
      ap.onclick = async function () { if (!ms.value) return; ap.disabled = true; var x = await ejadPost({ action: 'ejad_set_model', role: r.role, model: ms.value }); ap.disabled = false; toast(x.ok ? r.role + ' now uses ' + ms.value + ' (next agent start)' : (x.j.error || 'Could not change the model'), !x.ok); if (x.ok) { cur = ms.value; curProv = ps.value; } };
      var ts = el('button', 'btn btn-sm', 'Test'); ts.type = 'button';
      ts.onclick = async function () { if (!ms.value) return; ts.disabled = true; ts.textContent = 'Testing…'; var x = await ejadPost({ action: 'ejad_test_model', model: ms.value }); ts.disabled = false; ts.textContent = 'Test'; toast(x.ok ? (x.j.ok ? ms.value + ' works' : ms.value + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), !(x.ok && x.j.ok)); };
      row.append(ap, ts); ac.append(row);
    });
    var ir = tb.insertRow();
    var i0 = ir.insertCell(); var inm = el('div', 'pvp-role', 'Implementer'); inm.append(el('small', '', 'Optional: another CLI types each step, the worker reviews it')); i0.append(inm);
    var isel = el('select'); isel.setAttribute('aria-label', 'Implementer CLI');
    [['none', 'None: the worker builds it itself']].concat(Object.keys(d.clis).map(function (k) { return [k, k + (d.clis[k] ? '' : '  (not installed)')]; })).forEach(function (a) { var o = el('option', '', a[1]); o.value = a[0]; isel.append(o); });
    isel.value = d.implementer; var ic = ir.insertCell(); ic.colSpan = 2; ic.append(isel);
    var ib = el('button', 'btn btn-sm btn-primary', 'Apply'); ib.type = 'button';
    ib.onclick = async function () { var x = await ejadPost({ action: 'ejad_set_implementer', cli: isel.value }); toast(x.ok ? 'Implementer is now ' + isel.value + ' (next worker)' : (x.j.error || 'Could not change the implementer'), !x.ok); };
    ir.insertCell().append(ib);
    var wrap = el('div'); wrap.style.overflowX = 'auto'; wrap.append(tbl); body.append(wrap);
  }
  window.ejadAgentsLoad = load;
})();

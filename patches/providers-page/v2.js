/* Providers page v2: inner tabs (Providers, Agents & planner), per-provider "How to connect". */
(function () {
  var root = document.getElementById('pvp');
  if (!root) return;
  var state = { cat: [], connected: [], models: [], planner: null, filter: 'all', q: '', shown: 48, testing: {}, open: {}, tab: 'providers', loaded: false };
  var METHOD = { key: 'API key', login: 'Sign in', env: 'Env variables' };
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(msg, bad) { showToast(msg, bad ? 'bad' : undefined); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function modelsOf(id) { return state.models.filter(function (m) { return m.indexOf(id + '/') === 0; }); }
  function link(href, text) { var a = el('a', 'pvp-link', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function copy(text, what) {
    function done() { toast('Copied ' + what); }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { toast('Copy failed: select the text and copy it', true); }); return; }
    var t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed', true); } t.remove();
  }
  function store(k, v) { try { if (v == null) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }

  async function api(path) {
    var res = await fetch(path, { headers: getAuthHeaders() });
    if (res.status === 401) { openAuthModal(); throw new Error('Not signed in'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function skeleton() {
    var g = $('pvp-grid'); g.textContent = ''; g.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 8; i++) { var c = el('div', 'pvp-card pvp-skel'); c.append(el('div', 'pvp-sk a'), el('div', 'pvp-sk b'), el('div', 'pvp-sk c')); g.append(c); }
  }
  async function load(force) {
    if (!state.loaded) skeleton();
    try {
      var c = await api('/api/wv/catalog' + (force ? '?refresh=1' : ''));
      var p = await api('/api/wv/providers');
      state.cat = c.providers || []; state.connected = c.connected || [];
      state.models = p.models || []; state.planner = p.planner || { runtime: 'claude', claude: 'sonnet' };
      state.loaded = true;
      $('pvp-sub').textContent = state.connected.length + ' connected' + (c.stale ? ' · offline list' : '');
      $('pvp-count').textContent = state.cat.length;
      renderPlanner(); renderGrid();
    } catch (e) {
      var g = $('pvp-grid'); g.textContent = ''; g.removeAttribute('aria-busy');
      var box = el('div', 'pvp-empty'); box.append(el('p', '', 'Could not load the providers: ' + e.message + '.'));
      var r = el('button', 'btn btn-sm', 'Try again'); r.type = 'button'; r.onclick = function () { load(true); }; box.append(r); g.append(box);
    }
  }

  /* ---------- planner ---------- */
  function plannerValue() { var p = state.planner || {}; return p.runtime === 'opencode' && p.opencode ? p.opencode : 'claude:' + (p.claude || 'sonnet'); }
  function renderPlanner() {
    var sel = $('pvp-planner'); sel.textContent = '';
    var g = document.createElement('optgroup'); g.label = 'Claude (your Claude plan)';
    ['sonnet', 'opus', 'haiku'].forEach(function (m) { var o = el('option', '', 'Claude ' + m); o.value = 'claude:' + m; g.append(o); });
    sel.append(g);
    state.connected.forEach(function (id) {
      var ms = modelsOf(id); if (!ms.length) return;
      var og = document.createElement('optgroup'); og.label = id;
      ms.forEach(function (m) { var o = el('option', '', m.slice(id.length + 1) + (/-free$/.test(m) ? '  (free)' : '')); o.value = m; og.append(o); });
      sel.append(og);
    });
    var v = plannerValue();
    if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { var x = el('option', '', v + ' (current)'); x.value = v; sel.prepend(x); }
    sel.value = v; $('pvp-pnow').textContent = 'Now: ' + v;
  }

  /* ---------- how to connect ---------- */
  function step(list, node) { var li = el('li'); if (typeof node === 'string') li.textContent = node; else li.append(node); list.append(li); return li; }
  function codeRow(text, what) {
    var r = el('div', 'pvp-code'); r.append(el('code', '', text));
    var b = el('button', 'btn btn-sm', 'Copy'); b.type = 'button'; b.setAttribute('aria-label', 'Copy ' + what); b.onclick = function () { copy(text, what); };
    r.append(b); return r;
  }
  function howTo(p) {
    var box = el('div', 'pvp-how'); var ol = el('ol'); var href = p.keyUrl || p.doc;
    var m = p.method || 'key';
    if (m === 'key') {
      var s1 = step(ol, ''); s1.append(href ? link(href, p.keyUrl ? 'Open the ' + p.name + ' key page' : 'Open the ' + p.name + ' website') : document.createTextNode('Open the ' + p.name + ' website'), document.createTextNode(' and sign in.'));
      step(ol, 'Create an API key and copy it. Most providers show it only once.');
      step(ol, 'Paste it in the field on the card and press Connect.');
      step(ol, 'Press Test: it sends one tiny prompt to prove the key works.');
      box.append(ol);
      if (p.alsoLogin) box.append(el('p', 'pvp-note', 'Have a subscription instead of an API key? Run opencode auth login in a terminal and pick ' + p.name + '.'));
    } else if (m === 'login') {
      step(ol, 'Open a terminal on the computer that runs the fleet.');
      var s2 = step(ol, 'Run this command:'); s2.append(codeRow('opencode auth login', 'the command'));
      step(ol, 'Choose ' + p.name + ' and finish the sign-in in the browser window that opens.');
      step(ol, 'Come back here, press Refresh list, then Test.');
      box.append(ol, el('p', 'pvp-note', 'This provider signs in with your account, not a pasted key, so it cannot be connected from this page.'));
    } else {
      var s1b = step(ol, ''); s1b.append(href ? link(href, 'Open ' + p.name) : document.createTextNode('Open ' + p.name), document.createTextNode(' and collect these values:'));
      var s2b = step(ol, 'Set each one as an environment variable on the computer that runs the fleet:');
      (p.env || []).forEach(function (n) { s2b.append(codeRow('setx ' + n + ' "<value>"', n + ' command')); });
      step(ol, 'Close and reopen the terminal, then restart the fleet (Pause all, start again) so it picks them up.');
      step(ol, 'Press Refresh list, then Test on one of its models.');
      box.append(ol, el('p', 'pvp-note', 'This provider needs several values, not one key, so it is set up outside this page. I have not verified it end to end.'));
    }
    return box;
  }

  /* ---------- cards ---------- */
  function avatar(p) {
    var av = el('div', 'pvp-av'); av.setAttribute('aria-hidden', 'true'); av.style.background = 'hsl(' + hue(p.id) + ' 40% 30%)';
    var ltr = el('span', '', (p.name || p.id).charAt(0).toUpperCase()); av.append(ltr);
    var img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.className = 'pvp-logo';
    img.onload = function () { ltr.hidden = true; av.classList.add('logo'); av.style.background = ''; img.style.opacity = '1'; };
    img.onerror = function () { img.remove(); };
    img.src = '/api/wv/logo?id=' + encodeURIComponent(p.id); av.append(img);
    return av;
  }
  function fmtCtx(n) { return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'K'; }
  function fmtPrice(p) {
    if (p.priceMin == null) return p.free ? 'Free models only' : 'Not listed';
    var r = p.priceMin === p.priceMax ? '$' + p.priceMin : '$' + p.priceMin + ' – $' + p.priceMax;
    return r + ' per 1M input tokens' + (p.free ? ' (plus ' + p.free + ' free)' : '');
  }
  function fact(dl, k, v) { if (v == null || v === '') return; dl.append(el('dt', '', k)); var d = el('dd'); if (typeof v === 'string') d.textContent = v; else d.append(v); dl.append(d); }
  function details(p) {
    var box = el('div', 'pvp-det'); var dl = el('dl', 'pvp-facts');
    fact(dl, 'Models', p.models + (p.free ? ' (' + p.free + ' free)' : ''));
    fact(dl, 'Price', fmtPrice(p));
    if (p.ctxMax) fact(dl, 'Longest context', fmtCtx(p.ctxMax) + ' tokens');
    fact(dl, 'Abilities', (p.tools || 0) + ' with tool calling · ' + (p.reasoning || 0) + ' reasoning · ' + (p.vision || 0) + ' read images');
    if (p.api) fact(dl, 'API address', p.api);
    if (p.sdk) fact(dl, 'SDK', p.sdk);
    if ((p.env || []).length) fact(dl, 'Variables', p.env.join(', '));
    if (p.doc) fact(dl, 'Docs', link(p.doc, p.doc.replace(/^https?:\/\//, '').replace(/\/$/, '')));
    box.append(dl);
    if ((p.sample || []).length) {
      var sm = el('div', 'pvp-sample'); sm.append(el('span', 'pvp-sample-l', 'Some models'));
      p.sample.forEach(function (m) { sm.append(el('code', m.free ? 'free' : '', m.id)); });
      box.append(sm);
    }
    return box;
  }
  function matches(p) {
    if (state.q && (p.name + ' ' + p.id).toLowerCase().indexOf(state.q) < 0) return false;
    if (state.filter === 'connected') return state.connected.indexOf(p.id) >= 0;
    if (state.filter === 'popular') return p.popular;
    if (state.filter === 'free') return p.free > 0;
    return true;
  }
  function actions(p, on, inDialog) {
    var m = p.method || 'key'; var act = el('div', 'pvp-act');
    if (on) {
      var t = el('button', 'btn btn-sm', state.testing[p.id] ? 'Testing…' : 'Test'); t.type = 'button'; t.disabled = !!state.testing[p.id];
      t.onclick = function () { testProvider(p); };
      var d = el('button', 'btn btn-sm pvp-danger', 'Disconnect'); d.type = 'button';
      d.onclick = async function () {
        if (!confirm('Disconnect ' + p.name + '? Agents using its models will fail until you switch them.')) return;
        var x = await wvPost({ action: 'wv_disconnect_provider', provider: p.id });
        toast(x.ok ? p.name + ' disconnected' : (x.j.error || 'Failed'), !x.ok); if (x.ok) { closeDialog(); load(); }
      };
      act.append(t, d);
    } else if (m === 'key') {
      var k = el('input', 'pvp-key'); k.type = 'password'; k.autocomplete = 'off'; k.placeholder = 'Paste API key'; k.setAttribute('aria-label', 'API key for ' + p.name);
      var b = el('button', 'btn btn-sm btn-primary', 'Connect'); b.type = 'button';
      var go = async function () {
        if (!k.value.trim()) { k.focus(); return; }
        b.disabled = true; b.textContent = 'Connecting…';
        var x = await wvPost({ action: 'wv_connect_provider', provider: p.id, key: k.value.trim() }); k.value = '';
        toast(x.ok ? p.name + ' connected (' + x.j.models + ' models). Press Test to check it.' : (x.j.error || 'Could not connect'), !x.ok);
        if (x.ok) { closeDialog(); load(); } else { b.disabled = false; b.textContent = 'Connect'; }
      };
      b.onclick = go; k.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      act.append(k);
      if (p.keyUrl) { var a = el('a', 'btn btn-sm', 'Get key ↗'); a.href = p.keyUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; act.append(a); }
      act.append(b);
    }
    return act;
  }
  function card(p) {
    var on = state.connected.indexOf(p.id) >= 0; var m = p.method || 'key';
    var c = el('article', 'pvp-card' + (on ? ' on' : '')); c.setAttribute('aria-label', p.name);
    c.append(head(p, on));
    var meta = el('div', 'pvp-meta');
    meta.append(el('span', 'pvp-chipm m-' + m, METHOD[m]), el('span', '', p.models + ' models'));
    if (p.free) meta.append(el('span', 'pvp-free', p.free + ' free'));
    c.append(meta, actions(p, on, false));
    var hb = el('button', 'btn btn-sm pvp-how-btn', 'Details & how to connect'); hb.type = 'button'; hb.setAttribute('aria-haspopup', 'dialog');
    hb.onclick = function () { openDialog(p); };
    c.append(hb);
    return c;
  }
  function head(p, on) {
    var top = el('div', 'pvp-top');
    var tt = el('div', 'pvp-tt'); tt.append(el('div', 'pvp-name', p.name), el('div', 'pvp-id', p.id));
    top.append(avatar(p), tt);
    if (on) { var ok = el('span', 'pvp-badge ok'); ok.append(el('span', 'pvp-dot'), document.createTextNode('Connected')); top.append(ok); }
    return top;
  }

  /* ---------- details dialog (native <dialog>: focus trap, Esc, focus returns to the opener) ---------- */
  var dlg = $('pvp-dialog'), dlgFor = null;
  function openDialog(p) {
    dlgFor = p.id; var on = state.connected.indexOf(p.id) >= 0;
    var h = $('pvp-dlg-head'); h.textContent = ''; var hd = head(p, on); hd.id = 'pvp-dlg-title'; h.append(hd);
    var x = el('button', 'btn btn-sm pvp-dlg-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.onclick = closeDialog; h.append(x);
    var b = $('pvp-dlg-body'); b.textContent = ''; b.scrollTop = 0;
    b.append(el('h3', 'pvp-dlg-h', 'About ' + p.name), details(p), el('h3', 'pvp-dlg-h', 'How to connect (' + METHOD[p.method || 'key'] + ')'), howTo(p));
    var f = $('pvp-dlg-foot'); f.textContent = ''; f.append(actions(p, on, true));
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeDialog() { dlgFor = null; if (dlg.open) dlg.close(); }
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDialog(); });
  function renderGrid() {
    var g = $('pvp-grid'); g.textContent = ''; g.removeAttribute('aria-busy');
    var list = state.cat.filter(matches).sort(function (a, b) {
      var ca = state.connected.indexOf(a.id) >= 0, cb = state.connected.indexOf(b.id) >= 0;
      if (ca !== cb) return ca ? -1 : 1;
      if (a.popular !== b.popular) return a.popular ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    $('pvp-live').textContent = list.length + (list.length === 1 ? ' provider' : ' providers') + ' shown';
    if (!list.length) {
      var e = el('div', 'pvp-empty'); var none = state.filter === 'connected' && !state.q;
      e.append(el('p', 'pvp-empty-t', none ? 'Nothing connected yet.' : 'No provider matches' + (state.q ? ' “' + state.q + '”' : '') + '.'),
        el('p', '', none ? 'Pick a provider under All, open its key page and paste the key.' : 'Try another name, or show everything.'));
      var r = el('button', 'btn btn-sm btn-primary', 'Show all providers'); r.type = 'button';
      r.onclick = function () { state.q = ''; $('pvp-search').value = ''; setFilter('all'); }; e.append(r); g.append(e);
      $('pvp-more').hidden = true; return;
    }
    list.slice(0, state.shown).forEach(function (p) { g.append(card(p)); });
    if (dlgFor && dlg.open) { var cur = state.cat.filter(function (q) { return q.id === dlgFor; })[0]; if (cur) { var fo = $('pvp-dlg-foot'); fo.textContent = ''; fo.append(actions(cur, state.connected.indexOf(cur.id) >= 0, true)); } }
    $('pvp-more').hidden = list.length <= state.shown;
    $('pvp-more').textContent = 'Show more (' + (list.length - state.shown) + ' left)';
  }
  function setFilter(f) {
    state.filter = f; state.shown = 48;
    Array.prototype.forEach.call(document.querySelectorAll('#pvp .pvp-chip'), function (x) { x.setAttribute('aria-pressed', x.dataset.f === f ? 'true' : 'false'); });
    renderGrid();
  }

  async function testProvider(p) {
    var ms = modelsOf(p.id);
    if (!ms.length) { toast('No models listed for ' + p.name + ' yet. Press Refresh list.', true); return; }
    var m = ms.filter(function (x) { return /-free$/.test(x); })[0] || ms[0];
    state.testing[p.id] = true; renderGrid();
    var x = await wvPost({ action: 'wv_test_model', model: m });
    delete state.testing[p.id]; renderGrid();
    toast(x.ok ? (x.j.ok ? p.name + ' works (' + m + ')' : p.name + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), !(x.ok && x.j.ok));
  }

  /* ---------- inner tabs ---------- */
  var TABS = ['providers', 'agents'];
  function showTab(name, focus) {
    if (TABS.indexOf(name) < 0) name = 'providers';
    state.tab = name; store('mc.pvp.tab', name);
    TABS.forEach(function (t) {
      var b = $('pvp-tab-' + t), on = t === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      $('pvp-panel-' + t).hidden = !on;
      if (on && focus) b.focus();
    });
  }
  TABS.forEach(function (t) {
    var b = $('pvp-tab-' + t);
    b.onclick = function () { showTab(t); };
    b.onkeydown = function (e) {
      var i = TABS.indexOf(t), n = null;
      if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length];
      else if (e.key === 'ArrowLeft') n = TABS[(i + TABS.length - 1) % TABS.length];
      else if (e.key === 'Home') n = TABS[0]; else if (e.key === 'End') n = TABS[TABS.length - 1];
      if (n) { e.preventDefault(); showTab(n, true); }
    };
  });

  $('pvp-save').onclick = async function () {
    var v = $('pvp-planner').value, b = $('pvp-save'); b.disabled = true;
    var x = await wvPost({ action: 'wv_set_planner', choice: v }); b.disabled = false;
    toast(x.ok ? 'Planner is now ' + v + ' (next ticket plan)' : (x.j.error || 'Could not change the planner'), !x.ok); if (x.ok) load();
  };
  $('pvp-ptest').onclick = async function () {
    var v = $('pvp-planner').value; var b = $('pvp-ptest');
    if (v.indexOf('claude:') === 0) { toast('Claude runs on your Claude plan; nothing to test here.'); return; }
    b.disabled = true; b.textContent = 'Testing…';
    var x = await wvPost({ action: 'wv_test_model', model: v });
    b.disabled = false; b.textContent = 'Test';
    toast(x.ok ? (x.j.ok ? v + ' works' : v + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), !(x.ok && x.j.ok));
  };
  var st = null;
  $('pvp-search').oninput = function (e) { clearTimeout(st); var v = e.target.value.trim().toLowerCase(); st = setTimeout(function () { state.q = v; state.shown = 48; renderGrid(); }, 120); };
  $('pvp-more').onclick = function () { state.shown += 48; renderGrid(); };
  $('pvp-refresh').onclick = function () { load(true); };
  Array.prototype.forEach.call(document.querySelectorAll('#pvp .pvp-chip'), function (b) { b.onclick = function () { setFilter(b.dataset.f); }; });

  window.wvOpenProvidersPage = function () { var t = document.querySelector('.tab-btn[data-tab="providers"]'); if (t) t.click(); };
  window.wvProvidersShown = function () { showTab(store('mc.pvp.tab') || state.tab); load(); if (window.wvAgentsLoad) window.wvAgentsLoad(); };
})();

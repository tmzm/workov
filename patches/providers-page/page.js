/* Providers page: a full-screen view inside the dashboard (so it shares the dashboard's sign-in). */
(function () {
  var root = document.getElementById('pvp');
  if (!root) return;
  var state = { cat: [], connected: [], models: [], planner: null, filter: 'all', q: '', shown: 48, testing: {} };
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(msg, bad) { showToast(msg, bad ? 'bad' : undefined); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function modelsOf(id) { return state.models.filter(function (m) { return m.indexOf(id + '/') === 0; }); }

  async function api(path) {
    var res = await fetch(path, { headers: getAuthHeaders() });
    if (res.status === 401) { openAuthModal(); throw new Error('Not signed in'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function load(force) {
    $('pvp-grid').textContent = 'Loading providers…';
    try {
      var c = await api('/api/wv/catalog' + (force ? '?refresh=1' : ''));
      var p = await api('/api/wv/providers');
      state.cat = c.providers || []; state.connected = c.connected || [];
      state.models = p.models || []; state.planner = p.planner || { runtime: 'claude', claude: 'sonnet' };
      $('pvp-sub').textContent = state.cat.length + ' providers · ' + state.connected.length + ' connected' + (c.stale ? ' · offline list' : '');
      renderPlanner(); renderGrid();
    } catch (e) { $('pvp-grid').textContent = 'Could not load: ' + e.message; }
  }

  function plannerValue() {
    var p = state.planner || {};
    return p.runtime === 'opencode' && p.opencode ? p.opencode : 'claude:' + (p.claude || 'sonnet');
  }
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
    sel.value = v;
  }

  function matches(p) {
    var q = state.q;
    if (q && (p.name + ' ' + p.id).toLowerCase().indexOf(q) < 0) return false;
    if (state.filter === 'connected') return state.connected.indexOf(p.id) >= 0;
    if (state.filter === 'popular') return p.popular;
    if (state.filter === 'free') return p.free > 0;
    return true;
  }
  function card(p) {
    var on = state.connected.indexOf(p.id) >= 0;
    var c = el('article', 'pvp-card' + (on ? ' on' : ''));
    var top = el('div', 'pvp-top');
    var av = el('div', 'pvp-av', (p.name || p.id).charAt(0).toUpperCase()); av.style.background = 'hsl(' + hue(p.id) + ' 45% 32%)';
    var tt = el('div', 'pvp-tt'); tt.append(el('div', 'pvp-name', p.name), el('div', 'pvp-id', p.id));
    top.append(av, tt);
    if (on) top.append(el('span', 'pvp-badge ok', 'Connected'));
    var meta = el('div', 'pvp-meta');
    meta.append(el('span', '', p.models + ' models'));
    if (p.free) meta.append(el('span', 'pvp-free', p.free + ' free'));
    c.append(top, meta);
    var act = el('div', 'pvp-act');
    if (on) {
      var t = el('button', 'btn btn-sm', state.testing[p.id] ? 'Testing…' : 'Test'); t.type = 'button'; t.disabled = !!state.testing[p.id];
      t.onclick = function () { testProvider(p); };
      var d = el('button', 'btn btn-sm', 'Disconnect'); d.type = 'button';
      d.onclick = async function () {
        if (!confirm('Disconnect ' + p.name + '?')) return;
        var x = await wvPost({ action: 'wv_disconnect_provider', provider: p.id });
        toast(x.ok ? p.name + ' disconnected' : (x.j.error || 'Failed'), !x.ok); if (x.ok) load();
      };
      act.append(t, d);
    } else {
      var href = p.keyUrl || p.doc;
      if (href) { var a = el('a', 'btn btn-sm', p.keyUrl ? 'Get key ↗' : 'Website ↗'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; act.append(a); }
      var k = el('input', 'pvp-key'); k.type = 'password'; k.autocomplete = 'off'; k.placeholder = 'Paste key'; k.setAttribute('aria-label', 'API key for ' + p.name);
      var b = el('button', 'btn btn-sm btn-primary', 'Connect'); b.type = 'button';
      var go = async function () {
        if (!k.value.trim()) { k.focus(); return; }
        b.disabled = true; var x = await wvPost({ action: 'wv_connect_provider', provider: p.id, key: k.value.trim() }); k.value = ''; b.disabled = false;
        toast(x.ok ? p.name + ' connected (' + x.j.models + ' models)' : (x.j.error || 'Could not connect'), !x.ok); if (x.ok) load();
      };
      b.onclick = go; k.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      act.append(k, b);
    }
    c.append(act);
    return c;
  }
  function renderGrid() {
    var g = $('pvp-grid'); g.textContent = '';
    var list = state.cat.filter(matches).sort(function (a, b) {
      var ca = state.connected.indexOf(a.id) >= 0, cb = state.connected.indexOf(b.id) >= 0;
      if (ca !== cb) return ca ? -1 : 1;
      if (a.popular !== b.popular) return a.popular ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    if (!list.length) { g.append(el('p', 'pvp-empty', 'No provider matches.')); $('pvp-more').hidden = true; return; }
    list.slice(0, state.shown).forEach(function (p) { g.append(card(p)); });
    $('pvp-more').hidden = list.length <= state.shown;
    $('pvp-more').textContent = 'Show more (' + (list.length - state.shown) + ' left)';
  }

  async function testProvider(p) {
    var ms = modelsOf(p.id);
    if (!ms.length) { toast('No models listed for ' + p.name + ' yet. Press Refresh.', true); return; }
    var m = ms.filter(function (x) { return /-free$/.test(x); })[0] || ms[0];
    state.testing[p.id] = true; renderGrid();
    var x = await wvPost({ action: 'wv_test_model', model: m });
    delete state.testing[p.id]; renderGrid();
    toast(x.ok ? (x.j.ok ? p.name + ' works (' + m + ')' : p.name + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), !(x.ok && x.j.ok));
  }

  $('pvp-save').onclick = async function () {
    var v = $('pvp-planner').value;
    var x = await wvPost({ action: 'wv_set_planner', choice: v });
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
  $('pvp-search').oninput = function (e) { state.q = e.target.value.trim().toLowerCase(); state.shown = 48; renderGrid(); };
  $('pvp-more').onclick = function () { state.shown += 48; renderGrid(); };
  $('pvp-refresh').onclick = function () { load(true); };
  Array.prototype.forEach.call(document.querySelectorAll('#pvp .pvp-chip'), function (b) {
    b.onclick = function () {
      state.filter = b.dataset.f; state.shown = 48;
      Array.prototype.forEach.call(document.querySelectorAll('#pvp .pvp-chip'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      renderGrid();
    };
  });

  function open() { root.hidden = false; document.body.style.overflow = 'hidden'; if (location.hash !== '#providers') history.replaceState(null, '', '#providers'); load(); $('pvp-search').focus(); }
  function close() { root.hidden = true; document.body.style.overflow = ''; if (location.hash === '#providers') history.replaceState(null, '', location.pathname + location.search); }
  $('pvp-close').onclick = close;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !root.hidden) close(); });
  window.wvOpenProvidersPage = open;
  if (location.hash === '#providers') open();
})();

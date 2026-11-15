// Ejad: agent logs as a timeline, like the chat (apply after ejad-agent-steps.cjs and ejad-dashboard-router.cjs).
//  - the ticket's Logs tab and the Router panel get a Timeline / Text switch (Timeline by default)
//  - the Timeline groups the work per agent (worker, tester, reviewer, router ...) and draws each step as the chat does:
//    messages as formatted text, thinking folded away, one row per tool (command with its output, diffs for edits,
//    reads, searches), the plan as a checklist. Same data as before, only drawn properly. Text mode stays one click away.
const fs = require('fs');
const path = require('path');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const fail = (m) => { throw new Error('anchor missing: ' + m); };

if (!h.includes('id="ejad-steps-js"')) {
  // markdown renderer: the chat's own, so replies look the same everywhere
  const mdPath = [path.join(__dirname, '..', 'app', 'chat-md.js'), path.join(__dirname, 'chat-md.js')].find((p) => fs.existsSync(p));
  if (!mdPath) fail('chat-md.js (app/chat-md.js)');
  const MD = fs.readFileSync(mdPath, 'utf8').replace("'use strict';", '').replace('window.renderMarkdown', 'window.ejadMarkdown');

  // 1. the ticket Logs tab: a host for the timeline and the switch
  const pre = /<pre\b[^>]*\bid="d-log-view"/.exec(h) || fail('d-log-view');
  h = h.slice(0, pre.index) + '<div id="d-steps" class="steps" hidden></div>\n' + h.slice(pre.index);
  const bar = /<div class="logs-toolbar">/.exec(h) || fail('logs-toolbar');
  h = h.replace(bar[0], () => bar[0] + '<span class="st-mode" id="d-steps-mode" role="group" aria-label="Log view"><button type="button" data-m="steps">Timeline</button><button type="button" data-m="text">Text</button></span>');
  // 2. the Router panel
  const rt = /<pre\b[^>]*\bid="rt-log"/.exec(h) || fail('rt-log');
  h = h.slice(0, rt.index) + '<div class="st-mode" id="rt-steps-mode" role="group" aria-label="Router log view"><button type="button" data-m="steps">Timeline</button><button type="button" data-m="text">Text</button></div>\n<div id="rt-steps" class="steps" hidden></div>\n' + h.slice(rt.index);

  const CSS = `<style id="ejad-steps-css">
.st-mode { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r-control, 6px); overflow: hidden; margin: 0 8px 0 0; }
.st-mode button { border: 0; background: transparent; color: var(--text-3); padding: 0 12px; min-height: 30px; font: 600 var(--fs-small, 13px) var(--font-ui); cursor: pointer; }
.st-mode button[aria-pressed="true"] { background: var(--surface-2); color: var(--text); }
.steps { max-height: 62vh; overflow: auto; padding: 4px 2px 8px; display: flex; flex-direction: column; gap: 10px; font-size: var(--fs-small, 13.5px); color: var(--text); }
.steps[hidden] { display: none; }
.st-agent { border: 1px solid var(--line); border-radius: var(--r-panel, 8px); background: var(--surface-1); }
.st-agent > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; }
.st-agent > summary::-webkit-details-marker { display: none; }
.st-badge { font: 700 11px var(--font-mono); text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: var(--r-control, 6px); background: var(--surface-3, var(--surface-2)); color: var(--text); }
.st-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.st-meta { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.st-live { width: 8px; height: 8px; border-radius: 50%; background: var(--lamp-run); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lamp-run) 25%, transparent); }
.st-body { display: flex; flex-direction: column; gap: 8px; padding: 4px 12px 12px; border-top: 1px solid var(--line); }
.st-md { line-height: 1.55; word-break: break-word; }
.st-md p { margin: 0 0 6px; } .st-md ul, .st-md ol { margin: 0 0 6px; padding-left: 20px; }
.st-md code { font-family: var(--font-mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--line); padding: 0 5px; border-radius: 4px; }
.st-md .code { border: 1px solid var(--line); border-radius: var(--r-control, 6px); overflow: hidden; margin: 4px 0; }
.st-md .code .lang { display: flex; justify-content: space-between; padding: 3px 10px; font-size: 11px; color: var(--text-3); background: var(--surface-2); }
.st-md .code button { border: 0; background: none; color: var(--text-3); font-size: 11px; cursor: pointer; }
.st-md a { color: var(--btn-primary-bg, var(--lamp-info)); }
.st-note { color: var(--text-3); font-size: 12px; }
.st-fold { border: 0; }
.st-fold > summary { cursor: pointer; color: var(--text-3); font-style: italic; list-style: none; }
.st-fold > summary::-webkit-details-marker { display: none; }
.st-fold > div { margin: 4px 0 0 4px; padding-left: 10px; border-left: 2px solid var(--line); color: var(--text-3); white-space: pre-wrap; font-style: italic; }
.st-task > summary { cursor: pointer; color: var(--text-2); }
.st-task > pre { margin-top: 4px; }
.st-tool { border: 1px solid var(--line); border-radius: var(--r-control, 8px); background: var(--surface-1); overflow: hidden; }
.st-tool > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 6px 10px; cursor: pointer; }
.st-tool > summary::-webkit-details-marker { display: none; }
.st-tool > summary:hover { background: var(--surface-2); }
.st-tool svg { width: 15px; height: 15px; stroke: var(--btn-primary-bg, var(--lamp-info)); fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.st-tool .vb { font-weight: 700; } .st-tool .tg { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.st-tool .sx { margin-left: auto; display: flex; gap: 8px; font-size: 12px; color: var(--text-3); flex: none; }
.st-tool.err .sx { color: var(--lamp-stop); } .st-tool .plus { color: var(--lamp-run); } .st-tool .minus { color: var(--lamp-stop); }
.st-tool .dt { border-top: 1px solid var(--line); }
.st-tool pre, .st-md pre, .st-task pre { margin: 0; padding: 8px 12px; font: 12px/1.5 var(--font-mono); white-space: pre-wrap; word-break: break-word; background: var(--readout-bg, var(--surface-2)); max-height: 260px; overflow: auto; }
.st-tool .lb { padding: 5px 12px 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); background: var(--readout-bg, var(--surface-2)); }
.st-tool .hd { padding: 5px 12px; font-size: 12px; color: var(--text-2); background: var(--surface-2); border-bottom: 1px solid var(--line); font-family: var(--font-mono); }
.st-tool .l { display: flex; gap: 10px; padding: 0 12px; font: 12px/1.6 var(--font-mono); white-space: pre-wrap; word-break: break-word; }
.st-tool .l b { width: 14px; flex: none; text-align: center; } .st-tool .l.a { background: color-mix(in srgb, var(--lamp-run) 14%, transparent); } .st-tool .l.d { background: color-mix(in srgb, var(--lamp-stop) 14%, transparent); }
.st-todo { border: 1px solid var(--line); border-radius: var(--r-control, 8px); padding: 8px 12px; background: var(--surface-1); }
.st-todo h5 { margin: 0 0 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); display: flex; justify-content: space-between; }
.st-todo .r { display: flex; gap: 8px; padding: 2px 0; } .st-todo .r.done { color: var(--text-3); text-decoration: line-through; } .st-todo .r.now { color: var(--text); font-weight: 600; }
.log-view[hidden], #rt-log[hidden] { display: none !important; }
body.st-timeline #d-log-files, body.st-timeline #d-log-meta, body.st-timeline #d-logs-autorefresh { display: none !important; }
.st-empty { color: var(--text-3); padding: 16px; text-align: center; }
</style>
`;
  h = h.replace('</head>', () => CSS + '</head>');

  const JS = `<script id="ejad-steps-js">
(function () {
${MD}
  var ICONS = { file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', term: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>' };
  var KIND = { Read: 'file', Edit: 'edit', Write: 'edit', Bash: 'term', Grep: 'search', Glob: 'search', WebFetch: 'search', WebSearch: 'search' };
  function mk(tag, cls, text, parent) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; }
  function icon(k, parent) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICONS[k] || ICONS.spark; parent.append(s); }
  function hhmm(t) { return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
  function base(p) { return String(p || '').split(/[\\\\/]/).pop(); }
  function line1(s, n) { s = String(s || '').split('\\n')[0]; return s.length > n ? s.slice(0, n) + '…' : s; }
  function describe(name, i) {
    switch (name) {
      case 'Read': case 'Edit': case 'Write': return [name === 'Read' ? 'Read' : name === 'Edit' ? 'Edit' : 'Write', i.file_path || ''];
      case 'Bash': return ['Run', i.description ? i.description + '  ·  ' + line1(i.command, 70) : line1(i.command, 110)];
      case 'Grep': return ['Search', (i.pattern || '') + (i.path ? ' in ' + i.path : '')];
      case 'Glob': return ['Find', i.pattern || i.path || ''];
      case 'WebFetch': return ['Fetch', i.url || '']; case 'WebSearch': return ['Web search', i.query || ''];
      case 'Script': return ['Script', line1(i.code, 110)];
      case 'Task': return ['Agent', (i.agent ? i.agent + ': ' : '') + (i.description || i.subagent_type || '')];
      default: return [name, line1(JSON.stringify(i), 90)];
    }
  }
  function diff(from, to, host) {
    function add(c, sign, tx) { var l = mk('div', 'l ' + c, null, host); mk('b', null, sign, l); l.append(tx); }
    String(from || '').split('\\n').forEach(function (x) { add('d', '−', x); });
    String(to || '').split('\\n').forEach(function (x) { add('a', '+', x); });
  }
  function toolRow(step, host, keep) {
    var i = step.input || {}, d = mk('details', 'st-tool' + (step.status === 'error' ? ' err' : ''), null, host), sm = mk('summary', null, null, d), de = describe(step.name, i);
    icon(KIND[step.name], sm); mk('span', 'vb', de[0], sm); mk('span', 'tg', de[1], sm);
    var sx = mk('span', 'sx', null, sm);
    if (step.name === 'Edit') { sx.append(mk('span', 'plus', '+' + String(i.new_string || '').split('\\n').length), mk('span', 'minus', '−' + String(i.old_string || '').split('\\n').length)); }
    else sx.append(step.status === 'completed' ? '✓' : step.status === 'error' ? 'failed' : step.status === 'running' || step.status === 'pending' ? 'running…' : step.status);
    sx.append(hhmm(step.t));
    var dt = mk('div', 'dt', null, d);
    if (step.name === 'Edit') { mk('div', 'hd', i.file_path || '', dt); diff(i.old_string, i.new_string, dt); }
    else if (step.name === 'Write') { mk('div', 'hd', i.file_path || '', dt); diff('', String(i.content || '').split('\\n').slice(0, 60).join('\\n'), dt); }
    else {
      if (step.name === 'Bash') mk('pre', null, '$ ' + (i.command || ''), dt); else if (step.name !== 'Read') mk('pre', null, JSON.stringify(i, null, 2), dt);
      if (step.out) { mk('div', 'lb', step.status === 'error' ? 'Error' : step.name === 'Read' ? 'Content' : 'Output', dt); mk('pre', null, step.out, dt); }
    }
    if (keep.has(d.dataset.k = step.key)) d.open = true;
    d.addEventListener('toggle', function () { if (d.open) keep.add(step.key); else keep.delete(step.key); });
  }
  function todo(step, host) {
    var items = (step.input && step.input.todos) || [], done = items.filter(function (x) { return x.status === 'completed'; }).length, c = mk('div', 'st-todo', null, host), hd = mk('h5', null, null, c);
    mk('span', null, 'Plan', hd); mk('span', null, done + ' of ' + items.length, hd);
    items.forEach(function (x) { var r = mk('div', 'r' + (x.status === 'completed' ? ' done' : x.status === 'in_progress' ? ' now' : ''), (x.status === 'completed' ? '✓ ' : x.status === 'in_progress' ? '▸ ' : '○ ') + x.content, c); });
  }
  function draw(host, data, keep) {
    host.replaceChildren(); var agents = data.agents || [];
    if (!agents.length) { mk('div', 'st-empty', 'Nothing here yet. Steps appear as soon as an agent starts working.', host); return; }
    agents.forEach(function (a, ai) {
      var k = 'a:' + a.id, g = mk('details', 'st-agent', null, host), sm = mk('summary', null, null, g), last = a.steps.length ? a.steps[a.steps.length - 1] : null;
      var live = last && (last.k === 'tool' ? (last.status === 'running' || last.status === 'pending') : false);
      mk('span', 'st-badge', a.agent, sm); mk('span', 'st-title', a.title, sm); if (live) mk('span', 'st-live', null, sm).title = 'working now';
      mk('span', 'st-meta', a.total + ' step' + (a.total === 1 ? '' : 's') + (last ? ' · ' + hhmm(last.t) : ''), sm);
      g.open = keep.has(k) || (!keep.has('x:' + k) && ai === agents.length - 1); g.addEventListener('toggle', function () { if (g.open) { keep.add(k); keep.delete('x:' + k); } else { keep.delete(k); keep.add('x:' + k); } });
      var body = mk('div', 'st-body', null, g);
      a.steps.forEach(function (s, n) {
        s.key = a.id + ':' + (a.total - a.steps.length + n);
        if (s.k === 'user') { var t = mk('details', 'st-task', null, body); mk('summary', null, 'Task: ' + line1(s.text, 110), t); mk('pre', null, s.text, t); if (keep.has(s.key)) t.open = true; t.addEventListener('toggle', function () { if (t.open) keep.add(s.key); else keep.delete(s.key); }); }
        else if (s.k === 'note') mk('div', 'st-note', line1(s.text, 200), body);
        else if (s.k === 'think') { var f = mk('details', 'st-fold', null, body); mk('summary', null, 'Thinking', f); mk('div', null, s.text, f); }
        else if (s.k === 'text') window.ejadMarkdown(s.text, mk('div', 'st-md', null, body));
        else if (s.k === 'tool') { if (s.name === 'TodoWrite') todo(s, body); else toolRow(s, body, keep); }
      });
    });
  }
  // one timeline attached to a host: it follows the data, keeps what you opened, and sticks to the bottom unless you scrolled up
  function mount(o) {
    var host = document.getElementById(o.host), mode = document.getElementById(o.mode), raw = document.getElementById(o.raw), keep = new Set(), sig = '', pref = 'steps', busy = false;
    if (!host || !mode || !raw) return;
    try { pref = localStorage.getItem('ejad.logs') || 'steps'; } catch (e) { /* default */ }
    function paint() { var on = pref === 'steps'; if (o.cls) document.body.classList.toggle(o.cls, on); host.hidden = !on; raw.hidden = on; mode.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === pref)); }); }
    mode.querySelectorAll('button').forEach(function (b) { b.onclick = function () { pref = b.dataset.m; try { localStorage.setItem('ejad.logs', pref); } catch (e) { /* not saved */ } paint(); load(true); }; });
    async function load(force) {
      var u = o.url(); if (pref !== 'steps' || !u || busy || document.hidden || !host.offsetParent) return; busy = true;
      try {
        var r = await fetch(u, { headers: getAuthHeaders() }); if (!r.ok) return; var d = await r.json();
        var s = JSON.stringify((d.agents || []).map(function (a) { var l = a.steps[a.steps.length - 1] || {}; return [a.id, a.total, l.k, l.status, l.t]; })); if (!force && s === sig) return; sig = s;
        var stick = host.scrollHeight - host.scrollTop - host.clientHeight < 60, top = host.scrollTop; draw(host, d, keep); host.scrollTop = stick ? host.scrollHeight : top;
      } catch (e) { /* keeps the last view */ } finally { busy = false; }
    }
    paint(); setInterval(function () { load(false); }, 3500); return { reload: function () { sig = ''; load(true); } };
  }
  window.ejadStepsInit = function () {
    var t = mount({ host: 'd-steps', mode: 'd-steps-mode', raw: 'd-log-view', cls: 'st-timeline', url: function () { return typeof currentTicket !== 'undefined' && currentTicket ? '/api/ejad/steps?ticket=' + encodeURIComponent(currentTicket) : ''; } });
    mount({ host: 'rt-steps', mode: 'rt-steps-mode', raw: 'rt-log', url: function () { return '/api/ejad/steps?router=1'; } });
    var prev = window.renderLogs; if (t && typeof prev === 'function') window.renderLogs = function () { prev.apply(this, arguments); t.reload(); };
  };
  window.ejadStepsInit();
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('steps view patch applied');

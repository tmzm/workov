// Ejad Chat page. Renders Claude's turn as a timeline, the way the VS Code extension shows it: streamed text, thinking rows,
// one collapsible row per tool call (diffs for edits, output for commands), a live plan, and Allow/Deny cards.
'use strict';
const $ = (id) => document.getElementById(id);
const log = $('log'), box = $('box'), scroller = $('scroll');
const ICON = { Read: 'file', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'term', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'search' };
let files = [], cmds = [], busy = false, stick = true, turn = null, live = {}, tools = {}, streamed = new Set(), todoCard = null, menuIdx = 0, thinkCount = 0;

function svg(name, cls) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; }
function h(tag, cls, text, parent) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; }
const base = (p) => String(p || '').split(/[\\/]/).pop();
const json = (o) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } };
function bottom() { if (stick) scroller.scrollTop = scroller.scrollHeight; }
scroller.addEventListener('scroll', () => { stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; $('jump').classList.toggle('show', !stick); });
$('jump').onclick = () => { stick = true; bottom(); };
function clearEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }
function empty() {
  log.replaceChildren(); const e = h('div', 'empty', null, log); h('h2', null, 'What should we work on?', e); h('div', null, 'Claude can read and change files, run commands, and use your skills and MCP servers.', e);
  const s = h('div', 'sug', null, e);
  for (const t of ['What changed in this repo today?', 'Explain how the router decides what to dispatch', 'Review my uncommitted changes']) { const b = h('button', null, t, s); b.onclick = () => { box.value = t; box.focus(); }; }
}
function setBusy(b) {
  busy = b; $('work').classList.toggle('show', b); $('goIcon').firstChild.setAttribute('href', b ? '#i-stop' : '#i-send'); $('go').setAttribute('aria-label', b ? 'Stop' : 'Send');
}

// ---------- the timeline ----------
function userBlock(text, attached) {
  clearEmpty(); const u = h('div', 'user', null, log); const who = h('div', 'who', null, u); h('span', 'avatar', 'T', who); who.append('You');
  if (text) h('div', null, text, u).style.whiteSpace = 'pre-wrap';
  if (attached && attached.length) { const f = h('div', 'files', null, u); for (const p of attached) { const c = h('span', 'file', null, f); c.append(svg('file'), base(p)); } }
  turn = null; bottom();
}
function turnBody() {
  if (turn) return turn; clearEmpty();
  const a = h('div', 'asst', null, log), b = h('span', 'badge', null, a); b.append(svg('spark'));
  turn = h('div', 'body', null, a); return turn;
}
function textBlock(text) { const d = h('div', 'md', null, turnBody()); window.renderMarkdown(text, d); return d; }
function thinkBlock(text) {
  const t = turnBody(), b = h('button', 'think', null, t); b.type = 'button'; b.setAttribute('aria-expanded', 'false'); b.append(svg('chev'), 'Thinking');
  const body = h('div', 'think-body', text || '', t); b.onclick = () => b.setAttribute('aria-expanded', b.getAttribute('aria-expanded') !== 'true');
  return { btn: b, body, started: Date.now() };
}

function summary(name, i) {
  i = i || {};
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return ['Read', 'Edit', 'Write', 'Edit', 'Edit'][['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].indexOf(name)] + '|' + (i.file_path || i.notebook_path || '');
    case 'Bash': return 'Run|' + String(i.command || '').split('\n')[0];
    case 'Grep': return 'Search|' + (i.pattern || '') + (i.path ? ' in ' + i.path : '');
    case 'Glob': return 'Find|' + (i.pattern || '');
    case 'WebFetch': return 'Fetch|' + (i.url || '');
    case 'WebSearch': return 'Web search|' + (i.query || '');
    case 'Task': case 'Agent': return 'Agent|' + (i.description || '');
    default: return name.replace(/^mcp__/, '').replace(/__/g, ' › ') + '|' + (i && Object.keys(i).length ? json(i).replace(/\s+/g, ' ').slice(0, 80) : '');
  }
}
function diffLines(from, to, host) {
  const add = (cls, sign, text) => { const l = h('div', 'l ' + cls, null, host); h('i', null, '', l); h('b', null, sign, l); l.append(text); };
  for (const x of String(from || '').split('\n')) add('d', '−', x);
  for (const x of String(to || '').split('\n')) add('a', '+', x);
}
function fillDetail(row, name, i, result, isErr) {
  const d = row.querySelector('.detail'); d.replaceChildren(); i = i || {};
  if (name === 'Edit' || name === 'MultiEdit') {
    d.classList.add('diff'); h('div', 'diffhead', i.file_path || '', d);
    for (const e of name === 'Edit' ? [i] : (i.edits || [])) diffLines(e.old_string, e.new_string, d);
  } else if (name === 'Write') { d.classList.add('diff'); h('div', 'diffhead', i.file_path || '', d); diffLines('', String(i.content || '').split('\n').slice(0, 60).join('\n'), d); }
  else if (name === 'Bash') { h('pre', null, '$ ' + (i.command || ''), d); }
  else if (name !== 'Read') { h('pre', null, json(i), d); }
  if (result != null && name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write') { h('div', 'lbl', isErr ? 'Error' : 'Result', d); h('pre', null, String(result).slice(0, 6000), d); }
}
function toolRow(id, name, input) {
  if (name === 'TodoWrite') return todoUpdate(id, input);
  const host = turnBody(), row = h('details', 'tool', null, host), sm = h('summary', null, null, row);
  const ic = h('span', 'ico', null, sm); ic.append(svg(ICON[name] || 'spark'));
  const [verb, target] = summary(name, input).split('|');
  h('span', 'verb', verb, sm); h('span', 'target', target, sm);
  const st = h('span', 'state', null, sm); h('span', 'spin', null, st); sm.append(svg('chev', 'chev'));
  h('div', 'detail', null, row); fillDetail(row, name, input);
  tools[id] = { row, name, input, st, sm }; bottom(); return tools[id];
}
function toolInput(id, input) {
  const t = tools[id]; if (!t || !input) return; t.input = input;
  const [verb, target] = summary(t.name, input).split('|'); t.sm.querySelector('.target').textContent = target; fillDetail(t.row, t.name, input);
  if (t.name === 'Edit' || t.name === 'MultiEdit') t.row.open = true;
}
function toolResult(id, content, isErr) {
  const t = tools[id]; if (!t) return;
  const text = typeof content === 'string' ? content : (content || []).map((x) => x.text || '').join('\n');
  t.st.replaceChildren();
  if (isErr) { t.row.classList.add('err'); t.st.append('failed'); } else {
    t.st.append(svg('check')); const n = text ? text.split('\n').length : 0;
    if (t.name === 'Read' && n) t.st.append(n + ' lines'); else if (t.name === 'Edit' || t.name === 'MultiEdit') { const i = t.input || {}, a = String(i.new_string || '').split('\n').length, d = String(i.old_string || '').split('\n').length; t.st.replaceChildren(h('span', 'plus', '+' + a), h('span', 'minus', '−' + d)); }
  }
  fillDetail(t.row, t.name, t.input, text, isErr);
}
function todoUpdate(id, input) {
  const items = (input && input.todos) || [];
  if (!todoCard || !todoCard.isConnected) { todoCard = h('div', 'todo', null, turnBody()); }
  todoCard.replaceChildren(); const done = items.filter((x) => x.status === 'completed').length;
  const hd = h('h5', null, null, todoCard); h('span', null, 'Plan', hd); h('span', null, done + ' of ' + items.length, hd);
  for (const x of items) {
    const r = h('div', 'row' + (x.status === 'completed' ? ' done' : x.status === 'in_progress' ? ' now' : ''), null, todoCard), c = h('span', 'chk', null, r);
    if (x.status === 'completed') c.append(svg('check')); else if (x.status === 'in_progress') h('span', 'spin', null, c);
    r.append(x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content);
  }
  bottom(); return null;
}

// ---------- messages from the engine ----------
function onBlock(b, m, fromHistory) {
  if (b.type === 'text' && m.type === 'assistant') { if (!streamed.has(m.message.id)) textBlock(b.text); }
  else if (b.type === 'thinking') { if (!streamed.has(m.message.id)) { const t = thinkBlock(b.thinking); t.btn.lastChild.textContent = 'Thought'; } }
  else if (b.type === 'tool_use') { if (tools[b.id]) toolInput(b.id, b.input); else toolRow(b.id, b.name, b.input); }
  else if (b.type === 'tool_result') toolResult(b.tool_use_id, b.content, b.is_error);
  else if (b.type === 'text' && m.type === 'user' && fromHistory) userBlock(b.text, []);
}
function onMessage(m, fromHistory) {
  if (m.type === 'stream_event') return onStream(m.event);
  if (m.type === 'assistant' || m.type === 'user') {
    const c = m.message && m.message.content;
    if (typeof c === 'string') { if (m.type === 'user' && fromHistory) userBlock(c, []); return; }
    for (const b of c || []) onBlock(b, m, fromHistory);
    if (m.type === 'user' && !(c || []).some((b) => b.type === 'tool_result')) turn = null;
  } else if (m.type === 'result') {
    setBusy(false); turn = null; live = {};
    if (m.is_error) h('div', 'msg-err', (m.errors && m.errors.join('\n')) || m.result || 'The turn failed.', log);
    loadSessions();
  }
}
function onStream(ev) {
  if (ev.type === 'message_start') { live = {}; streamed.add(ev.message.id); }
  else if (ev.type === 'content_block_start') {
    const cb = ev.content_block;
    if (cb.type === 'text') live[ev.index] = { type: 'text', text: '', el: h('div', 'md', null, turnBody()) };
    else if (cb.type === 'thinking') live[ev.index] = { type: 'thinking', t: thinkBlock('') };
    else if (cb.type === 'tool_use') { toolRow(cb.id, cb.name, {}); live[ev.index] = { type: 'tool', id: cb.id, json: '' }; }
  } else if (ev.type === 'content_block_delta') {
    const l = live[ev.index]; if (!l) return; const d = ev.delta;
    if (d.type === 'text_delta') { l.text += d.text; if (!l.raf) l.raf = requestAnimationFrame(() => { l.raf = 0; window.renderMarkdown(l.text, l.el); bottom(); }); }
    else if (d.type === 'thinking_delta') { l.t.body.textContent += d.thinking; bottom(); }
    else if (d.type === 'input_json_delta') l.json += d.partial_json;
  } else if (ev.type === 'content_block_stop') {
    const l = live[ev.index]; if (!l) return;
    if (l.type === 'text') window.renderMarkdown(l.text, l.el);
    else if (l.type === 'thinking') l.t.btn.lastChild.textContent = 'Thought for ' + Math.max(1, Math.round((Date.now() - l.t.started) / 1000)) + ' seconds';
    else if (l.type === 'tool') { try { toolInput(l.id, JSON.parse(l.json || '{}')); } catch { /* the final message carries the input */ } if (tools[l.id] && tools[l.id].name === 'TodoWrite') { try { todoUpdate(l.id, JSON.parse(l.json)); } catch { /* same */ } } }
    bottom();
  }
}

// ---------- permissions ----------
function permission(d) {
  clearEmpty(); const c = h('div', 'perm', null, log); c.setAttribute('role', 'alertdialog');
  const hd = h('div', 'ph', null, c); hd.append(svg('shield'), d.title || (d.displayName + ' needs your permission'));
  if (d.reason) h('div', 'why', d.reason, c);
  const done = (label) => { c.classList.add('done'); h('div', 'res', label, c); };
  const respond = (allow, always, input) => { fleetChat.answer({ id: d.id, allow, always, input }); done(allow ? (always ? 'Allowed, and remembered' : 'Allowed') : 'Denied'); turn = null; };
  const acts = h('div', 'acts');
  if (d.toolName === 'AskUserQuestion') { questions(c, d, respond); return; }
  if (d.toolName === 'ExitPlanMode') { const p = h('div', 'md', null, c); p.style.padding = '8px 14px'; window.renderMarkdown(String((d.input && d.input.plan) || ''), p); }
  else { h('pre', null, d.blockedPath ? d.blockedPath + '\n' + (d.input.command || json(d.input)) : (d.input.command || d.input.file_path || json(d.input)), c); }
  c.append(acts);
  const mk = (label, cls, fn, kbd) => { const b = h('button', 'btn ' + cls, null, acts); b.type = 'button'; b.append(label); if (kbd) h('kbd', null, kbd, b); b.onclick = fn; return b; };
  const allow = mk('Allow', 'primary', () => respond(true, false), 'Enter');
  if (d.toolName !== 'ExitPlanMode') mk('Always allow', '', () => respond(true, true));
  mk('Deny', 'danger', () => respond(false, false), 'Esc');
  c.addEventListener('keydown', (e) => { if (e.key === 'Escape') respond(false, false); });
  allow.focus(); bottom();
}
function questions(c, d, respond) {
  const qs = (d.input && d.input.questions) || [], answers = {};
  qs.forEach((q) => {
    const wrap = h('div', null, null, c); wrap.style.padding = '6px 14px 10px'; h('div', null, q.question, wrap).style.fontWeight = '600';
    const row = h('div', null, null, wrap); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px';
    for (const o of q.options || []) { const b = h('button', 'btn', o.label, row); b.type = 'button'; b.title = o.description || ''; b.onclick = () => { answers[q.question] = o.label; row.querySelectorAll('.btn').forEach((x) => x.classList.remove('primary')); b.classList.add('primary'); }; }
  });
  const acts = h('div', 'acts', null, c), go = h('button', 'btn primary', 'Send answers', acts); go.type = 'button';
  go.onclick = () => respond(true, false, { questions: qs, answers });
}

// ---------- composer ----------
function chips() {
  $('chips').replaceChildren(...files.map((f, i) => { const c = h('span', 'chip'); c.append(svg('file'), base(f)); c.firstChild.style.width = '13px'; const x = h('button', null, null, c); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + base(f)); x.append(svg('x')); x.firstChild.style.width = '12px'; x.onclick = () => { files.splice(i, 1); chips(); }; return c; }));
  $('chips').style.display = files.length ? 'flex' : 'none';
}
async function send() {
  if (busy) { fleetChat.interrupt(); return; }
  const text = box.value.trim(); if (!text && !files.length) return;
  closeMenu(); box.value = ''; grow(); const f = files; files = []; chips();
  if (text === '/clear') { await newChat(); return; }
  if (text === '/model') { $('model').focus(); return; }
  userBlock(text, f); stick = true; setBusy(true); await fleetChat.say({ text, files: f });
}
async function newChat() { await fleetChat.newChat(); streamed = new Set(); tools = {}; live = {}; todoCard = null; turn = null; setBusy(false); empty(); loadSessions(); }
function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 200) + 'px'; }
function closeMenu() { $('menu').classList.remove('show'); }
function menuItems() { return [...$('menu').querySelectorAll('.it')]; }
function pick(it) { box.value = '/' + it.dataset.name + ' '; closeMenu(); box.focus(); grow(); }
function openMenu(q) {
  const all = [{ name: 'clear', description: 'Start a fresh chat', kind: 'Commands' }, { name: 'model', description: 'Pick the model', kind: 'Commands' }, ...cmds.map((c) => ({ ...c, kind: c.name.includes(':') || c.description.length ? 'Skills' : 'Commands' }))];
  const list = all.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40), m = $('menu'); m.replaceChildren();
  if (!list.length) { closeMenu(); return; }
  let last = ''; menuIdx = 0;
  for (const c of list) {
    if (c.kind !== last) { h('div', 'sec', c.kind, m); last = c.kind; }
    const it = h('div', 'it' + (m.querySelector('.it') ? '' : ' on'), null, m); it.dataset.name = c.name; it.setAttribute('role', 'option');
    h('b', null, '/' + c.name, it); h('span', null, (c.description || '').slice(0, 80), it); it.onmousedown = (e) => { e.preventDefault(); pick(it); };
  }
  m.classList.add('show');
}
box.addEventListener('input', () => { grow(); const m = /^\/(\S*)$/.exec(box.value); if (m) openMenu(m[1]); else closeMenu(); });
box.addEventListener('keydown', (e) => {
  const open = $('menu').classList.contains('show'), items = menuItems();
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); items[menuIdx].classList.remove('on'); menuIdx = (menuIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[menuIdx].classList.add('on'); items[menuIdx].scrollIntoView({ block: 'nearest' }); return; }
  if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pick(items[menuIdx]); return; }
  if (e.key === 'Escape') { if (open) closeMenu(); else if (busy) fleetChat.interrupt(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('go').onclick = send;
$('attach').onclick = async () => { files.push(...((await fleetChat.pickFiles()) || [])); chips(); };
box.addEventListener('paste', (e) => { for (const it of e.clipboardData.items) if (it.kind === 'file') { const p = fleetChat.pathOf(it.getAsFile()); if (p) { files.push(p); chips(); } } });
for (const ev of ['dragover', 'dragenter']) addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('drop'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('drop'); });
addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drop'); for (const f of e.dataTransfer.files) { const p = fleetChat.pathOf(f); if (p) files.push(p); } chips(); });

// ---------- header and sidebar ----------
function paintState(s) {
  $('folderName').textContent = s.cwd; $('folder').title = s.cwd;
  document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.permissionMode)));
}
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => fleetChat.setPermissionMode(b.dataset.mode)));
$('model').onchange = () => fleetChat.setModel($('model').value);
$('new').onclick = newChat;
$('dash').onclick = () => fleetChat.openDashboard();
$('folder').onclick = async (e) => {
  e.stopPropagation(); const m = $('folderMenu'); if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const f = await fleetChat.folders(), r = $('folder').getBoundingClientRect(); m.replaceChildren();
  m.style.top = r.bottom + 6 + 'px'; m.style.left = Math.max(8, r.left) + 'px';
  const row = (title, path, cur) => { const it = h('div', 'it' + (cur ? ' cur' : ''), null, m); it.setAttribute('role', 'menuitem'); it.tabIndex = 0; h('b', null, title, it); h('span', null, path, it); const go = async () => { m.classList.remove('show'); if (await fleetChat.setFolder(path)) newChat(); }; it.onclick = go; it.onkeydown = (ev) => { if (ev.key === 'Enter') go(); }; };
  const browse = h('div', 'it', null, m); h('b', null, 'Browse for a folder…', browse); browse.tabIndex = 0; browse.onclick = async () => { m.classList.remove('show'); if (await fleetChat.pickFolder()) newChat(); };
  h('div', 'sec', 'Fleet', m); row('Fleet folder', f.fleet, f.fleet === f.current);
  if (f.worktrees.length) { h('div', 'sec', 'Worker folders (one per ticket)', m); for (const w of f.worktrees) row(w.split(/[\\/]/).pop(), w, w === f.current); }
  if (f.recent.length) { h('div', 'sec', 'Recent', m); for (const w of f.recent) row(w.split(/[\\/]/).pop() || w, w, w === f.current); }
  m.classList.add('show');
};
document.addEventListener('click', (e) => { const m = $('folderMenu'); if (!m.contains(e.target)) m.classList.remove('show'); });

// the Claude account: always visible; without a sign-in the chat is locked and the chip is the way in
let claudeOk = true; const placeholder = box.placeholder;
async function claudeChip() {
  const s = (await fleetChat.claude()) || {}; claudeOk = !!s.loggedIn;
  $('claudeChip').classList.toggle('warn', !claudeOk); $('claudeDot').className = 'dot' + (claudeOk ? '' : ' off');
  $('claudeText').textContent = claudeOk ? (s.email || 'Claude') + (s.plan ? ' · ' + s.plan : '') : s.installed === false ? 'Install Claude Code' : 'Sign in to Claude';
  $('claudeChip').title = claudeOk ? 'Signed in to Claude' + (s.org ? ' (' + s.org + ')' : '') + '. Click to switch account.' : 'Chat is locked until you sign in to Claude.';
  box.disabled = !claudeOk; $('go').disabled = !claudeOk && !busy; box.placeholder = claudeOk ? placeholder : 'Sign in to Claude to chat';
}
$('claudeChip').onclick = async () => { $('claudeText').textContent = 'Finish in your browser…'; await fleetChat.claudeLogin(); claudeChip(); };
claudeChip(); setInterval(claudeChip, 300000); addEventListener('focus', claudeChip);
function theme(t, mode) {
  const r = document.documentElement; if (t) { r.dataset.theme = t; $('theme').value = t; } if (mode) r.dataset.mode = mode;
  try { localStorage.setItem('chat.theme', r.dataset.theme); localStorage.setItem('chat.mode', r.dataset.mode); } catch { /* not saved */ }
}
$('theme').value = document.documentElement.dataset.theme;
$('theme').onchange = () => theme($('theme').value);
$('mode').onclick = () => theme(null, document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark');
async function loadSessions() {
  const list = (await fleetChat.sessions()) || [], host = $('sessions'); host.replaceChildren();
  if (!list.length) { h('div', 'kv', 'none yet', host).style.color = 'var(--faint)'; return; }
  for (const s of list.slice(0, 15)) {
    const b = h('button', 'sess', String(s.title).slice(0, 60), host); b.type = 'button'; h('small', null, new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), b);
    b.onclick = async () => { const r = await fleetChat.resume(s.id); log.replaceChildren(); streamed = new Set(); tools = {}; live = {}; todoCard = null; turn = null; for (const m of (r && r.messages) || []) onMessage(m, true); h('div', 'note', 'Resumed. Your next message continues this chat.', log); stick = true; bottom(); };
  }
}
function meta(d) {
  cmds = d.commands; const c = $('cmds'); c.replaceChildren();
  for (const x of cmds.slice(0, 60)) { const e = h('div', 'cmd', '/' + x.name, c); e.title = x.description; e.onclick = () => { box.value = '/' + x.name + ' '; box.focus(); }; }
  const m = $('mcp'); m.replaceChildren(); if (!d.mcp.length) h('div', 'kv', 'none configured', m).style.color = 'var(--faint)';
  for (const s of d.mcp) { const k = h('div', 'kv', null, m); h('span', 'dot' + (s.status === 'connected' ? '' : ' off'), null, k); k.append(s.name); k.title = s.status; }
}
function followDashboard(d) {
  const r = document.documentElement; r.dataset.theme = d.style; r.dataset.mode = d.mode;
  for (const [k, v] of Object.entries(d.tokens || {})) r.style.setProperty('--' + k, v);
  const rc = parseFloat((d.tokens || {})['r-control']); r.style.setProperty('--rk', Number.isFinite(rc) ? String(Math.min(1.6, rc / 6)) : '1');
  r.style.setProperty('--rpill', Number.isFinite(rc) && rc < 3 ? rc + 'px' : '999px');
  if ($('theme')) $('theme').value = d.style;
}
fleetChat.on((kind, d) => {
  if (kind === 'theme') followDashboard(d);
  else if (kind === 'message') onMessage(d); else if (kind === 'permission') permission(d); else if (kind === 'meta') meta(d);
  else if (kind === 'state') paintState(d); else if (kind === 'idle') setBusy(false);
  else if (kind === 'error') { setBusy(false); h('div', 'msg-err', String(d), log); bottom(); }
});
fleetChat.state().then((s) => { paintState(s); empty(); chips(); loadSessions(); box.focus(); });

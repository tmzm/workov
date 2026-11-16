// Workeve Chat page. Renders Claude's turn as a timeline, the way the VS Code extension shows it: streamed text, thinking rows,
// one collapsible row per tool call (diffs for edits, output for commands), a live plan, and Allow/Deny cards.
'use strict';
const $ = (id) => document.getElementById(id);
if ($('brandText')) $('brandText').textContent = window.APP_NAME + ' Chat';
document.title = window.APP_NAME + ' Chat';
const log = $('log'), box = $('box'), scroller = $('scroll');
const ICON = { Read: 'file', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'term', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'search' };
let files = [], cmds = [], busy = false, stick = true, turn = null, live = {}, tools = {}, streamed = new Set(), todoCard = null, menuIdx = 0, thinkCount = 0;

function svg(name, cls) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; }
function h(tag, cls, text, parent) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; }
const base = (p) => (p && p.name ? p.name : String(p || '').split(/[\\/]/).pop());
const json = (o) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } };
const typing = h('div', 'typing'); const dots = h('span', 'dots', null, typing); for (let i = 0; i < 3; i++) h('i', null, null, dots);
const typingText = h('span', null, 'Working', typing), typingTime = h('span', null, '', typing); let typingTimer = 0, typingSince = 0;
function placeTyping() { if (typing.parentNode !== log || log.lastChild !== typing) log.append(typing); }
function working(text) { typingText.textContent = text; }
function bottom() { if (busy) placeTyping(); if (stick) scroller.scrollTop = scroller.scrollHeight; }
scroller.addEventListener('scroll', () => { stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; $('jump').classList.toggle('show', !stick); });
$('jump').onclick = () => { stick = true; bottom(); };
function clearEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }
function empty() {
  log.replaceChildren(); const e = h('div', 'empty', null, log); h('h2', null, 'What should we work on?', e); h('div', null, 'Claude can read and change files, run commands, and use your skills and MCP servers.', e);
  const s = h('div', 'sug', null, e);
  for (const t of ['What changed in this repo today?', 'Explain how the router decides what to dispatch', 'Review my uncommitted changes']) { const b = h('button', null, t, s); b.onclick = () => { box.value = t; box.focus(); }; }
}
box.addEventListener('input', () => { if (busy) $('goIcon').firstChild.setAttribute('href', box.value.trim() ? '#i-send' : '#i-stop'); });
function setBusy(b) {
  busy = b; $('work').classList.toggle('show', b); typing.classList.toggle('show', b); clearInterval(typingTimer);
  if (b) { typingSince = Date.now(); working('Working'); typingTime.textContent = ''; placeTyping(); typingTimer = setInterval(() => { const s = Math.round((Date.now() - typingSince) / 1000); typingTime.textContent = s >= 5 ? s + 's' : ''; }, 1000); bottom(); } else typing.remove(); $('goIcon').firstChild.setAttribute('href', b ? '#i-stop' : '#i-send'); $('go').setAttribute('aria-label', b ? 'Stop' : 'Send');
}

// ---------- the timeline ----------
function userBlock(text, attached, uuid) {
  clearEmpty(); const u = h('div', 'user', null, log); const who = h('div', 'who', null, u); h('span', 'avatar', 'T', who); who.append('You');
  const acts = h('div', 'acts2', null, who); const cp = h('button', 'mini', 'Copy', acts); cp.type = 'button'; cp.onclick = () => navigator.clipboard.writeText(text || '');
  if (uuid) { const rw = h('button', 'mini', 'Rewind files', acts); rw.type = 'button'; rw.title = 'Restore the files to how they were before this message'; rw.onclick = () => rewind(uuid, rw); }
  if (text) h('div', null, text, u).style.whiteSpace = 'pre-wrap';
  if (attached && attached.length) { const f = h('div', 'files', null, u); for (const p of attached) { const c = h('span', 'file', null, f); c.append(svg('file'), base(p)); } }
  turn = null; bottom();
}
function turnBody() {
  if (turn) return turn; clearEmpty();
  const a = h('div', 'asst', null, log), b = h('span', 'badge', null, a); b.append(svg('spark'));
  turn = h('div', 'body', null, a); return turn;
}
function copyable(d, getText) { const w = d.parentNode; if (d.parentNode.classList.contains('md-wrap')) return; const wrap = document.createElement('div'); wrap.className = 'md-wrap'; w.replaceChild(wrap, d); wrap.append(d); const b = h('button', 'mini', 'Copy', wrap); b.type = 'button'; b.onclick = () => { navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); }; }
function textBlock(text) { const d = h('div', 'md', null, turnBody()); window.renderMarkdown(text, d); copyable(d, () => text); return d; }
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
  h('span', 'verb', verb, sm); const tg = h('span', 'target', target, sm);
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) { tg.classList.add('link'); tg.title = 'Show in folder'; tg.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fleetChat.openPath(tg.textContent); }; }
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
    loadSessions(); paintContext();
  }
}
function onStream(ev) {
  if (ev.type === 'message_start') { live = {}; streamed.add(ev.message.id); }
  else if (ev.type === 'content_block_start') {
    const cb = ev.content_block;
    working(cb.type === 'thinking' ? 'Thinking' : cb.type === 'tool_use' ? 'Running ' + cb.name.replace(/^mcp__/, '').replace(/__/g, ' › ') : 'Writing');
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
    if (l.type === 'text') { window.renderMarkdown(l.text, l.el); copyable(l.el, () => l.text); }
    else if (l.type === 'thinking') l.t.btn.lastChild.textContent = 'Thought for ' + Math.max(1, Math.round((Date.now() - l.t.started) / 1000)) + ' seconds';
    else if (l.type === 'tool') { try { toolInput(l.id, JSON.parse(l.json || '{}')); } catch { /* the final message carries the input */ } if (tools[l.id] && tools[l.id].name === 'TodoWrite') { try { todoUpdate(l.id, JSON.parse(l.json)); } catch { /* same */ } } }
    bottom();
  }
}

async function rewind(uuid, btn) {
  const d = await fleetChat.rewind({ uuid, dry: true });
  if (!d || !d.canRewind) { h('div', 'note', 'Cannot rewind: ' + ((d && d.error) || 'no checkpoint for that message'), log); return; }
  const n = d.filesChanged ? d.filesChanged.length : 0;
  if (!confirm('Restore ' + n + ' file(s) to how they were before this message? Your chat stays as it is.')) return;
  const r = await fleetChat.rewind({ uuid, dry: false }); btn.textContent = r && r.canRewind ? 'Rewound' : 'Failed'; h('div', 'note', r && r.canRewind ? 'Files restored to before that message.' : 'Rewind failed: ' + ((r && r.error) || ''), log); bottom();
}

// ---------- permissions ----------
function permission(d) {
  clearEmpty(); const c = h('div', 'perm', null, log); c.setAttribute('role', 'alertdialog'); c.dataset.id = d.id;
  const hd = h('div', 'ph', null, c); hd.append(svg('shield'), d.title || (d.displayName + ' needs your permission'));
  if (d.reason) h('div', 'why', d.reason, c);
  const done = (label) => { c.classList.add('done'); h('div', 'res', label, c); };
  const respond = (allow, always, input) => { fleetChat.answer({ id: d.id, allow, always, input }); done(allow ? (always ? 'Allowed, and remembered' : 'Allowed') : 'Denied'); turn = null; };
  const acts = h('div', 'acts');
  if (d.toolName === 'AskUserQuestion') { questions(c, d, respond); return; }
  if (d.toolName === 'ExitPlanMode') { const p = h('div', 'md', null, c); p.style.padding = '8px 14px'; window.renderMarkdown(String((d.input && d.input.plan) || ''), p); }
  else if (['Edit', 'MultiEdit', 'Write'].includes(d.toolName)) { const df = h('div', 'detail diff', null, c); h('div', 'diffhead', (d.input && d.input.file_path) || '', df); if (d.toolName === 'Write') diffLines('', String(d.input.content || '').split('\n').slice(0, 80).join('\n'), df); else for (const e of d.toolName === 'Edit' ? [d.input] : d.input.edits || []) diffLines(e.old_string, e.new_string, df); }
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
const hist = []; let histAt = -1;
async function send() {
  const text = box.value.trim();
  if (busy && !text && !files.length) { fleetChat.interrupt(); return; }
  if (!text && !files.length) return;
  if (text && hist[0] !== text) hist.unshift(text); histAt = -1;
  closeMenu(); box.value = ''; grow(); const f = files; files = []; chips();
  if (text === '/clear') { await newChat(); return; }
  if (text === '/model') { openModels(); return; }
  if (text === '/mode') { openModes(); return; }
  if (text === '/usage' || text === '/context') { $('ctxChip').click(); return; }
  const wasBusy = busy; stick = true; setBusy(true);
  try { await fleetChat.say({ text, files: f }); } catch (e) { setBusy(wasBusy); h('div', 'msg-err', String((e && e.message) || e), log); bottom(); }
}
function resetView() { streamed = new Set(); tools = {}; live = {}; todoCard = null; turn = null; setBusy(false); empty(); }
async function newChat() { await fleetChat.newChat(); resetView(); loadSessions(); }
function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 200) + 'px'; }
function closeMenu() { $('menu').classList.remove('show'); }
function menuItems() { return [...$('menu').querySelectorAll('.it')]; }
function pick(it) { if (it.dataset.file) return pickFile(it); box.value = '/' + it.dataset.name + ' '; closeMenu(); box.focus(); grow(); }
function openMenu(q) {
  const all = [{ name: 'clear', description: 'Start a fresh chat', kind: 'Commands' }, { name: 'model', description: 'Pick the model', kind: 'Commands' }, { name: 'mode', description: 'Manual, Auto-edit, Auto, Plan or Allow all', kind: 'Commands' }, { name: 'usage', description: 'Context, cost and plan limits', kind: 'Commands' }, ...cmds.map((c) => ({ ...c, kind: c.name.includes(':') || c.description.length ? 'Skills' : 'Commands' }))];
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
let mentionReq = 0;
async function openMentions(q) {
  const req = ++mentionReq, list = (await fleetChat.files(q)) || []; if (req !== mentionReq) return;
  const m = $('menu'); m.replaceChildren(); if (!list.length) { closeMenu(); return; } menuIdx = 0; h('div', 'sec', 'Files', m);
  for (const f of list) { const it = h('div', 'it' + (m.querySelector('.it') ? '' : ' on'), null, m); it.dataset.file = f; it.setAttribute('role', 'option'); h('b', null, f.split('/').pop(), it); h('span', null, f, it); it.onmousedown = (e) => { e.preventDefault(); pickFile(it); }; }
  m.classList.add('show');
}
function pickFile(it) { const pos = box.selectionStart, before = box.value.slice(0, pos).replace(/@(\S*)$/, '@' + it.dataset.file + ' '); box.value = before + box.value.slice(pos); closeMenu(); box.focus(); box.selectionStart = box.selectionEnd = before.length; grow(); }
box.addEventListener('input', () => {
  grow(); const m = /^\/(\S*)$/.exec(box.value); if (m) { openMenu(m[1]); return; }
  const at = /@(\S*)$/.exec(box.value.slice(0, box.selectionStart)); if (at) openMentions(at[1]); else closeMenu();
});
box.addEventListener('keydown', (e) => {
  const open = $('menu').classList.contains('show'), items = menuItems();
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); items[menuIdx].classList.remove('on'); menuIdx = (menuIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[menuIdx].classList.add('on'); items[menuIdx].scrollIntoView({ block: 'nearest' }); return; }
  if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pick(items[menuIdx]); return; }
  if (e.key === 'Escape') { if (open) closeMenu(); else if (busy) fleetChat.interrupt(); return; }
  if (e.key === 'ArrowUp' && !box.value.includes('\n') && box.selectionStart === 0 && histAt + 1 < hist.length) { e.preventDefault(); box.value = hist[++histAt]; grow(); return; }
  if (e.key === 'ArrowDown' && histAt >= 0 && box.selectionStart === box.value.length) { e.preventDefault(); box.value = histAt > 0 ? hist[--histAt] : ((histAt = -1), ''); grow(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('go').onclick = send;
function readFile(f) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f); }); }
async function addFiles(list) { for (const f of list) { if (fleetChat.web) { if (f.size <= 8 * 1024 * 1024) files.push(await readFile(f)); } else { const p = fleetChat.pathOf(f); if (p) files.push(p); } } chips(); }
$('attach').onclick = async () => { if (fleetChat.web) { $('fileIn').click(); return; } files.push(...((await fleetChat.pickFiles()) || [])); chips(); };
$('fileIn').onchange = () => { addFiles($('fileIn').files); $('fileIn').value = ''; };
box.addEventListener('paste', (e) => { const fl = [...e.clipboardData.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()); if (fl.length) addFiles(fl); });
for (const ev of ['dragover', 'dragenter']) addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('drop'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('drop'); });
addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drop'); addFiles(e.dataTransfer.files); });

// ---------- header and sidebar ----------
const MODES = [
  ['default', 'Manual', 'Asks before every change and command'],
  ['acceptEdits', 'Auto-edit', 'Edits files without asking; still asks for commands'],
  ['auto', 'Auto', 'Claude decides what is safe to run on its own'],
  ['plan', 'Plan', 'Reads and plans only; changes nothing'],
  ['bypassPermissions', 'Allow all', 'Never asks. Use only in a folder you trust'],
];
const MODELS = [['', 'Default model', 'What your Claude plan picks'], ['sonnet', 'Sonnet', 'Fast and capable for most work'], ['opus', 'Opus', 'Strongest, slower, uses the plan faster'], ['haiku', 'Haiku', 'Fastest and lightest']];
let curMode = 'default', curModel = '';
function pop(anchor, build) {
  const p = $('pop'); if (p.classList.contains('show') && p.dataset.for === anchor.id) { closePop(); return; }
  p.replaceChildren(); p.dataset.for = anchor.id; build(p); const r = anchor.getBoundingClientRect();
  p.classList.add('show'); p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + 'px'; p.style.top = Math.max(8, r.top - p.offsetHeight - 8) + 'px';
  document.querySelectorAll('.chip2').forEach((c) => c.setAttribute('aria-expanded', String(c === anchor)));
}
function closePop() { $('pop').classList.remove('show'); delete $('pop').dataset.for; document.querySelectorAll('.chip2').forEach((c) => c.setAttribute('aria-expanded', 'false')); }
document.addEventListener('click', (e) => { if (!$('pop').contains(e.target) && !e.target.closest('.chip2')) closePop(); });
function choose(anchor, list, cur, apply) {
  pop(anchor, (p) => { for (const [id, name, desc] of list) { const it = h('div', 'it' + (id === cur ? ' cur' : ''), null, p); it.tabIndex = 0; h('b', null, name, it); h('span', null, desc, it); const go = () => { closePop(); apply(id); }; it.onclick = go; it.onkeydown = (ev) => { if (ev.key === 'Enter') go(); }; } });
}
// Switching mode or model while a turn is streaming is accepted by the SDK but only confirmed once that turn ends
// (its own 'state' broadcast arrives late), so the chip is painted right away instead of waiting for that echo.
const openModes = () => choose($('modeChip'), MODES, curMode, (m) => { curMode = m; const d = MODES.find((x) => x[0] === m) || MODES[0]; $('modeText').textContent = d[1]; $('modeChip').className = 'chip2 mode-' + m; fleetChat.setPermissionMode(m); });
const openModels = () => choose($('modelChip'), MODELS, curModel, (m) => { curModel = m; $('modelText').textContent = (MODELS.find((x) => x[0] === m) || MODELS[0])[1]; fleetChat.setModel(m); });
const THINK = [[null, 'Thinking: normal', 'Claude decides how much to think'], [0, 'Thinking: off', 'Fastest, no extended thinking'], [8000, 'Thinking: deeper', 'Up to 8k thinking tokens'], [31999, 'Thinking: maximum', 'Up to 32k thinking tokens, slower']];
let curThink = null;
$('thinkChip').onclick = () => choose($('thinkChip'), THINK.map(([v, n, d]) => [String(v), n, d]), String(curThink), (v) => { curThink = v === 'null' ? null : Number(v); $('thinkText').textContent = THINK.find((x) => String(x[0]) === v)[1]; fleetChat.thinking(curThink); });
$('modeChip').onclick = openModes; $('modelChip').onclick = openModels;
function paintState(s) {
  $('folderName').textContent = s.cwd; $('folder').title = s.cwd;
  curMode = s.permissionMode || 'default'; curModel = ['sonnet', 'opus', 'haiku'].find((x) => String(s.model || '').includes(x)) || '';
  const m = MODES.find((x) => x[0] === curMode) || MODES[0]; $('modeText').textContent = m[1]; $('modeChip').className = 'chip2 mode-' + curMode;
  $('modelText').textContent = (MODELS.find((x) => x[0] === curModel) || MODELS[0])[1];
}
async function paintContext() {
  const c = await fleetChat.context(); if (!c) return; $('ctxRing').style.setProperty('--p', c.pct); $('ctxRing').classList.toggle('hot', c.pct >= 85);
  $('ctxText').textContent = c.pct + '%'; $('ctxChip').title = 'Context: ' + c.used.toLocaleString() + ' of ' + c.max.toLocaleString() + ' tokens. Click for usage.';
}
$('ctxChip').onclick = async () => {
  const [c, u] = await Promise.all([fleetChat.context(), fleetChat.usage()]);
  pop($('ctxChip'), (p) => {
    h('div', 'sec', 'This chat', p);
    const row = (k, v) => { const r = h('div', 'row', null, p); r.append(k); h('b', null, v, r); };
    if (c) { row('Context used', c.used.toLocaleString() + ' / ' + c.max.toLocaleString() + ' (' + c.pct + '%)'); const b = h('div', 'bar', null, p); h('i', null, null, b).style.width = Math.min(100, c.pct) + '%'; }
    if (u && u.session) { row('Cost so far', '$' + (u.session.total_cost_usd || 0).toFixed(3)); row('Lines changed', '+' + (u.session.total_lines_added || 0) + ' / −' + (u.session.total_lines_removed || 0)); }
    if (u && u.rate_limits) { h('div', 'sec', 'Your Claude plan' + (u.subscription_type ? ' (' + u.subscription_type + ')' : ''), p); for (const [k, lab] of [['five_hour', '5-hour window'], ['seven_day', '7-day window']]) { const w = u.rate_limits[k]; if (w && w.utilization != null) { row(lab, Math.round(w.utilization) + '% used'); const b = h('div', 'bar', null, p); h('i', null, null, b).style.width = Math.min(100, w.utilization) + '%'; } } }
    if (!c && !u) h('div', 'row', 'Send a message first; usage appears once a chat is running.', p);
    const cp = h('div', 'it', null, p); h('b', null, 'Compact this chat', cp); h('span', null, 'Summarize it to free up context', cp); cp.onclick = () => { closePop(); box.value = '/compact'; send(); };
  });
};
box.addEventListener('keydown', (e) => { if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); const i = MODES.findIndex((x) => x[0] === curMode), m = MODES[(i + 1) % MODES.length]; curMode = m[0]; $('modeText').textContent = m[1]; $('modeChip').className = 'chip2 mode-' + m[0]; fleetChat.setPermissionMode(m[0]); } });
$('new').onclick = newChat;
$('dash').onclick = () => fleetChat.openDashboard();
$('folder').onclick = async (e) => {
  e.stopPropagation(); const m = $('folderMenu'); if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const f = await fleetChat.folders(), r = $('folder').getBoundingClientRect(); m.replaceChildren();
  m.style.top = r.bottom + 6 + 'px'; m.style.left = Math.max(8, r.left) + 'px';
  const row = (title, path, cur) => { const it = h('div', 'it' + (cur ? ' cur' : ''), null, m); it.setAttribute('role', 'menuitem'); it.tabIndex = 0; h('b', null, title, it); h('span', null, path, it); const go = async () => { m.classList.remove('show'); if (await fleetChat.setFolder(path)) newChat(); }; it.onclick = go; it.onkeydown = (ev) => { if (ev.key === 'Enter') go(); }; };
  if (!fleetChat.web) { const browse = h('div', 'it', null, m); h('b', null, 'Browse for a folder…', browse); browse.tabIndex = 0; browse.onclick = async () => { m.classList.remove('show'); if (await fleetChat.pickFolder()) newChat(); }; }
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
$('claudeChip').onclick = async () => { if (fleetChat.web) return; $('claudeText').textContent = 'Finish in your browser…'; await fleetChat.claudeLogin(); claudeChip(); };
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
    b.onclick = async () => { await fleetChat.resume(s.id); h('div', 'note', 'Resumed. Your next message continues this chat.', log); stick = true; bottom(); };
  }
}
function meta(d) {
  cmds = d.commands; const c = $('cmds'); c.replaceChildren();
  for (const x of cmds.slice(0, 60)) { const e = h('div', 'cmd', '/' + x.name, c); e.title = x.description; e.onclick = () => { box.value = '/' + x.name + ' '; box.focus(); }; }
  const m = $('mcp'); m.replaceChildren(); if (!d.mcp.length) h('div', 'kv', 'none configured', m).style.color = 'var(--faint)';
  for (const s of d.mcp) { const k = h('div', 'kv mcp-row', null, m); h('span', 'dot' + (s.status === 'connected' ? '' : ' off'), null, k); k.append(s.name); k.title = s.status + '. Click to turn ' + (s.status === 'disabled' ? 'on' : 'off'); k.onclick = () => fleetChat.mcpToggle({ name: s.name, on: s.status === 'disabled' }); }
}
function followDashboard(d) {
  const r = document.documentElement; r.classList.remove('pending'); r.dataset.theme = d.style; r.dataset.mode = d.mode;
  for (const [k, v] of Object.entries(d.tokens || {})) r.style.setProperty('--' + k, v);
  const rc = parseFloat((d.tokens || {})['r-control']); r.style.setProperty('--rk', Number.isFinite(rc) ? String(Math.min(1.6, rc / 6)) : '1');
  r.style.setProperty('--rpill', Number.isFinite(rc) && rc < 3 ? rc + 'px' : '999px');
  if ($('theme')) $('theme').value = d.style;
}
fleetChat.on((kind, d) => {
  if (kind === 'theme') followDashboard(d);
  else if (kind === 'user') { userBlock(d.text, d.files, d.uuid); setBusy(true); }
  else if (kind === 'reset') resetView();
  else if (kind === 'hist') onMessage(d, true);
  else if (kind === 'permissionDone') { const c = log.querySelector('.perm[data-id="' + d.id + '"]:not(.done)'); if (c) { c.classList.add('done'); h('div', 'res', 'Answered', c); } }
  else if (kind === 'message') onMessage(d); else if (kind === 'permission') permission(d); else if (kind === 'meta') meta(d);
  else if (kind === 'state') paintState(d); else if (kind === 'idle') setBusy(false);
  else if (kind === 'error') { setBusy(false); h('div', 'msg-err', String(d), log); bottom(); }
});
fleetChat.state().then((s) => { paintState(s); empty(); chips(); loadSessions(); box.focus(); });

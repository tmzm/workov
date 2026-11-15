// Workeve: Windows launcher (stage 1).
// - starts with Windows (tray), keeps the dashboard + router loop + tunnel running through the fleet's own
//   start-dashboard.sh (it is idempotent: it reuses a healthy server), restarts them if they die
// - shows the dashboard in its own window (it is the same page as on the phone, loaded from this computer)
// - tray: open, status, pause all, restart router, start with Windows, quit; notifications for provider problems
// The window loads only 127.0.0.1; the dashboard token is read by this process and never given to the page.
'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage, dialog, ipcMain, WebContentsView } = require('electron');
const { createEngine } = require('./chat-engine');
const setup = require('./setup');
const { createBridge } = require('./chat-bridge');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SELFTEST = process.argv.includes('--selftest');
const START_HIDDEN = process.argv.includes('--hidden');
// EJAD_TEST_DIR gives tests their own data, config and instance lock, so they never touch an installed copy
if (process.env.EJAD_TEST_DIR) app.setPath('userData', path.join(process.env.EJAD_TEST_DIR, 'userData'));
const CFG_FILE = path.join(process.env.EJAD_TEST_DIR || app.getPath('appData'), 'Workeve', 'config.json');
const DEFAULTS = { fleet: 'E:\\Projects\\Ejad\\dashboard-fleet', autostart: true };

// the app used to be called Ejad Fleet: keep its settings
const OLD_CFG = path.join(path.dirname(path.dirname(CFG_FILE)), 'EjadFleet', 'config.json');
if (!fs.existsSync(CFG_FILE) && fs.existsSync(OLD_CFG)) { try { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.copyFileSync(OLD_CFG, CFG_FILE); } catch { /* starts fresh */ } }
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { /* first run */ }
const saveCfg = () => { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); };

let win = null, tray = null, quitting = false, lastStart = 0, lastNotified = '', status = { text: 'starting…', ok: false };

// ---------- the fleet folder ----------
function fleetJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(cfg.fleet, rel), 'utf8')); } catch { return null; } }
function port() { const c = fleetJson('specs/worker-fleet.config.json'); return (c && c.dashboard && Number(c.dashboard.port)) || 3080; }
function token() { const a = fleetJson('job/dashboard-auth.json'); return a && a.authToken || ''; }
function gitBash() { return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || null; }

function prerequisites() {
  const has = (exe) => spawnSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true }).status === 0;
  return [
    ['Fleet folder', fs.existsSync(path.join(cfg.fleet, 'specs', 'worker-fleet.config.json')), 'Pick the fleet folder (tray menu)'],
    ['Git Bash', !!gitBash(), 'Install Git for Windows'],
    ['Python', has('python.exe') || has('python3.exe'), 'Install Python 3'],
    ['Node', has('node.exe'), 'Install Node.js'],
    ['OpenCode', has('opencode.cmd') || has('opencode.exe') || has('opencode'), 'Install OpenCode (pnpm add -g opencode)'],
    ['Claude Code', has('claude.exe') || has('claude'), 'Install Claude Code (needed for chat, planner, designer)'],
    ['cloudflared', has('cloudflared.exe'), 'Install cloudflared (only for the phone link)'],
  ].map(([name, ok, hint]) => ({ name, ok, hint }));
}

// ---------- talking to the dashboard ----------
function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (method === 'POST') { headers.authorization = 'Bearer ' + token(); headers.origin = `http://127.0.0.1:${port()}`; if (data) headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers, timeout: 5000 }, (res) => {
      let raw = ''; res.on('data', (d) => (raw += d)); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (p) => request('GET', p);
const act = (action, extra) => request('POST', '/api/action', { action, ...(extra || {}) });

function startServices() {
  if (Date.now() - lastStart < 45000) return; // never hammer: start-dashboard.sh needs a moment
  const bash = gitBash();
  if (!bash || !fs.existsSync(path.join(cfg.fleet, '.claude', 'scripts', 'start-dashboard.sh'))) return;
  lastStart = Date.now();
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  const log = fs.openSync(path.join(path.dirname(CFG_FILE), 'launcher.log'), 'a');
  spawn(bash, ['.claude/scripts/start-dashboard.sh'], { cwd: cfg.fleet, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
}

// ---------- status, tray, notifications ----------
function toast(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.png') }); n.on('click', onClick || open); n.show();
}
function notify(key, title, body) {
  if (key === lastNotified) return;
  lastNotified = key; toast(title, body);
}
let wasWorking = null, lastPending = '';
async function watchTickets(o) {
  const now = new Set((o && o.working) || []);
  if (wasWorking) for (const id of wasWorking) if (!now.has(id)) toast('Ticket ' + id + ' stopped building', 'Open the board to see whether it finished or needs you.');
  wasWorking = now;
  const f = await get('/api/ejad/failover'), p = f.json && f.json.pending;
  const key = p ? JSON.stringify(p).slice(0, 80) : '';
  if (key && key !== lastPending) toast('Model switch waiting for you', 'The failover watchdog suggests a change. Open Providers to apply or dismiss it.');
  lastPending = key;
}
async function poll() {
  const r = await get('/api/ejad/router');
  if (r.status !== 200 || !r.json) { status = { text: 'dashboard not running: starting it…', ok: false }; startServices(); updateTray(); return false; }
  const o = await get('/api/ejad/overview');
  const working = (o.json && o.json.working) || [];
  const issue = o.json && o.json.issue;
  watchTickets(o.json).catch(() => {});
  status = { text: `router ${r.json.state}${working.length ? ` · building ${working.join(', ')}` : ''}`, ok: true, state: r.json.state, issue };
  if (issue) notify('issue:' + issue.message.slice(0, 40), 'Provider problem', issue.message.slice(0, 160));
  else if (r.json.state === 'stuck') notify('stuck', 'Router looks stuck', 'Open the dashboard to restart it (the watchdog restarts it after 12 minutes).');
  else lastNotified = '';
  updateTray();
  return true;
}
function open() { if (!win) createWindow(); win.show(); win.focus(); }
function menu() {
  return Menu.buildFromTemplate([
    { label: 'Open Workeve', click: open },
    { label: 'Open chat in its own window', click: openChat },
    { label: status.text, enabled: false },
    { type: 'separator' },
    { label: 'Pause all', click: () => act('ejad_pause_all') },
    { label: 'Start fleet', click: () => act('ejad_fleet_start') },
    { label: 'Restart router (fresh session)', click: () => act('ejad_router_restart') },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!cfg.autostart, click: (i) => { cfg.autostart = i.checked; saveCfg(); applyLoginItem(); } },
    { label: 'Choose fleet folder…', click: chooseFleet },
    { label: 'Chat from the phone link', type: 'checkbox', checked: cfg.remoteChat !== false, click: (i) => { cfg.remoteChat = i.checked; saveCfg(); } },
    { label: 'Setup & checks…', click: openSetup },
    { type: 'separator' },
    { label: 'Quit (leaves the fleet running)', click: () => { quitting = true; app.quit(); } },
  ]);
}
function updateTray() { if (!tray) return; tray.setToolTip('Workeve: ' + status.text); tray.setContextMenu(menu()); }
function applyLoginItem() { if (process.env.EJAD_NO_AUTOSTART) return; if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, args: ['--hidden'] }); }
async function chooseFleet(parent) {
  const r = await dialog.showOpenDialog(parent || undefined, { title: 'Choose the fleet folder (it contains specs/worker-fleet.config.json)', properties: ['openDirectory'], defaultPath: cfg.fleet });
  if (!r.canceled && r.filePaths[0]) { cfg.fleet = r.filePaths[0]; saveCfg(); lastStart = 0; poll(); }
}
function showPrereq() {
  const p = prerequisites();
  dialog.showMessageBox({ type: p.every((x) => x.ok) ? 'info' : 'warning', title: 'Prerequisites', message: p.map((x) => `${x.ok ? '✔' : '✘'}  ${x.name}${x.ok ? '' : ' — ' + x.hint}`).join('\n') });
}

// ---------- the chat (local only: the page talks to this process over IPC, never over the network) ----------
// One engine, shown in two places: a view laid over the dashboard's Chat tab, and an optional window of its own.
let chatWin = null, chatView = null, chatViewShown = false, engine = null, lastTheme = null, bridge = null;
const CHAT_PREFS = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true });
function lockChat(wc) {
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e) => e.preventDefault());
}
function chatContents() { return [chatWin, chatView].filter((x) => x && !(x.isDestroyed && x.isDestroyed())).map((x) => x.webContents).filter((w) => !w.isDestroyed()); }
function ensureChatView() {
  if (chatView) return chatView;
  chatView = new WebContentsView({ webPreferences: CHAT_PREFS() });
  const bg = (lastTheme && lastTheme.tokens.bg) || '#0f0e0b'; chatView.setBackgroundColor(bg); // no white flash before the page paints
  const query = { embedded: '1' }; if (lastTheme) { query.theme = lastTheme.style; query.mode = lastTheme.mode; if (/^#[0-9a-f]{3,8}$/i.test(bg)) query.bg = bg; }
  lockChat(chatView.webContents); chatView.webContents.loadFile(path.join(__dirname, 'chat.html'), { query });
  chatView.webContents.on('did-finish-load', () => { if (lastTheme) chatView.webContents.send('chat:event', 'theme', lastTheme); });
  return chatView;
}
function hideChatView() { if (chatView && chatViewShown && win) { try { win.contentView.removeChildView(chatView); } catch { /* already off */ } } chatViewShown = false; }
function fromDashboard(e) { return !!win && e.sender === win.webContents && e.senderFrame && e.senderFrame.url.startsWith(`http://127.0.0.1:${port()}/`); }
function openChat() {
  if (chatWin) { chatWin.show(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 1100, height: 820, minWidth: 420, minHeight: 500, backgroundColor: '#0f0e0b', title: 'Workeve Chat', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'), webPreferences: CHAT_PREFS(),
  });
  lockChat(chatWin.webContents);
  chatWin.on('closed', () => { chatWin = null; });
  chatWin.loadFile(path.join(__dirname, 'chat.html'));
}
// inside the installed app the bundled Claude binary sits next to app.asar, not inside it
function bundledClaude() { try { const p = require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe').replace('app.asar', 'app.asar.unpacked'); return fs.existsSync(p) ? p : ''; } catch { return ''; } }
function rememberFolder(p) { cfg.chatCwd = p; cfg.chatRecent = [p, ...(cfg.chatRecent || []).filter((x) => x !== p)].slice(0, 8); saveCfg(); }
function setupChat() {
  const push = (kind, data) => {
    for (const w of chatContents()) w.send('chat:event', kind, data);
    if (bridge) bridge.publish(kind, data);
    const seen = (chatWin && chatWin.isVisible() && chatWin.isFocused()) || (chatViewShown && win && win.isVisible() && win.isFocused());
    if (kind === 'permission' && !seen) toast('Claude is waiting for your permission', String(data.title || data.displayName || data.toolName).slice(0, 120), () => { if (chatViewShown || !chatWin) open(); else openChat(); });
    if (kind === 'message' && data.type === 'result' && !seen) toast('Claude finished', data.is_error ? 'The turn ended with an error.' : String(data.result || 'Done').slice(0, 120), open);
  };
  engine = createEngine({ send: push, cwd: cfg.chatCwd || path.dirname(cfg.fleet), claudePath: bundledClaude() });
  const own = (e) => chatContents().some((w) => w === e.sender); // only our own chat pages may call these
  const h = (name, fn) => ipcMain.handle('chat:' + name, (e, a) => (own(e) ? fn(a, e) : null));
  // the engine calls. The page in this app reaches them over IPC; the phone reaches the allowed ones through the bridge.
  const calls = {
    say: (a) => engine.say({ text: String((a && a.text) || ''), files: Array.isArray(a && a.files) ? a.files.filter((f) => typeof f === 'string') : [] }),
    answer: (a) => { engine.answer(a.id, !!a.allow, !!a.always, a.input); push('permissionDone', { id: a.id }); },
    interrupt: () => engine.interrupt(),
    setModel: (m) => engine.setModel(String(m || '')),
    setPermissionMode: (m) => engine.setPermissionMode(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'].includes(m) ? m : 'default'),
    state: () => engine.state(),
    newChat: () => { engine.reset(); push('reset', {}); push('state', engine.state()); },
    sessions: () => engine.sessions().catch(() => []),
    resume: async (id) => { const r = await engine.resume(String(id)); push('reset', {}); for (const m of (r && r.messages) || []) push('hist', m); push('state', engine.state()); return {}; },
    claude: () => setup.claudeStatus(),
    folders: () => {
      const fleet = cfg.fleet, parent = path.dirname(fleet), stem = path.basename(fleet) + '-', wt = [];
      try { for (const d of fs.readdirSync(parent, { withFileTypes: true })) if (d.isDirectory() && d.name.startsWith(stem)) wt.push(path.join(parent, d.name)); } catch { /* none */ }
      return { current: engine.state().cwd, fleet, worktrees: wt, recent: (cfg.chatRecent || []).filter((p) => fs.existsSync(p)) };
    },
    setFolder: async (p) => { p = String(p || ''); if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return null; rememberFolder(p); await engine.setCwd(p); push('reset', {}); return p; },
    context: () => engine.context(),
    usage: () => engine.usage(),
    rewind: (a) => engine.rewind(String(a.uuid), !!a.dry),
    thinking: (n) => engine.setThinking(n === null ? null : Math.max(0, Math.min(63999, Number(n) || 0))),
    mcpToggle: (a) => engine.toggleMcp(String(a.name), !!a.on),
    files: (q) => engine.files(q),
  };
  for (const k of Object.keys(calls)) h(k, (a) => calls[k](a));
  bridge = createBridge({ calls, enabled: () => cfg.remoteChat !== false, assetDir: __dirname, fleetDir: () => cfg.fleet });
  bridge.start();
  h('openDashboard', () => { hideChatView(); open(); });
  h('openPath', (p) => { p = String(p || ''); const full = path.isAbsolute(p) ? p : path.join(engine.state().cwd, p); if (fs.existsSync(full)) shell.showItemInFolder(full); });
  h('claudeLogin', () => setup.claudeLogin());
  h('pickFolder', async (_a, e) => { const parent = BrowserWindow.fromWebContents(e.sender) || win; const r = await dialog.showOpenDialog(parent, { title: 'Folder Claude should work in', properties: ['openDirectory'], defaultPath: engine.state().cwd }); if (r.canceled || !r.filePaths[0]) return null; rememberFolder(r.filePaths[0]); await engine.setCwd(r.filePaths[0]); return r.filePaths[0]; });
  h('pickFiles', async (_a, e) => { const parent = BrowserWindow.fromWebContents(e.sender) || win; const r = await dialog.showOpenDialog(parent, { title: 'Attach files or images', properties: ['openFile', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
  ipcMain.handle('shell:chatShow', (e, r) => {
    if (!fromDashboard(e) || !r) return;
    const v = ensureChatView(), b = { x: Math.round(+r.x || 0), y: Math.round(+r.y || 0), width: Math.max(50, Math.round(+r.width || 0)), height: Math.max(50, Math.round(+r.height || 0)) };
    if (!chatViewShown) { win.contentView.addChildView(v); chatViewShown = true; v.webContents.focus(); }
    v.setBounds(b);
  });
  ipcMain.handle('shell:chatTheme', (e, s) => {
    if (!fromDashboard(e) || !s || typeof s !== 'object') return;
    const tokens = {}; // only plain design values are passed on
    for (const [k, v] of Object.entries(s.tokens || {})) if (/^[a-z0-9-]{1,30}$/.test(k) && typeof v === 'string' && v.length < 400 && !/[<>;{}]/.test(v)) tokens[k] = v;
    lastTheme = { style: ['andon', 'cyberpunk', 'tmzm'].includes(s.style) ? s.style : 'andon', mode: s.mode === 'light' ? 'light' : 'dark', tokens };
    if (chatView && !chatView.webContents.isDestroyed()) { chatView.webContents.send('chat:event', 'theme', lastTheme); if (/^#[0-9a-f]{3,8}$/i.test(tokens.bg || '')) chatView.setBackgroundColor(tokens.bg); }
  });
  ipcMain.handle('shell:chatHide', (e) => { if (fromDashboard(e)) hideChatView(); });
}

// ---------- start screen: checks, onboarding and launch all happen in the main window ----------
function openSetup() { if (!win) createWindow(); win.loadFile(path.join(__dirname, 'start.html'), { query: { force: '1' } }); open(); }
function setupIpc() {
  const ok = (e) => win && e.sender === win.webContents && e.senderFrame && /\/start\.html/.test(e.senderFrame.url);
  ipcMain.handle('setup:checks', (e) => (ok(e) ? setup.checks(cfg) : null));
  ipcMain.handle('setup:claudeLogin', (e) => (ok(e) ? setup.claudeLogin() : null));
  ipcMain.handle('setup:pickFleet', async (e) => { if (!ok(e)) return; await chooseFleet(win); });
  ipcMain.handle('setup:open', (e, url) => { if (ok(e) && /^https:\/\//.test(String(url))) shell.openExternal(String(url)); });
  ipcMain.handle('setup:testNotification', (e) => { if (ok(e)) toast('Notifications work', 'You will hear about finished tickets, provider problems and permission requests.'); });
  ipcMain.handle('setup:launch', async (e) => {
    if (!ok(e)) return { ok: false };
    lastStart = 0; startServices();
    for (let n = 0; n < 60; n++) { if (await poll()) { if (win) win.loadURL(`http://127.0.0.1:${port()}/`); return { ok: true }; } if (n % 10 === 9) { lastStart = 0; startServices(); } await new Promise((r) => setTimeout(r, 1500)); }
    return { ok: false };
  });
}

// ---------- the window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 420, minHeight: 600, backgroundColor: '#0f0e0b', title: 'Workeve', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'shell-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const local = `http://127.0.0.1:${port()}/`;
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(local) && !url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; chatViewShown = false; });
  win.loadFile(path.join(__dirname, 'start.html'));
  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });
}

if (!SELFTEST && !app.requestSingleInstanceLock()) app.quit();
app.on('before-quit', () => { if (bridge) bridge.stop(); });
app.on('second-instance', open);
app.on('window-all-closed', () => { /* stays in the tray */ });

app.whenReady().then(async () => {
  if (SELFTEST) {
    const pre = prerequisites(); startServices();
    let r = null; for (let i = 0; i < 12 && !(r && r.status === 200); i++) { await new Promise((x) => setTimeout(x, 2500)); r = await get('/api/ejad/router'); }
    const ok = !!(r && r.status === 200);
    const out = JSON.stringify({ selftest: true, fleet: cfg.fleet, port: port(), prerequisites: pre.map((p) => `${p.ok ? 'ok ' : 'MISSING '}${p.name}`), dashboard: ok ? 'reachable' : 'NOT reachable', router: ok ? r.json.state : null, tokenFound: !!token() }, null, 1);
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(path.join(path.dirname(CFG_FILE), 'selftest.json'), out); console.log(out);
    app.exit(ok ? 0 : 1); return;
  }
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', open); tray.on('double-click', open);
  app.setAppUserModelId('app.workeve');
  setupChat(); setupIpc(); applyLoginItem(); updateTray(); createWindow();
  if (START_HIDDEN) { const first = setup.checks(cfg); if (!first.ready) toast('Workeve needs setup', first.claude.loggedIn ? 'A required tool is missing. Open Workeve to finish.' : 'Sign in to Claude to use the chat and planner.', open); }
  if (process.argv.includes('--chat')) openChat();
  setInterval(poll, 15000);
});

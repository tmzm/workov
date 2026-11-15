// Chat bridge: lets the dashboard server (and through it the full-access phone link) use this app's chat.
// It listens on 127.0.0.1 only, on a random port, and answers only requests that carry a secret kept in
// <fleet>/job/chat-bridge.json (the dashboard server reads it; nothing else needs it). The dashboard server already checks
// who is asking (full access only, never the read-only link). Here: a narrow list of calls, no folder dialogs, no
// "Allow all" mode, and one switch (tray: "Chat from the phone link") that turns the whole thing off.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const REMOTE_CALLS = new Set(['say', 'answer', 'interrupt', 'setModel', 'setPermissionMode', 'state', 'newChat', 'sessions', 'resume', 'claude', 'folders', 'setFolder', 'context', 'usage', 'rewind', 'thinking', 'mcpToggle', 'files']);
const ASSETS = { 'chat.html': 'text/html; charset=utf-8', 'chat.css': 'text/css; charset=utf-8', 'chat.js': 'text/javascript; charset=utf-8', 'chat-md.js': 'text/javascript; charset=utf-8', 'chat-boot.js': 'text/javascript; charset=utf-8', 'chat-web.js': 'text/javascript; charset=utf-8' };
const MAX_BODY = 40 * 1024 * 1024;

function createBridge({ calls, enabled, assetDir, fleetDir }) {
  const secret = crypto.randomBytes(24).toString('hex');
  const clients = new Set(), buffer = [], pending = new Map(), last = {};
  let server = null, bridgeFile = '';

  // everything the engine says goes here too: remembered for late joiners and sent to every open phone page
  function publish(kind, data) {
    if (kind === 'message' && data && data.type === 'stream_event') { fan(kind, data); return; }
    if (kind === 'state' || kind === 'meta') last[kind] = data;
    else if (kind === 'reset') { buffer.length = 0; pending.clear(); }
    else if (kind === 'permission') pending.set(data.id, data);
    else if (kind === 'permissionDone') pending.delete(data.id);
    else { buffer.push([kind, data]); if (buffer.length > 3000) buffer.shift(); }
    fan(kind, data);
  }
  function fan(kind, data) { const line = 'data: ' + JSON.stringify([kind, data]) + '\n\n'; for (const r of clients) { try { r.write(line); } catch { clients.delete(r); } } }

  // files from the phone arrive as {name,type,data}: they are written to a temp folder and handed on as paths
  function normalizeFiles(files) {
    const dir = path.join(os.tmpdir(), 'workeve-chat-uploads'); fs.mkdirSync(dir, { recursive: true });
    return (Array.isArray(files) ? files : []).slice(0, 8).map((f) => {
      if (typeof f === 'string') return null; // a path from the phone means nothing on this computer
      if (!f || typeof f.data !== 'string') return null;
      const p = path.join(dir, crypto.randomUUID().slice(0, 8) + '-' + String(f.name || 'file').replace(/[^\w.\-]/g, '_').slice(-60));
      fs.writeFileSync(p, Buffer.from(f.data, 'base64')); return p;
    }).filter(Boolean);
  }

  async function run(call, args) {
    if (!enabled()) throw Object.assign(new Error('Chat from the phone link is switched off in the Workeve app (tray menu).'), { status: 403 });
    if (!REMOTE_CALLS.has(call) || !calls[call]) throw Object.assign(new Error('That chat action is not available from the phone.'), { status: 400 });
    if (call === 'say') args = { text: String((args && args.text) || '').slice(0, 100000), files: normalizeFiles(args && args.files) };
    if (call === 'setPermissionMode' && args === 'bypassPermissions') throw Object.assign(new Error('"Allow all" can only be switched on at the computer.'), { status: 403 });
    if (call === 'setFolder') { const f = await calls.folders(); if (![f.fleet, ...f.worktrees, ...f.recent].includes(String(args))) throw Object.assign(new Error('Pick one of the listed folders.'), { status: 400 }); }
    return calls[call](args);
  }

  function handler(req, res) {
    if (req.headers['x-bridge-secret'] !== secret) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ available: true, enabled: enabled() })); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/asset/')) {
      const name = url.pathname.slice(7); if (!ASSETS[name]) { res.writeHead(404); res.end(); return; }
      try { res.writeHead(200, { 'content-type': ASSETS[name], 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(assetDir, name))); } catch { res.writeHead(500); res.end(); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!enabled()) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n'); clients.add(res);
      const send = (k, d) => res.write('data: ' + JSON.stringify([k, d]) + '\n\n');
      send('reset', {}); if (last.state) send('state', last.state); if (last.meta) send('meta', last.meta);
      for (const [k, d] of buffer) send(k, d); for (const p of pending.values()) send('permission', p);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      let size = 0; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else parts.push(c); });
      req.on('end', async () => {
        try { const b = JSON.parse(Buffer.concat(parts).toString('utf8')); const result = await run(String(b.call), b.args); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result })); }
        catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String((e && e.message) || e) })); }
      });
      return;
    }
    res.writeHead(404); res.end();
  }

  return {
    publish,
    start() {
      return new Promise((resolve) => {
        server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
          try { bridgeFile = path.join(fleetDir(), 'job', 'chat-bridge.json'); fs.mkdirSync(path.dirname(bridgeFile), { recursive: true }); fs.writeFileSync(bridgeFile, JSON.stringify({ port: server.address().port, secret, pid: process.pid })); } catch { /* no fleet folder yet */ }
          resolve();
        });
      });
    },
    stop() { try { if (bridgeFile) fs.unlinkSync(bridgeFile); } catch { /* already gone */ } try { server.close(); } catch { /* not started */ } },
  };
}
module.exports = { createBridge };

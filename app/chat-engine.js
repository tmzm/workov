// Ejad Fleet chat engine (main process). One live Claude session per chat window, on the Claude plan (the CLI's own login).
// It loads the user's settings, skills, slash commands, MCP servers and plugins the way Claude Code does, asks for every
// tool call through Allow/Deny cards, and talks to the page only over local IPC (nothing here is reachable from the tunnel).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let sdkPromise = null;
const sdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function createEngine({ send, cwd, claudePath }) {
  let q = null, inbox = null, running = false, pending = new Map(), seq = 0, abort = null;
  let state = { cwd, model: '', permissionMode: 'default', sessionId: '' };

  function queue() {
    const items = [], waiters = [];
    return {
      push(m) { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m); },
      close() { while (waiters.length) waiters.shift()({ value: undefined, done: true }); items.push(null); },
      [Symbol.asyncIterator]() { return { next: () => (items.length ? Promise.resolve(items[0] === null ? { done: true } : { value: items.shift(), done: false }) : new Promise((r) => waiters.push(r))) }; },
    };
  }

  function content(text, files) {
    const blocks = [];
    const notes = [];
    for (const f of files || []) {
      const ext = path.extname(f).toLowerCase();
      if (IMAGE_TYPES[ext]) {
        try { blocks.push({ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: fs.readFileSync(f).toString('base64') } }); continue; } catch { /* falls through to a path note */ }
      }
      notes.push('@' + f);
    }
    blocks.push({ type: 'text', text: (notes.length ? notes.join(' ') + '\n' : '') + text });
    return blocks;
  }

  async function canUseTool(toolName, input, opts) {
    const id = 'p' + ++seq;
    send('permission', { id, toolName, input, title: opts.title || '', displayName: opts.displayName || toolName, reason: opts.decisionReason || '', blockedPath: opts.blockedPath || '' });
    return new Promise((resolve) => {
      pending.set(id, { resolve, suggestions: opts.suggestions, input });
      opts.signal.addEventListener('abort', () => { pending.delete(id); resolve({ behavior: 'deny', message: 'Cancelled' }); }, { once: true });
    });
  }

  function answer(id, allow, always, input) {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    p.resolve(allow ? { behavior: 'allow', updatedInput: input || p.input, ...(always && p.suggestions ? { updatedPermissions: p.suggestions } : {}) } : { behavior: 'deny', message: 'The user denied this.' });
  }

  async function pump(stream) {
    try {
      for await (const m of stream) {
        if (m.type === 'system' && m.subtype === 'init') { state.sessionId = m.session_id || state.sessionId; state.model = m.model || state.model; send('state', { ...state, tools: (m.tools || []).length }); refreshMeta(); }
        send('message', m);
      }
    } catch (e) { send('error', String((e && e.message) || e)); }
    running = false; q = null; send('idle', {});
  }

  async function refreshMeta() {
    try {
      const [commands, mcp] = await Promise.all([q.supportedCommands(), q.mcpServerStatus().catch(() => [])]);
      send('meta', { commands: commands.map((c) => ({ name: c.name, description: c.description })), mcp: mcp.map((s) => ({ name: s.name, status: s.status })) });
    } catch { /* the meta panel stays as it was */ }
  }

  async function start(resume) {
    const { query } = await sdk();
    inbox = queue(); abort = new AbortController(); running = true;
    const options = {
      cwd: state.cwd, abortController: abort, canUseTool, includePartialMessages: true,
      permissionMode: state.permissionMode, settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(state.model ? { model: state.model } : {}), ...(resume ? { resume } : {}), ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    };
    q = query({ prompt: inbox, options });
    pump(q);
  }

  return {
    state: () => ({ ...state, running }),
    async say({ text, files }) {
      if (!running) await start(state.sessionId || undefined);
      inbox.push({ type: 'user', message: { role: 'user', content: content(text, files) }, parent_tool_use_id: null });
    },
    answer,
    interrupt() { if (q) q.interrupt().catch(() => {}); },
    async setModel(model) { state.model = model; if (q) await q.setModel(model || undefined); send('state', { ...state }); },
    async setPermissionMode(mode) { state.permissionMode = mode; if (q) await q.setPermissionMode(mode); send('state', { ...state }); },
    async setCwd(dir) { this.reset(); state.cwd = dir; state.sessionId = ''; send('state', { ...state }); },
    reset() { try { if (abort) abort.abort(); if (inbox) inbox.close(); } catch { /* already closed */ } pending.forEach((p) => p.resolve({ behavior: 'deny', message: 'Cancelled' })); pending.clear(); q = null; running = false; state.sessionId = ''; },
    async sessions() { const s = await sdk(); return (await s.listSessions({ dir: state.cwd, limit: 20 })).map((x) => ({ id: x.sessionId, title: x.summary || x.firstPrompt || x.sessionId, at: x.lastModified })); },
    async resume(id) {
      this.reset(); state.sessionId = id; send('state', { ...state });
      try { const s = await sdk(); return { messages: await s.getSessionMessages(id, { dir: state.cwd }) }; } catch { return { messages: [] }; }
    },
    async compact() { return this.say({ text: '/compact' }); },
  };
}

module.exports = { createEngine };

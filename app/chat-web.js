// The chat page's connection when it is opened from the dashboard in a browser (the phone link) instead of inside the
// desktop app. It speaks to the dashboard server: calls go through the audited action API, events come from an
// EventSource. Same page, same look: it only replaces the `fleetChat` that the desktop app's preload provides.
'use strict';
(function () {
  const parent = window.parent !== window ? window.parent : null;
  const headers = () => (parent && parent.getAuthHeaders ? parent.getAuthHeaders() : { 'Content-Type': 'application/json' });
  async function call(name, args) {
    const r = await fetch('/api/action', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'chat_call', call: name, args: args === undefined ? null : args }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j.result;
  }
  const api = { web: true };
  for (const c of ['say', 'answer', 'interrupt', 'setModel', 'setPermissionMode', 'state', 'newChat', 'sessions', 'resume', 'claude', 'folders', 'setFolder', 'context', 'usage', 'rewind', 'thinking', 'mcpToggle', 'files']) api[c] = (a) => call(c, a);
  for (const c of ['pickFolder', 'pickFiles', 'openPath', 'openDashboard', 'claudeLogin']) api[c] = async () => null; // these need the computer itself
  api.pathOf = () => '';
  api.on = (cb) => {
    const es = new EventSource('/api/chat/events');
    es.onmessage = (e) => { try { const [k, d] = JSON.parse(e.data); cb(k, d); } catch { /* ignore a broken frame */ } };
    es.onerror = () => cb('conn', { ok: false });
    es.onopen = () => cb('conn', { ok: true });
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'wv-theme') cb('theme', e.data.data); });
  };
  window.fleetChat = api;
})();

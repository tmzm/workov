// Ejad: the Chat tab in a browser (the phone link). Inside the desktop app the tab shows the app's own chat view; in a
// browser it shows the same chat page in a frame, served by the dashboard server (apply after ejad-chat-bridge.cjs).
// The tab appears only when the server says the chat is reachable: full access, another device, app running.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="ejad-chat-web-js"')) {
  const JS = `<script id="ejad-chat-web-js">
(function () {
  if (window.fleetShell) return; // the desktop app has its own chat view
  var btn = document.getElementById('tab-chat-btn'), host = document.getElementById('chat-host'), frame = null, on = false;
  if (!btn || !host) return;
  var TOKENS = ['bg', 'surface-1', 'surface-2', 'surface-3', 'line', 'line-strong', 'text', 'text-2', 'text-3', 'lamp-run', 'lamp-attn', 'lamp-stop', 'lamp-info', 'readout-bg', 'btn-primary-bg', 'btn-primary-text', 'text-on-lamp', 'focus', 'shadow-float', 'font-ui', 'font-mono', 'font-display', 'r-control', 'r-panel', 'cp-text-glow'];
  function snapshot() {
    var root = document.documentElement, cs = getComputedStyle(root), v = {}, t = root.getAttribute('data-theme') || '';
    TOKENS.forEach(function (k) { var x = cs.getPropertyValue('--' + k).trim(); if (x) v[k] = x; });
    var style = t === 'cyberpunk' || t === 'tmzm' ? t : 'andon';
    var mode = root.getAttribute('data-mode') || (t === 'light' ? 'light' : t === 'dark' ? 'dark' : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    v.accent = style === 'andon' ? (v['lamp-info'] || '#6cb1ff') : (v['btn-primary-bg'] || '#c9a14a');
    v['accent-text'] = style === 'andon' ? (v['text-on-lamp'] || '#0b1624') : (v['btn-primary-text'] || '#0f0e0b');
    return { style: style, mode: mode, tokens: v };
  }
  function theme() { if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'ejad-theme', data: snapshot() }, location.origin); }
  function fit() {
    if (!frame) return; var nav = document.getElementById('views'), bottom = nav && getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
    frame.style.height = Math.max(300, window.innerHeight - host.getBoundingClientRect().top - bottom) + 'px';
  }
  function ensure() {
    if (frame) return; var note = document.getElementById('chat-note'); if (note) note.hidden = true;
    var q = new URLSearchParams({ web: '1', embedded: '1' }); var s = snapshot(); q.set('theme', s.style); q.set('mode', s.mode); if (/^#[0-9a-f]{3,8}$/i.test(s.tokens.bg || '')) q.set('bg', s.tokens.bg);
    frame = document.createElement('iframe'); frame.src = '/chat/chat.html?' + q.toString(); frame.title = 'Chat'; frame.style.cssText = 'border:0;width:100%;display:block;background:var(--bg)';
    frame.addEventListener('load', function () { theme(); }); host.appendChild(frame); fit();
  }
  fetch('/api/chat/status', { headers: getAuthHeaders() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s || !s.available) return; btn.hidden = false; if (on) ensure();
  }).catch(function () { /* no chat from here */ });
  var prev = window.ejadNavSync;
  window.ejadNavSync = function (tab) { if (prev) prev(tab); on = tab === 'chat'; if (on && !btn.hidden) { ensure(); fit(); theme(); } };
  new MutationObserver(function () { setTimeout(theme, 30); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class', 'style'] });
  window.addEventListener('resize', fit);
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('chat web tab patch applied');

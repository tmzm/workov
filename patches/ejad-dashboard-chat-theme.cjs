// Ejad: the Chat tab follows the dashboard's own theme (apply after ejad-dashboard-nav-chat.cjs).
// The dashboard reads its live design tokens (the colours, fonts and corner radii of whatever theme and mode is on now,
// Andon, Cyberpunk or Tmzm, dark or light) and hands them to the desktop app, which passes them to the chat view.
// The chat therefore never keeps a theme of its own while it is inside the dashboard.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="ejad-chat-theme-js"')) {
  const JS = `<script id="ejad-chat-theme-js">
(function () {
  var shell = window.fleetShell; if (!shell || !shell.chatTheme) return;
  var root = document.documentElement;
  var TOKENS = ['bg', 'surface-1', 'surface-2', 'surface-3', 'line', 'line-strong', 'text', 'text-2', 'text-3', 'lamp-run', 'lamp-attn', 'lamp-stop', 'lamp-info', 'readout-bg', 'btn-primary-bg', 'btn-primary-text', 'text-on-lamp', 'focus', 'shadow-float', 'font-ui', 'font-mono', 'font-display', 'r-control', 'r-panel', 'cp-text-glow'];
  function snapshot() {
    var cs = getComputedStyle(root), v = {}, t = root.getAttribute('data-theme') || '';
    TOKENS.forEach(function (k) { var x = cs.getPropertyValue('--' + k).trim(); if (x) v[k] = x; });
    var style = t === 'cyberpunk' || t === 'tmzm' ? t : 'andon';
    var mode = root.getAttribute('data-mode') || (t === 'light' ? 'light' : t === 'dark' ? 'dark' : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    // the accent: the theme's brand colour (gold, magenta); Andon's primary button is plain, so its info blue leads there
    v.accent = style === 'andon' ? (v['lamp-info'] || '#6cb1ff') : (v['btn-primary-bg'] || '#c9a14a');
    v['accent-text'] = style === 'andon' ? (v['text-on-lamp'] || '#0b1624') : (v['btn-primary-text'] || '#0f0e0b');
    return { style: style, mode: mode, tokens: v };
  }
  var last = '';
  function push() { var s = snapshot(), k = JSON.stringify(s); if (k !== last) { last = k; shell.chatTheme(s); } }
  window.ejadPushChatTheme = function () { last = ''; push(); };
  new MutationObserver(function () { setTimeout(push, 30); }).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class', 'style'] });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { setTimeout(push, 30); });
  var prev = window.ejadNavSync; window.ejadNavSync = function (tab) { if (prev) prev(tab); if (tab === 'chat') window.ejadPushChatTheme(); };
  push();
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('chat theme patch applied');

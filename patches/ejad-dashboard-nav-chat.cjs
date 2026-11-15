// Ejad: a calmer navbar and a Chat tab (apply last among the dashboard patches).
//  - Board, Chat, Providers and Telemetry stay on the bar; Ring, Graph, Ports and Audit move under "More"
//    (a dropdown on the desktop bar, a sheet above the bottom bar on a phone). Their buttons keep data-tab, so every
//    existing route, hash and script keeps working.
//  - Chat is a tab that only exists inside the Ejad Fleet desktop app (window.fleetShell, given by its preload). The app
//    lays its local chat view over the tab's host area. A browser, a phone or the tunnel never gets the tab or the chat.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const fail = (m) => { throw new Error('anchor missing: ' + m); };

if (!h.includes('id="views-more"')) {
  // 1. regroup the buttons
  const nav = /(<nav id="views"[^>]*>)([\s\S]*?)(<\/nav>)/.exec(h) || fail('nav#views');
  const btn = (tab) => { const m = new RegExp('<button[^>]*data-tab="' + tab + '"[\\s\\S]*?</button>').exec(nav[2]); if (!m) fail('tab button ' + tab); return m[0]; };
  const icon = (n, label) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg><span class="lbl">${label}</span>`;
  const chat = `<button type="button" class="tab-btn" data-tab="chat" id="tab-chat-btn" hidden>${icon('chat', 'Chat')}</button>`;
  const more = `<button type="button" class="tab-btn" data-tab="more" id="more-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="views-more">${icon('more', 'More')}</button>`;
  const menu = `<div id="views-more" class="views-more" role="menu" aria-label="More views" hidden>${['ring', 'graph', 'ports', 'audit'].map(btn).join('\n')}</div>`;
  const order = [btn('kanban'), chat, btn('providers'), btn('telemetry'), more, menu].join('\n          ');
  h = h.replace(nav[0], () => nav[1] + '\n          ' + order + '\n        ' + nav[3]);

  // 2. icons
  const sym = '<symbol id="i-chat" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/></symbol>\n  <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></symbol>\n  ';
  if (!/<symbol id="i-audit"/.test(h)) fail('i-audit symbol');
  h = h.replace(/<symbol id="i-audit"/, () => sym + '<symbol id="i-audit"');

  // 3. routes
  h = h.replace(/(const VIEW_HASH = \{)/, '$1\n        chat: \'chat\',').replace(/(const HASH_VIEW = \{)/, '$1\n        chat: \'chat\',');
  if (!h.includes("chat: 'chat'")) fail('VIEW_HASH');

  // 4. the Chat section (its host area is where the desktop app places the chat view)
  const sec = `<section id="tab-chat" class="tab-content" aria-labelledby="h-chat"><h1 id="h-chat" class="sr-only">Chat</h1>
<div id="chat-host" class="chat-host"><p class="note-s chat-note" id="chat-note">Chat runs inside the Ejad Fleet desktop app. It is not available from a browser or the phone link.</p></div></section>
`;
  if (!/<section id="tab-ports"/.test(h)) fail('tab-ports');
  h = h.replace(/<section id="tab-ports"/, () => sec + '<section id="tab-ports"');

  // 5. switchMainTab: "More" opens its menu; every switch syncs the bar and the chat view
  const sw = /function switchMainTab\(tabId, btnEl, opts\) \{/.exec(h) || fail('switchMainTab');
  h = h.replace(sw[0], () => sw[0] + "\n        if (tabId === 'more') { if (window.ejadToggleMore) window.ejadToggleMore(); return; }");
  const tail = /(if \(tabId === 'providers' && window\.ejadProvidersShown\) window\.ejadProvidersShown\(\);)/.exec(h) || fail('providers hook');
  h = h.replace(tail[1], () => tail[1] + "\n        if (window.ejadNavSync) window.ejadNavSync(tabId);");

  // 6. styles
  const CSS = `<style id="ejad-nav-css">
.tab-btn[hidden] { display: none !important; }
.views { grid-auto-flow: column; grid-auto-columns: 1fr; grid-template-columns: none; }
.views-more { position: fixed; z-index: 60; min-width: 200px; padding: 6px; display: flex; flex-direction: column; gap: 2px; background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: var(--r-panel, 8px); box-shadow: var(--shadow-float, 0 12px 32px -8px rgb(0 0 0 / .5)); }
.views-more[hidden] { display: none; }
.views-more .tab-btn { flex-direction: row; justify-content: flex-start; gap: 12px; width: 100%; margin: 0; min-height: 44px; padding: 0 12px; border-radius: var(--r-control, 6px); font-size: var(--fs-small); color: var(--text-2); }
.views-more .tab-btn::after { display: none !important; }
.views-more .tab-btn:hover { background: var(--surface-2); color: var(--text); }
.views-more .tab-btn.active { background: var(--surface-2); color: var(--text); box-shadow: inset 3px 0 0 var(--btn-primary-bg, currentColor); }
#more-btn[aria-expanded="true"] { color: var(--text); }
.chat-host { position: relative; min-height: calc(100vh - 150px); }
.chat-note { padding: var(--s5); }
@media (max-width: 767px) { .chat-host { min-height: calc(100vh - 130px); } }
</style>
`;
  h = h.replace('</head>', () => CSS + '</head>');

  // 7. behaviour
  const JS = `<script id="ejad-nav-js">
(function () {
  var shell = window.fleetShell, nav = document.getElementById('views'), more = document.getElementById('more-btn'), menu = document.getElementById('views-more');
  if (!nav || !more || !menu) return;
  if (shell) { var cb = document.getElementById('tab-chat-btn'); if (cb) cb.hidden = false; var note = document.getElementById('chat-note'); if (note) note.hidden = true; }
  function place() {
    var r = more.getBoundingClientRect(), bottomBar = getComputedStyle(nav).position === 'fixed', w = menu.offsetWidth || 200;
    if (bottomBar) { menu.style.top = 'auto'; menu.style.bottom = (window.innerHeight - r.top + 8) + 'px'; menu.style.right = '8px'; menu.style.left = 'auto'; }
    else { menu.style.bottom = 'auto'; menu.style.top = (r.bottom + 6) + 'px'; menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px'; menu.style.right = 'auto'; }
  }
  function close() { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
  window.ejadToggleMore = function () { if (!menu.hidden) { close(); return; } menu.hidden = false; more.setAttribute('aria-expanded', 'true'); place(); var a = menu.querySelector('.tab-btn.active') || menu.querySelector('.tab-btn'); if (a) a.focus(); };
  document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target) && !more.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { close(); more.focus(); } });
  window.addEventListener('resize', function () { if (!menu.hidden) place(); chatPlace(); });

  var obs = null, onChat = false;
  function chatPlace() {
    if (!shell || !onChat) return;
    var host = document.getElementById('chat-host'); if (!host) return;
    var r = host.getBoundingClientRect(); shell.chatShow({ x: r.left, y: r.top, width: r.width, height: Math.max(200, window.innerHeight - r.top) });
  }
  window.ejadNavSync = function (tab) {
    close();
    var inMore = !!menu.querySelector('.tab-btn[data-tab="' + tab + '"]');
    more.classList.toggle('active', inMore); if (inMore) more.setAttribute('aria-current', 'page'); else more.removeAttribute('aria-current');
    if (!shell) return;
    onChat = tab === 'chat';
    if (onChat) { requestAnimationFrame(function () { chatPlace(); setTimeout(chatPlace, 120); }); if (!obs && window.ResizeObserver) { obs = new ResizeObserver(chatPlace); obs.observe(document.getElementById('chat-host')); } }
    else shell.chatHide();
  };
  // a dashboard dialog or panel opening over the chat must not sit under it
  if (shell && window.MutationObserver) new MutationObserver(function () {
    if (!onChat) return; var open = Array.prototype.some.call(document.querySelectorAll('#system-panel, dialog[open], [role="dialog"]'), function (d) { return !d.hidden && d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden'; });
    if (open) shell.chatHide(); else chatPlace();
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('nav + chat tab patch applied');

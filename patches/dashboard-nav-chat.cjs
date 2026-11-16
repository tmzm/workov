// Workerov: a calmer navbar and a Chat tab (apply last among the dashboard patches).
//  - Board, Chat, Providers and Telemetry stay on the bar; Ring, Graph, Ports and Audit move under "More"
//    (a dropdown on the desktop bar, a sheet above the bottom bar on a phone). Their buttons keep data-tab, so every
//    existing route, hash and script keeps working.
//  - Chat is a tab that only exists inside the Workeve desktop app (window.fleetShell, given by its preload). The app
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
<div id="chat-host" class="chat-host"><p class="note-s chat-note" id="chat-note">Chat runs inside the Workeve desktop app. It is not available from a browser or the phone link.</p></div></section>
`;
  if (!/<section id="tab-ports"/.test(h)) fail('tab-ports');
  h = h.replace(/<section id="tab-ports"/, () => sec + '<section id="tab-ports"');

  // 5. switchMainTab: "More" opens its menu; every switch syncs the bar and the chat view
  const sw = /function switchMainTab\(tabId, btnEl, opts\) \{/.exec(h) || fail('switchMainTab');
  h = h.replace(sw[0], () => sw[0] + "\n        if (tabId === 'more') { if (window.wvToggleMore) window.wvToggleMore(); return; }");
  const tail = /(if \(tabId === 'providers' && window\.wvProvidersShown\) window\.wvProvidersShown\(\);)/.exec(h) || fail('providers hook');
  h = h.replace(tail[1], () => tail[1] + "\n        if (window.wvNavSync) window.wvNavSync(tabId);");

  // 6. styles
  const CSS = `<style id="wv-nav-css">
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
  const JS = `<script id="wv-nav-js">
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
  window.wvToggleMore = function () { if (!menu.hidden) { close(); return; } menu.hidden = false; more.setAttribute('aria-expanded', 'true'); place(); var a = menu.querySelector('.tab-btn.active') || menu.querySelector('.tab-btn'); if (a) a.focus(); };
  document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target) && !more.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { close(); more.focus(); } });
  window.addEventListener('resize', function () { if (!menu.hidden) place(); chatPlace(); });

  var obs = null, onChat = false;
  // A native chat view always draws above regular page content, so a dropdown/drawer/dialog can never cover it with
  // CSS alone. Instead of just hiding the whole chat whenever anything opens, find the topmost visible overlay and
  // shrink the chat's width to stop before it (every overlay here slides in from the right), so the chat stays
  // visible in whatever width remains. Only truly full-width overlays (nothing left to show the chat in) hide it.
  function topOverlay() {
    var els = document.querySelectorAll('#system-panel, .drawer-panel, #views-more, #lightbox, dialog[open], [role="dialog"], [role="menu"]'), best = null;
    for (var i = 0; i < els.length; i++) {
      var d = els[i]; if (d.hidden || getComputedStyle(d).visibility === 'hidden') continue;
      var r = d.getBoundingClientRect(); if (!r.width || !r.height) continue;
      if (!best || r.left < best.left) best = r;
    }
    return best;
  }
  var snapOn = false;
  function snapClear() { var s = document.getElementById('chat-snap'); if (s) s.remove(); }
  function chatPlace() {
    if (!shell || !onChat) return;
    var host = document.getElementById('chat-host'); if (!host) return;
    var r = host.getBoundingClientRect(), over = topOverlay();
    var covered = !!(over && over.left < r.right && over.right > r.left && over.top < r.bottom && over.bottom > r.top);
    if (covered) {
      if (snapOn) return;
      snapOn = true;
      // the native chat view always draws above the page, so while an overlay is open the chat is shown as a still image
      shell.chatSnapshot().then(function (url) {
        if (!snapOn) return;
        if (url) { snapClear(); var im = new Image(); im.id = 'chat-snap'; im.alt = ''; im.src = url; im.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none'; host.style.position = 'relative'; host.appendChild(im); }
        shell.chatHide();
      });
      return;
    }
    if (snapOn) { snapOn = false; snapClear(); }
    shell.chatShow({ x: r.left, y: r.top, width: r.width, height: Math.max(200, window.innerHeight - r.top) });
  }
  window.wvNavSync = function (tab) {
    close();
    var inMore = !!menu.querySelector('.tab-btn[data-tab="' + tab + '"]');
    more.classList.toggle('active', inMore); if (inMore) more.setAttribute('aria-current', 'page'); else more.removeAttribute('aria-current');
    if (!shell) return;
    onChat = tab === 'chat';
    if (onChat) { requestAnimationFrame(function () { chatPlace(); setTimeout(chatPlace, 120); }); if (!obs && window.ResizeObserver) { obs = new ResizeObserver(chatPlace); obs.observe(document.getElementById('chat-host')); } }
    else { snapOn = false; snapClear(); shell.chatHide(); }
  };
  document.addEventListener('transitionend', function () { if (onChat) chatPlace(); }, true);
  // a dashboard dialog, drawer or dropdown opening over the chat must never sit under it
  if (shell && window.MutationObserver) new MutationObserver(function () {
    if (onChat) { chatPlace(); [120, 350, 700].forEach(function (ms) { setTimeout(chatPlace, ms); }); }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('nav + chat tab patch applied');

// The chat is drawn as a still image while a dashboard popup is open (see chatPlace), and that image is a data: URL.
{
  const S = '.claude/scripts/dashboard-server.py';
  const s = fs.readFileSync(S, 'utf8');
  if (s.includes("img-src 'self'; connect-src 'self'")) fs.writeFileSync(S, s.replace("img-src 'self'; connect-src 'self'", "img-src 'self' data:; connect-src 'self'"));
  // the fleet's own selftest pins the policy text, so it learns the same wording
  const T = '.claude/scripts/selftest.py';
  if (fs.existsSync(T)) {
    const t = fs.readFileSync(T, 'utf8');
    const a = "img-src 'self'; connect-src", b = "img-src 'self' data:; connect-src";
    if (t.includes(a)) fs.writeFileSync(T, t.replace(a, b));
  }
}

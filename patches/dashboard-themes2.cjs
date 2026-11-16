// Workerov: Auto / Dark / Light for every style, a light Cyberpunk, and portfolio-style motion for Tmzm (apply after dashboard-theme.cjs).
//  - Mode (Auto = follow the system, Dark, Light) is now independent of the style. It is stored in mc.mode and applied as
//    data-mode="dark|light" on <html> before first paint. Andon keeps its own data-theme dark/light as before.
//  - Cyberpunk gets a light palette (neon accents on a pale lavender ground, all text at 4.5:1 or better); Tmzm's dark and
//    light palettes now follow the Mode (before, light was only the system setting).
//  - Tmzm motion, taken from the portfolio's feel: expo-out easing (cubic-bezier(0.16, 1, 0.3, 1)), rises of 700 to 800 ms with a
//    60 ms stagger, the gold { } brackets sliding in, the active tab's underline growing from the centre, running lamps
//    breathing, cards lifting on hover, sections of the long Board page revealing as they scroll in. Entrances play when a tab
//    is opened (class tm-enter for 2.5 s), never on the 3-second data refresh, and all of it stops under reduced motion.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="wv-themes2-css"')) {
  // 1. pre-paint: data-mode before the first frame
  const pre = /var t = localStorage\.getItem\('mc\.theme'\);/;
  if (!pre.test(h)) throw new Error("anchor missing: pre-paint script (var t = localStorage.getItem('mc.theme'))");
  h = h.replace(pre, () => "var mm = localStorage.getItem('mc.mode') || 'auto'; document.documentElement.setAttribute('data-mode', mm === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : (mm === 'light' ? 'light' : 'dark'));\n          var t = localStorage.getItem('mc.theme');");

  const E = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const items = '.station, .kanban-column, .attention-row, .pvp-card, .worker-card, .callout, .readouts';
  let stagger = '';
  for (let i = 2; i <= 10; i++) stagger += `:root[data-theme="tmzm"] .tm-enter :is(${items}):nth-child(${i}) { animation-delay: ${(i - 1) * 60}ms; }\n`;
  const CSS = `<style id="wv-themes2-css">
/* ---- Tmzm: both palettes follow the Mode (these beat the older system-setting media query by specificity) ---- */
:root[data-theme="tmzm"][data-mode="dark"] {
  color-scheme: dark;
  --bg: #0f0e0b; --surface-1: #1a1813; --surface-2: #25221b; --surface-3: #2e2a22;
  --line: #3a352b; --line-strong: #6b6456;
  --text: #ece9e2; --text-2: #cfcac0; --text-3: #a29c90; --text-on-lamp: #0f0e0b;
  --lamp-run: #6fcf7f; --lamp-attn: #e8a33d; --lamp-stop: #f0a08f; --lamp-info: #c9a14a; --lamp-ready: #ece9e2; --lamp-off: #7d7668;
  --readout-bg: #14120e; --readout-text-muted: #a29c90;
  --btn-primary-bg: #c9a14a; --btn-primary-text: #0f0e0b; --focus: #d2ab57; --scrim: rgb(8 7 5 / 0.7); --purple: #c8b6e8;
  --shadow-float: 0 12px 32px -8px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(201 161 74 / 0.18);
}
:root[data-theme="tmzm"][data-mode="light"] {
  color-scheme: light;
  --bg: #f4f3ef; --surface-1: #fbfaf7; --surface-2: #efece4; --surface-3: #e6e1d4;
  --line: #dcd6c8; --line-strong: #8f8672;
  --text: #16140f; --text-2: #3b372e; --text-3: #625c50; --text-on-lamp: #fbfaf7;
  --lamp-run: #2f8a44; --lamp-attn: #8f5f0c; --lamp-stop: #b3412c; --lamp-info: #7d5f1c; --lamp-ready: #3b372e; --lamp-off: #8a8372;
  --readout-bg: #fbfaf7; --readout-text-muted: #625c50;
  --btn-primary-bg: #c9a14a; --btn-primary-text: #0f0e0b; --focus: #7d5f1c; --scrim: rgb(22 20 15 / 0.45); --purple: #6b46c1;
  --shadow-float: 0 12px 32px -10px rgb(22 20 15 / 0.28), 0 2px 6px rgb(22 20 15 / 0.12);
}
/* ---- Cyberpunk light: neon accents on pale lavender ---- */
:root[data-theme="cyberpunk"][data-mode="light"] {
  color-scheme: light;
  --bg: #eef0fb; --surface-1: #ffffff; --surface-2: #f4f5fe; --surface-3: #e6e9fa;
  --line: #cfd3ee; --line-strong: #6a76a8;
  --text: #151a33; --text-2: #2d3560; --text-3: #4b5486; --text-on-lamp: #ffffff;
  --lamp-run: #0a8a4a; --lamp-attn: #9a5a00; --lamp-stop: #c4153f; --lamp-info: #006e8a; --lamp-ready: #2d3560; --lamp-off: #7580a8;
  --readout-bg: #f7f8ff; --readout-text-muted: #4b5486;
  --btn-primary-bg: #c4009f; --btn-primary-text: #ffffff; --focus: #5a2bd9; --scrim: rgb(20 24 54 / 0.45); --purple: #6b2bd9;
  --shadow-float: 0 16px 40px -14px rgb(21 26 51 / 0.35), 0 0 0 1px rgb(196 0 159 / 0.22);
  --cp-magenta: #c4009f;
  --cp-scanline: repeating-linear-gradient(to bottom, rgb(106 118 168 / 0.07) 0 1px, transparent 1px 4px);
  --cp-focus-glow: 0 0 0 3px rgb(90 43 217 / 0.35);
  --cp-marker-glow: 0 0 6px rgb(196 0 159 / 0.45);
  --cp-text-glow: none;
}
/* ---- Tmzm motion (the portfolio's feel) ---- */
:root[data-theme="tmzm"] { --tm-ease: ${E}; }
@keyframes tm-rise { from { opacity: 0; transform: translateY(22px); } }
@keyframes tm-drop { from { opacity: 0; transform: translateY(-14px); } }
@keyframes tm-bracket-l { from { opacity: 0; transform: translateX(-16px); } }
@keyframes tm-bracket-r { from { opacity: 0; transform: translateX(16px); } }
@keyframes tm-grow { from { transform: scaleX(0); } }
@keyframes tm-breathe { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--lamp-run) 50%, transparent); } 55% { box-shadow: 0 0 0 7px transparent; } }
@media (prefers-reduced-motion: no-preference) {
  :root[data-theme="tmzm"] .tm-enter :is(${items}) { animation: tm-rise 800ms var(--tm-ease) backwards; }
${stagger}  :root[data-theme="tmzm"] .tm-enter h2.sec { animation: tm-rise 700ms var(--tm-ease) backwards; }
  :root[data-theme="tmzm"] .tm-enter h2.sec::before { animation: tm-bracket-l 800ms var(--tm-ease) 140ms backwards; }
  :root[data-theme="tmzm"] .tm-enter h2.sec::after { animation: tm-bracket-r 800ms var(--tm-ease) 140ms backwards; }
  :root[data-theme="tmzm"].tm-boot .tier1 { animation: tm-drop 800ms var(--tm-ease) backwards; }
  :root[data-theme="tmzm"] .tab-btn.active::after { transform-origin: center; animation: tm-grow 600ms var(--tm-ease) backwards; }
  :root[data-theme="tmzm"] .lamp.run.lit { animation: tm-breathe 2.8s ease-in-out infinite; }
  :root[data-theme="tmzm"] :is(.ticket-card, .pvp-card, .worker-card, .attention-row) { transition: transform 450ms var(--tm-ease), border-color 300ms var(--tm-ease), box-shadow 450ms var(--tm-ease); }
  :root[data-theme="tmzm"] :is(.ticket-card, .pvp-card, .worker-card, .attention-row):hover { transform: translateY(-3px); border-color: var(--btn-primary-bg); box-shadow: 0 14px 28px -16px color-mix(in srgb, var(--btn-primary-bg) 55%, transparent); }
  :root[data-theme="tmzm"] .btn.primary:hover, :root[data-theme="tmzm"] .btn-primary:hover { box-shadow: 0 0 0 1px var(--btn-primary-bg), 0 10px 24px -12px var(--btn-primary-bg); }
}
/* sections of the long Board page reveal as they scroll in (scroll-driven, no JS) */
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    :root[data-theme="tmzm"] #tab-kanban .wv-panel { animation: tm-rise linear both; animation-timeline: view(); animation-range: entry 0% entry 40%; }
  }
}
</style>
`;
  if (!h.includes('</head>')) throw new Error('anchor missing: </head>');
  h = h.replace('</head>', () => CSS + '</head>');

  const JS = `<script id="wv-themes2-js">
(function () {
  var NAMES = { cyberpunk: 'Cyberpunk', tmzm: 'Tmzm' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function store(k, v) { try { if (v == null) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }
  function styled() { var t = document.documentElement.getAttribute('data-theme'); return t === 'cyberpunk' || t === 'tmzm'; }
  function mode() { var m = store('mc.mode'); return m === 'dark' || m === 'light' ? m : 'auto'; }
  function effective(m) { return m === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : m; }
  function sync() {
    var m = mode(), root = document.documentElement;
    root.setAttribute('data-mode', effective(m));
    var lbl = document.getElementById('theme-mode-label'); if (lbl) lbl.textContent = 'Mode';
    if (styled()) {
      document.querySelectorAll('[data-theme-option]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-theme-option') === m ? 'true' : 'false'); });
      var now = document.getElementById('theme-now'); var t = root.getAttribute('data-theme');
      if (now) now.textContent = NAMES[t] + ' \\u00B7 ' + (m === 'auto' ? 'Auto' : m === 'dark' ? 'Dark' : 'Light');
    }
  }
  function setMode(m) { store('mc.mode', m); sync(); }
  var orig = window.applyTheme;
  if (typeof orig === 'function') window.applyTheme = function (m, persist) {
    // a mode click (Auto/Dark/Light) while a styled theme is active changes the mode, not the style
    if (persist && (m === 'auto' || m === 'dark' || m === 'light') && styled()) { setMode(m); return; }
    orig(m, persist); sync();
  };
  if (mq) (mq.addEventListener ? mq.addEventListener('change', sync) : mq.addListener(sync));
  // entrance motion plays when a tab opens, never on the 3 s data refresh
  function enter(id, ms) {
    var el = document.getElementById('tab-' + id); if (!el) return;
    el.classList.remove('tm-enter'); void el.offsetWidth; el.classList.add('tm-enter');
    setTimeout(function () { el.classList.remove('tm-enter'); }, ms || 2500);
  }
  var origSwitch = window.switchMainTab;
  if (typeof origSwitch === 'function') window.switchMainTab = function (id) { var r = origSwitch.apply(this, arguments); enter(id, id === 'providers' ? 4000 : 2500); return r; };
  document.documentElement.classList.add('tm-boot');
  setTimeout(function () { document.documentElement.classList.remove('tm-boot'); }, 1500);
  var active = document.querySelector('.tab-content.active'); if (active) enter(active.id.replace(/^tab-/, ''), 3500);
  sync();
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('themes2 patch applied');

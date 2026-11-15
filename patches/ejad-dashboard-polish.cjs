// Ejad: dashboard-wide UI/UX polish, from the ui-ux-pro-max checklist (apply last among the dashboard patches).
// Audit findings fixed here:
//  - the seven-tab bar pushed the header actions 68px past a 1280px viewport (horizontal page scroll)
//  - no hover / press feedback on buttons and cards, snapping state changes, tab switches that just appear
//  - form fields under 16px on phones (iOS zooms the page on focus), small touch targets on coarse pointers
//  - truncated ticket titles had no way to read the rest; the provider-problem banner was not announced
//  - numbers jittered as they changed (no tabular figures)
// Everything uses the theme tokens, so Andon, Cyberpunk and Tmzm all get it, and reduced motion switches the motion off.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="ejad-polish"')) {
  const CSS = `<style id="ejad-polish">
/* 1. the header fits from tablet to wide desktop */
@media (min-width: 768px) and (max-width: 1439px) {
  .tab-btn { padding: 0 4px; gap: 5px; }
  .tier1 { gap: 8px; }
  #copy-url-btn .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
/* below 1200px only the current tab keeps its label (the others keep an icon, a tooltip and their accessible name) */
@media (min-width: 768px) and (max-width: 1199px) {
  .tab-btn:not(.active) .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tab-btn { padding: 0 10px; }
  .sub-wide { display: none; }
}
/* 2. keyboard focus is always visible (2px ring, offset so it is not clipped) */
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
/* 3. feedback: hover, press, state changes, never layout-shifting (transform and colour only) */
.btn { transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); touch-action: manipulation; }
.btn:active:not(:disabled):not([aria-disabled="true"]) { transform: translateY(1px); }
.tab-btn { transition: color var(--dur-fast) var(--ease-out); touch-action: manipulation; }
.ticket-card { transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
.ticket-card:hover { border-color: var(--line-strong); }
.ejad-panel > summary { cursor: pointer; min-height: 36px; display: flex; align-items: center; gap: var(--s2); border-radius: var(--r-control); transition: color var(--dur-fast) var(--ease-out); }
.ejad-panel > summary:hover { color: var(--text); }
/* 4. a tab switch fades in instead of snapping (opacity only) */
@keyframes ejad-in { from { opacity: 0; } }
.tab-content.active { animation: ejad-in var(--dur) var(--ease-out); }
/* 5. phones and touch: 16px fields (no zoom on focus), 44px targets */
@media (max-width: 767px) { input:not([type="checkbox"]):not([type="radio"]), select, textarea { font-size: 16px; } }
@media (pointer: coarse) { .btn, select, input:not([type="checkbox"]):not([type="radio"]) { min-height: var(--tap); } .ejad-panel > summary { min-height: var(--tap); } }
/* 6. numbers do not jitter; text selection and scrollbars follow the theme */
.stat-value, .badge, .tab-btn .n, td, .note-s, .pvp-sub, time { font-variant-numeric: tabular-nums; }
::selection { background: color-mix(in srgb, var(--btn-primary-bg) 45%, transparent); }
* { scrollbar-color: var(--line-strong) transparent; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
/* reduced motion: all of the above stops moving */
@media (prefers-reduced-motion: reduce) { .tab-content.active { animation: none; } .btn, .tab-btn, .ticket-card, .ejad-panel > summary { transition: none; } .btn:active:not(:disabled) { transform: none; } }
</style>
`;
  const JS = `<script id="ejad-polish-js">
(function () {
  // the provider-problem banner is announced when it appears
  var iss = document.getElementById('ejad-issue'); if (iss) iss.setAttribute('role', 'alert');
  // icon-only tabs (narrow screens) still say what they are on hover
  document.querySelectorAll('.tab-btn').forEach(function (b) { var l = b.querySelector('.lbl'); if (l && !b.title) b.title = l.textContent.replace(/[0-9]+$/, '').trim(); });
  // a truncated ticket title shows its full text on hover and to assistive tech
  var pending = false;
  function titles() {
    pending = false;
    document.querySelectorAll('.ticket-card .clamp').forEach(function (e) {
      if (e.scrollHeight > e.clientHeight + 1 && !e.title) e.title = e.textContent.trim();
    });
  }
  var grid = document.getElementById('kanban-grid');
  if (grid && window.MutationObserver) new MutationObserver(function () { if (!pending) { pending = true; requestAnimationFrame(titles); } }).observe(grid, { childList: true, subtree: true });
  titles();
})();
</script>
`;
  if (!h.includes('</head>') || !h.includes('</body>')) throw new Error('anchor missing: head/body');
  h = h.replace('</head>', () => CSS + '</head>');
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('polish patch applied');

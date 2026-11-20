// Workov: soft sounds for the dashboard. A quiet bell when a ticket changes stage, a rising run when one is done, a gentle
// double ping when something needs you, and a tick on tab clicks. Synthesized with Web Audio (no files), only while a
// dashboard page is open and visible, off with one button (remembered). The Office tab has its own sounds, so these stay
// quiet while it is open. Browsers keep audio locked until the first click or key press.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="wv-sound-js"')) {
  const CSS = `<style id="wv-sound-css">
.wv-snd { position: fixed; right: 14px; bottom: 14px; z-index: 55; width: 36px; height: 36px; display: grid; place-items: center; padding: 0; color: var(--text-2); background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: 999px; box-shadow: var(--shadow-float, 0 8px 20px -8px rgb(0 0 0 / .45)); cursor: pointer; opacity: .85; transition: opacity .18s ease, transform .18s cubic-bezier(.16, 1, .3, 1), color .18s ease; }
.wv-snd:hover { opacity: 1; color: var(--text); transform: translateY(-1px); }
.wv-snd:focus-visible { outline: 2px solid var(--btn-primary-bg, currentColor); outline-offset: 2px; }
.wv-snd svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.wv-snd .off { display: none; } .wv-snd[aria-pressed="false"] .on { display: none; } .wv-snd[aria-pressed="false"] .off { display: block; }
@media (max-width: 767px) { .wv-snd { bottom: 78px; } }
@media (prefers-reduced-motion: reduce) { .wv-snd { transition: none; } }
</style>
`;
  const JS = `<script id="wv-sound-js">
(function () {
  var ctx = null, master = null, on = true, KEY = 'wv-dash-sound';
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) { /* no storage: stays on */ }
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'wv-snd'; btn.setAttribute('aria-label', 'Sounds'); btn.title = 'Sounds';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><g class="on"><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></g><g class="off"><path d="M16 9.5l5 5M21 9.5l-5 5"/></g></svg>';
  function paint() { btn.setAttribute('aria-pressed', String(on)); btn.title = on ? 'Sounds on' : 'Sounds off'; }
  function ensure() {
    if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination); }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
    return true;
  }
  var office = function () { var f = document.getElementById('office-frame'); return !!(f && f.getAttribute('src')); };
  function ok() { return on && ctx && ctx.state === 'running' && !document.hidden; }
  // a bell: a sine with a faint octave above, a soft attack and a long fade
  function bell(f, at, vol, len) {
    if (!ok()) return; var t = ctx.currentTime + (at || 0), d = len || 0.9;
    [[1, 1], [2, 0.18], [3, 0.06]].forEach(function (p) {
      var o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f * p[0];
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((vol || 0.12) * p[1], t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d / p[0]);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + d / p[0] + 0.05);
    });
  }
  var N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5 };   // a pentatonic scale: never sour
  var S = {
    tick: function () { bell(1760, 0, 0.035, 0.12); },
    move: function () { bell(N.E5, 0, 0.1, 0.7); bell(N.A5, 0.1, 0.09, 0.8); },
    done: function () { [N.C5, N.E5, N.G5, N.C6].forEach(function (f, i) { bell(f, i * 0.1, 0.1, 1.1); }); },
    need: function () { bell(N.G5, 0, 0.09, 0.6); bell(N.D5, 0.2, 0.09, 0.9); }
  };
  btn.addEventListener('click', function () {
    on = !on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* kept for this visit */ } paint();
    if (on) { ensure(); setTimeout(S.move, 60); }
  });
  ['pointerdown', 'keydown'].forEach(function (ev) { addEventListener(ev, ensure, { passive: true }); });
  document.addEventListener('visibilitychange', function () { if (ctx) { if (document.hidden) ctx.suspend(); else ctx.resume(); } });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.tab-btn') && !office()) S.tick(); }, true);

  // what changed on the board: every project's tickets, polled gently
  var STAGE = { specifying: 'plan', draft: 'draft', designing: 'design', todo: 'todo', ready: 'todo', 'in-progress': 'building', 'in-review': 'review', delivering: 'deliver', done: 'done' };
  var NEED = { blocked: 1, failed: 1, 'budget-exceeded': 1 }, prev = null;
  function headers() { var t = new URLSearchParams(location.search).get('token'); return t ? { Authorization: 'Bearer ' + t } : {}; }
  function poll() {
    if (document.hidden) return;
    fetch('/api/wv/projects', { credentials: 'same-origin', headers: headers() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return; var now = {}, needs = 0;
      (d.projects || []).forEach(function (p) { (p.tickets || []).forEach(function (t) { now[p.name + '/' + t.id] = STAGE[t.status] || 'x'; if (t.awaiting || NEED[t.status]) needs++; }); });
      if (prev && !office()) {
        var moved = false, won = false;
        Object.keys(now).forEach(function (k) { if (prev.t[k] && prev.t[k] !== now[k]) { moved = true; if (now[k] === 'done') won = true; } });
        if (won) S.done(); else if (moved) S.move();
        if (needs > prev.needs) setTimeout(S.need, won || moved ? 700 : 0);
      }
      prev = { t: now, needs: needs };
    }).catch(function () { /* the dashboard keeps working without sound */ });
  }
  paint(); document.body.appendChild(btn); poll(); setInterval(poll, 5000);
})();
</script>
`;
  h = h.replace('</head>', () => CSS + '</head>');
  const i = h.lastIndexOf('</body>');
  if (i < 0) throw new Error('anchor missing: </body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('dashboard sound applied');

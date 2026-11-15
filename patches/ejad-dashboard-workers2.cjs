// Ejad: the Parallel workers control where it is easy to find (apply after ejad-dashboard-workers.cjs).
//  - Board > Agents header: a compact "Workers [n]" picker next to the Active badge, saved on change.
//  - Providers > Agents & planner: the section moves to the top of the tab.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
if (!h.includes('id="board-workers"')) {
  // 1. Board header picker
  const re = /<span id="active-worker-count"[^>]*>[^<]*<\/span>/;
  if (!re.test(h)) throw new Error('anchor missing: active-worker-count');
  h = h.replace(re, (m) => `<label class="note-s" style="display:inline-flex;align-items:center;gap:6px">Workers <select id="board-workers" aria-label="Maximum parallel workers" style="min-height:32px"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label> ` + m);
  // 2. move the section to the top of the Agents tab
  const sec = /<section class="pvp-plan" id="ejad-workers-sec">[\s\S]*?<\/section>\s*/;
  const m = sec.exec(h);
  if (!m) throw new Error('anchor missing: ejad-workers-sec');
  h = h.replace(sec, '');
  const panel = /(id="pvp-panel-agents"[^>]*>\s*)/;
  if (!panel.test(h)) throw new Error('anchor missing: pvp-panel-agents');
  h = h.replace(panel, (x) => x + m[0]);
  const JS = `<script id="ejad-board-workers-js">
(function () {
  var sel = document.getElementById('board-workers'); if (!sel) return;
  async function load() {
    if (document.hidden || sel === document.activeElement) return;
    try {
      var res = await fetch('/api/ejad/workers', { headers: getAuthHeaders() }); if (!res.ok) return;
      var d = await res.json();
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === String(d.max); })) { var o = document.createElement('option'); o.textContent = d.max; sel.append(o); }
      sel.value = String(d.max); sel.title = d.running + ' running';
    } catch (e) { /* keeps its last view */ }
  }
  sel.onchange = async function () {
    var n = Number(sel.value); var x = await ejadPost({ action: 'ejad_set_workers', n: n });
    showToast(x.ok ? 'Up to ' + n + ' workers (next router cycle)' : (x.j.error || 'Could not change it'), x.ok ? undefined : 'bad'); load();
  };
  load(); setInterval(load, 10000);
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('workers2 patch applied');

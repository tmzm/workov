// Workerov: "Parallel workers" control in Providers > Agents & planner (apply after failover.cjs).
// Sets concurrency.maxParallelWorkers in specs/worker-fleet.config.json (1 to 8). The router reads it each cycle, so a new
// value applies to the next dispatch. Lowering it never stops a running worker: extra workers finish, nothing new starts.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

let s = rd(S);
if (!s.includes('def wv_set_workers')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('\ndef wv_run_action(action, req, tid):', String.raw`
def wv_workers_state():
    try:
        n = int(json.loads(wv_config_path().read_text(encoding="utf-8")).get("concurrency", {}).get("maxParallelWorkers") or 2)
    except Exception:
        n = 2
    running = len([r for r in wv_board() if r["status"] == "in-progress"])
    return {"max": n, "running": running}


def wv_set_workers(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return 400, {"error": "Give a number from 1 to 8."}
    if not 1 <= n <= 8:
        return 400, {"error": "Give a number from 1 to 8."}
    path = wv_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    cfg.setdefault("concurrency", {})["maxParallelWorkers"] = n
    wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return 200, {"ok": True, "max": n, "note": "Applies from the next router cycle. Workers already running are not stopped."}

` + '\ndef wv_run_action(action, req, tid):');
  sub('WV_ACTIONS = (', 'WV_ACTIONS = ("wv_set_workers", ');
  sub('    if action == "wv_set_failover":', '    if action == "wv_set_workers":\n        return wv_set_workers(req.get("n"))\n    if action == "wv_set_failover":');
  sub('        if path == "/api/wv/failover":', '        if path == "/api/wv/workers":\n            self._send_json(200, wv_workers_state())\n            return\n\n        if path == "/api/wv/failover":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('id="wv-workers-js"')) {
  const re = /<section class="pvp-plan"[^>]*>\s*<h3>Agents<\/h3>/;
  if (!re.test(h)) throw new Error('anchor missing: Agents section');
  const SEC = `<section class="pvp-plan" id="wv-workers-sec"><h3>Parallel workers</h3><p>How many tickets are built at the same time. Each worker is a model session, so more workers use more of your providers' limits. Lowering it never stops a worker that is running. <strong id="pvp-wnow"></strong></p>
      <div class="pvp-row"><select id="pvp-workers" aria-label="Maximum parallel workers"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select><button type="button" class="btn btn-sm btn-primary" id="pvp-wsave">Save</button></div></section>
    `;
  h = h.replace(re, (m) => SEC + m);
  const JS = `<script id="wv-workers-js">
(function () {
  async function load() {
    var sel = document.getElementById('pvp-workers'); if (!sel) return;
    try {
      var res = await fetch('/api/wv/workers', { headers: getAuthHeaders() }); if (!res.ok) return;
      var d = await res.json();
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === String(d.max); })) { var o = document.createElement('option'); o.textContent = d.max; sel.append(o); }
      sel.value = String(d.max);
      document.getElementById('pvp-wnow').textContent = 'Now: ' + d.max + ' allowed, ' + d.running + ' running.';
    } catch (e) { /* keeps its last view */ }
  }
  var save = document.getElementById('pvp-wsave');
  if (save) save.onclick = async function () {
    var n = Number(document.getElementById('pvp-workers').value); save.disabled = true;
    var x = await wvPost({ action: 'wv_set_workers', n: n }); save.disabled = false;
    showToast(x.ok ? 'Up to ' + n + ' workers (next router cycle)' : (x.j.error || 'Could not change it'), x.ok ? undefined : 'bad'); if (x.ok) load();
  };
  var old = window.wvProvidersShown;
  window.wvProvidersShown = function () { if (old) old(); load(); };
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('workers patch applied');

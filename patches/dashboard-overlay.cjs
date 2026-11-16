// Workerov: "Pause all" in the dashboard's top bar, with a full-screen overlay for the whole pause and resume.
//   Pausing  -> overlay with a loader: "Stopping ..." until the router has stopped every worker.
//   Paused   -> the same overlay, now with a Resume all button (and "Close (stay paused)" to look around first;
//               the top-bar button then reads Resume all and brings the overlay back).
//   Resuming -> the overlay shows a loader while the fleet starts and its workers are dispatched again, then hides.
// The state lives on the server (job/pausing.json, paused.json, resuming.json), so the overlay is right after a page
// reload or a restart. Builds on dashboard-run.cjs and dashboard-pause.cjs (apply them first).
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing (apply the run and pause patches first): ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_resuming():
    """The pause being undone: pending = its tickets still waiting for a worker. Done once none is ready and the loop runs."""
    f = REPO_ROOT / "job" / "resuming.json"
    if not f.exists():
        return None
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
        started = datetime.strptime(d.get("at", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - started).total_seconds()
    except Exception:
        f.unlink(missing_ok=True)
        return None
    pending = [r["id"] for r in wv_board() if r["id"] in d.get("tickets", []) and r["status"] == "ready"]
    if age > 5 * 60 or (age > 8 and not pending and wv_loop_pids()):
        f.unlink(missing_ok=True)
        return None
    return {"pending": pending}


def wv_recover_pause():
    """A restart of the dashboard must not lose a pause in progress: finish it again from job/pausing.json."""
    f = REPO_ROOT / "job" / "pausing.json"
    if not f.exists():
        return
    try:
        tickets = json.loads(f.read_text(encoding="utf-8")).get("tickets", [])
    except Exception:
        tickets = []
    threading.Thread(target=wv_finish_pause, args=(tickets,), daemon=True).start()


wv_recover_pause()

`;
if (!s.includes('def wv_resuming')) {
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);
  const a1 = '    (REPO_ROOT / "job" / "paused.json").unlink(missing_ok=True)\n    (REPO_ROOT / "job" / "pausing.json").unlink(missing_ok=True)\n    if wv_loop_pids():';
  must(s, a1);
  s = s.replace(a1, () => `    _pj = REPO_ROOT / "job" / "paused.json"
    if _pj.exists():
        try:
            _t = json.loads(_pj.read_text(encoding="utf-8")).get("tickets", [])
        except Exception:
            _t = []
        (REPO_ROOT / "job" / "resuming.json").write_text(json.dumps({"at": utc_now_iso(), "tickets": _t}), encoding="utf-8")
    _pj.unlink(missing_ok=True)
    (REPO_ROOT / "job" / "pausing.json").unlink(missing_ok=True)
    if wv_loop_pids():`);
  const a2 = '    return {"working": ';
  must(s, a2);
  s = s.replace(a2, () => '    return {"resuming": wv_resuming(), "working": ');
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: resuming state');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="wv-overlay"')) {
  const css = `<style id="wv-overlay-css">
.wv-overlay { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--scrim, rgba(0,0,0,.65)); }
.wv-overlay[hidden] { display: none; }
.wv-ov-box { background: var(--surface-1, #1a1b1d); border: 1px solid var(--line, #8884); border-radius: 12px; padding: 28px 32px; max-width: 460px; width: 100%; text-align: center; outline: none; }
.wv-ov-box h2 { margin: 14px 0 8px; font-size: 20px; }
.wv-ov-box p { margin: 0 0 4px; line-height: 1.5; opacity: .85; }
.wv-ov-acts { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 18px; }
.wv-spin { width: 44px; height: 44px; margin: 0 auto; border: 4px solid var(--line, #8884); border-top-color: var(--accent, #7aa2ff); border-radius: 50%; animation: wv-rot .9s linear infinite; }
.wv-spin[hidden] { display: none; }
@keyframes wv-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wv-spin { animation-duration: 3s; } }
</style>
`;
  must(h, '</head>');
  h = h.replace('</head>', () => css + '</head>');

  const acts = '<div class="acts" id="acts-wide">';
  must(h, acts);
  h = h.replace(acts, () => acts + '\n      <button type="button" id="wv-pause-btn" class="btn" title="Pause every worker; Resume all continues where it stopped">Pause all</button>');

  const dlg = '<!-- Decision dialog -->';
  must(h, dlg);
  h = h.replace(dlg, () => `<div id="wv-overlay" class="wv-overlay" role="alertdialog" aria-modal="true" aria-labelledby="wv-ov-title" aria-describedby="wv-ov-text" hidden>
  <div class="wv-ov-box" id="wv-ov-box" tabindex="-1">
    <div id="wv-ov-spin" class="wv-spin" aria-hidden="true"></div>
    <h2 id="wv-ov-title"></h2>
    <p id="wv-ov-text" aria-live="polite"></p>
    <div class="wv-ov-acts">
      <button type="button" id="wv-ov-main" class="btn primary" hidden>Resume all</button>
      <button type="button" id="wv-ov-close" class="btn ghost" hidden>Close (stay paused)</button>
    </div>
  </div>
</div>
` + dlg);

  const call = '    wvPollPermissions(); setInterval(wvPollPermissions, 2000);';
  must(h, call);
  h = h.replace(call, () => `    let wvOvDismissed = false, wvOvShown = '', wvResumeClicked = 0;
    function wvOverlayRender(d) {
      const ov = document.getElementById('wv-overlay'), btn = document.getElementById('wv-pause-btn');
      const wk = d.working || [], clicked = Date.now() - wvResumeClicked < 12000;
      let mode = '';
      if (d.pausing) mode = 'pausing'; else if (d.resuming || clicked && !d.paused) mode = 'resuming'; else if (d.paused) mode = 'paused';
      const title = document.getElementById('wv-ov-title'), text = document.getElementById('wv-ov-text');
      const spin = document.getElementById('wv-ov-spin'), main = document.getElementById('wv-ov-main'), close = document.getElementById('wv-ov-close');
      if (mode === 'pausing') {
        title.textContent = 'Stopping…';
        text.textContent = (wk.length ? 'Stopping ' + wk.length + ' worker(s) (' + wk.join(', ') + '). ' : 'Stopping the fleet. ') + 'Their work and branches are kept. This takes a few seconds.';
      } else if (mode === 'resuming') {
        const pend = (d.resuming && d.resuming.pending) || [];
        title.textContent = 'Resuming…';
        text.textContent = 'Starting the fleet and restarting the workers' + (pend.length ? ' (waiting for ' + pend.join(', ') + ')' : '') + '. This window closes when everything is running.';
      } else if (mode === 'paused') {
        title.textContent = 'Paused';
        text.textContent = 'Everything is stopped and nothing is running. Work and branches are kept. Resume all continues where it stopped.';
      }
      spin.hidden = mode === 'paused'; main.hidden = mode !== 'paused'; close.hidden = mode !== 'paused';
      const show = mode !== '' && !(mode === 'paused' && wvOvDismissed);
      if (!mode) wvOvDismissed = false;
      if (show && ov.hidden) setTimeout(() => (mode === 'paused' ? main : document.getElementById('wv-ov-box')).focus(), 0);
      ov.hidden = !show; wvOvShown = mode;
      btn.disabled = mode === 'pausing' || mode === 'resuming' || (!mode && !d.loopRunning);
      btn.textContent = mode === 'pausing' ? 'Pausing…' : mode === 'resuming' ? 'Resuming…' : mode === 'paused' ? 'Resume all' : 'Pause all';
      return mode;
    }
    async function wvOverlayTick() {
      let mode = '';
      try {
        const res = await fetch('/api/wv/overview', { headers: getAuthHeaders() });
        if (res.ok) mode = wvOverlayRender(await res.json());
      } catch (e) { /* the dashboard keeps working without it */ }
      setTimeout(wvOverlayTick, mode === 'pausing' || mode === 'resuming' ? 2000 : 8000);
    }
    document.getElementById('wv-pause-btn').onclick = async () => {
      if (wvOvShown === 'paused') { wvOvDismissed = false; document.getElementById('wv-overlay').hidden = false; document.getElementById('wv-ov-main').focus(); return; }
      const r = await wvPost({ action: 'wv_pause_all' });
      if (!r.ok) showToast(r.j.error || 'Could not pause', 'bad');
      setTimeout(async () => { const x = await fetch('/api/wv/overview', { headers: getAuthHeaders() }); if (x.ok) wvOverlayRender(await x.json()); }, 400);
    };
    document.getElementById('wv-ov-main').onclick = async () => {
      wvResumeClicked = Date.now();
      const r = await wvPost({ action: 'wv_fleet_start' });
      if (!r.ok) { wvResumeClicked = 0; showToast(r.j.error || 'Could not resume', 'bad'); return; }
      const x = await fetch('/api/wv/overview', { headers: getAuthHeaders() }); if (x.ok) wvOverlayRender(await x.json());
    };
    document.getElementById('wv-ov-close').onclick = () => { wvOvDismissed = true; document.getElementById('wv-overlay').hidden = true; };
    wvOverlayTick();
` + call);
  fs.writeFileSync(H, h);
}
console.log('index.html: pause overlay');

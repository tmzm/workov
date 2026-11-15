// Ejad: see what the router is doing, and fix it when it is stuck (apply after ejad-dashboard-readonly.cjs).
//  - GET /api/ejad/router: status (working / waiting / slow / stuck / error / stopped / off), the router model and session,
//    how long since its last output, and the last lines of what it is doing.
//  - ejad_router_restart: stops the router run and its loop and starts a fresh loop with a NEW router session. Workers keep
//    running (they live in OpenCode's service, the router adopts them again). A router session that has grown very long is
//    the usual reason for a router that crawls or hangs.
//  - a watchdog restarts a router that has been silent for 12 minutes while tickets are waiting, at most once per 20 minutes.
//  - Board > "Router" panel with the status lamp, facts, live activity, "Restart router (fresh session)" and "Dispatch now".
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def ejad_router_status')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  const FN = String.raw`EJAD_ROUTER_STUCK_SEC = 12 * 60
EJAD_ROUTER_WD = REPO_ROOT / "job" / "router-watchdog.json"
EJAD_JSONISH_RE = re.compile(r'^\s*[\[\]{},]|^\s*"[^"]+"\s*:|^\s*$')


def ejad_router_status():
    log = REPO_ROOT / "job" / "router-loop.log"
    now = time.time()
    loops, runs = ejad_loop_pids(), ejad_router_runs()
    silent, lines = None, []
    try:
        st = log.stat()
        silent = int(now - st.st_mtime)
        with open(log, "rb") as fh:
            fh.seek(max(0, st.st_size - 40000))
            raw = EJAD_ANSI_RE.sub("", fh.read().decode("utf-8", "ignore")).splitlines()
        lines = [ln.rstrip()[:240] for ln in raw if not EJAD_JSONISH_RE.search(ln)][-14:]
    except OSError:
        pass
    session = ""
    try:
        m = re.findall(r"router session: (\S+)", EJAD_ANSI_RE.sub("", log.read_text(encoding="utf-8", errors="ignore")[-200000:]))
        session = m[-1] if m else ""
    except OSError:
        pass
    try:
        cfg = json.loads(ejad_config_path().read_text(encoding="utf-8"))
        model = ((cfg.get("models") or {}).get("router") or {}).get("opencode", {}).get("model", "")
    except Exception:
        model = ""
    issue = ejad_provider_issue()
    wanted = ejad_wanted()
    if EJAD_FLEET_OFF.exists():
        state, text = "off", "The fleet is switched off."
    elif issue:
        state, text = "error", "The provider is failing: " + issue["message"][:140]
    elif runs:
        if silent is not None and silent < 180:
            state, text = "working", "A router cycle is running."
        elif silent is not None and silent < EJAD_ROUTER_STUCK_SEC:
            state, text = "slow", "The router has been silent for " + str(silent // 60) + " min. It may be waiting on a slow model."
        else:
            state, text = "stuck", "The router has been silent for " + str((silent or 0) // 60) + " min: it looks stuck. Restart it."
    elif loops:
        state, text = "waiting", "Between cycles. The next one starts within about 90 seconds."
    elif wanted:
        state, text = "stopped", "Tickets are waiting but no router is running. The dashboard starts it within 30 seconds, or restart it now."
    else:
        state, text = "idle", "Nothing needs the router right now."
    try:
        wd = json.loads(EJAD_ROUTER_WD.read_text(encoding="utf-8"))
    except Exception:
        wd = None
    return {"state": state, "text": text, "model": model, "session": session, "silentSec": silent, "loopRunning": bool(loops),
            "runActive": bool(runs), "lines": lines, "lastRestart": wd, "stuckAfterMin": EJAD_ROUTER_STUCK_SEC // 60}


def ejad_router_restart(reason="manual"):
    for pid in (ejad_router_runs() or []) + ejad_loop_pids():
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20, creationflags=EJAD_NOWIN)
        else:
            try:
                os.kill(pid, 15)
            except OSError:
                pass
    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)
    time.sleep(2)
    res = ejad_fleet_start()
    try:
        ejad_atomic_write(EJAD_ROUTER_WD, json.dumps({"at": utc_now_iso(), "reason": reason}))
    except Exception:
        pass
    return 200, {"ok": True, "note": "Router restarted with a fresh session. Workers keep running.", "start": res.get("note")}


def ejad_router_watchdog():
    time.sleep(90)
    while True:
        try:
            if not EJAD_FLEET_OFF.exists() and ejad_wanted():
                st = ejad_router_status()
                last = (st.get("lastRestart") or {}).get("at", "")
                recent = False
                if last:
                    try:
                        recent = time.time() - datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() < 20 * 60
                    except ValueError:
                        recent = False
                if st["state"] == "stuck" and not recent:
                    ejad_router_restart("automatic: the router was silent for " + str((st["silentSec"] or 0) // 60) + " minutes")
                    print("[ejad] router watchdog restarted a stuck router", file=sys.stderr)
        except Exception as e:
            print(f"[ejad] router watchdog failed: {e}", file=sys.stderr)
        time.sleep(60)


threading.Thread(target=ejad_router_watchdog, daemon=True).start()


`;
  sub('\ndef ejad_run_action(action, req, tid):', '\n' + FN + 'def ejad_run_action(action, req, tid):');
  sub('EJAD_ACTIONS = ("ejad_rotate_viewer",', 'EJAD_ACTIONS = ("ejad_router_restart", "ejad_rotate_viewer",');
  sub('    if action == "ejad_rotate_viewer":', '    if action == "ejad_router_restart":\n        return ejad_router_restart("manual")\n    if action == "ejad_rotate_viewer":');
  sub('EJAD_CLEARS_ISSUE = (', 'EJAD_CLEARS_ISSUE = ("ejad_router_restart", ');
  sub('        if path == "/api/share":', '        if path == "/api/ejad/router":\n            self._send_json(200, ejad_router_status())\n            return\n\n        if path == "/api/share":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('id="ejad-router"')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub('        <details id="ejad-timeline" class="ejad-panel"', `        <details id="ejad-router" class="ejad-panel" style="margin-bottom:12px;" open>
          <summary><span id="rt-lamp" class="lamp off" aria-hidden="true"></span> Router <span class="note-s" id="rt-head">checking…</span></summary>
          <p id="rt-line" class="note-s" style="margin:8px 0;" role="status"></p>
          <dl class="rt-facts" id="rt-facts"></dl>
          <pre id="rt-log" class="mono" tabindex="0" aria-label="What the router is doing (latest lines)"></pre>
          <div class="rt-acts">
            <button type="button" class="btn btn-sm btn-primary" id="rt-restart">Restart router (fresh session)</button>
            <button type="button" class="btn btn-sm" id="rt-dispatch">Dispatch now</button>
          </div>
          <p class="note-s" id="rt-help">Restart when it is slow, stuck, or still on a model you changed. Workers keep running; the new router picks them up again.</p>
        </details>
        <details id="ejad-timeline" class="ejad-panel"`);
  const CSS = `<style id="ejad-router-css">
#ejad-router .rt-facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--s1) var(--s4); margin: 0 0 var(--s3); font-size: var(--fs-small); }
#ejad-router .rt-facts dt { color: var(--text-3); }
#ejad-router .rt-facts dd { margin: 0; overflow-wrap: anywhere; }
#rt-log { margin: 0 0 var(--s3); padding: var(--s3); max-height: 220px; overflow: auto; background: var(--readout-bg); border: 1px solid var(--line); border-radius: var(--r-control); font-size: var(--fs-label); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
#ejad-router .rt-acts { display: flex; gap: var(--s2); flex-wrap: wrap; margin-bottom: var(--s2); }
#rt-lamp.run { background: var(--lamp-run); } #rt-lamp.attn { background: var(--lamp-attn); } #rt-lamp.stop { background: var(--lamp-stop); }
</style>
`;
  must(h, '</head>');
  h = h.replace('</head>', () => CSS + '</head>');
  const JS = `<script id="ejad-router-js">
(function () {
  var LAMP = { working: 'run', waiting: 'run', idle: 'off', slow: 'attn', stuck: 'stop', error: 'stop', stopped: 'attn', off: 'off' };
  var WORD = { working: 'working', waiting: 'waiting for the next cycle', idle: 'idle', slow: 'slow', stuck: 'STUCK', error: 'provider error', stopped: 'not running', off: 'off' };
  var box = document.getElementById('ejad-router');
  if (!box) return;
  function el(tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
  function ago(sec) { if (sec == null) return 'unknown'; if (sec < 90) return sec + ' s ago'; if (sec < 5400) return Math.round(sec / 60) + ' min ago'; return (sec / 3600).toFixed(1) + ' h ago'; }
  async function load() {
    if (document.hidden) return;
    try {
      var res = await fetch('/api/ejad/router', { headers: getAuthHeaders() });
      if (!res.ok) return;
      var d = await res.json();
      document.getElementById('rt-lamp').className = 'lamp ' + (LAMP[d.state] || 'off') + ' lit';
      document.getElementById('rt-head').textContent = '(' + (WORD[d.state] || d.state) + ')';
      document.getElementById('rt-line').textContent = d.text;
      var f = document.getElementById('rt-facts'); f.textContent = '';
      [['Model', d.model || 'unknown'], ['Last output', ago(d.silentSec)], ['Session', d.session || 'none yet'], ['Cycle running', d.runActive ? 'yes' : 'no'],
       ['Last restart', d.lastRestart ? new Date(d.lastRestart.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + d.lastRestart.reason + ')' : 'never']].forEach(function (kv) { f.append(el('dt', kv[0]), el('dd', kv[1])); });
      var pre = document.getElementById('rt-log'); var atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = (d.lines || []).join('\\n') || 'No output yet.';
      if (atEnd) pre.scrollTop = pre.scrollHeight;
      var ok = typeof isAuthed === 'function' ? isAuthed() : true;
      document.getElementById('rt-restart').disabled = !ok; document.getElementById('rt-dispatch').disabled = !ok;
    } catch (e) { /* the panel keeps its last view */ }
  }
  document.getElementById('rt-restart').onclick = async function () {
    if (!confirm('Restart the router with a fresh session? A cycle in progress is cut off. Workers keep running.')) return;
    var b = this; b.disabled = true; b.textContent = 'Restarting…';
    var x = await ejadPost({ action: 'ejad_router_restart' });
    b.textContent = 'Restart router (fresh session)'; b.disabled = false;
    showToast(x.ok ? x.j.note : (x.j.error || 'Could not restart the router'), x.ok ? undefined : 'bad'); load();
  };
  document.getElementById('rt-dispatch').onclick = async function () {
    var x = await ejadPost({ action: 'dispatch_now' });
    showToast(x.ok ? 'Dispatch requested. The next router cycle picks it up.' : (x.j.error || 'Could not request a dispatch'), x.ok ? undefined : 'bad');
  };
  load(); setInterval(load, 6000);
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('router patch applied');

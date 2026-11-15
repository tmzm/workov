// Ejad: run the whole fleet flow from the dashboard, so the Claude session can be closed once a ticket exists.
//  1. The dashboard server starts the router loop itself (detached, no console) whenever a ticket is ready or
//     in-progress, or an answer is waiting to be forwarded, and Start / Stop buttons control it. Stop is sticky
//     (job/fleet-off) until Start.
//  2. Deliver button: runs `ejad-land.cjs deliver NNN <branch>` (dry run first, then for real): MR ready, Plane and
//     Ejad HR to Review. The branch comes from job/router-state.json, never from the request.
//  3. Hours form: logs minutes on today's Ejad HR attendance session against the ticket's Ejad HR task (dry run
//     first). Credentials come from the HR_EMAIL / HR_PASS user environment variables of the server process.
// Every action goes through the existing token-protected POST /api/action. Nothing here submits a day.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
EJAD_ACTIONS = ("ejad_fleet_start", "ejad_fleet_stop", "ejad_deliver", "ejad_hours")
EJAD_FLEET_OFF = REPO_ROOT / "job" / "fleet-off"
EJAD_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
EJAD_DETACH = (getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | EJAD_NOWIN)
EJAD_HR_API = os.environ.get("EJAD_HR_API", "https://hr.ejad.net/api/v1")


def ejad_loop_pids():
    """Windows PIDs of the running ejad-router-loop.sh (its pid file holds an MSYS pid, which is not a Windows pid)."""
    try:
        if os.name == "nt":
            ps = "Get-CimInstance Win32_Process -Filter \"Name='bash.exe' and CommandLine like '%ejad-router-loop.sh%'\" | ForEach-Object { $_.ProcessId }"
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=20, creationflags=EJAD_NOWIN).stdout
        else:
            out = subprocess.run(["pgrep", "-f", "ejad-router-loop.sh"], capture_output=True, text=True, timeout=10).stdout
        return [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        return []


def ejad_git_bash():
    for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
        if os.path.isfile(p):
            return p
    return "bash"


def ejad_fleet_start():
    EJAD_FLEET_OFF.unlink(missing_ok=True)
    if ejad_loop_pids():
        return {"ok": True, "running": True, "note": "already running"}
    (REPO_ROOT / "job").mkdir(exist_ok=True)
    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)
    log = open(REPO_ROOT / "job" / "router-loop.log", "ab")
    subprocess.Popen([ejad_git_bash(), ".claude/scripts/ejad-router-loop.sh"], cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, creationflags=EJAD_DETACH if os.name == "nt" else 0, start_new_session=(os.name != "nt"))
    return {"ok": True, "running": True, "note": "started"}


def ejad_fleet_stop():
    EJAD_FLEET_OFF.write_text(utc_now_iso(), encoding="utf-8")
    for pid in ejad_loop_pids():
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20, creationflags=EJAD_NOWIN)
        else:
            os.kill(pid, 15)
    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)
    return {"ok": True, "running": False}


def ejad_router_state():
    try:
        return json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def ejad_entry(tid):
    for v in ejad_router_state().values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and str(e.get("ticket", "")).startswith(tid + "-"):
                    return e
    return None


def ejad_board():
    rows = []
    try:
        text = (REPO_ROOT / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return rows
    for m in re.finditer(r"^\|\s*(\d{3})\s*\|\s*([^|]*?)\s*\|\s*([a-z-]+)\s*\|", text, re.M):
        rows.append({"id": m.group(1), "title": m.group(2), "status": m.group(3)})
    return rows


def ejad_wanted():
    if any(r["status"] in ("ready", "in-progress") for r in ejad_board()):
        return True
    for slug in ejad_router_state().get("pendingDecisions", []) or []:
        if (REPO_ROOT / "specs" / "tickets" / str(slug) / "user-decision.md").exists():
            return True
    return False


def ejad_autostart():
    time.sleep(20)
    while True:
        try:
            if not EJAD_FLEET_OFF.exists() and ejad_wanted() and not ejad_loop_pids():
                ejad_fleet_start()
                print("[ejad] router loop started by the dashboard", file=sys.stderr)
        except Exception as e:
            print(f"[ejad] autostart failed: {e}", file=sys.stderr)
        time.sleep(30)


threading.Thread(target=ejad_autostart, daemon=True).start()


def ejad_overview():
    tickets = []
    for r in ejad_board():
        if r["status"] != "in-review":
            continue
        e = ejad_entry(r["id"]) or {}
        pr = str(e.get("prUrl") or "")
        tickets.append({"id": r["id"], "title": r["title"], "branch": e.get("branch") or "", "prUrl": pr if pr.startswith("https://") else ""})
    return {"loopRunning": bool(ejad_loop_pids()), "fleetOff": EJAD_FLEET_OFF.exists(), "hrConfigured": bool(os.environ.get("HR_EMAIL") and os.environ.get("HR_PASS")), "inReview": tickets}


def ejad_deliver(tid, dry):
    e = ejad_entry(tid)
    branch = (e or {}).get("branch")
    if not branch or not re.fullmatch(r"[A-Za-z0-9._/-]+", str(branch)):
        return 404, {"error": f"No branch recorded for ticket {tid} in job/router-state.json"}
    cmd = ["node", ".claude/scripts/ejad-land.cjs", "deliver", tid, branch] + (["--dry-run"] if dry else [])
    r = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=300, creationflags=EJAD_NOWIN)
    return 200, {"ok": r.returncode == 0, "dry": dry, "output": (r.stdout + r.stderr)[-6000:]}


def ejad_hr_call(path, token=None, body=None):
    import urllib.request
    import urllib.error
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(EJAD_HR_API + path, data=data, method="POST" if body is not None else "GET")
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", "ejad-fleet-dashboard/1.0")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Ejad HR answered {e.code} for {path}: {e.read().decode('utf-8', 'ignore')[:200]}")


def ejad_hours(tid, minutes, description, dry):
    email, pw = os.environ.get("HR_EMAIL"), os.environ.get("HR_PASS")
    if not email or not pw:
        return 400, {"error": "HR_EMAIL / HR_PASS are not set for the dashboard process (Windows user environment variables)."}
    if not isinstance(minutes, int) or minutes < 1 or minutes > 1440 or not str(description).strip():
        return 400, {"error": "Give whole minutes (1-1440) and a description."}
    tdir = resolve_ticket_dir(tid)
    m = re.search(r"\*\*Ejad HR task:\*\*\s*([0-9a-fA-F-]{36})", (tdir / "rd.md").read_text(encoding="utf-8")) if tdir else None
    if not m:
        return 404, {"error": f"Ticket {tid} has no '**Ejad HR task:** <id>' line in rd.md"}
    login = ejad_hr_call("/auth/login", body={"email": email, "password": pw})
    token = login.get("accessToken") or (login.get("data") or {}).get("accessToken") or login.get("token")
    today = datetime.now().strftime("%Y-%m-%d")
    res = ejad_hr_call(f"/me/attendance?from={today}&to={today}", token)
    sessions = res if isinstance(res, list) else (res.get("data") or res.get("items") or [])
    if not sessions:
        return 409, {"error": f"No attendance session on {today}: check in on Ejad HR first."}
    sess = next((x for x in sessions if not x.get("checkedOutAt")), sessions[-1])
    free = int(((sess.get("allocation") or {}).get("unallocated") or {}).get("seconds") or 0)
    task = ejad_hr_call("/tasks/" + m.group(1), token)
    task = task.get("data", task) if isinstance(task, dict) else {}
    secs = minutes * 60
    plan = {"date": today, "task": task.get("code") or m.group(1), "minutes": minutes, "unallocatedMinutes": free // 60, "description": description}
    if secs > free:
        return 409, {"error": f"{minutes} min does not fit: only {free // 60} min of {today} is unallocated.", "plan": plan}
    if dry:
        return 200, {"ok": True, "dry": True, "plan": plan}
    ejad_hr_call(f"/me/attendance/{sess['id']}/entries", token, {"type": "PROJECT_TIME", "projectId": task.get("projectId"), "taskId": m.group(1), "description": description, "durationSeconds": secs})
    return 200, {"ok": True, "dry": False, "plan": plan, "note": "Logged as a draft entry; the day is not submitted."}


def ejad_run_action(action, req, tid):
    if action == "ejad_fleet_start":
        return 200, ejad_fleet_start()
    if action == "ejad_fleet_stop":
        return 200, ejad_fleet_stop()
    if not is_valid_ticket_id(tid):
        return 400, {"error": "Invalid ticket parameter: a numeric ticket id of at least 3 digits (e.g. 013) is required."}
    dry = req.get("dry") is not False
    if action == "ejad_deliver":
        return ejad_deliver(tid, dry)
    return ejad_hours(tid, req.get("minutes"), str(req.get("description", "")).strip()[:300], dry)

`;
if (!s.includes('def ejad_run_action')) {
  must('\ndef ejad_mockup_path(tdir):');
  s = s.replace('\ndef ejad_mockup_path(tdir):', () => `${FN}\ndef ejad_mockup_path(tdir):`);
  const g = '        if path == "/api/logs":';
  must(g);
  s = s.replace(g, () => '        if path == "/api/ejad/overview":\n            self._send_json(200, ejad_overview())\n            return\n\n' + g);
  const p = '            elif action == "dispatch_now":';
  must(p);
  s = s.replace(p, () => `            elif action in EJAD_ACTIONS:
                try:
                    code, payload = ejad_run_action(action, req, ticket_id)
                except Exception as e:
                    code, payload = 500, {"error": str(e)}
                self._audit_action(req, "ok" if code == 200 else f"error:{code}")
                self._send_json(code, payload)
                return
` + p);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: fleet start/stop, deliver, hours');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="ejad-run"')) {
  const mark = '        <h2 class="sec section-gap" id="agents-h">Agents';
  if (!h.includes(mark)) throw new Error('anchor missing: agents heading');
  h = h.replace(mark, () => `        <section id="ejad-run" class="ejad-run" aria-labelledby="ejad-run-h" style="margin-bottom:18px;">
          <h2 class="sec section-gap" id="ejad-run-h">Fleet and delivery</h2>
          <p class="note-s" id="ejad-fleet-line" style="margin-bottom:8px;"></p>
          <div id="ejad-delivery"></div>
        </section>
` + mark);
  const call = '    ejadPollPermissions(); setInterval(ejadPollPermissions, 2000);';
  if (!h.includes(call)) throw new Error('anchor missing: ejadPollPermissions');
  h = h.replace(call, () => `    async function ejadPost(body) {
      const r = await fetch('/api/action', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
      let j = {}; try { j = await r.json(); } catch (e) { /* no body */ }
      if (r.status === 401) openAuthModal();
      return { ok: r.ok, j: j };
    }
    let ejadSig = '';
    function ejadMk(tag, text, attrs) { const e = document.createElement(tag); if (text) e.textContent = text; Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v)); return e; }
    function ejadBtn(label, onclick) { const b = ejadMk('button', label, { type: 'button', class: 'btn btn-sm' }); b.onclick = onclick; return b; }
    function ejadShow(pre, r, okText) {
      pre.hidden = false;
      pre.textContent = r.j.error ? 'Error: ' + r.j.error + (r.j.plan ? '\\n' + JSON.stringify(r.j.plan) : '') : (r.j.output || (r.j.plan ? JSON.stringify(r.j.plan, null, 1) : okText || 'ok'));
    }
    function ejadTicketBlock(t, hrOk) {
      const box = ejadMk('div', '', { class: 'ejad-ticket', style: 'border:1px solid var(--line, #8884);border-radius:8px;padding:10px 12px;margin-bottom:10px;' });
      box.append(ejadMk('strong', t.id + '  ' + t.title));
      if (t.prUrl) { const a = ejadMk('a', 'Open the draft MR', { href: t.prUrl, target: '_blank', rel: 'noopener', style: 'margin-left:10px;' }); box.append(a); }
      const out = ejadMk('pre', '', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;max-height:220px;overflow:auto;margin:8px 0;' }); out.hidden = true;
      const go = ejadBtn('Deliver now (MR ready, Plane and Ejad HR to Review)', async () => {
        if (!confirm('Deliver ticket ' + t.id + ' now? The MR becomes ready and Plane and Ejad HR move to Review.')) return;
        const r = await ejadPost({ action: 'ejad_deliver', ticket: t.id, dry: false }); ejadShow(out, r, 'Delivered.'); showToast(r.ok ? 'Delivered ' + t.id : 'Delivery failed', r.ok ? undefined : 'bad');
      }); go.disabled = true;
      const check = ejadBtn('Check delivery (dry run)', async () => { const r = await ejadPost({ action: 'ejad_deliver', ticket: t.id, dry: true }); ejadShow(out, r); go.disabled = !(r.ok && r.j.ok); });
      const row1 = ejadMk('div', '', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }); row1.append(check, go);
      const mins = ejadMk('input', '', { type: 'number', min: '1', max: '1440', placeholder: 'minutes', 'aria-label': 'Minutes to log for ' + t.id, style: 'width:90px;' });
      const desc = ejadMk('input', '', { type: 'text', placeholder: 'what was done', 'aria-label': 'Work description for ' + t.id, style: 'flex:1;min-width:200px;' });
      const hrs = (dry) => async () => { const r = await ejadPost({ action: 'ejad_hours', ticket: t.id, minutes: parseInt(mins.value, 10), description: desc.value, dry: dry }); ejadShow(out, r, 'Logged.'); if (!dry) showToast(r.ok ? 'Hours logged (draft, day not submitted)' : 'Could not log hours', r.ok ? undefined : 'bad'); };
      const row2 = ejadMk('div', '', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;' });
      row2.append(mins, desc, ejadBtn('Check hours', hrs(true)), ejadBtn('Log hours', hrs(false)));
      if (!hrOk) row2.append(ejadMk('span', 'Ejad HR credentials (HR_EMAIL / HR_PASS) are not set for the dashboard.', { class: 'note-s' }));
      box.append(row1, row2, out);
      return box;
    }
    async function ejadRefreshRun() {
      try {
        const res = await fetch('/api/ejad/overview', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        const sig = JSON.stringify(d);
        if (sig === ejadSig) return;
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#ejad-delivery')) return;
        ejadSig = sig;
        const line = document.getElementById('ejad-fleet-line');
        line.textContent = '';
        line.append(ejadMk('span', d.loopRunning ? 'Fleet: running. ' : (d.fleetOff ? 'Fleet: stopped by you. ' : 'Fleet: idle, it starts by itself when a ticket is ready. ')));
        line.append(d.loopRunning ? ejadBtn('Stop fleet', async () => { await ejadPost({ action: 'ejad_fleet_stop' }); ejadSig = ''; ejadRefreshRun(); }) : ejadBtn('Start fleet', async () => { await ejadPost({ action: 'ejad_fleet_start' }); ejadSig = ''; setTimeout(ejadRefreshRun, 3000); }));
        const box = document.getElementById('ejad-delivery');
        box.textContent = '';
        if (!d.inReview.length) box.append(ejadMk('p', 'No ticket is waiting for delivery. A ticket appears here when its draft MR is open (status in-review).', { class: 'note-s' }));
        d.inReview.forEach(t => box.append(ejadTicketBlock(t, d.hrConfigured)));
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    ejadRefreshRun(); setInterval(ejadRefreshRun, 10000);
` + call);
  fs.writeFileSync(H, h);
}
console.log('index.html: fleet and delivery panel');

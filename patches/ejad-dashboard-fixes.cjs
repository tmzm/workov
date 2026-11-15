// Ejad: three fixes found while pausing a real fleet (apply after ejad-dashboard-run/pause/overlay):
//  1. A worker the user stopped on purpose (heartbeat note "stopped by the user") is labelled "paused", not "dead",
//     and no longer raises a "worker dead" attention item.
//  2. Pause all no longer depends on the router alone. If the router has not stopped the workers after 6 minutes (or
//     is not running), the dashboard stops the router runs itself, which ends the workers that run inside them, then
//     puts every still-working ticket back to `ready` the way the fleet's own stop does: its heartbeat says stopped
//     by the user, the ledger entry is `paused` (no retry used), the stale stop request is removed.
//  3. The dashboard never starts a second router: it also looks for a running `opencode run --agent router`, treats a
//     failed process lookup as "unknown, do not start", and no longer deletes the loop's pid file.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n'); // the file may mix CRLF and LF; Python reads both
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };

const FN = String.raw`
def ejad_router_runs():
    """PIDs of running router cycles (opencode run --agent router). None when the lookup itself failed."""
    try:
        if os.name == "nt":
            ps = "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Where-Object { $_.CommandLine -match 'run .*--agent router' } | ForEach-Object { $_.ProcessId }"
            r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=30, creationflags=EJAD_NOWIN)
            if r.returncode != 0:
                return None
            out = r.stdout
        else:
            out = subprocess.run(["pgrep", "-f", "opencode run .*--agent router"], capture_output=True, text=True, timeout=10).stdout
        return [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        return None


def ejad_router_busy():
    """True when a router loop or a router cycle may be running (also when we cannot tell): never start another."""
    runs = ejad_router_runs()
    return bool(ejad_loop_pids()) or runs is None or bool(runs)


def ejad_worktree_of(branch):
    try:
        out = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=15, creationflags=EJAD_NOWIN).stdout
    except Exception:
        return None
    for block in out.split("\n\n"):
        if f"branch refs/heads/{branch}" in block:
            m = re.search(r"^worktree (.+)$", block, re.M)
            return Path(m.group(1)) if m else None
    return None


def ejad_atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(dir=str(Path(path).parent))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def ejad_force_stop(tickets):
    """Stop the router runs (their workers end with them), then record the stop for every ticket still in-progress."""
    for pid in (ejad_router_runs() or []) + ejad_loop_pids():
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20, creationflags=EJAD_NOWIN)
        else:
            os.kill(pid, 15)
    now = utc_now_iso()
    still = [t for t in tickets if any(r["id"] == t and r["status"] == "in-progress" for r in ejad_board())]
    if not still:
        return []
    state = ejad_router_state()
    for tid in still:
        entry = ejad_entry(tid)
        if entry and entry.get("branch"):
            wt = ejad_worktree_of(entry["branch"])
            hb = (wt / "job" / "status.json") if wt else None
            if hb and hb.exists():
                try:
                    d = json.loads(hb.read_text(encoding="utf-8-sig"))
                    d.update({"phase": "failed", "note": "stopped by the user (stop_worker): not a failed attempt", "updatedAt": now})
                    ejad_atomic_write(hb, json.dumps(d, indent=2))
                except Exception as e:
                    print(f"[ejad] heartbeat of {tid} not updated: {e}", file=sys.stderr)
            entry["lastPhase"] = "paused"
            entry["lastPhaseAt"] = now
        state["pendingDecisions"] = [x for x in state.get("pendingDecisions", []) if not str(x).startswith(tid + "-")]
        (REPO_ROOT / "job" / "control" / f"{tid}.json").unlink(missing_ok=True)
    ejad_atomic_write(REPO_ROOT / "job" / "router-state.json", json.dumps(state, indent=2))
    board = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
    text = board.read_text(encoding="utf-8")
    for tid in still:
        text = re.sub(rf"^(\|\s*{tid}\s*\|[^|]*\|\s*)in-progress(\s*\|)", lambda m: m.group(1) + "ready      " + m.group(2), text, count=1, flags=re.M)
    ejad_atomic_write(board, text)
    return still


def ejad_finish_pause(queued):
    """Wait for the router to stop the queued workers; whatever it did not stop is stopped here. Then stop the loop."""
    # The router's model needs 12-30 minutes per cycle, so the dashboard does not wait for it. Only a landing in
    # progress (push / MR) is given up to 2 minutes to finish, so it is never cut in the middle.
    deadline = time.time() + 120
    confirmed = True
    while time.time() < deadline and any(str(e.get("lastPhase", "")) in ("merging", "landing") for v in ejad_router_state().values() if isinstance(v, list) for e in v if isinstance(e, dict) and str(e.get("ticket", "")).split("-")[0] in queued):
        time.sleep(3)
    forced = ejad_force_stop(queued)
    ejad_fleet_stop()
    job = REPO_ROOT / "job"
    (job / "pausing.json").unlink(missing_ok=True)
    (job / "paused.json").write_text(json.dumps({"at": utc_now_iso(), "tickets": queued, "confirmed": confirmed, "stoppedByDashboard": forced}), encoding="utf-8")

`;

if (!s.includes('def ejad_force_stop')) {
  // replace the pause patch's finisher with the robust one
  const i = s.indexOf('def ejad_finish_pause(queued):');
  const j = s.indexOf('def ejad_pause_all():');
  if (i < 0 || j < i) throw new Error('anchor missing (apply ejad-dashboard-pause.cjs first): ejad_finish_pause');
  s = s.slice(0, i) + FN.trimStart() + '\n\n' + s.slice(j);

  // Pause all stops the workers itself: no stop_worker requests for the (slow) router to find later
  const q = '    queued = []\n    if ejad_loop_pids():\n        for tid in working:\n            try:\n                write_control_intent(tid, "stop_worker")\n                queued.append(tid)\n            except Exception as e:\n                print(f"[ejad] could not queue stop for {tid}: {e}", file=sys.stderr)\n';
  must(s, q);
  s = s.replace(q, () => '    queued = list(working)\n');

  // 3. never a second router
  const a1 = '    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)\n    log = open(';
  must(s, a1);
  s = s.replace(a1, () => '    log = open(');
  const a2 = '    if ejad_loop_pids():\n        return {"ok": True, "running": True, "note": "already running"}';
  must(s, a2);
  s = s.replace(a2, () => '    if ejad_router_busy():\n        return {"ok": True, "running": True, "note": "already running"}');
  const a3 = 'ejad_wanted() and not ejad_loop_pids():';
  must(s, a3);
  s = s.replace(a3, () => 'ejad_wanted() and not ejad_router_busy():');
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: forced pause, single router');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('stopped by the user')) {
  const re1 = "r.isDead ? h('span', { class: 'plate stop dead-marker', text: 'dead' }) : null,";
  must(h, re1);
  h = h.replace(re1, () => "r.isDead ? h('span', { class: 'plate stop dead-marker', text: /stopped by the user/i.test(r.note || '') ? 'paused' : 'dead' }) : null,");
  const re2 = "flag: a ? (a.isDead ? 'dead' :";
  must(h, re2);
  h = h.replace(re2, () => "flag: a ? (a.isDead ? (/stopped by the user/i.test(a.note || '') ? 'paused' : 'dead') :");
  const re3 = "agentRows.filter(r => r.isDead && r.cls === 'failed').forEach(r => {";
  must(h, re3);
  h = h.replace(re3, () => "agentRows.filter(r => r.isDead && r.cls === 'failed' && !/stopped by the user/i.test(r.note || '')).forEach(r => {");
  fs.writeFileSync(H, h);
}
console.log('index.html: paused label');

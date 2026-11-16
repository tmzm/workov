// Workerov: Pause all / Resume all on the dashboard, so the user can leave (or reboot) and continue where the fleet stopped.
// Pause all: sticky fleet-off (the dashboard stops auto-starting the router loop), a `stop_worker` intent for every
// in-progress ticket (the fleet's own stop: the worker stops, its worktree and commits stay, the ticket goes back to
// `ready`, no retry is used), then, once the router confirms the workers are stopped (or after 6 minutes), the router
// loop is stopped and job/paused.json records it. Tickets that are only waiting for the user's answer stay as they are.
// Resume all: clears the pause and starts the router loop; it dispatches the ready tickets again in their kept
// worktrees. After a reboot the state is the same files, so Resume all works the next day. Builds on
// dashboard-run.cjs (apply it first).
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing (apply dashboard-run.cjs first): ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_finish_pause(queued):
    """Wait for the router to stop the queued workers, then stop the loop and record the pause."""
    deadline = time.time() + 6 * 60
    confirmed = True
    while queued:
        time.sleep(5)
        if not [r for r in wv_board() if r["id"] in queued and r["status"] == "in-progress"]:
            break
        if time.time() > deadline:
            confirmed = False
            break
    wv_fleet_stop()
    job = REPO_ROOT / "job"
    (job / "pausing.json").unlink(missing_ok=True)
    (job / "paused.json").write_text(json.dumps({"at": utc_now_iso(), "tickets": queued, "confirmed": confirmed}), encoding="utf-8")


def wv_pause_all():
    job = REPO_ROOT / "job"
    if (job / "pausing.json").exists():
        return {"ok": True, "pausing": True, "note": "already pausing"}
    working = [r["id"] for r in wv_board() if r["status"] == "in-progress"]
    WV_FLEET_OFF.write_text(utc_now_iso(), encoding="utf-8")
    queued = []
    if wv_loop_pids():
        for tid in working:
            try:
                write_control_intent(tid, "stop_worker")
                queued.append(tid)
            except Exception as e:
                print(f"[wv] could not queue stop for {tid}: {e}", file=sys.stderr)
    (job / "pausing.json").write_text(json.dumps({"startedAt": utc_now_iso(), "tickets": queued}), encoding="utf-8")
    threading.Thread(target=wv_finish_pause, args=(queued,), daemon=True).start()
    return {"ok": True, "pausing": True, "tickets": queued}

`;
if (!s.includes('def wv_pause_all')) {
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);

  const a1 = 'WV_ACTIONS = (';
  must(s, a1);
  s = s.replace(a1, () => 'WV_ACTIONS = ("wv_pause_all", ');

  const a2 = '    if action == "wv_fleet_stop":\n        return 200, wv_fleet_stop()\n';
  must(s, a2);
  s = s.replace(a2, () => a2 + '    if action == "wv_pause_all":\n        return 200, wv_pause_all()\n');

  const a3 = '    WV_FLEET_OFF.unlink(missing_ok=True)\n    if wv_loop_pids():';
  must(s, a3);
  s = s.replace(a3, () => '    WV_FLEET_OFF.unlink(missing_ok=True)\n    (REPO_ROOT / "job" / "paused.json").unlink(missing_ok=True)\n    (REPO_ROOT / "job" / "pausing.json").unlink(missing_ok=True)\n    if wv_loop_pids():');

  const a4 = '    return {"loopRunning": bool(wv_loop_pids()), "fleetOff": WV_FLEET_OFF.exists(), ';
  must(s, a4);
  s = s.replace(a4, () => '    return {"working": [r["id"] for r in wv_board() if r["status"] == "in-progress"], "pausing": (REPO_ROOT / "job" / "pausing.json").exists(), "paused": (REPO_ROOT / "job" / "paused.json").exists(), "loopRunning": bool(wv_loop_pids()), "fleetOff": WV_FLEET_OFF.exists(), ');
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: pause all / resume all');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('wv_pause_all')) {
  const re = /        line\.append\(wvMk\('span', d\.loopRunning[\s\S]*?setTimeout\(wvRefreshRun, 3000\); \}\)\);\n/;
  if (!re.test(h)) throw new Error('anchor missing (apply dashboard-run.cjs first): fleet line');
  h = h.replace(re, () => `        const wk = d.working || [];
        const resume = (label) => wvBtn(label, async () => { await wvPost({ action: "wv_fleet_start" }); wvSig = ""; setTimeout(wvRefreshRun, 3000); });
        if (d.pausing) {
          line.append(wvMk("span", "Pausing: " + (wk.length ? "waiting for " + wk.length + " worker(s) (" + wk.join(", ") + ") to stop; this takes a few seconds. " : "stopping the fleet. ")));
        } else if (d.paused) {
          line.append(wvMk("span", "Paused: nothing is running. Resume all continues where it stopped. "));
          line.append(resume("Resume all"));
        } else if (d.loopRunning) {
          line.append(wvMk("span", "Fleet: running" + (wk.length ? " (" + wk.length + " worker(s) on " + wk.join(", ") + ")" : "") + ". "));
          line.append(wvBtn("Pause all", async () => {
            if (!confirm("Pause everything? Workers working now are stopped (their work and branches are kept, no retry is used) and the fleet stops. Resume all continues from the same place, also tomorrow or after a restart.")) return;
            const r = await wvPost({ action: "wv_pause_all" });
            showToast(r.ok ? "Pausing: it takes a minute or two" : (r.j.error || "Could not pause"), r.ok ? undefined : "bad");
            wvSig = ""; setTimeout(wvRefreshRun, 1500);
          }));
        } else {
          line.append(wvMk("span", d.fleetOff ? "Fleet: stopped. " : "Fleet: idle, it starts by itself when a ticket is ready. "));
          line.append(resume(d.fleetOff ? "Resume all" : "Start fleet"));
        }
`);
  fs.writeFileSync(H, h);
}
console.log('index.html: pause all / resume all');

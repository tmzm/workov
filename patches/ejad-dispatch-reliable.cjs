// Ejad: dispatching works once, and the board tells the truth (apply after ejad-dashboard-agentmodels.cjs).
// Found on tickets 009 to 011: three workers were running while the board showed all three as "ready", because the
// router (a weak free model) skipped its own step of flipping the row to "in-progress"; and "Dispatch now" waited for
// the router loop's 90 s sleep. So the owner clicked Dispatch five times.
//  1. the dashboard flips a "ready" row to "in-progress" itself (and rd.md's Status) when the ledger lists the ticket and
//     a worker session for it was active in the last 4 minutes. It never flips anything back.
//  2. the router loop sleeps in 3 s steps and starts the next cycle as soon as job/control/_dispatch.json appears.
//  3. the Router panel says when a dispatch is waiting for the router to pick it up.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const L = '.claude/scripts/ejad-router-loop.sh';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

let s = rd(S);
if (!s.includes('def ejad_board_sync')) {
  const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
  const sub = (a, b) => { must(a); s = s.replace(a, () => b); };
  sub('\ndef ejad_run_action(action, req, tid):', String.raw`
def ejad_board_sync_once():
    """Flip ready -> in-progress for tickets that have a live worker. Returns the ids flipped."""
    try:
        ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        return []
    listed = {str(d.get("ticket", ""))[:3] for d in (ledger.get("dispatched") or []) if isinstance(d, dict)}
    rows = [r for r in ejad_board() if r["status"] == "ready" and r["id"] in listed]
    if not rows:
        return []
    live = {t for t, agents in ejad_agent_models().get("tickets", {}).items() if any(a["agent"] == "worker" and a["agoSec"] < 240 for a in agents)}
    todo = [r["id"] for r in rows if r["id"] in live]
    if not todo:
        return []
    board = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
    with _board_lock:
        text = board.read_text(encoding="utf-8")
        for n in todo:
            text = re.sub(r"^(\|\s*" + n + r"\s*\|[^|]*\|\s*)ready(\s*)\|", lambda m: m.group(1) + "in-progress" + (" " * max(0, len(m.group(2)) - 6)) + ("" if len(m.group(2)) > 6 else " ") + "|", text, count=1, flags=re.M)
        write_board_atomic(board, text)
    for n in todo:
        tdir = resolve_ticket_dir(n)
        rdp = tdir / "rd.md" if tdir else None
        if rdp and rdp.is_file():
            try:
                t = rdp.read_text(encoding="utf-8")
                nt = re.sub(r"^(\*\*Status:\*\*\s*)ready\b", r"\1in-progress", t, count=1, flags=re.M)
                if nt != t:
                    rdp.write_text(nt, encoding="utf-8")
            except OSError:
                pass
    print(f"[ejad] board sync: {', '.join(todo)} -> in-progress (a live worker exists)", file=sys.stderr)
    return todo


def ejad_board_sync():
    time.sleep(45)
    while True:
        try:
            ejad_board_sync_once()
        except Exception as e:
            print(f"[ejad] board sync failed: {e}", file=sys.stderr)
        time.sleep(15)


threading.Thread(target=ejad_board_sync, daemon=True).start()

` + '\ndef ejad_run_action(action, req, tid):');
  // the Router panel says when a dispatch is waiting
  sub('    return {"state": state, "text": text, "model": model,', '    try:\n        pend = REPO_ROOT / "job" / "control" / "_dispatch.json"\n        if pend.exists() and state in ("working", "waiting", "slow", "stopped"):\n            text = "Dispatch requested " + str(int(now - pend.stat().st_mtime)) + " s ago: the router starts a cycle within seconds. " + text\n    except OSError:\n        pass\n    return {"state": state, "text": text, "model": model,');
  fs.writeFileSync(S, s);
}

if (fs.existsSync(L)) {
  let l = rd(L);
  if (!l.includes('_dispatch.json ]')) {
    const a = '  sleep "$INTERVAL"';
    if (!l.includes(a)) throw new Error('anchor missing in ejad-router-loop.sh: sleep');
    l = l.replace(a, () => '  # wake early when the dashboard queues a dispatch (job/control/_dispatch.json), instead of sleeping the whole interval\n  waited=0\n  while [ "$waited" -lt "$INTERVAL" ] && [ ! -f job/control/_dispatch.json ]; do sleep 3; waited=$((waited + 3)); done');
    fs.writeFileSync(L, l);
  }
}
console.log('dispatch-reliable patch applied');

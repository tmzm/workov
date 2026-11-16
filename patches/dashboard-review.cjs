// Workerov: hand a finished ticket to Claude from the dashboard, then deliver. Builds on dashboard-run.cjs (apply it
// first). When the fleet has landed a ticket (draft MR open, status in-review) the "Fleet and delivery" panel offers:
//   - Review with Claude: runs review.cjs (agent wv-reviewer: code review, security review, simplify) on the
//     ticket's branch. Clean -> Deliver is the next step. Findings -> they go back to the fleet as a Rework and the
//     ticket returns here when fixed. Costs one Sonnet run on the user's Claude subscription, so it is never automatic.
//   - Check delivery / Deliver now (the existing buttons): skip the review and deliver as it is.
//   - End without delivering: the ticket is marked done on the board and nothing is pushed to Plane or Ejad HR.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing (apply dashboard-run.cjs first): ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_review_state_file(tid):
    return REPO_ROOT / "job" / f"review-{tid}.json"


def wv_branch_head(branch):
    try:
        return subprocess.run(["git", "rev-parse", f"refs/heads/{branch}"], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=15, creationflags=WV_NOWIN).stdout.strip()
    except Exception:
        return ""


def wv_review_info(tid, branch):
    try:
        d = json.loads(wv_review_state_file(tid).read_text(encoding="utf-8"))
    except Exception:
        return {"state": "none"}
    state = d.get("state", "none")
    if state == "running":
        try:
            started = datetime.strptime(d.get("startedAt", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - started).total_seconds() > 45 * 60:
                state = "failed"
        except ValueError:
            state = "failed"
    head = wv_branch_head(branch) if branch else ""
    return {"state": state, "findings": d.get("findings", 0), "current": (not head) or head == d.get("commit"), "cost": d.get("cost")}


def wv_review(tid, by):
    e = wv_entry(tid) or {}
    branch = e.get("branch") or ""
    row = next((r for r in wv_board() if r["id"] == tid), None)
    if not row or row["status"] != "in-review" or not branch:
        return 409, {"error": f"Ticket {tid} is not in-review with a recorded branch."}
    if wv_review_info(tid, branch)["state"] == "running":
        return 409, {"error": f"A Claude review of ticket {tid} is already running."}
    wv_review_state_file(tid).write_text(json.dumps({"ticket": tid, "branch": branch, "commit": wv_branch_head(branch), "by": by, "state": "running", "startedAt": utc_now_iso()}), encoding="utf-8")
    log = open(REPO_ROOT / "job" / f"review-{tid}.out", "ab")
    subprocess.Popen(["node", ".claude/scripts/review.cjs", tid, "--by", by], cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     creationflags=WV_DETACH if os.name == "nt" else 0, start_new_session=(os.name != "nt"))
    return 200, {"ok": True, "started": True, "note": "Claude review started; follow it in the ticket's Logs tab."}


def wv_end(tid):
    board = REPO_ROOT / "specs" / "tickets" / "BOARD.md"
    text = board.read_text(encoding="utf-8")
    new, n = re.subn(rf"^(\|\s*{tid}\s*\|[^|]*\|\s*)in-review(\s*\|)", lambda m: m.group(1) + "done     " + m.group(2), text, count=1, flags=re.M)
    if not n:
        return 409, {"error": f"Ticket {tid} is not in-review."}
    board.write_text(new, encoding="utf-8")
    return 200, {"ok": True, "note": "Ticket ended: marked done on the board. Nothing was delivered to Plane or Ejad HR."}

`;
if (!s.includes('def wv_review(')) {
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);
  const a1 = 'WV_ACTIONS = ("wv_fleet_start", "wv_fleet_stop", "wv_deliver", "wv_hours")';
  must(s, a1);
  s = s.replace(a1, () => 'WV_ACTIONS = ("wv_fleet_start", "wv_fleet_stop", "wv_deliver", "wv_hours", "wv_review", "wv_end")');
  const a2 = '    dry = req.get("dry") is not False\n';
  must(s, a2);
  s = s.replace(a2, () => '    if action == "wv_review":\n        by = str(req.get("by", "claude"))\n        return wv_review(tid, by) if by in ("claude", "fleet", "both") else (400, {"error": "by must be claude, fleet or both"})\n    if action == "wv_end":\n        return wv_end(tid)\n' + a2);
  const a3 = '"prUrl": pr if pr.startswith("https://") else ""})';
  must(s, a3);
  s = s.replace(a3, () => '"prUrl": pr if pr.startswith("https://") else "", "review": wv_review_info(r["id"], e.get("branch") or "")})');
  const g = '        if path == "/api/wv/overview":';
  must(s, g);
  s = s.replace(g, () => `        if path.startswith("/api/wv/review/"):
            tid_rv = path.rsplit("/", 1)[1]
            tdir_rv = resolve_ticket_dir(tid_rv) if is_valid_ticket_id(tid_rv) else None
            rv_file = (tdir_rv / "review.md") if tdir_rv else None
            if not rv_file or not rv_file.exists():
                self._send_json(404, {"error": "No review.md for this ticket yet."})
                return
            self._send_json(200, {"text": rv_file.read_text(encoding="utf-8")[:12000]})
            return

` + g);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: Claude review and end ticket');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('wvReviewText')) {
  const row = "const row1 = wvMk('div', '', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }); row1.append(check, go);";
  must(h, row);
  h = h.replace(row, () => `const rv = t.review || { state: "none" };
      const rvLine = wvMk("p", wvReviewText(rv), { class: "note-s", style: "margin:8px 0 0;" });
      const showRv = wvBtn("Show review", async () => {
        const r = await fetch("/api/wv/review/" + t.id, { headers: getAuthHeaders() });
        let j = {}; try { j = await r.json(); } catch (e) { /* no body */ }
        out.hidden = false; out.textContent = j.text || j.error || "No review yet.";
      });
      const who = wvMk("select", "", { "aria-label": "Who reviews ticket " + t.id });
      [["claude", "Claude (code, security, simplify)"], ["fleet", "Fleet reviewer (OpenCode, free of Claude usage)"], ["both", "Both: Claude and the fleet reviewer"]].forEach(([v, l]) => who.append(wvMk("option", l, { value: v })));
      const review = wvBtn(rv.state === "none" ? "Start review" : "Review again", async () => {
        const by = who.value;
        const names = { claude: "Claude", fleet: "the fleet reviewer", both: "Claude and the fleet reviewer" }[by];
        if (!confirm("Start the final review of ticket " + t.id + " by " + names + "?" + (by === "fleet" ? "" : " Claude runs once on your Claude subscription.") + " If it finds problems, the ticket goes back to the fleet to fix them; if it is clean you can deliver.")) return;
        const r = await wvPost({ action: "wv_review", ticket: t.id, by: by });
        showToast(r.ok ? "Review by " + names + " started for " + t.id + " (see the Logs tab)" : (r.j.error || "Could not start the review"), r.ok ? undefined : "bad");
        wvSig = ""; setTimeout(wvRefreshRun, 2500);
      });
      review.disabled = rv.state === "running"; who.disabled = rv.state === "running";
      const end = wvBtn("End without delivering", async () => {
        if (!confirm("End ticket " + t.id + " without delivering? It is marked done on the board; the MR stays a draft and Plane and Ejad HR are not touched.")) return;
        const r = await wvPost({ action: "wv_end", ticket: t.id });
        showToast(r.ok ? "Ticket " + t.id + " ended" : (r.j.error || "Could not end the ticket"), r.ok ? undefined : "bad");
        wvSig = ""; wvRefreshRun();
      });
      check.textContent = "Skip review: check delivery (dry run)";
      const row1 = wvMk("div", "", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;" }); row1.append(who, review, check, go, end, showRv);`);
  const box = "box.append(row1, row2, out);";
  must(h, box);
  h = h.replace(box, () => 'box.append(rvLine, row1, row2, out);');
  const fnAnchor = '    function wvTicketBlock(t, hrOk) {';
  must(h, fnAnchor);
  h = h.replace(fnAnchor, () => `    function wvReviewText(rv) {
      const n = rv.findings || 0;
      if (rv.state === "running") return "Final review: running now (follow it in the ticket's Logs tab).";
      if (rv.state === "clean") return rv.current ? "Final review: clean. Next step: check delivery, then deliver." : "Final review: clean, but the branch changed since. Review again or deliver as it is.";
      if (rv.state === "findings") return rv.current ? "Final review: " + n + " finding(s) were sent back to the fleet." : "Final review: " + n + " finding(s) in an earlier round; the branch changed since. Review again or deliver.";
      if (rv.state === "failed") return "The final review failed or stopped. See the Logs tab, then try again or skip it.";
      return "Choose who reviews (Claude, the fleet reviewer or both), or skip the review and check delivery, or end the ticket without delivering.";
    }
` + fnAnchor);
  fs.writeFileSync(H, h);
}
console.log('index.html: review, skip and end buttons');

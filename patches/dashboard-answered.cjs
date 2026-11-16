// Workerov: once you answer, everything says so (apply after dashboard-issue.cjs).
// Before: after "Send decision" the Needs-you row kept saying "Decision" with an Answer button, the count still asked for
// you, and the dialog/drawer looked untouched until the worker moved. Now /api/state carries answers{NNN:{text,at,state}}
// (state: saved = the router has not passed it on yet, delivered = it has) and the page shows, in every place:
//   - the Needs-you row: "Answered", your words, saved/delivered, a "Change answer" button, and it no longer counts as needing you
//   - the Answer dialog: "Answered" title, a status note with your words, "Send a new answer"
//   - the ticket drawer: the callout reads "You answered", the action button "Answered, change answer"
//   - the toast after sending says what happens next
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def get_answers')) {
  const FN = String.raw`def get_answers() -> dict:
    """{"NNN": {"text","at","state","answered"}} from specs/tickets/*/user-decision.md.
    state: "delivered" when the router has passed that answer to the worker, else "saved". An answer stops counting as the
    current one 15 minutes after it was delivered (the worker may be asking something new) or 6 hours after it was saved."""
    out = {}
    try:
        ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        ledger = {}
    fwd = {}
    for f in (ledger.get("forwardedDecisions") or []) if isinstance(ledger, dict) else []:
        if isinstance(f, dict):
            parts = str(f.get("path", "")).replace("\\", "/").split("/")
            if len(parts) >= 2 and str(f.get("submitted", "")):
                fwd[parts[-2][:3]] = max(fwd.get(parts[-2][:3], ""), str(f["submitted"]))
    now = time.time()
    for p in glob.glob(str(REPO_ROOT / "specs" / "tickets" / "*" / "user-decision.md")):
        try:
            txt = Path(p).read_text(encoding="utf-8")
            num = Path(p).parent.name[:3]
            m = re.search(r"\*\*Submitted:\*\*\s*(\S+)", txt)
            at = m.group(1) if m else ""
            body = txt.split("## Instructions", 1)[-1].strip()
            age = now - datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
            delivered = bool(fwd.get(num)) and fwd[num] >= at
            out[num] = {"text": body[:300], "at": at, "state": "delivered" if delivered else "saved", "answered": age < (900 if delivered else 21600)}
        except Exception:
            continue
    return out


`;
  must(s, 'def get_pipeline_state() -> dict:');
  s = s.replace('def get_pipeline_state() -> dict:', () => FN + 'def get_pipeline_state() -> dict:');
  must(s, '                "pipeline": get_pipeline_state(),\n');
  s = s.replace('                "pipeline": get_pipeline_state(),\n', () => '                "pipeline": get_pipeline_state(),\n                "answers": get_answers(),\n');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('function answerFor(')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  const HELPERS = String.raw`function answerFor(id) { const a = stateData && stateData.answers && stateData.answers[pipelineNum(id)]; return a && a.answered ? a : null; }
    function answerLine(a) {
      let at = '';
      try { at = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { /* keep empty */ }
      return 'You answered' + (at ? ' at ' + at : '') + ': “' + a.text + '”. ' + (a.state === 'delivered' ? 'Delivered to the worker.' : 'Saved; the router passes it to the worker on its next cycle.');
    }
    function wvAnswerNote(id) {
      const a = answerFor(id);
      let n = document.getElementById('wv-answered-note');
      if (!n) {
        n = document.createElement('p'); n.id = 'wv-answered-note'; n.className = 'callout'; n.setAttribute('role', 'status');
        const f = document.getElementById('decision-input').closest('.field'); f.parentNode.insertBefore(n, f);
      }
      n.hidden = !a;
      if (a) n.textContent = '✓ ' + answerLine(a) + ' Send a new answer below to change it.';
      setText($('#decision-send'), a ? 'Send a new answer' : 'Send decision');
      setText($('#decision-title'), a ? 'Answered' : 'Answer the worker');
    }
    `;
  sub('    function needsDecision(id) {', '    ' + HELPERS + 'function needsDecision(id) {');
  sub("rows.push({ kind: 'decision', ticket: t.id, title: t.title || '', note: workerNoteFor(num) });", "rows.push({ kind: 'decision', ticket: t.id, title: t.title || '', note: workerNoteFor(num), answer: answerFor(t.id) });");
  sub("const kindLabel = r.kind === 'stalled' ? 'Stalled ' + r.age : k.label;", "const kindLabel = r.answer ? 'Answered' : (r.kind === 'stalled' ? 'Stalled ' + r.age : k.label);");
  sub("? (r.note || 'The worker is waiting for your answer.')", "? (r.answer ? answerLine(r.answer) : (r.note || 'The worker is waiting for your answer.'))");
  const old = "if (r.kind === 'decision') acts.push(h('button', { type: 'button', class: 'btn primary', 'data-fkey': 'row:decision:' + r.ticket + ':answer', disabled: !authed, onclick: () => openDecisionModal(r.ticket) }, 'Answer'));";
  sub(old, "if (r.kind === 'decision') acts.push(h('button', { type: 'button', class: r.answer ? 'btn' : 'btn primary', 'data-fkey': 'row:decision:' + r.ticket + ':answer', disabled: !authed, onclick: () => openDecisionModal(r.ticket) }, r.answer ? 'Change answer' : 'Answer'));");
  sub("h('span', { class: 'lamp ' + k.lamp + ' lit', 'aria-hidden': 'true' }), h('span', { class: 'kind ' + k.tone, text: kindLabel })", "h('span', { class: 'lamp ' + (r.answer ? 'run' : k.lamp) + ' lit', 'aria-hidden': 'true' }), h('span', { class: 'kind ' + (r.answer ? 'info' : k.tone), text: kindLabel })");
  sub("const rows = computeAttention(agentRows);\n      const n = rows.length;", "const rows = computeAttention(agentRows);\n      const n = rows.filter(r => !r.answer).length; // an answered question no longer needs you");
  sub("const needRows = attRows.filter(r => r && r.ticket);", "const needRows = attRows.filter(r => r && r.ticket && !r.answer);");
  sub("      $('#decision-input').value = '';\n      openLayer($('#decision-modal')", "      $('#decision-input').value = '';\n      wvAnswerNote(ticketId);\n      openLayer($('#decision-modal')");
  sub("      if (need) setText($('#drawer-question'), workerNoteFor(pipelineNum(currentTicket)) || 'The worker is waiting for your answer.');",
    "      const ans = need ? answerFor(currentTicket) : null;\n      if (need) setText($('#drawer-question'), ans ? answerLine(ans) : (workerNoteFor(pipelineNum(currentTicket)) || 'The worker is waiting for your answer.'));\n      setText($('#drawer-callout .head span:last-child'), ans ? 'You answered' : 'The worker is waiting for you');\n      $('#drawer-callout .lamp').className = 'lamp ' + (ans ? 'run' : 'attn') + ' lit';\n      setText($('#drawer-decision-send'), ans ? 'Send a new answer' : 'Send decision');");
  sub("onclick: () => openDecisionModal(ticketId) }, 'Answer the worker'));", "onclick: () => openDecisionModal(ticketId) }, answerFor(ticketId) ? 'Answered ✓ change answer' : 'Answer the worker'));");
  sub("showToast('Decision saved to the ticket folder.');", "showToast('Answer sent. The router passes it to the worker on its next cycle.');");
  fs.writeFileSync(H, h);
}
console.log('answered patch applied');

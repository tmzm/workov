// Workerov: make the dashboard's "Answer the worker" box say what is being asked. worker-fleet shows only the worker's
// last status note there, which is often stale or technical ("plan check fixes applied, draft"). The box now says in
// plain words what the worker waits for, what to type to accept, and what to do to change something. When the ticket
// has a mockup it says that the mockup is waiting for approval and where to look at it.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('wv-decision-help')) {
  const q = '<q id="decision-question"></q>';
  if (!h.includes(q)) throw new Error('anchor missing: decision-question');
  h = h.replace(q, () => q + '\n    <p id="wv-decision-help" class="note-s" style="margin:8px 0 12px;line-height:1.5;"></p>');

  const old = "setText($('#decision-question'), workerNoteFor(pipelineNum(ticketId)) || 'The worker did not leave a question. Write your instructions.');";
  if (!h.includes(old)) throw new Error('anchor missing: openDecisionModal question');
  h = h.replace(old, () => `const wvNote = workerNoteFor(pipelineNum(ticketId)) || '';
      setText($('#decision-question'), wvNote ? 'Last note from the worker: ' + wvNote : 'The worker did not leave a note.');
      wvDecisionHelp(ticketId, wvNote);`);

  const fn = '    function openDecisionModal(ticketId) {';
  if (!h.includes(fn)) throw new Error('anchor missing: openDecisionModal');
  h = h.replace(fn, () => `    async function wvDecisionHelp(ticketId, note) {
      const el = $('#wv-decision-help');
      const how = ' Type "approve" to accept and continue, or write what to change.';
      setText(el, 'The worker is stopped and waiting for your answer.' + how);
      try {
        const res = await fetch('/api/mockup/' + encodeURIComponent(String(ticketId).slice(0, 3)), { headers: getAuthHeaders() });
        if (res.ok) setText(el, 'WHAT IS ASKED: approve the mockup (the screen design) before the worker writes any code. Open this ticket and look at its Mockup tab first.' + how + ' The worker will then build it, or redo the mockup with your changes.');
      } catch (e) { /* the generic text stays */ }
    }
` + fn);
  fs.writeFileSync(H, h);
}
console.log('index.html: decision help');

// Workerov: restart a failed or dead ticket cleanly. The action wv_retry_ticket resets the ticket's retry budget, clears its
// death record in the router's ledger and sets its board row to ready, so the next dispatch is a properly tracked attempt 1
// (moving the board status by hand leaves the router counting the old attempts, and the ticket stays "exhausted").
// Server only; the dashboard's Restart button on a dead worker calls this action. Idempotent.
const fs = require('fs');
const path = require('path');
const F = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(F, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (!s.includes('def wv_retry_ticket')) {
  const fn = fs.readFileSync(path.join(__dirname, 'retry-ticket.py.txt'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^WV_ACTIONS = \([^\n]*\)\n/m.exec(s);
  if (!m) throw new Error('anchor missing: WV_ACTIONS');
  const withAction = m[0].replace(/"\)\n$/, '", "wv_retry_ticket")\n');
  s = s.replace(m[0], withAction + '\n\n' + fn);
  const d = '    if action == "wv_router_restart":';
  if (!s.includes(d)) throw new Error('anchor missing: wv_router_restart dispatch');
  s = s.replace(d, '    if action == "wv_retry_ticket":\n        return wv_retry_ticket(tid)\n' + d);
  fs.writeFileSync(F, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log('retry-ticket patched');
}

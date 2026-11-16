// Workerov: a check that cannot run because something is missing (a test account, a credential, a tool) is never skipped
// on an agent's own decision. The tester and checker report NEEDS-USER with the exact need; the worker then blocks the
// ticket through the fleet's existing decision flow (phase "blocked", the dashboard's Decision row and push) with two
// options; only the owner's answer in user-decision.md allows a SKIP. The planner names the accounts a ticket needs and
// always lands through a draft MR. Idempotent; applied to the agent files in .claude/agents and .opencode/agents.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-ask-before-skip -->';
const END = '<!--/ wv-ask-before-skip -->';
const BLOCKS = {
  tester: `## Missing access: ask, never skip

If a check cannot run because something it needs is missing (a test account for a role, a credential, a seeded record,
a tool), do NOT return SKIP and do NOT write "missing credentials" evidence. Return a line
\`NEEDS-USER <check id>: <the exact thing that is missing>; options: A) skip this check and note it in the MR, B) the owner
provides it and the ticket retries\` and stop the other checks only if they depend on it. A SKIP is allowed only when
\`user-decision.md\` already holds the owner's answer to exactly this question.`,
  checker: `## Missing access: ask, never skip

If a check cannot run because something it needs is missing (a test account, a credential, a tool), report
\`NEEDS-USER <check id>: <what is missing>\` instead of SKIP. Only \`user-decision.md\` can authorise a skip.`,
  worker: `## Missing access: block and ask

When the tester or checker reports \`NEEDS-USER\`, or you find that something a required check needs is missing (a test
account, a credential), do not mark the check skipped and do not finish the ticket. Block it with the existing decision
flow: heartbeat \`"phase": "blocked"\` with the question and the two options (A: skip it and say so in the MR; B: the
owner provides it and you retry) in \`"note"\`, and send the one push as described above. Continue only after
\`user-decision.md\` holds the answer.`,
  'wv-planner': `## Accounts and landing

- Every ticket gets \`## Landing\` with \`- Mode: pr\` (a draft MR, then the owner's review and delivery choices).
- When a check or screenshot needs a test account of a particular role, name the role in the plan's open questions as a
  decision for the owner (does the account exist, or should it be created), so nobody discovers it at test time.`,
};
let n = 0;
for (const dir of ['.claude/agents', '.opencode/agents']) {
  for (const [name, text] of Object.entries(BLOCKS)) {
    const f = path.join(dir, name + '.md');
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    const crlf = s.includes('\r\n');
    s = s.replace(/\r\n/g, '\n');
    if (s.includes(MARK)) continue;
    const block = `${MARK}\n${text}\n${END}\n\n`;
    const m = /^---\n[\s\S]*?\n---\n/.exec(s);
    s = m ? s.slice(0, m[0].length) + '\n' + block + s.slice(m[0].length).replace(/^\n+/, '') : block + s;
    fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
    n++;
  }
}
if (n) console.log('ask-before-skip rules added to ' + n + ' agent files');

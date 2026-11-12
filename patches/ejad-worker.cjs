// Adds the implementer and mockup rules to both worker agent files.
const fs = require('fs');
const LF = (s) => s.split('\r\n').join('\n');
const add = `- **Implementer:** if rd.md has \`## Implementer\` naming \`copilot\`, \`kilo\` or \`antigravity\` (default: you build it yourself), delegate each implementation step from rd.md with \`bash .claude/scripts/delegate-task.sh <cli> exec "<step>"\`, then read and fix the diff yourself before the next step. The tester and reviewer gates are unchanged. If the CLI is missing or fails, build the step yourself and note it in results.md.
- **Mockup first:** if rd.md has \`## Mockup\` and the ticket folder has no \`mockup.html\`, your first job is the mockup: one self-contained HTML file \`specs/tickets/NNN-slug/mockup.html\` (no external scripts, fonts or images; inline SVG icons) following that section: a states switcher, every app language with RTL, light and dark, phone first, only what the API can do. Commit it, set your heartbeat to \`blocked\` with the note \`Mockup ready: open the ticket's Mockup tab, then answer approve or your changes\`, fire \`bash .claude/scripts/notify.sh worker_blocked 'Ticket NNN: mockup ready for approval' NNN || true\`, and return to the router. Build the feature only after user-decision.md approves it; apply requested changes to the mockup first.
`;
for (const f of ['.claude/agents/worker.md', '.opencode/agents/worker.md']) {
  let t = LF(fs.readFileSync(f, 'utf8'));
  if (!t.includes('**Mockup first:**')) t = t.replace('\n# Inputs Provided by Router', add + '\n# Inputs Provided by Router');
  fs.writeFileSync(f, t);
  console.log(f, t.includes('**Mockup first:**'));
}

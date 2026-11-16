// Workerov: the router coordinates; it never runs the project's install, test, lint, build or e2e itself. Doing so made
// router cycles last 15+ minutes (queued behind the machine-wide lock, 6 GB per run) and the dashboard called it stuck.
// Checks belong to the tester and checker agents; the router only dispatches them and reads their results.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-router-no-heavy -->';
const END = '<!--/ wv-router-no-heavy -->';
const TEXT = `## The router runs no project checks

Never run \`pnpm\`/\`npm\`/\`ng\` install, test, lint, build or e2e yourself, not even to "verify" a merged ticket or a
worktree. Read the ticket's \`results.md\`, \`results.json\` and the board instead; if a check is really needed, dispatch
the tester or checker for that ticket. Keep every cycle short: reconcile, dispatch, report.`;
let n = 0;
for (const dir of ['.claude/agents', '.opencode/agents']) {
  const f = path.join(dir, 'router.md');
  if (!fs.existsSync(f)) continue;
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (s.includes(MARK)) continue;
  const block = `${MARK}\n${TEXT}\n${END}\n\n`;
  const m = /^---\n[\s\S]*?\n---\n/.exec(s);
  s = m ? s.slice(0, m[0].length) + '\n' + block + s.slice(m[0].length).replace(/^\n+/, '') : block + s;
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  n++;
}
if (n) console.log('router no-heavy rule added to ' + n + ' files');

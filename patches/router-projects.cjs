// Workerov: one router for every project. The router's instructions are written for one repository (relative paths such as
// job/ and specs/). Each cycle's message now names a PROJECT and its HOME folder; this block tells the router to read every
// such path under HOME. The permission plugin enforces it (.opencode/wv/router-scope.mjs). Idempotent.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-router-projects -->';
const END = '<!--/ wv-router-projects -->';
const TEXT = `## One router, several projects

You are the only router on this computer and you serve every registered project, one project per cycle. Your working folder is
the hub, not the project. Each cycle message starts with \`PROJECT <name>, HOME <absolute path>\`. For that cycle:

- Every path in these instructions that starts with \`job/\`, \`specs/\`, \`.claude/\` or \`.opencode/\` means the same path under HOME.
  Read and write it by absolute path (\`HOME/job/router-state.json\`), never by a relative one.
- Start every shell command with \`cd "HOME" && \`, including \`git\`, \`node .claude/scripts/...\` and \`bash .claude/scripts/...\`.
- Work on that project only. Never read the state of another project to decide anything, and never write outside HOME; the
  permission plugin denies it. If a call is denied because a path was relative, repeat it with HOME.
- Keep the ledger per project: \`HOME/job/router-state.json\` and \`HOME/specs/tickets/BOARD.md\` are that project's. Do not carry
  tickets, ports or worker ids from one cycle's project into the next.`;
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
if (n) console.log('router-projects rule added to ' + n + ' router files');

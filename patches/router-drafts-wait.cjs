// Workerov: a Draft ticket waits for the owner. The router once started a draft by itself (the plan, an approved mockup and
// old branches made it look ready), flipped the board row and recreated worktrees. Only the owner's Dispatch (board status
// `ready`) starts work. Idempotent; applied to the router's agent files.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-drafts-wait -->';
const END = '<!--/ wv-drafts-wait -->';
const TEXT = `## Drafts wait for the owner

Dispatch a ticket only when its board status is \`ready\`. Never change a ticket from \`draft\`, \`specifying\` or \`blocked\` to
\`ready\` or \`in-progress\` yourself, and never create a worktree or start a worker for one, however complete its plan,
mockup or earlier branches look. Old branches and worktree leftovers of a draft ticket are history, not work to resume;
report them in your summary line and leave them alone.`;
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
if (n) console.log('drafts-wait rule added to ' + n + ' router files');

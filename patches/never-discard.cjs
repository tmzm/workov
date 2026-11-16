// Workerov: no agent may throw away work. On 2026-11-16 a router cycle pruned a dead worker's worktree and cleaned the
// main checkout, which deleted the worker's uncommitted edits and the ticket's approved mockup (untracked files that were
// never committed). Before any worktree is removed or any reset/clean is run, the work is salvaged; a dead worker never
// justifies deleting its files. Idempotent; applied to the agent files in .claude/agents and .opencode/agents.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-never-discard -->';
const END = '<!--/ wv-never-discard -->';
const TEXT = `## Never discard work

- Never run \`git clean\`, \`git checkout -- .\`, \`git reset --hard\`, \`git stash drop\`, \`git worktree remove --force\` or delete a
  ticket folder or worktree directory while it holds uncommitted or untracked files. A dead or stale worker is a reason to
  reset the ticket's state, never to delete its files.
- Before a worktree is pruned or removed for any reason, salvage it: copy every uncommitted and untracked file (including
  \`specs/tickets/NNN-*/\` files such as mockups, notes and evidence) to \`job/salvage/NNN-<timestamp>/\`, and write
  \`salvage.patch\` from \`git diff HEAD\`. Only then may the worktree be removed, and the router reports the salvage path.
- Mockups, notes and evidence that are not committed are the owner's approved material: never touch them in the main
  checkout.`;
const NAMES = ['router', 'orchestrator', 'merger', 'watchdog', 'reproducer', 'worker', 'implementer', 'teammate', 'checker', 'tester'];
let n = 0;
for (const dir of ['.claude/agents', '.opencode/agents']) {
  for (const name of NAMES) {
    const f = path.join(dir, name + '.md');
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
}
if (n) console.log('never-discard rules added to ' + n + ' agent files');

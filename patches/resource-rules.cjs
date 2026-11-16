// Workerov: tell every fleet agent how to treat a small machine. Three parallel `ng test` runs (each starts a headless
// Chromium), two `npm install` runs and a lint at once ran a 16 GB laptop out of memory and broke the fleet's database.
//  - use the package manager the project pins (package.json "packageManager"), never npm in a pnpm project;
//  - run install, test, build and lint through heavy-run.sh, which lets one such command run at a time on the machine.
// Applied to the agent files in .claude/agents and .opencode/agents; idempotent.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-resource-rules -->';
const BLOCK = `${MARK}
## Machine limits (read first)

- Install and run scripts with the package manager named in \`package.json\` under \`packageManager\` (pnpm in this
  project). Never use \`npm\` or \`yarn\` there and never create another lockfile. Skip \`install\` when \`node_modules\`
  exists and \`package.json\` and the lockfile did not change.
- Run every memory-heavy command (install, test, build, lint, e2e) through the machine-wide lock, so only one runs at a
  time: \`bash .claude/scripts/heavy-run.sh <command...>\`, for example
  \`bash .claude/scripts/heavy-run.sh pnpm test --watch=false --include <one spec path>\`.
  Prefer running only the specs you changed over the whole suite until the final check.
${MARK.replace('<!--', '<!--/')}

`;
const NAMES = ['router', 'orchestrator', 'worker', 'implementer', 'tester', 'merger', 'checker', 'teammate', 'reproducer', 'reviewer', 'planner', 'watchdog'];
let n = 0;
for (const dir of ['.claude/agents', '.opencode/agents']) {
  for (const name of NAMES) {
    const f = path.join(dir, name + '.md');
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    const crlf = s.includes('\r\n');
    s = s.replace(/\r\n/g, '\n');
    if (!s.includes(MARK)) {
      const m = /^---\n[\s\S]*?\n---\n/.exec(s);
      s = m ? s.slice(0, m[0].length) + '\n' + BLOCK + s.slice(m[0].length).replace(/^\n+/, '') : BLOCK + s;
      n++;
    }
    s = s.split('(e.g., `npm run lint && npm run build`)').join('(e.g., `bash .claude/scripts/heavy-run.sh pnpm lint`, then `bash .claude/scripts/heavy-run.sh pnpm build`)');
    fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  }
}
if (n) console.log('resource rules added to ' + n + ' agent files');

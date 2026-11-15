// Ejad: a ticket can land ON an existing branch (apply after ejad-windows.cjs; edits .claude/scripts/ejad-land.cjs).
// Use it for a review comment on an open MR: the fix must reach that MR's branch, and no ticket file may go with it.
//   rd.md:  ## Landing
//           - Mode: branch
//           - Target branch: feat/my-evaluation
//           - MR: https://git.ejad.net/ejad-hr/dashboard/-/merge_requests/43     (printed as MR_URL; nothing is opened or changed)
// What "land" does in this mode: fetch the target, replay only the commits on top of origin/<target> with EVERY
// specs/tickets path removed (evidence/ too), refuse anything that is not a fast-forward (never force-pushes), refuse to
// push if a ticket path survived, and push <sha>:refs/heads/<target>.
const fs = require('fs');
const F = '.claude/scripts/ejad-land.cjs';
let s = fs.readFileSync(F, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing in ejad-land.cjs: ' + a.slice(0, 90)); };
if (!s.includes('function landOnBranch')) {
  const sub = (a, b) => { must(a); s = s.replace(a, () => b); };
  sub('function withoutTickets(branch, ticketDir) {', "function withoutTickets(branch, ticketDir, baseRef) {");
  sub("  sh('git', ['fetch', '-q', 'origin', 'main']);\n  const base = sh('git', ['merge-base', branch, 'origin/main']);",
    "  const baseName = (baseRef || 'origin/main').replace(/^origin\\//, '');\n  sh('git', ['fetch', '-q', 'origin', baseName]);\n  const base = sh('git', ['merge-base', branch, baseRef || 'origin/main']);");
  sub('async function land(nnn, branch) {\n  const url = await openMr(ticket(nnn), branch, true);\n  log(`MR_URL ${url}`);\n}',
`async function land(nnn, branch) {
  const landing = branchLanding(nnn);
  if (landing) return landOnBranch(nnn, branch, landing);
  const url = await openMr(ticket(nnn), branch, true);
  log(\`MR_URL \${url}\`);
}

// rd.md "## Landing" with "- Mode: branch": push onto an existing branch instead of opening an MR.
function branchLanding(nnn) {
  const dir = fs.readdirSync('specs/tickets').find((d) => d.startsWith(\`\${nnn}-\`));
  if (!dir) return null;
  const rd = fs.readFileSync(path.join('specs/tickets', dir, 'rd.md'), 'utf8').replace(/\\r\\n/g, '\\n');
  const sec = /^## Landing\\n([\\s\\S]*?)(?=\\n## |$)/m.exec(rd);
  if (!sec || !/^- Mode:\\s*branch\\s*$/im.test(sec[1])) return null;
  const t = /^- Target branch:\\s*(\\S+)\\s*$/im.exec(sec[1]);
  if (!t) throw new Error('Landing mode "branch" needs "- Target branch: <name>"');
  const mr = /^- MR:\\s*(\\S+)\\s*$/im.exec(sec[1]);
  return { target: t[1], mr: mr ? mr[1] : '' };
}

async function landOnBranch(nnn, branch, { target, mr }) {
  const NL = String.fromCharCode(10);
  sh('git', ['fetch', '-q', 'origin', target]);
  const ref = \`origin/\${target}\`;
  // Every ticket path is stripped (ticketDir null: not even this ticket's evidence/ is kept).
  const sha = withoutTickets(branch, null, ref);
  const leaked = sh('git', ['diff', '--name-only', ref, sha, '--', TICKETS]);
  if (leaked) throw new Error(\`ticket files would be pushed, nothing was pushed: \${leaked.split(NL).join(', ')}\`);
  try {
    sh('git', ['merge-base', '--is-ancestor', ref, sha]);
  } catch {
    throw new Error(\`\${target} has moved on: rebase \${branch} onto \${ref} first (this never force-pushes)\`);
  }
  const files = sh('git', ['diff', '--name-only', ref, sha]);
  if (!files) throw new Error(\`\${branch} has no changes on top of \${ref}\`);
  await write(\`git push origin \${sha.slice(0, 8)}:refs/heads/\${target} (no ticket files, no MR opened or changed)\`, () =>
    sh('git', ['push', 'origin', \`\${sha}:refs/heads/\${target}\`]),
  );
  log(\`LANDED_ON \${target} \${sha}\`);
  log(\`FILES \${files.split(NL).join(', ')}\`);
  if (mr) log(\`MR_URL \${mr}\`);
}`);
  fs.writeFileSync(F, s);
}
console.log('land-branch patch applied');

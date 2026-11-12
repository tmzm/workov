const fs=require('fs');
const MERGER_BLOCK=`
## Ejad landing (overrides the gh steps below)

This repository lands on GitLab, not GitHub. In PR mode, skip the \`gh\` precondition (step 1's first bullet) and steps 3 and 4. After step 2 (build verified on the ticket branch), run exactly:

\`node .claude/scripts/ejad-land.cjs land NNN <branch>\`

It pushes the branch (never force) and opens or updates the GitLab MR as a **draft** from the ticket's delivery pack (screenshots, \`delivery/mr-title.txt\`, \`delivery/mr.md\`). Plane and Ejad HR are not touched: the owner's final review marks the MR ready and moves them (\`ejad-land.cjs deliver\`). The \`prUrl\` is the URL on its \`MR_URL\` line.
`;
const WORKER_BLOCK=`
# Ejad rules (override anything below that disagrees)
- Read the repository's \`CLAUDE.md\` (the constitution) before coding; it wins over this file.
- Commits: one per feature or fix, one-line conventional subject in the repo's style (\`feat(<scope>): …\`, \`fix(<scope>): …\`), no body, no \`Co-Authored-By\`, no AI attribution. Stage files by explicit path. Never push.
- Before the tester's final run, apply the ticket's \`## Final review\` (code review, security review, simplify — procedures in \`rd.md\`), fix what they find and re-run the checks.
- Delivery pack, last, in \`specs/tickets/NNN-slug/delivery/\` (never committed: it is in \`.git/info/exclude\`): \`screens/NN-<name>.png\` (the screenshots listed in \`rd.md\` \`## Screenshots\`, copied or taken against your dev server, checked by eye), \`mr.md\` (\`## Summary\` / \`## Screenshots\` with \`![caption](screens/NN-<name>.png)\` / \`## Notes\` with deviations, backend gaps and checks run; short, no AI attribution), \`mr-title.txt\` (one line, matching the main commit), \`tracker.md\` (3–6 lines for Plane and Ejad HR, no link).
`;
const LF = (s) => s.split('\r\n').join('\n');
for (const dir of ['.claude', '.opencode']) {
  const r = `${dir}/agents/router.md`;
  let t = LF(fs.readFileSync(r, 'utf8'));
  t = t.split('`gh pr view <number-or-branch> --json state`').join('`node .claude/scripts/ejad-land.cjs status <branch>` (prints `opened`, `merged`, `closed` or `none`)');
  fs.writeFileSync(r, t);
  const m = `${dir}/agents/merger.md`;
  t = LF(fs.readFileSync(m, 'utf8'));
  if (!t.includes('## Ejad landing')) {
    if (!t.includes('# PR Landing Mode (ticket 022)\n')) throw new Error(`${m}: PR Landing Mode heading not found`);
    t = t.replace('# PR Landing Mode (ticket 022)\n', '# PR Landing Mode (ticket 022)\n' + MERGER_BLOCK);
  }
  fs.writeFileSync(m, t);
  const w = `${dir}/agents/worker.md`;
  t = LF(fs.readFileSync(w, 'utf8'));
  if (!t.includes('# Ejad rules')) t = t.replace('# Inputs Provided by Router', WORKER_BLOCK.trim() + '\n\n# Inputs Provided by Router');
  t = t.split('(`feat(NNN): <title>`)').join('(one-line conventional subject per the Ejad rules above)');
  fs.writeFileSync(w, t);
}
console.log('agents patched');

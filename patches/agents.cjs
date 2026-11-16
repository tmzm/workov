const fs=require('fs');
const MERGER_BLOCK=`
## Workerov landing (overrides the gh steps below)

This repository lands on GitLab, not GitHub. In PR mode, skip the \`gh\` precondition (step 1's first bullet) and steps 3 and 4. After step 2 (build verified on the ticket branch), run exactly:

\`node .claude/scripts/land.cjs land NNN <branch>\`

It pushes the branch (never force) and opens or updates the GitLab MR as a **draft** from the ticket's delivery pack (screenshots, \`delivery/mr-title.txt\`, \`delivery/mr.md\`). Plane and Ejad HR are not touched: the owner's final review marks the MR ready and moves them (\`land.cjs deliver\`). The \`prUrl\` is the URL on its \`MR_URL\` line.
`;
const WORKER_BLOCK=`
# Workerov rules (override anything below that disagrees)
- Read the repository's \`CLAUDE.md\` (the constitution) before coding; it wins over this file.
- Commits: one per feature or fix, one-line conventional subject in the repo's style (\`feat(<scope>): …\`, \`fix(<scope>): …\`), no body, no \`Co-Authored-By\`, no AI attribution. Stage files by explicit path. Never push.
- Before the tester's final run, apply the ticket's \`## Final review\` (code review, security review, simplify — procedures in \`rd.md\`), fix what they find and re-run the checks.
- Delivery pack, last, in \`specs/tickets/NNN-slug/delivery/\` (never committed: it is in \`.git/info/exclude\`): \`screens/NN-<name>.png\` (the screenshots listed in \`rd.md\` \`## Screenshots\`, copied or taken against your dev server, checked by eye; every change a user can see has screenshots, even a single button), \`mr.md\` (exactly these sections in this order: \`## Summary\` (one bullet per feature or fix) / \`## Implementation\` (how it was built, short, no file list) / \`## Screenshots\` (only when there are any; bold caption, then \`![caption](screens/NN-<name>.png)\`) / \`## Notes\` (deviations, backend gaps, follow-ups, checks run with results); short, no AI attribution), \`mr-title.txt\` (one line, matching the main commit), \`tracker.md\` (3–6 lines for Plane and Ejad HR, no link).
- Browser checks against staging: the app on a worker port is not an origin staging's CORS allows (only \`localhost:4200\`), so sign-in fails there. Run the check browser (Playwright or agent-browser Chromium) with \`--disable-web-security\`, for these local checks only, and sign in with the test account from the environment variables \`E2E_EMAIL\` / \`E2E_PASSWORD\` (never print them, never write them to a file; pass this rule to the tester in its prompt). Never report a check as skipped for a sign-in failure before trying this. Never approve, reject or write real people's records in a check: answer only the GET you need inside the browser, and hold or abort the writes.
`;
const LF = (s) => s.split('\r\n').join('\n');
for (const dir of ['.claude', '.opencode']) {
  const r = `${dir}/agents/router.md`;
  let t = LF(fs.readFileSync(r, 'utf8'));
  t = t.split('`gh pr view <number-or-branch> --json state`').join('`node .claude/scripts/land.cjs status <branch>` (prints `opened`, `merged`, `closed` or `none`)');
  fs.writeFileSync(r, t);
  const m = `${dir}/agents/merger.md`;
  t = LF(fs.readFileSync(m, 'utf8'));
  if (!t.includes('## Workerov landing')) {
    if (!t.includes('# PR Landing Mode (ticket 022)\n')) throw new Error(`${m}: PR Landing Mode heading not found`);
    t = t.replace('# PR Landing Mode (ticket 022)\n', '# PR Landing Mode (ticket 022)\n' + MERGER_BLOCK);
  }
  fs.writeFileSync(m, t);
  const w = `${dir}/agents/worker.md`;
  t = LF(fs.readFileSync(w, 'utf8'));
  if (!t.includes('# Workerov rules')) t = t.replace('# Inputs Provided by Router', WORKER_BLOCK.trim() + '\n\n# Inputs Provided by Router');
  t = t.split('(`feat(NNN): <title>`)').join('(one-line conventional subject per the Workerov rules above)');
  fs.writeFileSync(w, t);
}
console.log('agents patched');

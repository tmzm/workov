// Ejad: the worker edits only inside its own worktree (apply after ejad-worker.cjs).
// Found on ticket 009: the worker's shell and editor tools started in the MAIN checkout, so its edits went there by
// absolute path while its worktree and branch stayed untouched, and its own `pnpm format` (`prettier --write .`) rewrote
// every file of the main checkout, including the dashboard page and BOARD.md that the fleet reads.
const fs = require('fs');
const RULE = "**Your worktree is the only place you edit.** Your task message names it: a folder next to the main checkout (for example `E:/Projects/Ejad/dashboard-fleet-NNN-slug`). Your shell and editor tools may start in the MAIN checkout (`E:/Projects/Ejad/dashboard-fleet`), which is not yours: never edit, format or run anything that writes there. Before your first edit run `git -C <worktree> rev-parse --abbrev-ref HEAD` and confirm it is your branch. Give every read, edit and write an **absolute path under your worktree**, and start every shell command with `cd <worktree> &&`. Never run `pnpm format` or `prettier --write .`; format only the files you changed (`pnpm exec prettier --write <paths>`). If you find your changes landed in the main checkout, stop, say so in your heartbeat note and return to the router.";
for (const f of ['.opencode/agents/worker.md', '.claude/agents/worker.md']) {
  if (!fs.existsSync(f)) continue;
  let w = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (w.includes('Your worktree is the only place you edit')) continue;
  const anchor = 'You build one `solo` ticket end-to-end inside your isolated git worktree.';
  if (!w.includes(anchor)) throw new Error('anchor missing in ' + f);
  w = w.replace(anchor, () => anchor + '\n\n' + RULE);
  fs.writeFileSync(f, w);
}
console.log('worker worktree rule applied');

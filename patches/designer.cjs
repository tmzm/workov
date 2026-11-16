// Workerov: a studied mockup for every ticket that changes what a user sees (apply after dashboard-providers-page.cjs).
// Before: the worker (a cheap model) built the mockup itself from one paragraph, with no design system and no UI/UX
// rules, and then was told only to "build the feature". Now:
//  - agent wv-designer (Claude) studies the ticket, DESIGN.md, the real screens and the ui-ux-pro-max rules, builds
//    mockup.html with the app's own tokens, checks it with screenshots and writes mockup-notes.md;
//  - .claude/scripts/mockup.cjs runs it as a fleet job (log in the ticket's Logs tab, heartbeat on the board),
//    on Claude (default, your plan) or on any connected OpenCode model (models.designer in the fleet config);
//  - the worker no longer designs: the approved mockup is its visual spec, and it must match it and say where it did not.
const fs = require('fs');
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// ---- 1. the runner, derived from the planner runner so both share one tested mechanism ----
if (!fs.existsSync('.claude/scripts/mockup.cjs')) {
  let p = rd('.claude/scripts/plan.cjs');
  const sub = (a, b) => { if (!p.includes(a)) throw new Error('anchor missing in plan.cjs: ' + a.slice(0, 80)); p = p.split(a).join(b); };
  sub('plan.cjs: run the Claude ticket writer (agent wv-planner) inside the fleet, so planning is a fleet job.', 'mockup.cjs: run the Claude designer (agent wv-designer) inside the fleet, so the mockup is a fleet job.');
  sub("const answerFile = opt('--answer');", "const answerFile = opt('--answer');\nconst suffix = opt('--suffix'); // e.g. v2: write mockup-v2.html and leave mockup.html untouched");
  sub('(!briefFile && !resume)', 'false');
  sub('usage: node .claude/scripts/plan.cjs <NNN-slug> <brief-file>', 'usage: node .claude/scripts/mockup.cjs <NNN-slug> [brief-file] [--suffix v2]');
  sub('Write the ticket \\`specs/tickets/${slug}\\`. The brief is in \\`${briefFile}\\`; read it first.',
    'Design the mockup of the ticket \\`specs/tickets/${slug}\\`.${briefFile ? \' The brief is in \\`\' + briefFile + \'\\`.\' : \'\'} Follow your instructions in order: study first, then build, check with screenshots, then write the notes.${suffix ? \' Write mockup-\' + suffix + \'.html and mockup-notes-\' + suffix + \'.md instead; do not touch mockup.html or mockup-notes.md.\' : \'\'}');
  sub('Finish the ticket.', 'Finish the mockup.');
  sub('Continue the ticket.', 'Continue the mockup.');
  sub('Writes one fleet ticket (rd.md + eval.md) from a task brief', 'Designs the mockup of one fleet ticket');
  sub('wv-planner', 'wv-designer');
  sub('-planner.log', '-designer.log');
  sub('status-writer-', 'status-designer-');
  sub('planner-prompt-', 'designer-prompt-');
  sub('PLANNER_', 'DESIGNER_');
  sub('planner', 'designer');
  fs.writeFileSync('.claude/scripts/mockup.cjs', p);
}

// ---- 2. the worker: it implements the mockup, it does not design it ----
const MOCKUP_RULE = "- **Mockup:** the Designer (Claude) builds the ticket's mockup before the ticket is ready: `mockup.html` and `mockup-notes.md` in the ticket folder. You never design or redesign it. If rd.md has `## Mockup` and `mockup.html` is missing, set your heartbeat to `blocked` with the note `Waiting for the designer's mockup` and return to the router. Once user-decision.md approves it, the approved mockup is the **visual spec**: read `mockup-notes.md` first, then build the screen to match the mockup's layout, states, texts in every language, spacing, focus and error behaviour, using the app's own components and theme tokens (DESIGN.md), never raw colours. Before you finish, open the real screen at desktop width and at 390 px, in both themes and in Arabic, compare it with the mockup, and fix every difference. Write each deliberate deviation, with the reason, in results.md under `## Mockup deviations`.";
for (const f of ['.opencode/agents/worker.md', '.claude/agents/worker.md']) {
  if (!fs.existsSync(f)) continue;
  let w = rd(f);
  if (!w.includes('**visual spec**')) {
    if (!/^- \*\*Mockup first:\*\*.*$/m.test(w)) throw new Error('anchor missing in ' + f + ': Mockup first');
    w = w.replace(/^- \*\*Mockup first:\*\*.*$/m, () => MOCKUP_RULE);
  }
  w = w.replace('naming `copilot`, `kilo` or `antigravity`', 'naming `copilot`, `kilo`, `antigravity` or `claude`').replace("if it is `copilot`, `kilo` or `antigravity`", "if it is `copilot`, `kilo`, `antigravity` or `claude`");
  fs.writeFileSync(f, w);
}
console.log('designer patch applied');

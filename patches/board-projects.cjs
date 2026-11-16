// Workerov: the Board page shows the tickets of every registered project, with a project selector next to the filter.
// Tickets of another project are merged into the board's own columns as cards with a project tag (their ids are shown as
// "<PRE>-001" so numbers never collide) and open in this dashboard's own ticket drawer, read through
// /api/wv/project-ticket. Dispatch and Pause of such a ticket are done by the hub on that project's files. There is only
// ever one dashboard. Needs /api/wv/projects (patch projects-board). Anchors are whitespace tolerant because the
// page is laid out differently before and after formatting. Idempotent.
const fs = require('fs');
const path = require('path');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('id="board-project"')) process.exit(0);

// replace the first match of `re`, or fail loudly naming the anchor
const sub = (re, to, what) => {
  const m = re.exec(h);
  if (!m) throw new Error('anchor missing: ' + what);
  h = h.slice(0, m.index) + (typeof to === 'function' ? to(m) : to) + h.slice(m.index + m[0].length);
};

// 1. the selector, right before the text filter
sub(/<div class="filter">\s*<svg class="i" aria-hidden="true"><use href="#i-filter"\s*\/><\/svg>/,
  (m) => `<div class="filter" id="board-project-wrap" hidden>
                <label class="sr-only" for="board-project">Project</label>
                <select id="board-project" aria-label="Project"></select>
              </div>
              ` + m[0], 'board filter');

// 2. foreign tickets join the board's cards
sub(/\(stateData\.tickets \|\| \[\]\)\.forEach\(\(t, idx\) => \{\s*const d = cardInfo\(t, agentByNum\);\s*d\.idx = idx;\s*byStage\[stageOfStatus\(d\.status\)\]\.push\(d\);\s*\}\);/,
  `(window.wvBoardTickets ? window.wvBoardTickets(stateData.tickets || []) : stateData.tickets || []).forEach((t, idx) => {
          const d = cardInfo(t, agentByNum);
          d.idx = idx;
          if (t.wvProject) { d.project = t.wvProject; d.projectRaw = t.wvRaw; }
          byStage[stageOfStatus(d.status)].push(d);
        });`, 'board card loop');

// 3. a project tag on the card (the card's click opens the same drawer for every ticket)
sub(/const meta = \[\];(\s*)if \(d\.flag\)/,
  `const meta = [];
        if (d.project) meta.push(h('span', { class: 'plate quiet', title: 'Project', text: d.project }));
        if (d.flag)`, 'card meta');

// 4. Needs you: count the drafts of every project, and make Review open one
sub(/const drafts = tickets\.filter\(\s*\(?t\)? =>\s*String\(t\.status \|\| ''\)\.toLowerCase\(\) === 'draft',?\s*\)\.length;/,
  `const drafts = window.wvDraftCount
          ? window.wvDraftCount(tickets)
          : tickets.filter((t) => String(t.status || '').toLowerCase() === 'draft').length;`, 'drafts count');
sub(/onclick: \(\) => jumpToStage\('plan'\)(,?\s*\},\s*'Review')/,
  (m) => `onclick: () => (window.wvReviewDrafts ? window.wvReviewDrafts() : jumpToStage('plan'))` + m[1], 'drafts Review button');

// 4b. Needs you: a ticket of another project that waits for your answer is a Decision row like any other
sub(/if \(drafts > 0\) rows\.push\(\{ kind: 'drafts', count: drafts \}\);/,
  `(window.wvAwaiting ? window.wvAwaiting() : []).forEach((f) => {
          rows.push({ kind: 'decision', ticket: f.id, title: f.title || '', note: '', answer: null });
        });
        if (drafts > 0) rows.push({ kind: 'drafts', count: drafts });`, 'foreign decisions');

// 5. the drawer reads other projects' tickets and shows their actions
sub(/return \(\(stateData && stateData\.tickets\) \|\| \[\]\)\.find\(\(?t\)? => t\.id === id\);(\s*\}\s*function answerFor)/,
  (m) => `return ((stateData && stateData.tickets) || []).find((t) => t.id === id) || (window.wvForeignById ? window.wvForeignById(id) : undefined);` + m[1], 'ticketById');
// (the drawer's own requests and buttons need no special case: the server runs them in the ticket's project)

// 6. the data script, last
const script = fs.readFileSync(path.join(__dirname, 'board-projects.script.html'), 'utf8').replace(/\r\n/g, '\n');
const i = h.lastIndexOf('</body>');
if (i < 0) throw new Error('anchor missing: </body>');
h = h.slice(0, i) + script + h.slice(i);

fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('board projects: page patched');

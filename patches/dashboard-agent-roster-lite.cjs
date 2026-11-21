// Workov: a short agent list. The roster table under Agents showed the runtime, model, provider and effort of every agent, which the layered
// settings editor (project dialog, ticket drawer tab, Providers) now owns. The section keeps what is not shown anywhere else: which agents
// the fleet has and what each one does. One row per agent (an agent that exists in both runtimes is listed once, for the active runtime).
// Builds on agent-roster.cjs. Idempotent; tolerant of how the page is formatted.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
const fail = (m) => { throw new Error('anchor missing: ' + m); };
if (!h.includes('data-lite="1"')) {
  if (!/id="wv-roster"/.test(h)) fail('wv-roster (apply agent-roster.cjs first)');
  const sum = /Agent roster: model and provider of every agent/;
  if (!sum.test(h)) fail('roster summary');
  h = h.replace(sum, 'Agents: what each one does');
  const thead = /(<table\s+class="wv-roster-table"[\s\S]*?>\s*)<thead>[\s\S]*?<\/thead>/;
  if (!thead.test(h)) fail('roster thead');
  h = h.replace(thead, (m, a) => a + '<thead><tr><th align="left" style="padding: 4px 8px">Agent</th><th align="left" style="padding: 4px 8px">What it does</th></tr></thead>');
  const cells = /const cells = \[[\s\S]*?\];/;
  if (!cells.test(h)) fail('roster cells');
  h = h.replace(cells, 'const cells = [a.agent, a.role || \'\'];');
  const active = /const active = a\.runtime === data\.harness;/;
  if (!active.test(h)) fail('roster active');
  h = h.replace(active, "const active = a.runtime === data.harness;\n            if (!active && (data.agents || []).some((o) => o.agent === a.agent && o.runtime === data.harness)) return;");
  h = h.replace(/document\.getElementById\('wv-roster-note'\)\.textContent\s*=\s*[^;]*;/, "document.getElementById('wv-roster-note').textContent = '';");
  h = h.replace('<details id="wv-roster"', '<details id="wv-roster" data-lite="1"');
  fs.writeFileSync(H, h);
}
// the provider summary that dashboard-roster.cjs writes next to the title (runtime and providers) is gone too: the models live in the editor
h = fs.readFileSync(H, 'utf8');
const note = /note\.textContent\s*=\s*'\('\s*\+[\s\S]*?\+\s*'\)';/;
if (note.test(h)) { h = h.replace(note, "note.textContent = '';"); fs.writeFileSync(H, h); }
console.log('index.html: short agent list');

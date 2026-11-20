#!/usr/bin/env node
// review.cjs: the final review of one fleet ticket's branch, by whoever the user picks on the dashboard:
//   --by claude  Claude (agent wv-reviewer, Sonnet): code review, security review, simplify
//   --by fleet   the fleet's own reviewer (OpenCode agent `reviewer`, model from specs/worker-fleet.config.json)
//   --by both    both, in parallel; the results are merged
// Steps stream into job/logs/<NNN>-reviewer.log (the ticket's Logs tab); the outcome is kept in job/review-<NNN>.json
// for the dashboard: state running | clean | findings | failed. The merged report is specs/tickets/<slug>/review.md.
//   clean    -> nothing changes; the dashboard offers Deliver.
//   findings -> a `## Rework` section pointing to review.md is added to rd.md, both are committed locally, and the
//               board row goes back to `ready`: the router re-dispatches a worker with the findings (reviewers never
//               fix them outside the fleet).
// Usage (from the fleet folder): node .claude/scripts/review.cjs <NNN> [--by claude|fleet|both] [--model sonnet]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : d; };
let model = opt('--model', null);
const by = opt('--by', 'claude');
const nnn = args[0];
if (!/^\d{3}$/.test(nnn || '') || !['claude', 'fleet', 'both'].includes(by)) {
  console.error('usage: node .claude/scripts/review.cjs <NNN> [--by claude|fleet|both] [--model sonnet]');
  process.exit(2);
}
if (!fs.existsSync('specs/worker-fleet.config.json')) { console.error('run it from the fleet folder'); process.exit(2); }
// the Claude model: --model wins, else the layered setting models.reviewer.claude.model (ticket > project > global), else sonnet
if (!model) { const m = require('./wv-settings.cjs').setting('models.reviewer.claude.model', { ticket: nnn, fallback: 'sonnet' }); model = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m || '') ? m : 'sonnet'; }

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const slug = fs.readdirSync('specs/tickets').find((d) => d.startsWith(`${nnn}-`));
if (!slug) { console.error(`no ticket ${nnn}`); process.exit(2); }
const tdir = `specs/tickets/${slug}`;
let branch = '';
try {
  const st = JSON.parse(fs.readFileSync('job/router-state.json', 'utf8'));
  for (const v of Object.values(st)) if (Array.isArray(v)) for (const e of v) if (e && String(e.ticket || '').startsWith(`${nnn}-`) && e.branch) branch = e.branch;
} catch {}
if (!/^[A-Za-z0-9._/-]+$/.test(branch)) { console.error(`no branch recorded for ticket ${nnn}`); process.exit(2); }

fs.mkdirSync('job/logs', { recursive: true });
const stateFile = `job/review-${nnn}.json`;
const out = fs.openSync(path.join('job', 'logs', `${nnn}-reviewer.log`), 'a');
const hhmm = () => new Date().toTimeString().slice(0, 8);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const line = (s) => fs.writeSync(out, `[${hhmm()}] ${s}\n`);
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
let commit = '';
try { commit = git('rev-parse', `refs/heads/${branch}`); } catch { try { commit = git('rev-parse', `origin/${branch}`); } catch {} }
const save = (o) => fs.writeFileSync(stateFile, JSON.stringify({ ticket: slug, branch, commit, by, ...o }, null, 2));

let worktree = '';
try {
  for (const b of git('worktree', 'list', '--porcelain').split(/\r?\n\r?\n/)) if (b.includes(`branch refs/heads/${branch}`)) worktree = (b.match(/^worktree (.+)$/m) || [])[1] || '';
} catch {}
try { git('fetch', '-q', 'origin', 'main'); } catch {}
for (const f of ['review.md', 'review-claude.md', 'review-fleet.md']) fs.rmSync(`${tdir}/${f}`, { force: true });
save({ state: 'running', startedAt: iso() });

const where = worktree ? `\`${worktree}\`` : 'none (review from git diff only and say checks were not run)';

function runClaude() {
  return new Promise((resolve) => {
    const prompt = `Review ticket \`${tdir}\` on branch \`${branch}\`. Its worktree: ${where}. Write \`${tdir}/review-claude.md\` as your instructions say.`;
    line(`▶ Claude review (${model}) of ${branch} @ ${commit.slice(0, 8)}`);
    const child = spawn('claude', ['-p', '--agent', 'wv-reviewer', '--model', model, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', prompt], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); // the reviewer never touches Plane, HR or GitLab: no MCP server needed
    let buf = '', cost = 0;
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        let ev;
        try { ev = JSON.parse(raw); } catch { line(clip(raw, 300)); continue; }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'text' && c.text.trim()) c.text.split('\n').filter((l) => l.trim()).forEach((l) => line(`claude: ${l}`));
            else if (c.type === 'tool_use') line(`claude → ${c.name} ${clip(JSON.stringify(c.input), 200)}`);
          }
        } else if (ev.type === 'result') { cost = ev.total_cost_usd ?? 0; line(`claude ■ ${ev.subtype || 'done'} · ${ev.num_turns ?? '?'} turns · $${cost.toFixed(2)}`); }
      }
    });
    child.stderr.on('data', (d) => d.toString('utf8').split('\n').filter((l) => l.trim()).forEach((l) => line(`claude stderr: ${clip(l, 300)}`)));
    child.on('close', () => resolve({ cost }));
    child.on('error', (e) => { line(`claude failed to start: ${e.message}`); resolve({ cost }); });
  });
}

function runFleet() {
  return new Promise((resolve) => {
    let fm = 'opencode-go/deepseek-v4-pro';
    fm = require('./wv-settings.cjs').setting('models.reviewer.opencode.model', { ticket: nnn, fallback: fm }) || fm;
    const pf = `job/review-prompt-${nnn}.md`;
    fs.writeFileSync(pf, `# Final review of ticket ${slug}\n\nBranch \`${branch}\`; its worktree: ${where}.\nRead \`CLAUDE.md\`, \`${tdir}/rd.md\` and \`${tdir}/eval.md\`, then review \`git diff origin/main...${branch}\` (ignore \`specs/tickets/\` except \`evidence/\`). Read each changed file in full and the callers of changed functions.\nLook for real defects only: wrong logic, null paths, unhandled errors, stale state, missing loading/empty/error states, wrong API use, missing translations, accessibility breaks, repo-rule violations, missing tests, behaviour that contradicts the ticket. Prove each with concrete inputs; drop what you cannot. Do not edit any file.\n\nYour final message must end with a line \`RESULT: clean\` or \`RESULT: findings\`, and for findings a numbered list placed AFTER that line: file:line, the scenario, the fix.\n`);
    line(`▶ fleet reviewer (${fm}) of ${branch}`);
    const child = spawn('opencode', ['run', '--auto', '--agent', 'reviewer', '-m', fm, `"Do the final review described in ${pf}"`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true, env: { ...process.env, WV_APPROVALS: 'auto' } });
    let text = '';
    const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    child.stdout.on('data', (d) => { const t = strip(d.toString('utf8')); text += t; t.split('\n').filter((l) => l.trim()).forEach((l) => line(`fleet: ${clip(l, 300)}`)); });
    child.stderr.on('data', (d) => strip(d.toString('utf8')).split('\n').filter((l) => l.trim()).forEach((l) => line(`fleet stderr: ${clip(l, 300)}`)));
    const done = () => {
      const i = text.lastIndexOf('RESULT:');
      if (i >= 0) {
        const body = text.slice(i);
        const m = body.match(/^RESULT:\s*(clean|findings)/i);
        if (m) fs.writeFileSync(`${tdir}/review-fleet.md`, `**Result:** ${m[1].toLowerCase()}\n\n${body.split('\n').slice(1).join('\n').trim()}\n`);
      }
      resolve({});
    };
    child.on('close', done);
    child.on('error', (e) => { line(`fleet reviewer failed to start: ${e.message}`); resolve({}); });
  });
}

const result = (f) => {
  try { const m = fs.readFileSync(`${tdir}/${f}`, 'utf8').split(/\r?\n/)[0].match(/\*\*Result:\*\*\s*(clean|findings)/i); return m ? m[1].toLowerCase() : null; } catch { return null; }
};

(async () => {
  const jobs = [];
  if (by !== 'fleet') jobs.push(runClaude());
  if (by !== 'claude') jobs.push(runFleet());
  const res = await Promise.all(jobs);
  const cost = res.reduce((a, r) => a + (r.cost || 0), 0);
  const parts = [];
  if (by !== 'fleet') parts.push(['Claude review', 'review-claude.md']);
  if (by !== 'claude') parts.push(['Fleet reviewer', 'review-fleet.md']);
  const results = parts.map(([, f]) => result(f));
  let state = 'failed';
  if (results.every((r) => r)) state = results.includes('findings') ? 'findings' : 'clean';
  let body = '', count = 0;
  parts.forEach(([title, f], i) => {
    let t = '';
    try { t = fs.readFileSync(`${tdir}/${f}`, 'utf8').split(/\r?\n/).slice(1).join('\n').trim(); } catch {}
    body += `\n## ${title}: ${results[i] || 'no result'}\n\n${t || '_The reviewer did not produce a report._'}\n`;
    count += (t.match(/^\d+\.\s/gm) || []).length;
  });
  fs.writeFileSync(`${tdir}/review.md`, `**Result:** ${state === 'failed' ? 'failed' : state}\n**Branch:** ${branch} @ ${commit.slice(0, 8)}\n**Reviewed:** ${iso()} by ${parts.map((p) => p[0]).join(' and ')}\n${body}`);
  if (state === 'findings') {
    try {
      const rd = `${tdir}/rd.md`;
      let text = fs.readFileSync(rd, 'utf8');
      text = text.replace(/\s*$/, '\n') + `\n## Rework\n\nThe final review (${parts.map((p) => p[0]).join(' and ')}) found problems on ${iso()}: fix every numbered finding in \`${tdir}/review.md\`, with a test that would have caught each, re-run all checks, then finish as before.\n`;
      fs.writeFileSync(rd, text);
      const board = 'specs/tickets/BOARD.md';
      const b = fs.readFileSync(board, 'utf8');
      const nb = b.replace(new RegExp(`^(\\|\\s*${nnn}\\s*\\|[^|]*\\|\\s*)in-review(\\s*\\|)`, 'm'), (m0, a, c) => `${a}ready    ${c}`);
      if (nb !== b) fs.writeFileSync(board, nb);
      try { git('add', '--', rd, `${tdir}/review.md`); git('commit', '-q', '-m', `docs(tickets): final review findings for ticket ${nnn}`, '--', rd, `${tdir}/review.md`); } catch (e) { line(`commit skipped: ${clip(e.message, 160)}`); }
      line(`${count} finding(s): ## Rework added to rd.md and the ticket is ready again for the fleet`);
    } catch (e) { line(`could not hand the findings back: ${clip(e.message, 200)}`); }
  }
  save({ state, finishedAt: iso(), findings: count, cost });
  line(`review ${state}`);
  fs.closeSync(out);
  console.log(`REVIEW ${state} (${count} findings)`);
  process.exit(state === 'failed' ? 1 : 0);
})();

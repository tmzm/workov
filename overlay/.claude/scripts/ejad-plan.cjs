#!/usr/bin/env node
// ejad-plan.cjs: run the Claude ticket writer (agent ejad-planner) inside the fleet, so planning is a fleet job.
// The planner works headless in this checkout; every step it takes streams into job/logs/<NNN>-planner.log, which
// the dashboard shows in the ticket's Logs tab, and its writer heartbeat (job/status-writer-<NNN>.json) shows it as
// an agent on the ticket. Usage (from the fleet folder):
//   node .claude/scripts/ejad-plan.cjs <NNN-slug> <brief-file> [--model sonnet] [--resume <session-id>] [--answer <file>]
// --resume continues the planner's session (e.g. after the user answered its open questions, given with --answer).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const model = opt('--model') || 'sonnet';
const resume = opt('--resume');
const answerFile = opt('--answer');
const [slug, briefFile] = args;
if (!slug || !/^\d{3}-[a-z0-9-]+$/.test(slug) || (!briefFile && !resume)) {
  console.error('usage: node .claude/scripts/ejad-plan.cjs <NNN-slug> <brief-file> [--model sonnet] [--resume <session-id> --answer <file>]');
  process.exit(2);
}
if (!fs.existsSync('specs/worker-fleet.config.json')) { console.error('run it from the fleet folder'); process.exit(2); }
const nnn = slug.slice(0, 3);
fs.mkdirSync('job/logs', { recursive: true });
const logFile = path.join('job', 'logs', `${nnn}-planner.log`);
const beatFile = path.join('job', `status-writer-${nnn}.json`);
const out = fs.openSync(logFile, 'a');
const hhmm = () => new Date().toTimeString().slice(0, 8);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const line = (s) => fs.writeSync(out, `[${hhmm()}] ${s}\n`);
const beat = (phase, note) => {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(beatFile, JSON.stringify({ ticket: slug, phase, updatedAt: now, note, branch: null }, null, 2));
};

let prompt;
if (resume) {
  prompt = answerFile ? `The user answered your open questions:\n\n${fs.readFileSync(answerFile, 'utf8')}\n\nFinish the ticket.` : 'Continue the ticket.';
} else {
  prompt = `Write the ticket \`specs/tickets/${slug}\`. The brief is in \`${briefFile}\`; read it first.`;
  if (!fs.existsSync(beatFile)) beat('reading-code', 'planner starting');
}
line(`▶ planner (${model}) ${resume ? `resuming ${resume}` : 'starting'}: ${clip(prompt, 200)}`);

const cli = ['-p', '--agent', 'ejad-planner', '--model', model, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];
if (resume) cli.push('--resume', resume);
cli.push(prompt);
const child = spawn('claude', cli, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
let session = resume || '';
let lastResult = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const raw = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!raw) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { line(clip(raw, 300)); continue; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      session = ev.session_id || session;
      line(`session ${session}`);
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) c.text.split('\n').filter((l) => l.trim()).forEach((l) => line(l));
        else if (c.type === 'tool_use') line(`→ ${c.name} ${clip(JSON.stringify(c.input), 220)}`);
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type !== 'tool_result') continue;
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content ?? '');
        text.split('\n').filter((l) => l.trim()).slice(0, 3).forEach((l) => line(`  ⎿ ${clip(l, 200)}`));
      }
    } else if (ev.type === 'result') {
      lastResult = ev.result || '';
      line(`■ ${ev.subtype || 'done'} · ${ev.num_turns ?? '?'} turns · $${(ev.total_cost_usd ?? 0).toFixed(2)}`);
    }
  }
});
child.stderr.on('data', (d) => d.toString('utf8').split('\n').filter((l) => l.trim()).forEach((l) => line(`stderr: ${clip(l, 300)}`)));
child.on('close', (code) => {
  let phase = '';
  try { phase = JSON.parse(fs.readFileSync(beatFile, 'utf8')).phase; } catch {}
  if (code !== 0 && phase !== 'done' && phase !== 'waiting-user') beat('waiting-user', `planner stopped (exit ${code}); see the Logs tab. Resume: --resume ${session}`);
  line(`planner exited ${code} · heartbeat ${phase || 'none'} · resume with --resume ${session}`);
  fs.closeSync(out);
  if (lastResult) console.log(lastResult);
  console.log(`PLANNER_SESSION ${session}`);
  process.exit(code ?? 1);
});

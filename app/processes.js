'use strict';
// Lists what runs in the background for the fleet (dashboards, router, agents, test runs, tunnels, chat engine) and
// stops one on request. Windows only: the list comes from WMI, a stop is `taskkill /T /F`. Nothing is stopped without
// the caller having confirmed it, and a stop re-reads the live list first so a reused pid can never be hit by mistake.
const { execFile } = require('child_process');
const path = require('path');

const PS = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{n='Start';e={$_.CreationDate.ToString('o')}},CommandLine,WorkingSetSize | ConvertTo-Json -Compress";

const folderOf = (cmd) => {
  const m = /([A-Za-z]:[\\/][^"]*?)[\\/](?:\.claude|node_modules|\.opencode)[\\/]/.exec(cmd || '');
  return m && !/AppData/i.test(m[1]) ? path.basename(m[1].replace(/[\\/]+$/, '')) : '';
};

// One rule per kind of process. `risk` is shown in the confirmation before anything is stopped.
const RULES = [
  { id: 'dashboard', test: (p) => /^python3?(\.exe)?$/i.test(p.Name) && /dashboard-server\.py/.test(p.CommandLine || ''),
    group: 'Dashboard', label: (p) => 'Dashboard server' + dot(folderOf(p.CommandLine)),
    risk: 'The dashboard and its Board page go offline until the dashboard is started again. Agents that are already running keep working.' },
  { id: 'router', test: (p) => /^bash(\.exe)?$/i.test(p.Name) && /router-loop\.sh/.test(p.CommandLine || ''),
    group: 'Router', label: (p) => 'Router loop' + dot(folderOf(p.CommandLine)),
    risk: 'No new work is handed out and finished tickets are not picked up until the router is restarted. Running workers keep going.' },
  { id: 'agent-service', test: (p) => /opencode/i.test((p.Name + ' ' + (p.CommandLine || ''))) && /\bserve\b[^|]*--service/.test(p.CommandLine || ''),
    group: 'Agents', label: () => 'OpenCode service (every agent runs through it)',
    risk: 'EVERY agent session stops at once, the router and the workers fail until it starts again, and a kill in the middle of a write can damage the agent database. Prefer stopping a single run instead.' },
  { id: 'agent-run', test: (p) => /^opencode(\.exe)?$/i.test(p.Name) && /\brun\b/.test(p.CommandLine || ''),
    group: 'Agents', label: (p) => 'Agent run' + dot((/--agent\s+(\S+)/.exec(p.CommandLine || '') || [])[1]),
    risk: 'That agent stops mid-step. The router will notice and retry it, but half-finished work in its worktree can be left behind.' },
  { id: 'heavy', test: (p) => /^node(\.exe)?$/i.test(p.Name) && /(@angular[\\/]cli[\\/]bin[\\/]ng\.js|pnpm\.m?js|npm-cli\.js|vitest|\bng\.js)/.test(p.CommandLine || '') && /\b(test|build|lint|install|e2e|format)/.test(p.CommandLine || ''),
    group: 'Tests and builds', label: (p) => heavyLabel(p),
    risk: 'The check or install fails and the worker or tester that started it will retry or report a failure. No saved work is lost.' },
  { id: 'browser', test: (p) => /^(chrome|chromium|headless_shell|chrome-headless-shell)(\.exe)?$/i.test(p.Name) && /(--headless|ms-playwright|--remote-debugging-pipe)/.test(p.CommandLine || '') && !/--type=/.test(p.CommandLine || ''),
    group: 'Tests and builds', label: () => 'Headless browser (test run)',
    risk: 'The test run that owns this browser fails and is retried.' },
  { id: 'tunnel', test: (p) => /^cloudflared(\.exe)?$/i.test(p.Name),
    group: 'Network', label: (p) => { const m = /127\.0\.0\.1:(\d+)/.exec(p.CommandLine || ''); return 'Cloudflare tunnel' + dot(m && ':' + m[1]); },
    risk: 'Remote and phone access through the tunnel goes offline. Nothing else is affected.' },
  { id: 'chat-engine', test: (p) => /^claude(\.exe)?$/i.test(p.Name) && /Programs[\\/]Workerov|ejad-fleet[\\/]app/i.test(p.ExecutablePath || p.CommandLine || ''),
    group: 'Chat', label: () => 'Claude chat engine',
    risk: 'The chat reply being written stops. The conversation itself is kept.' },
];

function dot(s) { return s ? ' · ' + s : ''; }
function heavyLabel(p) {
  const c = p.CommandLine || '';
  const what = /\binstall\b/.test(c) ? 'install' : /\bbuild\b/.test(c) ? 'build' : /\blint\b/.test(c) ? 'lint' : /\be2e\b/.test(c) ? 'e2e' : /\bformat/.test(c) ? 'format check' : 'test run';
  return (what === 'test run' ? 'Test run' : what[0].toUpperCase() + what.slice(1)) + dot(folderOf(c));
}

function snapshot() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30000 }, (err, out) => {
      if (err) return reject(err);
      try { const j = JSON.parse(out); resolve(Array.isArray(j) ? j : [j]); } catch (e) { reject(e); }
    });
  });
}

// Pure: turns a raw process list into the rows the window shows. Children of a shown process fold into it and add their
// memory, so one test run shows once with its browser and bundler included.
function classify(all, selfPid) {
  const byPid = new Map(all.map((p) => [p.ProcessId, p]));
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const rule = (p) => (p.ProcessId === selfPid ? null : RULES.find((r) => r.test(p)));
  const shown = new Map();
  for (const p of all) { const r = rule(p); if (r) shown.set(p.ProcessId, { p, r }); }
  const tree = (pid, seen = new Set()) => {
    if (seen.has(pid)) return { mem: 0, n: 0 };
    seen.add(pid);
    const p = byPid.get(pid); let mem = p ? p.WorkingSetSize || 0 : 0, n = p ? 1 : 0;
    for (const c of kids.get(pid) || []) { const t = tree(c.ProcessId, seen); mem += t.mem; n += t.n; }
    return { mem, n };
  };
  const rows = [];
  for (const [pid, { p, r }] of shown) {
    // fold into an ancestor that is shown with the same rule family (router bash wrappers, a test run's own children)
    let up = byPid.get(p.ParentProcessId), folded = false;
    for (let i = 0; up && i < 12 && !folded; i++) { if (shown.has(up.ProcessId) && shown.get(up.ProcessId).r.group === r.group) folded = true; up = byPid.get(up.ParentProcessId); }
    if (folded) continue;
    const t = tree(pid);
    const sub = (id, seen = new Set()) => { if (seen.has(id)) return ''; seen.add(id); const q = byPid.get(id); const f = q ? folderOf(q.CommandLine) : ''; if (f) return f; for (const c of kids.get(id) || []) { const g = sub(c.ProcessId, seen); if (g) return g; } return ''; };
    const label = r.id === 'heavy' && !folderOf(p.CommandLine) && sub(pid) ? r.label(p) + dot(sub(pid)) : r.label(p);
    rows.push({ pid, start: p.Start, group: r.group, kind: r.id, label, risk: r.risk, memoryMB: Math.round(t.mem / 1048576), processes: t.n });
  }
  const order = ['Dashboard', 'Router', 'Agents', 'Tests and builds', 'Chat', 'Network'];
  rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || b.memoryMB - a.memoryMB);
  return rows;
}

async function list() { return classify(await snapshot(), process.pid); }

// Stops one row after re-reading the live list: the pid must still be the same process (same start time) and still be
// one the rules allow. Returns { ok, error }.
async function stop(pid, start) {
  const rows = classify(await snapshot(), process.pid);
  const row = rows.find((r) => r.pid === pid && r.start === start);
  if (!row) return { ok: false, error: 'That process has already ended or changed.' };
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, (err) => resolve(err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true }));
  });
}

module.exports = { list, stop, classify, RULES };

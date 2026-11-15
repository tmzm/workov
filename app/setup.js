// First-run checks for the Ejad Fleet app (main process): what is installed, whether Claude is signed in, and the sign-in itself.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const has = (exe) => spawnSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true }).status === 0;
const ver = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0].slice(0, 40) : ''; };

// `claude auth status` prints JSON; it needs no network and returns in well under a second
function claudeStatus() {
  if (!has('claude.exe') && !has('claude.cmd') && !has('claude')) return { installed: false, loggedIn: false };
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', windowsHide: true, shell: true, timeout: 15000 });
  try {
    const j = JSON.parse(r.stdout);
    return { installed: true, loggedIn: !!j.loggedIn, email: j.email || '', org: j.orgName || '', plan: j.subscriptionType || '', expires: j.loginExpiresAt || '' };
  } catch { return { installed: true, loggedIn: false }; }
}

// opens the browser sign-in; resolves when the CLI exits (it exits after the browser flow finishes)
function claudeLogin() {
  return new Promise((resolve) => {
    const p = spawn('claude', ['auth', 'login'], { shell: true, windowsHide: true, stdio: 'ignore' });
    const done = () => resolve(claudeStatus());
    p.on('exit', done); p.on('error', done);
    setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, 5 * 60 * 1000);
  });
}

function gitBash() { return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || null; }

function checks(cfg) {
  const claude = claudeStatus();
  const fleetOk = fs.existsSync(path.join(cfg.fleet, 'specs', 'worker-fleet.config.json'));
  const list = [
    { id: 'claude', name: 'Claude account', required: true, ok: claude.loggedIn, detail: claude.loggedIn ? `${claude.email}${claude.plan ? ' · ' + claude.plan : ''}${claude.org ? ' · ' + claude.org : ''}` : claude.installed ? 'Not signed in' : 'Claude Code is not installed', hint: claude.installed ? 'Sign in with your Claude account (chat, planner and designer use it)' : 'Install Claude Code, then sign in', action: claude.installed ? 'claude-login' : 'link', link: 'https://claude.com/download' },
    { id: 'git', name: 'Git Bash', required: true, ok: !!gitBash(), detail: gitBash() ? 'found' : 'missing', hint: 'The fleet scripts run in Git Bash', action: 'link', link: 'https://git-scm.com/download/win' },
    { id: 'python', name: 'Python 3', required: true, ok: has('python.exe'), detail: has('python.exe') ? ver('python', ['--version']) : 'missing', hint: 'The dashboard server is Python', action: 'link', link: 'https://www.python.org/downloads/' },
    { id: 'node', name: 'Node.js', required: true, ok: has('node.exe'), detail: has('node.exe') ? ver('node', ['--version']) : 'missing', hint: 'Patches and the planner use Node', action: 'link', link: 'https://nodejs.org/' },
    { id: 'opencode', name: 'OpenCode', required: true, ok: has('opencode.cmd') || has('opencode.exe') || has('opencode'), detail: has('opencode.cmd') || has('opencode.exe') || has('opencode') ? 'found' : 'missing', hint: 'Workers run on OpenCode (npm i -g opencode-ai)', action: 'link', link: 'https://opencode.ai/docs/' },
    { id: 'fleet', name: 'Fleet folder', required: true, ok: fleetOk, detail: fleetOk ? cfg.fleet : 'Choose the folder that holds specs/worker-fleet.config.json', hint: 'The project the fleet works on', action: 'pick-fleet' },
    { id: 'cloudflared', name: 'cloudflared (phone link)', required: false, ok: has('cloudflared.exe'), detail: has('cloudflared.exe') ? 'found' : 'optional', hint: 'Only needed to open the dashboard on your phone', action: 'link', link: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' },
  ];
  return { items: list, ready: list.filter((x) => x.required).every((x) => x.ok), claude };
}

module.exports = { checks, claudeStatus, claudeLogin };

'use strict';
// Adds a project from the app: asks for the repository, runs the bundled kit's install.sh (which creates the project's fleet
// home under ~/Workerov/fleets and registers it) and reports the result. The repository itself is never modified.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// where the kit (install.sh, patches, overlay, vendored worker-fleet) lives: inside the installed app, or the repo in development
function kitDir(app) { return app.isPackaged ? path.join(process.resourcesPath, 'kit') : path.resolve(__dirname, '..'); }

const slash = (p) => p.replace(/\\/g, '/');

function registered(name) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workerov', 'fleets.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).find((f) => f && f.name === name) || null;
  } catch { return null; }
}

// Runs the installer for one repository. Resolves { ok, root, log } where root is the new fleet home.
function install({ app, bash, repo, name, logFile }) {
  return new Promise((resolve) => {
    const kit = kitDir(app);
    const script = path.join(kit, 'install.sh');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'The fleet kit is missing from this installation (' + script + ').', log: logFile });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'w');
    const child = spawn(bash, [slash(script), slash(repo)], { env: { ...process.env, WV_PROJECT_NAME: name }, stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), log: logFile }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* closed */ }
      const f = registered(name);
      resolve(code === 0 && f ? { ok: true, root: f.root, log: logFile } : { ok: false, error: 'The installer stopped with code ' + code + '.', log: logFile });
    });
  });
}

function isGitRepo(dir) { return fs.existsSync(path.join(dir, '.git')); }

module.exports = { install, kitDir, isGitRepo, registered };

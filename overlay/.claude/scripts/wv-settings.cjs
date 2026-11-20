// Read one effective setting through the layered-settings resolver (~/.wv-bin/wv-settings.py):
// kit defaults < the hub's worker-fleet.config.json < this project's layer < the ticket's layer.
// setting('models.reviewer.claude.model', { ticket: '012', fallback: 'sonnet' }) -> the value, or the fallback when it is not set
// or the resolver cannot run. Run it from the project folder. Resolve once when an agent starts; never mid-run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function hubRoot() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workov', 'hub.json'), 'utf8')).root || ''; } catch { return ''; }
}

function setting(key, { ticket, fallback, cwd = process.cwd() } = {}) {
  const hub = hubRoot();
  if (!hub) return fallback;
  const script = path.join(os.homedir(), '.wv-bin', 'wv-settings.py');
  const args = ['-I', script, 'resolve', '--hub', hub, '--project', cwd, '--base', cwd, ...(ticket ? ['--ticket', ticket] : []), '--key', key];
  for (const py of ['python3', 'python']) {
    try {
      const out = execFileSync(py, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || fallback;
    } catch (e) {
      if (e.status === 1) return fallback; // the resolver ran and the key is not set
    }
  }
  return fallback;
}

module.exports = { setting };

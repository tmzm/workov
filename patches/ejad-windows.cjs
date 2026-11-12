// Windows fix for worker-fleet's start-dashboard.sh: Python prints CRLF there, so the port read from the config
// ends with a carriage return and the start fails with "invalid port: 3080". Strip CR from the captured values.
// (Function replacements: a "$'" in a replacement string would be read as a special pattern.)
const fs = require('fs');
const f = '.claude/scripts/start-dashboard.sh';
let t = fs.readFileSync(f, 'utf8');
const CR = "$'\\r'";
const a = '    PORT="${CONFIG_OUT%%$\'\\n\'*}"';
if (!t.includes('CONFIG_OUT="${CONFIG_OUT//')) {
  if (!t.includes(a)) throw new Error('start-dashboard.sh anchor missing');
  t = t.replace(a, () => `    CONFIG_OUT="\${CONFIG_OUT//${CR}/}"\n${a}`);
}
const b = '    NEW_PORT="$(sd_py pick "$PORT" "$CONFIG_FILE" 2>/dev/null || true)"';
if (t.includes(b) && !t.includes('NEW_PORT="${NEW_PORT//')) t = t.replace(b, () => `${b}\n    NEW_PORT="\${NEW_PORT//${CR}/}"`);
fs.writeFileSync(f, t);
console.log('start-dashboard.sh patched');

// Windows: the dashboard server runs bash/git/python every few seconds (watchdog, telemetry). Each child of a
// windowless background process gets its own console window, which pops up on screen. Start them all hidden.
const NO_WINDOW = `
if os.name == "nt":  # ejad-fleet: never open a console window for child processes
    _ejad_popen_init = subprocess.Popen.__init__

    def _ejad_popen_hidden(self, *args, **kwargs):
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | 0x08000000  # CREATE_NO_WINDOW
        _ejad_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _ejad_popen_hidden
`;
for (const py of ['.claude/scripts/dashboard-server.py', '.claude/scripts/apply-setup.py']) {
  let s = fs.readFileSync(py, 'utf8');
  if (!s.includes('_ejad_popen_hidden')) {
    if (!/^import subprocess$/m.test(s) || !/^import os$/m.test(s)) throw new Error(`${py}: imports not found`);
    s = s.replace(/^import subprocess$/m, () => `import subprocess\n${NO_WINDOW}`);
    fs.writeFileSync(py, s);
  }
  console.log(`${py} patched`);
}

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

// Windows: watchdog-check.sh and router-wake.sh run Python that calls Unix-only APIs. os.getuid and signal.SIGHUP
// don't exist (AttributeError), and os.kill(pid, 0) — a liveness probe on Unix — TERMINATES the process on Windows.
// Prepend a shim to every embedded Python block: getuid() returns 0, missing signals map to SIGTERM, and
// os.kill(pid, 0) only checks that the process is alive (OpenProcess + GetExitCodeProcess).
const PY_SHIM = `import os as _ejad_os, signal as _ejad_signal  # ejad-fleet: Windows shim
if _ejad_os.name == "nt":
    import ctypes as _ejad_ct
    if not hasattr(_ejad_os, "getuid"):
        _ejad_os.getuid = lambda: 0
    for _ejad_n in ("SIGHUP", "SIGKILL", "SIGQUIT", "SIGUSR1"):
        if not hasattr(_ejad_signal, _ejad_n):
            setattr(_ejad_signal, _ejad_n, _ejad_signal.SIGTERM)
    _ejad_k32 = _ejad_ct.WinDLL("kernel32", use_last_error=True)
    _ejad_kill = _ejad_os.kill

    def _ejad_kill_safe(pid, sig):
        if sig != 0:
            return _ejad_kill(pid, sig)
        h = _ejad_k32.OpenProcess(0x1000, False, int(pid))
        if not h:
            if _ejad_ct.get_last_error() == 5:
                raise PermissionError(pid)
            raise ProcessLookupError(pid)
        code = _ejad_ct.c_ulong()
        _ejad_k32.GetExitCodeProcess(h, _ejad_ct.byref(code))
        _ejad_k32.CloseHandle(h)
        if code.value != 259:
            raise ProcessLookupError(pid)

    _ejad_os.kill = _ejad_kill_safe
`;
for (const sh of ['.claude/scripts/watchdog-check.sh', '.claude/scripts/router-wake.sh']) {
  let s = fs.readFileSync(sh, 'utf8');
  if (!s.includes('ejad-fleet: Windows shim')) {
    const n = (s.match(/<<'PY'\n/g) || []).length;
    if (!n) throw new Error(`${sh}: no python heredoc found`);
    s = s.replace(/<<'PY'\n/g, () => `<<'PY'\n${PY_SHIM}`);
    fs.writeFileSync(sh, s);
    console.log(`${sh} patched (${n} python blocks)`);
  } else console.log(`${sh} already patched`);
}

// Windows: the dashboard's watchdog scheduler executes watchdog-check.sh directly, which fails with
// "[WinError 193] %1 is not a valid Win32 application". Run it through bash there, like the other script calls.
{
  const py = '.claude/scripts/dashboard-server.py';
  let s = fs.readFileSync(py, 'utf8');
  const a = '        [str(WATCHDOG_SCRIPT_PATH), "--json"],';
  if (!s.includes('(["bash"] if os.name == "nt" else []) + [str(WATCHDOG_SCRIPT_PATH)')) {
    if (!s.includes(a)) throw new Error(`${py}: watchdog call not found`);
    s = s.replace(a, () => '        (["bash"] if os.name == "nt" else []) + [str(WATCHDOG_SCRIPT_PATH), "--json"],');
    fs.writeFileSync(py, s);
  }
  console.log(`${py} watchdog call patched`);
}

// Windows: a plain "bash" can resolve to WSL's bash.exe (System32), which can't run the repo's scripts. Every child
// process the dashboard starts as ["bash", ...] uses Git Bash instead (next to git.exe, or EJAD_BASH).
{
  const py = '.claude/scripts/dashboard-server.py';
  let s = fs.readFileSync(py, 'utf8');
  const hook = '        kwargs["creationflags"] = kwargs.get("creationflags", 0) | 0x08000000  # CREATE_NO_WINDOW\n';
  if (!s.includes('_ejad_git_bash')) {
    if (!s.includes(hook)) throw new Error(`${py}: popen hook not found`);
    s = s.replace(hook, () => hook + `        cmd = args[0] if args else kwargs.get("args")
        if isinstance(cmd, list) and cmd and cmd[0] == "bash" and _ejad_git_bash():
            cmd = [_ejad_git_bash()] + cmd[1:]
            args = (cmd,) + tuple(args[1:]) if args else args
            if not args:
                kwargs["args"] = cmd
`);
    s = s.replace('    _ejad_popen_init = subprocess.Popen.__init__\n', () => `    _ejad_popen_init = subprocess.Popen.__init__
    _ejad_bash_cache = []

    def _ejad_git_bash():
        if not _ejad_bash_cache:
            import shutil as _sh
            cands = [os.environ.get("EJAD_BASH", "")]
            git = _sh.which("git")
            if git:
                root = os.path.dirname(os.path.dirname(git))
                cands += [os.path.join(root, "bin", "bash.exe"), os.path.join(root, "usr", "bin", "bash.exe")]
            cands += ["C:/Program Files/Git/bin/bash.exe"]
            _ejad_bash_cache.append(next((c for c in cands if c and os.path.isfile(c)), ""))
        return _ejad_bash_cache[0]
`);
    fs.writeFileSync(py, s);
  }
  console.log(`${py} git bash for child scripts`);
}

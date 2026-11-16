// Workerov: one dashboard for every project. A dashboard records itself in ~/.workerov/hub.json when it starts listening;
// another project's start-dashboard.sh (run by its router) then does nothing instead of opening a second dashboard on
// the next free port. Its tickets are served by the hub's board. --stop and --help are never blocked. Idempotent.
const fs = require('fs');
const path = require('path');
const MARK = '# wv-one-dashboard';
let n = 0;

const sh = '.claude/scripts/start-dashboard.sh';
if (fs.existsSync(sh)) {
  let s = fs.readFileSync(sh, 'utf8').replace(/\r\n/g, '\n');
  if (!s.includes(MARK)) {
    const snippet = fs.readFileSync(path.join(__dirname, 'one-dashboard.sh.txt'), 'utf8').replace(/\r\n/g, '\n');
    const anchor = 'cd "$REPO_ROOT"\n';
    if (!s.includes(anchor)) { console.error('one-dashboard: anchor missing in start-dashboard.sh'); process.exit(1); }
    s = s.replace(anchor, anchor + '\n' + MARK + '\n' + snippet + '\n');
    fs.writeFileSync(sh, s); n++;
  }
}

const py = '.claude/scripts/dashboard-server.py';
if (fs.existsSync(py)) {
  let s = fs.readFileSync(py, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (!s.includes(MARK)) {
    const anchor = '        httpd.serve_forever()';
    if (!s.includes(anchor)) { console.error('one-dashboard: anchor missing in dashboard-server.py'); process.exit(1); }
    const add = `        ${MARK}: remember which dashboard serves this computer, so other projects do not start their own
        try:
            _hub = Path.home() / ".workerov" / "hub.json"
            _hub.parent.mkdir(parents=True, exist_ok=True)
            _hub.write_text(json.dumps({"root": str(REPO_ROOT).replace(chr(92), "/"), "port": port}), encoding="utf-8")
        except Exception:
            pass
`;
    s = s.replace(anchor, add + anchor);
    fs.writeFileSync(py, crlf ? s.replace(/\n/g, '\r\n') : s); n++;
  }
}
if (n) console.log('one-dashboard guard installed in ' + n + ' file(s)');

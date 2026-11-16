// Workerov: ONE dashboard server for every project. A request about a ticket of another project (id "MEL-001": the first
// three letters of the project's name and its number) is run by the very same handler code as a local ticket, inside that
// project's folder, for that one request in that request's thread only. REPO_ROOT and the 13 files derived from it follow a
// per-thread context, so the ticket drawer, tabs, evidence, logs, mockups and every action (dispatch, pause, stop, review,
// deliver...) work for all projects the same way. Needs the projects registry (patch projects-board). Idempotent.
const fs = require('fs');
const path = require('path');
const F = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(F, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (!s.includes('class _CtxPath')) {
  // 1. REPO_ROOT becomes context aware
  const root = /^REPO_ROOT = find_repo_root\(Path\(__file__\)\.parent\)$/m.exec(s);
  if (!root) throw new Error('anchor missing: REPO_ROOT');
  s = s.replace(root[0], `_WV_BASE_ROOT = find_repo_root(Path(__file__).parent)
_WV_CTX = threading.local()


class _CtxPath(os.PathLike):
    """A path under the project folder of the CURRENT request (the hub's own folder outside a project request)."""

    def __init__(self, *parts):
        self._parts = parts

    def _p(self):
        base = getattr(_WV_CTX, "root", None) or _WV_BASE_ROOT
        return Path(base).joinpath(*self._parts)

    def __fspath__(self):
        return str(self._p())

    def __str__(self):
        return str(self._p())

    def __repr__(self):
        return "CtxPath(" + str(self._p()) + ")"

    def __truediv__(self, other):
        return self._p() / other

    def __eq__(self, other):
        return self._p() == (other._p() if isinstance(other, _CtxPath) else other)

    def __hash__(self):
        return hash(self._p())

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return getattr(self._p(), name)


REPO_ROOT = _CtxPath()`);
  // 2. the files computed from it at import time follow the context too
  let n = 0;
  s = s.replace(/^([A-Z][A-Z0-9_]*) = REPO_ROOT((?: \/ "[^"\n]+")+)$/gm, (m, name, chain) => {
    n++;
    const parts = [...chain.matchAll(/"([^"\n]+)"/g)].map((x) => JSON.stringify(x[1]));
    return `${name} = _CtxPath(${parts.join(', ')})`;
  });
  // 2b. who may call is decided by the hub's own token file, whichever project the request is about
  s = s.split('REPO_ROOT / "job" / "dashboard-auth.json"').join('_WV_BASE_ROOT / "job" / "dashboard-auth.json"');
  // 3. evidence links of a ticket drawn in another project carry its prefix, so the next request finds the project again
  const ev = '"url": f"/api/evidence/{tid}/{ef.name}",';
  if (s.includes(ev)) s = s.replace(ev, '"url": f"/api/evidence/{wv_ctx_prefix()}{tid}/{ef.name}",');
  // 4. the per-request project scope, before the server class
  const cls = /^class FleetControlServer\(/m.exec(s);
  if (!cls) throw new Error('anchor missing: class FleetControlServer');
  const code = fs.readFileSync(path.join(__dirname, 'project-context.py.txt'), 'utf8').replace(/\r\n/g, '\n');
  s = s.slice(0, cls.index) + code + s.slice(cls.index);
  fs.writeFileSync(F, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log(`project context: server patched (${n} derived files)`);
}

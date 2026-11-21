// Workov: a Switch on / Switch off button on every project card of the Projects page. A project that is switched off (job/fleet-off in its
// folder, written by the stage migration or by hand) is skipped by the router however many times the fleet is resumed: "Resume all" only
// clears the hub's own marker, so the router loop stopped with "every project is switched off". The button writes or removes that marker
// for one project. It never touches another project and it never starts anything itself. Builds on dashboard-run.cjs and projects-board.cjs.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_project_fleet(req):
    """Switch one project's fleet on (remove its job/fleet-off) or off (write it). Only projects the app knows."""
    try:
        rows = json.loads((Path.home() / ".workov" / "fleets.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        rows = []
    name = str(req.get("project") or "")
    proj = next((r for r in rows if isinstance(r, dict) and r.get("name") == name and r.get("root")), None) if isinstance(rows, list) else None
    if not proj or not (Path(proj["root"]) / "specs").is_dir():
        return 404, {"error": "Unknown project."}
    marker = Path(proj["root"]) / "job" / "fleet-off"
    if req.get("on"):
        marker.unlink(missing_ok=True)
    else:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("switched off from the dashboard\n", encoding="utf-8")
    return 200, {"ok": True, "project": name, "off": marker.exists()}

`;
if (!s.includes('def wv_project_fleet')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const a = 'WV_ACTIONS = ("';
  must(a);
  s = s.replace(a, () => 'WV_ACTIONS = ("wv_project_fleet", "');
  const r = '    if action == "wv_fleet_start":';
  must(r);
  s = s.replace(r, () => '    if action == "wv_project_fleet":\n        return wv_project_fleet(req)\n' + r);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: wv_project_fleet');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('wvProjectFleetBtn')) {
  const m = /(head\.append\(el\('span', 'badge' \+ \(p\.router === 'run'[^\n]*\n)(\s*)((?:if \(window\.wvOpenModelsDialog\)[^\n]*\n\s*)?card\.append\(head\);)/.exec(h);
  if (!m) throw new Error('anchor missing: project card head (apply projects-board.cjs first)');
  const btn = `var wvProjectFleetBtn = el('button', 'btn btn-sm', p.off ? 'Switch on' : 'Switch off'); wvProjectFleetBtn.type = 'button';
              wvProjectFleetBtn.title = p.off ? 'The router skips this project while it is off' : 'Stop the router from starting work in this project';
              wvProjectFleetBtn.addEventListener('click', function () {
                var hh = { 'Content-Type': 'application/json' }; var tk = token(); if (tk) hh.Authorization = 'Bearer ' + tk;
                fetch('/api/action', { method: 'POST', headers: hh, body: JSON.stringify({ action: 'wv_project_fleet', project: p.name, on: !!p.off }) })
                  .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
                  .then(function (x) { var msg = document.getElementById('projects-msg'); if (msg) msg.textContent = x.ok ? p.name + (p.off ? ' is switched on. The router picks up its ready tickets.' : ' is switched off.') : (x.j && x.j.error) || 'Could not do that.'; load(); })
                  .catch(function () { var msg = document.getElementById('projects-msg'); if (msg) msg.textContent = 'Could not reach the dashboard.'; });
              });
              head.append(wvProjectFleetBtn);
`;
  h = h.replace(m[0], () => m[1] + m[2] + btn + m[2] + m[3]);
  fs.writeFileSync(H, h);
}
console.log('index.html: project fleet switch');

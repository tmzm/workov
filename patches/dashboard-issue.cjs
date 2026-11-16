// Workerov: the "Provider problem" banner clears when the provider is changed (apply after dashboard-keystore.cjs).
// The banner reads the last 15 minutes of the router and worker logs, so it kept showing a limit error that the user
// had already fixed by switching provider. Now switching a model, connecting or disconnecting a provider, refreshing
// the model list, starting the fleet or changing the implementer records how far each log has been written; only error
// lines after that point count. If the error comes back, so does the banner.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

if (!s.includes('def wv_clear_issue')) {
  const a = s.indexOf('def wv_provider_issue():');
  const b = s.indexOf('def wv_config_path():', a);
  if (a < 0 || b < 0) throw new Error('anchor missing: wv_provider_issue');
  const NEW = String.raw`WV_ISSUE_MARK = REPO_ROOT / "job" / "issue-cleared.json"
WV_CLEARS_ISSUE = ("wv_set_model", "wv_models_preset", "wv_connect_provider", "wv_disconnect_provider", "wv_refresh_models", "wv_fleet_start", "wv_set_implementer")


def wv_issue_files():
    return [REPO_ROOT / "job" / "router-loop.log"] + [Path(f) for f in sorted(glob.glob(str(REPO_ROOT / "job" / "logs" / "*.log")), key=os.path.getmtime, reverse=True)[:3]]


def wv_clear_issue():
    """Remember how far every log has been written, so earlier error lines stop counting."""
    marks = {}
    for p in wv_issue_files():
        try:
            marks[p.name] = p.stat().st_size
        except OSError:
            pass
    try:
        wv_atomic_write(WV_ISSUE_MARK, json.dumps(marks))
    except Exception:
        pass


def wv_provider_issue():
    """The newest provider error in the router and worker logs of the last 15 minutes that was written after the last provider change."""
    try:
        marks = json.loads(WV_ISSUE_MARK.read_text(encoding="utf-8"))
    except Exception:
        marks = {}
    now = time.time()
    for p in wv_issue_files():
        try:
            age, size = now - p.stat().st_mtime, p.stat().st_size
            if age > 15 * 60:
                continue
            start = marks.get(p.name, 0)
            if start > size:
                start = 0
            if start >= size:
                continue
            with open(p, "rb") as fh:
                fh.seek(max(start, size - 30000))
                lines = WV_ANSI_RE.sub("", fh.read().decode("utf-8", "ignore")).splitlines()
        except OSError:
            continue
        hits = [i for i, ln in enumerate(lines) if WV_ISSUE_RE.search(ln)]
        if not hits:
            continue
        return {"message": lines[hits[-1]].strip()[:320], "source": p.name, "ageSec": int(age)}
    return None


`;
  s = s.slice(0, a) + NEW + s.slice(b);
  const site = '                    code, payload = wv_run_action(action, req, ticket_id)\n';
  must(site);
  s = s.replace(site, () => site + '                    if code == 200 and action in WV_CLEARS_ISSUE:\n                        wv_clear_issue()\n');
  fs.writeFileSync(S, s);
}
console.log('issue patch applied');

// Workerov: three things the dashboard did not show or let you do (apply after wv-dashboard-run and -overlay):
//  1. Provider problems: when the router or a worker log shows "usage limit reached", a rate limit, a billing or auth
//     error or a missing model, a red banner says so, with the provider's own words, instead of the fleet just sitting.
//  2. Time per step: the server samples the board every 10 s and records each change of a ticket's step in
//     job/timeline.jsonl (plan, waiting for approval, queued, build phases, waiting for your answer, final review,
//     waiting for delivery, done). The "Time per step" panel adds it up per ticket: working vs waiting for you vs queued.
//  3. Providers panel: switch the model (and so the provider, e.g. opencode-go or the free opencode models) of every
//     role, and the default implementer CLI the worker hands build steps to (none, copilot, kilo, antigravity, codex).
//     A model change is written to the three places OpenCode reads (worker-fleet.config.json, opencode.json and the
//     agent file) and applies from the next agent start; the implementer applies from the next worker.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n'); // the file may mix CRLF and LF; Python reads both
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };

const FN = String.raw`
import shutil

WV_ISSUE_RE = re.compile(r"(usage limit reached|rate.?limit|quota (?:exceeded|reached)|insufficient (?:credit|balance|funds)|billing|unauthorized|invalid api key|authentication failed|Agent not found|model not found|ProviderModelNotFound)", re.I)
WV_ANSI_RE = re.compile(r"(?:\x1b)?\[[0-9;]*m")
WV_CLIS = {"copilot": "copilot", "kilo": "kilo", "antigravity": "agy", "codex": "codex"}
WV_TL_FILE = REPO_ROOT / "job" / "timeline.jsonl"
_wv_models_cache = [0.0, []]


def wv_provider_issue():
    """The newest provider error in the router and worker logs of the last 20 minutes, unless work went on after it."""
    files = [REPO_ROOT / "job" / "router-loop.log"] + [Path(f) for f in sorted(glob.glob(str(REPO_ROOT / "job" / "logs" / "*.log")), key=os.path.getmtime, reverse=True)[:3]]
    now = time.time()
    for p in files:
        try:
            age, size = now - p.stat().st_mtime, p.stat().st_size
            if age > 15 * 60:
                continue
            with open(p, "rb") as fh:
                fh.seek(max(0, size - 30000))
                lines = WV_ANSI_RE.sub("", fh.read().decode("utf-8", "ignore")).splitlines()
        except OSError:
            continue
        hits = [i for i, ln in enumerate(lines) if WV_ISSUE_RE.search(ln)]
        if not hits:
            continue
        return {"message": lines[hits[-1]].strip()[:320], "source": p.name, "ageSec": int(age)}
    return None


def wv_config_path():
    return REPO_ROOT / "specs" / "worker-fleet.config.json"


def wv_model_list():
    if time.time() - _wv_models_cache[0] < 300 and _wv_models_cache[1]:
        return _wv_models_cache[1]
    try:
        out = subprocess.run(["opencode", "models"], capture_output=True, text=True, timeout=45, shell=(os.name == "nt"), creationflags=WV_NOWIN).stdout
        models = sorted({ln.strip() for ln in out.splitlines() if "/" in ln and " " not in ln.strip()})
        if models:
            _wv_models_cache[0], _wv_models_cache[1] = time.time(), models
    except Exception as e:
        print(f"[wv] opencode models failed: {e}", file=sys.stderr)
    return _wv_models_cache[1]


def wv_providers():
    cfg = json.loads(wv_config_path().read_text(encoding="utf-8"))
    models = cfg.get("models", {})
    roles = [{"role": r, "model": ((v.get("opencode") or {}).get("model") or ""), "claude": ((v.get("claude") or {}).get("model") or "")} for r, v in models.items() if isinstance(v, dict)]
    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}
    return {"roles": roles, "models": wv_model_list(), "implementer": (models.get("worker") or {}).get("delegateCli", "none"), "clis": clis, "harness": cfg.get("harness", "")}


def wv_set_model(role, model):
    if not re.fullmatch(r"[a-z][a-z0-9-]*", str(role)) or not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+", str(model)):
        return 400, {"error": "Give a role and a model like provider/model."}
    known = wv_model_list()
    if known and model not in known:
        return 400, {"error": f"{model} is not in the list from opencode models."}
    path = wv_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    entry = (cfg.get("models") or {}).get(role)
    if not isinstance(entry, dict):
        return 404, {"error": f"No role {role} in the fleet config."}
    entry.setdefault("opencode", {})["model"] = model
    wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    changed = ["specs/worker-fleet.config.json"]
    oc = REPO_ROOT / "opencode.json"
    if oc.exists():
        data = json.loads(oc.read_text(encoding="utf-8"))
        if isinstance(data.get("agent", {}).get(role), dict):
            data["agent"][role]["model"] = model
            wv_atomic_write(oc, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            changed.append("opencode.json")
    md = REPO_ROOT / ".opencode" / "agents" / f"{role}.md"
    if md.exists():
        text = md.read_text(encoding="utf-8")
        head, sep, rest = text.partition("\n---\n")
        if sep and re.search(r"^model:.*$", head, re.M):
            wv_atomic_write(md, re.sub(r"^model:.*$", lambda m: f"model: {model}", head, count=1, flags=re.M) + sep + rest)
            changed.append(f".opencode/agents/{role}.md")
    try:
        subprocess.run(["opencode", "reload"], capture_output=True, timeout=30, shell=(os.name == "nt"), creationflags=WV_NOWIN)
    except Exception:
        pass
    return 200, {"ok": True, "role": role, "model": model, "changed": changed, "note": "Applies from the next agent start."}


def wv_set_implementer(cli):
    if cli != "none" and cli not in WV_CLIS:
        return 400, {"error": "Choose none, copilot, kilo, antigravity or codex."}
    if cli != "none" and not shutil.which(WV_CLIS[cli]):
        return 409, {"error": f"{cli} is not installed on this computer (command {WV_CLIS[cli]} not found)."}
    path = wv_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    cfg.setdefault("models", {}).setdefault("worker", {})["delegateCli"] = cli
    wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return 200, {"ok": True, "implementer": cli, "note": "Applies from the next worker."}


def wv_stage_of(row, entries, pending, reviewing):
    st = row["status"]
    if st == "specifying":
        return "plan"
    if st == "draft":
        return "waiting: your approval"
    if st == "ready":
        return "queued"
    if st == "in-progress":
        ph = str((entries.get(row["id"]) or {}).get("lastPhase") or "building")
        return "build" if ph in ("building", "dispatched", "implementing", "dispatching") else ph
    if st == "blocked":
        return "waiting: your answer" if row["id"] in pending else "blocked"
    if st == "in-review":
        return "final review" if row["id"] in reviewing else "waiting: review or delivery"
    return st


def wv_timeline_sample(last):
    state = wv_router_state()
    entries = {}
    for v in state.values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and e.get("ticket"):
                    entries[str(e["ticket"]).split("-")[0]] = e
    pending = {str(x).split("-")[0] for x in state.get("pendingDecisions", []) or []}
    reviewing = set()
    for f in glob.glob(str(REPO_ROOT / "job" / "review-*.json")):
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8"))
            if d.get("state") == "running":
                reviewing.add(str(d.get("ticket", "")).split("-")[0])
        except Exception:
            pass
    paused = (REPO_ROOT / "job" / "paused.json").exists()
    lines = []
    for row in wv_board():
        stage = wv_stage_of(row, entries, pending, reviewing)
        if paused and stage in ("queued", "build"):
            stage = "paused"
        if last.get(row["id"]) != stage:
            last[row["id"]] = stage
            lines.append(json.dumps({"ts": utc_now_iso(), "ticket": row["id"], "stage": stage}))
    if lines:
        with open(WV_TL_FILE, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")


def wv_timeline_loop():
    last = {}
    try:
        for ln in WV_TL_FILE.read_text(encoding="utf-8").splitlines():
            d = json.loads(ln)
            last[d["ticket"]] = d["stage"]
    except Exception:
        pass
    while True:
        try:
            wv_timeline_sample(last)
        except Exception as e:
            print(f"[wv] timeline sample failed: {e}", file=sys.stderr)
        time.sleep(10)


threading.Thread(target=wv_timeline_loop, daemon=True).start()


def wv_timeline():
    events = {}
    try:
        for ln in WV_TL_FILE.read_text(encoding="utf-8").splitlines():
            d = json.loads(ln)
            events.setdefault(d["ticket"], []).append((datetime.strptime(d["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc), d["stage"]))
    except Exception:
        pass
    titles = {r["id"]: r["title"] for r in wv_board()}
    now = datetime.now(timezone.utc)
    out = []
    for tid, evs in events.items():
        segs = []
        for i, (ts, stage) in enumerate(evs):
            end = evs[i + 1][0] if i + 1 < len(evs) else now
            sec = max(0, int((end - ts).total_seconds()))
            if segs and segs[-1]["stage"] == stage:
                segs[-1]["sec"] += sec
            else:
                segs.append({"stage": stage, "sec": sec, "at": ts.strftime("%H:%M")})
        if segs and segs[-1]["stage"] == "done":
            segs[-1]["sec"] = 0
        out.append({"id": tid, "title": titles.get(tid, ""), "since": evs[0][0].isoformat(), "segments": segs})
    return {"tickets": sorted(out, key=lambda t: t["since"], reverse=True), "note": "Recorded from the moment this dashboard version started; earlier history is not available."}

`;

if (!s.includes('def wv_provider_issue')) {
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);

  const a1 = 'WV_ACTIONS = (';
  must(s, a1);
  s = s.replace(a1, () => 'WV_ACTIONS = ("wv_set_model", "wv_set_implementer", ');

  const a2 = '    if not is_valid_ticket_id(tid):\n        return 400, {"error": "Invalid ticket parameter';
  must(s, a2);
  s = s.replace(a2, () => '    if action == "wv_set_model":\n        return wv_set_model(req.get("role"), req.get("model"))\n    if action == "wv_set_implementer":\n        return wv_set_implementer(str(req.get("cli", "")))\n' + a2);

  const a3 = 'return {"resuming": wv_resuming(), ';
  must(s, a3);
  s = s.replace(a3, () => 'return {"issue": wv_provider_issue(), "resuming": wv_resuming(), ');

  const g = '        if path == "/api/wv/overview":';
  must(s, g);
  s = s.replace(g, () => '        if path == "/api/wv/providers":\n            self._send_json(200, wv_providers())\n            return\n\n        if path == "/api/wv/timeline":\n            self._send_json(200, wv_timeline())\n            return\n\n' + g);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: provider issue banner, timeline, providers');

// the worker hands build steps to the configured default implementer when the ticket names none
for (const f of ['.claude/agents/worker.md', '.opencode/agents/worker.md']) {
  if (!fs.existsSync(f)) continue;
  let w = fs.readFileSync(f, 'utf8');
  const old = '(default: you build it yourself)';
  if (w.includes(old)) {
    w = w.replace(old, () => '(default when rd.md names none: the CLI that `models.worker.delegateCli` in `specs/worker-fleet.config.json` names, if it is `copilot`, `kilo` or `antigravity`; otherwise you build it yourself)');
    fs.writeFileSync(f, w);
    console.log(f + ': default implementer from the config');
  }
}

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="wv-issue"')) {
  const hd = '</header>';
  must(h, hd);
  h = h.replace(hd, () => hd + '\n<div id="wv-issue" role="alert" hidden style="margin:10px 16px;padding:12px 14px;border:1px solid #c0392b;border-left-width:6px;border-radius:8px;background:rgba(192,57,43,.14);line-height:1.5;"></div>');

  const sec = '          <div id="wv-delivery"></div>\n        </section>\n';
  must(h, sec);
  h = h.replace(sec, () => sec + `        <details id="wv-timeline" class="wv-panel" style="margin-bottom:12px;">
          <summary>Time per step <span class="note-s">(where the time goes: working, waiting for you, queued)</span></summary>
          <p class="note-s" id="wv-tl-note"></p>
          <div id="wv-tl-body" style="overflow-x:auto;"></div>
        </details>
        <details id="wv-providers" class="wv-panel" style="margin-bottom:12px;">
          <summary>Providers: switch the model of each agent, and the implementer <span class="note-s" id="wv-pv-note"></span></summary>
          <div id="wv-pv-body" style="overflow-x:auto;"></div>
        </details>
`);

  const hook = '      btn.disabled = mode === \'pausing\'';
  must(h, hook);
  h = h.replace(hook, () => '      wvShowIssue(d.issue);\n' + hook);

  const call = '    wvPollPermissions(); setInterval(wvPollPermissions, 2000);';
  must(h, call);
  h = h.replace(call, () => `    function wvShowIssue(i) {
      const el = document.getElementById('wv-issue');
      if (!i) { el.hidden = true; return; }
      el.textContent = '';
      const b = document.createElement('strong'); b.textContent = 'Provider problem: ';
      const t = document.createElement('span'); t.textContent = i.message;
      const hint = document.createElement('div'); hint.className = 'note-s';
      hint.textContent = 'Seen in ' + i.source + ' ' + Math.round(i.ageSec / 60) + ' min ago. The fleet cannot make progress until this is fixed. You can switch the model below under Providers.';
      const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-sm'; go.textContent = 'Open Providers'; go.style.marginTop = '6px';
      go.onclick = () => { const d = document.getElementById('wv-providers'); d.open = true; d.scrollIntoView({ block: 'center' }); };
      el.append(b, t, hint, go); el.hidden = false;
    }
    const wvFmt = (sec) => sec >= 3600 ? Math.floor(sec / 3600) + 'h ' + String(Math.floor(sec % 3600 / 60)).padStart(2, '0') + 'm' : sec >= 60 ? Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's' : sec + 's';
    async function wvLoadTimeline() {
      const box = document.getElementById('wv-tl-body');
      try {
        const res = await fetch('/api/wv/timeline', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        document.getElementById('wv-tl-note').textContent = d.note;
        box.textContent = '';
        if (!d.tickets.length) { box.textContent = 'No steps recorded yet.'; return; }
        const tbl = document.createElement('table'); tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
        const head = tbl.createTHead().insertRow();
        ['Ticket', 'Working', 'Waiting for you', 'Queued or paused', 'Steps in order'].forEach(x => { const th = document.createElement('th'); th.align = 'left'; th.style.padding = '4px 8px'; th.textContent = x; head.append(th); });
        d.tickets.forEach(t => {
          let work = 0, wait = 0, q = 0;
          t.segments.forEach(g => { if (g.stage.startsWith('waiting')) wait += g.sec; else if (g.stage === 'queued' || g.stage === 'paused') q += g.sec; else if (g.stage !== 'done' && g.stage !== 'blocked') work += g.sec; });
          const tr = tbl.insertRow();
          [t.id + ' ' + t.title, wvFmt(work), wvFmt(wait), wvFmt(q), t.segments.map(g => g.stage + ' ' + wvFmt(g.sec)).join('  ›  ')].forEach(x => { const td = tr.insertCell(); td.style.cssText = 'padding:4px 8px;border-top:1px solid var(--line, #8884);'; td.textContent = x; });
        });
        box.append(tbl);
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    async function wvLoadProviders() {
      const box = document.getElementById('wv-pv-body');
      try {
        const res = await fetch('/api/wv/providers', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        document.getElementById('wv-pv-note').textContent = '(runtime: ' + d.harness + ')';
        box.textContent = '';
        const tbl = document.createElement('table'); tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
        const head = tbl.createTHead().insertRow();
        ['Agent', 'Model (provider/model)', ''].forEach(x => { const th = document.createElement('th'); th.align = 'left'; th.style.padding = '4px 8px'; th.textContent = x; head.append(th); });
        const cell = (tr, node) => { const td = tr.insertCell(); td.style.cssText = 'padding:4px 8px;border-top:1px solid var(--line, #8884);'; td.append(node); return td; };
        d.roles.forEach(r => {
          const tr = tbl.insertRow();
          cell(tr, document.createTextNode(r.role));
          const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Model of ' + r.role); sel.style.maxWidth = '320px';
          const list = d.models.length ? d.models : [r.model];
          (list.includes(r.model) ? list : [r.model].concat(list)).forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m + (m.endsWith('-free') || m.startsWith('opencode/') ? '  (free tier)' : ''); if (m === r.model) o.selected = true; sel.append(o); });
          cell(tr, sel);
          const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = 'Apply';
          b.onclick = async () => { const x = await wvPost({ action: 'wv_set_model', role: r.role, model: sel.value }); showToast(x.ok ? r.role + ' now uses ' + sel.value + ' (next agent start)' : (x.j.error || 'Could not change the model'), x.ok ? undefined : 'bad'); };
          cell(tr, b);
        });
        const tr = tbl.insertRow();
        cell(tr, document.createTextNode('Implementer'));
        const isel = document.createElement('select'); isel.setAttribute('aria-label', 'Implementer CLI');
        [['none', 'None: the worker builds it itself']].concat(Object.keys(d.clis).map(k => [k, k + (d.clis[k] ? '' : '  (not installed)')])).forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === d.implementer) o.selected = true; isel.append(o); });
        cell(tr, isel);
        const ib = document.createElement('button'); ib.type = 'button'; ib.className = 'btn btn-sm'; ib.textContent = 'Apply';
        ib.onclick = async () => { const x = await wvPost({ action: 'wv_set_implementer', cli: isel.value }); showToast(x.ok ? 'Implementer is now ' + isel.value + ' (next worker)' : (x.j.error || 'Could not change the implementer'), x.ok ? undefined : 'bad'); };
        cell(tr, ib);
        box.append(tbl);
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    document.getElementById('wv-timeline').addEventListener('toggle', e => { if (e.target.open) wvLoadTimeline(); });
    document.getElementById('wv-providers').addEventListener('toggle', e => { if (e.target.open) wvLoadProviders(); });
    setInterval(() => { if (document.getElementById('wv-timeline').open) wvLoadTimeline(); }, 15000);
` + call);
  fs.writeFileSync(H, h);
}
console.log('index.html: banner, time per step, providers');

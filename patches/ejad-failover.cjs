// Ejad: model failover watchdog (apply after ejad-dashboard-claude.cjs and ejad-dispatch-reliable.cjs).
// When an agent's provider hits a limit, something must move it to a model that works. That job is mechanical, so a SCRIPT
// does it and costs no Claude tokens: detect the limit (provider issue in the logs, provider-limit deaths in the router
// ledger), probe the candidate models with a one-word prompt (free tokens only), switch the role with the dashboard's own
// model switcher, clear the banner, wake the router, and restart the router when it is the router that failed.
// Modes (config failover.mode, switchable in Agents & planner): off | script (never calls Claude) | haiku (default) | sonnet.
// In haiku/sonnet mode the model is asked ONE short question per failover event, and only when two or more candidates are
// healthy, to pick the best one for that role. It runs with every optional source off (no tools, no MCP, no project or user
// settings, no session saved, an empty folder): measured at about 950 tokens and 0.0003 USD per call. Without those flags the
// same call loads about 106,000 tokens, so they are not optional. If the call fails, the script's first healthy candidate wins.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

let s = rd(S);
if (!s.includes('def ejad_failover_tick')) {
  const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
  const sub = (a, b) => { must(a); s = s.replace(a, () => b); };
  sub('\ndef ejad_run_action(action, req, tid):', String.raw`
EJAD_FAILOVER_STATE = REPO_ROOT / "job" / "failover-state.json"
EJAD_FAILOVER_LOG = REPO_ROOT / "job" / "failover-log.jsonl"
EJAD_FAILOVER_POOL = ["kilo/kilo-auto/free", "kilo/nvidia/nemotron-3-ultra-550b-a55b:free", "kilo/openrouter/free", "kilo/cohere/north-mini-code:free",
                      "google/gemini-3.5-flash", "google/gemini-3.1-flash-lite"]
EJAD_FAILOVER_ROLES = ("worker", "router", "tester", "merger", "checker", "watchdog", "reviewer", "teammate", "reproducer")
EJAD_FAILOVER_HINT = {"worker": "long context, writes code, many tool calls", "router": "reliable tool use, many short steps, big prompts",
                      "reviewer": "careful reading of a diff", "teammate": "writes code", "reproducer": "debugging with tools"}
EJAD_FAILOVER_HEAVY = ("router", "worker", "teammate", "reviewer", "reproducer")  # big prompts: never a google/* free model
EJAD_LIMIT_RE = re.compile(r"rate.?limit|quota|usage limit|too many requests|insufficient (?:credit|balance)|\b429\b", re.I)
EJAD_FAILOVER_LOCK = threading.Lock()


def ejad_failover_cfg():
    try:
        f = json.loads(ejad_config_path().read_text(encoding="utf-8")).get("failover") or {}
    except Exception:
        f = {}
    mode = f.get("mode") if f.get("mode") in ("off", "manual", "script", "haiku", "sonnet") else "haiku"
    return {"mode": mode, "pool": [m for m in (f.get("pool") or EJAD_FAILOVER_POOL) if isinstance(m, str)], "cooldownMin": int(f.get("cooldownMinutes") or 10)}


def ejad_failover_load():
    try:
        st = json.loads(EJAD_FAILOVER_STATE.read_text(encoding="utf-8"))
    except Exception:
        st = {}
    st.setdefault("models", {}); st.setdefault("roles", {}); st.setdefault("handled", [])
    return st


def ejad_failover_save(st):
    st["handled"] = st["handled"][-40:]
    ejad_atomic_write(EJAD_FAILOVER_STATE, json.dumps(st))


def ejad_failover_log(entry):
    entry = {"at": utc_now_iso(), **entry}
    try:
        with open(EJAD_FAILOVER_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError:
        pass
    print("[ejad] failover: " + json.dumps(entry)[:300], file=sys.stderr)


_ejad_probe_cache = {}


def ejad_probe_model(model):
    hit = _ejad_probe_cache.get(model)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    res = _ejad_probe_raw(model)
    _ejad_probe_cache[model] = (time.time(), res)
    return res


def _ejad_probe_raw(model):
    """One-word prompt through OpenCode: (ok, seconds). Uses free tokens only."""
    t0 = time.time()
    try:
        r = subprocess.run(["opencode", "run", "-m", model, "reply with: ok"], capture_output=True, text=True, timeout=55, shell=(os.name == "nt"), creationflags=EJAD_NOWIN, cwd=str(REPO_ROOT))
    except subprocess.TimeoutExpired:
        return False, 55.0
    out = EJAD_ANSI_RE.sub("", (r.stdout or "") + (r.stderr or "")).lower()
    return (r.returncode == 0 and "ok" in out and "error:" not in out), round(time.time() - t0, 1)


def ejad_failover_current(role):
    try:
        m = (((json.loads(ejad_config_path().read_text(encoding="utf-8")).get("models") or {}).get(role) or {}).get("opencode") or {}).get("model")
    except Exception:
        m = ""
    return m or ejad_agent_file_model(role)


def ejad_failover_detect(st):
    """[(role, failing_model, why)] for limits seen recently and not yet handled."""
    found = {}
    issue = ejad_provider_issue()
    if issue and issue.get("ageSec", 9999) < 600 and EJAD_LIMIT_RE.search(issue.get("message", "")):
        role = "router" if issue.get("source") == "router-loop.log" else "worker"
        found[role] = issue["message"][:140]
    try:
        ledger = json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
        for d in ledger.get("dispatched") or []:
            death = (d or {}).get("lastDeath") or {}
            key = str(d.get("ticket", ""))[:3] + "@" + str(death.get("at", ""))
            if death.get("class") == "provider-limit" and key not in st["handled"]:
                at = datetime.strptime(str(death.get("at"))[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
                if time.time() - at < 900:
                    found.setdefault("worker", "a worker died on a provider limit (ticket " + key.split("@")[0] + ")")
                    st["handled"].append(key)
    except Exception:
        pass
    msg = (issue or {}).get("message", "")
    mm = re.search(r"(?:model[:=]\s*|models/)([A-Za-z0-9._-]+)", msg)
    if mm and found:
        on = [r for r in EJAD_FAILOVER_ROLES if (ejad_failover_current(r) or "").split("/")[-1] == mm.group(1)]
        if on:
            found = {r: msg[:140] for r in on}
    return [(r, ejad_failover_current(r), w) for r, w in found.items()]


def ejad_failover_advise(mode, role, failing, why, healthy):
    """Ask Claude to pick among healthy candidates. ~950 tokens. None when it fails or answers outside the list."""
    claude = shutil.which("claude")
    if not claude or len(healthy) < 2:
        return None, None
    cwd = REPO_ROOT / "job" / "failover-cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    prompt = ("Failover. role=" + role + " (" + EJAD_FAILOVER_HINT.get(role, "light work") + "). failing_model=" + failing + ". error=" + why[:100] +
              ". Healthy candidates, verified just now (reply seconds): " + ", ".join(m + " " + str(t) + "s" for m, t in healthy) +
              ". Pick the best candidate for this role. JSON only: {\"model\":\"<one candidate>\",\"reason\":\"<max 10 words>\"}")
    cmd = [claude, "-p", prompt, "--model", "haiku" if mode == "haiku" else "sonnet", "--tools", "", "--system-prompt", "You choose a replacement AI model. Reply with JSON only.",
           "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "local", "--output-format", "json"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=70, cwd=str(cwd), creationflags=EJAD_NOWIN)
        d = json.loads(r.stdout)
        m = re.search(r"\{.*\}", str(d.get("result") or ""), re.S)
        pick = json.loads(m.group(0)) if m else {}
        u = d.get("usage") or {}
        used = {"tokens": sum(int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")), "costUsd": round(float(d.get("total_cost_usd") or 0), 4)}
        if pick.get("model") in [h[0] for h in healthy]:
            return pick["model"], {"reason": str(pick.get("reason", ""))[:80], **used}
        return None, used
    except Exception as e:
        print(f"[ejad] failover advisor failed: {e}", file=sys.stderr)
        return None, None


def ejad_failover_switch(role, failing, why, cfg, st, forced=False, apply=True):
    now = time.time()
    st["models"][failing] = now + 10 * 60
    healthy = []
    for m in cfg["pool"]:
        if m == failing or st["models"].get(m, 0) > now:
            continue
        if role in EJAD_FAILOVER_HEAVY and m.startswith("google/"):
            continue
        ok, secs = ejad_probe_model(m)
        if ok:
            healthy.append((m, secs))
        else:
            st["models"][m] = now + 3 * 60
        if len(healthy) >= 3:
            break
    if not healthy:
        # nothing works right now: look again in two minutes, and say so once, not every tick
        st["roles"][role] = now - (cfg["cooldownMin"] * 60 - 120)
        for m in cfg["pool"]:
            st["models"].pop(m, None) if m != failing else None
        ejad_failover_log({"role": role, "from": failing, "result": "no healthy model in the pool; trying again in 2 minutes", "why": why})
        return {"role": role, "result": "no healthy model in the pool"}
    pick, advice = (None, None)
    if cfg["mode"] in ("haiku", "sonnet"):
        pick, advice = ejad_failover_advise(cfg["mode"], role, failing, why, healthy)
    chosen = pick or healthy[0][0]
    if not apply:
        pend = ejad_failover_pending()
        pend[role] = {"from": failing, "to": chosen, "healthy": [h[0] for h in healthy], "why": why, "at": utc_now_iso()}
        ejad_failover_pending_save(pend)
        st["roles"][role] = now
        ejad_failover_log({"role": role, "from": failing, "to": chosen, "result": "suggested (manual mode: waiting for you)", "why": why})
        return {"role": role, "result": "suggested", "to": chosen}
    code, res = ejad_set_model(role, chosen)
    if code != 200:
        ejad_failover_log({"role": role, "from": failing, "to": chosen, "result": "switch failed", "error": res.get("error")})
        return {"role": role, "result": "switch failed: " + str(res.get("error"))}
    st["roles"][role] = now
    ejad_clear_issue()
    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
        ejad_atomic_write(CONTROL_DIR / "_dispatch.json", json.dumps({"action": "dispatch", "issuedAt": utc_now_iso(), "by": "failover"}) + "\n")
    except Exception:
        pass
    if role == "router":
        threading.Thread(target=ejad_router_restart, args=("failover",), daemon=True).start()
    entry = {"role": role, "from": failing, "to": chosen, "why": why, "healthy": [h[0] for h in healthy], "decidedBy": ("claude-" + cfg["mode"]) if pick else "script", "forced": forced}
    if advice:
        entry["advisor"] = advice
    ejad_failover_log(entry)
    return {"role": role, "result": "switched", "from": failing, "to": chosen, "decidedBy": entry["decidedBy"]}


def ejad_failover_tick(force_role=None):
    if not EJAD_FAILOVER_LOCK.acquire(blocking=False):
        return {"result": "busy"}
    try:
        cfg = ejad_failover_cfg()
        if cfg["mode"] == "off" and not force_role:
            return {"result": "off"}
        st = ejad_failover_load()
        if force_role:
            events = [(force_role, ejad_failover_current(force_role), "manual test")]
        else:
            events = ejad_failover_detect(st)
        out = []
        for role, failing, why in events:
            if role not in EJAD_FAILOVER_ROLES or not failing:
                continue
            if not force_role and time.time() - st["roles"].get(role, 0) < cfg["cooldownMin"] * 60:
                continue
            if cfg["mode"] == "manual" and not force_role and role in ejad_failover_pending():
                continue
            out.append(ejad_failover_switch(role, failing, why, cfg, st, forced=bool(force_role), apply=(cfg["mode"] != "manual" or bool(force_role))))
        ejad_failover_save(st)
        return {"result": "ok", "events": out} if out else {"result": "no limit event"}
    finally:
        EJAD_FAILOVER_LOCK.release()


def ejad_failover_loop():
    time.sleep(90)
    while True:
        try:
            if not EJAD_FLEET_OFF.exists():
                ejad_failover_tick()
        except Exception as e:
            print(f"[ejad] failover tick failed: {e}", file=sys.stderr)
        time.sleep(30)


threading.Thread(target=ejad_failover_loop, daemon=True).start()


EJAD_FAILOVER_PENDING = REPO_ROOT / "job" / "failover-pending.json"


def ejad_failover_pending():
    try:
        d = json.loads(EJAD_FAILOVER_PENDING.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def ejad_failover_pending_save(p):
    ejad_atomic_write(EJAD_FAILOVER_PENDING, json.dumps(p))


def ejad_failover_apply_pending(role):
    """Manual mode: the owner pressed Apply on a suggestion."""
    pend = ejad_failover_pending()
    item = pend.get(role)
    if not item:
        return 404, {"error": "There is no suggestion for " + role + " (it may already be applied or dismissed)."}
    code, res = ejad_set_model(role, item["to"])
    if code != 200:
        return code, res
    pend.pop(role, None)
    ejad_failover_pending_save(pend)
    ejad_clear_issue()
    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
        ejad_atomic_write(CONTROL_DIR / "_dispatch.json", json.dumps({"action": "dispatch", "issuedAt": utc_now_iso(), "by": "failover"}) + "\n")
    except Exception:
        pass
    if role == "router":
        threading.Thread(target=ejad_router_restart, args=("failover (you applied it)",), daemon=True).start()
    ejad_failover_log({"role": role, "from": item.get("from"), "to": item["to"], "why": item.get("why"), "decidedBy": "you"})
    return 200, {"ok": True, "role": role, "to": item["to"]}


def ejad_failover_dismiss(role):
    pend = ejad_failover_pending()
    pend.pop(role, None)
    ejad_failover_pending_save(pend)
    return 200, {"ok": True}


def ejad_failover_status():
    cfg, st = ejad_failover_cfg(), ejad_failover_load()
    events = []
    try:
        events = [json.loads(l) for l in EJAD_FAILOVER_LOG.read_text(encoding="utf-8").splitlines()[-6:] if l.strip()]
    except OSError:
        pass
    now = time.time()
    return {"mode": cfg["mode"], "pool": cfg["pool"], "cooldownMin": cfg["cooldownMin"], "events": events[::-1], "pending": ejad_failover_pending(),
            "cooling": [{"model": m, "secLeft": int(u - now)} for m, u in st["models"].items() if u > now]}


def ejad_set_failover(mode):
    if mode not in ("off", "manual", "script", "haiku", "sonnet"):
        return 400, {"error": "Choose off, manual, script, haiku or sonnet."}
    path = ejad_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    cfg.setdefault("failover", {})["mode"] = mode
    ejad_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return 200, {"ok": True, "mode": mode}

` + '\ndef ejad_run_action(action, req, tid):');
  sub('EJAD_ACTIONS = ("ejad_claude_login",', 'EJAD_ACTIONS = ("ejad_failover_apply", "ejad_failover_dismiss", "ejad_set_failover", "ejad_failover_run", "ejad_claude_login",');
  sub('    if action == "ejad_claude_login":', '    if action == "ejad_failover_apply":\n        return ejad_failover_apply_pending(str(req.get("role") or ""))\n    if action == "ejad_failover_dismiss":\n        return ejad_failover_dismiss(str(req.get("role") or ""))\n    if action == "ejad_set_failover":\n        return ejad_set_failover(str(req.get("mode") or ""))\n    if action == "ejad_failover_run":\n        role = str(req.get("role") or "") or None\n        return 200, ejad_failover_tick(role if role in EJAD_FAILOVER_ROLES else None)\n    if action == "ejad_claude_login":');
  sub('        if path == "/api/ejad/claude":', '        if path == "/api/ejad/failover":\n            self._send_json(200, ejad_failover_status())\n            return\n\n        if path == "/api/ejad/claude":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('id="ejad-failover-js"')) {
  const re = /<section class="pvp-plan"[^>]*>\s*<h3>Agents<\/h3>/;
  if (!re.test(h)) throw new Error('anchor missing: Agents section');
  const SEC = `<section class="pvp-plan" id="ejad-failover-sec"><h3>Failover watchdog</h3><p>When an agent's provider hits a limit, this moves it to a model that works. A script does the detecting, testing and switching and uses no Claude tokens. In Claude modes, Claude is asked one short question (about 1,000 tokens) per failover event, only when two or more models are healthy, to pick the best one for that role. <strong id="pvp-fnow"></strong></p>
      <div class="pvp-row"><select id="pvp-failover" aria-label="Failover watchdog mode"><option value="haiku">Claude Haiku (default)</option><option value="sonnet">Claude Sonnet</option><option value="script">Script only (no Claude tokens)</option><option value="off">Off</option></select><button type="button" class="btn btn-sm btn-primary" id="pvp-fsave">Save</button></div>
      <div id="pvp-flog" class="pvp-note"></div></section>
    `;
  h = h.replace(re, (m) => SEC + m);
  const JS = `<script id="ejad-failover-js">
(function () {
  function el(tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
  async function load() {
    var sel = document.getElementById('pvp-failover'); if (!sel) return;
    try {
      var res = await fetch('/api/ejad/failover', { headers: getAuthHeaders() }); if (!res.ok) return;
      var d = await res.json(); sel.value = d.mode;
      document.getElementById('pvp-fnow').textContent = 'Now: ' + d.mode + '.';
      var box = document.getElementById('pvp-flog'); box.textContent = '';
      if (!d.events.length) box.append(el('div', 'No failover yet.'));
      d.events.slice(0, 4).forEach(function (e) {
        var t = ''; try { t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (x) { /* none */ }
        var line = t + '  ' + e.role + ': ' + (e.to ? e.from + ' \\u2192 ' + e.to + ' (' + e.decidedBy + (e.advisor ? ', ' + e.advisor.tokens + ' tokens' : '') + ')' : (e.result || 'no change'));
        box.append(el('div', line));
      });
      if (d.cooling.length) box.append(el('div', 'Resting: ' + d.cooling.map(function (c) { return c.model.split('/').slice(-1)[0] + ' ' + Math.ceil(c.secLeft / 60) + ' min'; }).join(', ')));
    } catch (e) { /* the picker keeps its last view */ }
  }
  var save = document.getElementById('pvp-fsave');
  if (save) save.onclick = async function () {
    var v = document.getElementById('pvp-failover').value; save.disabled = true;
    var x = await ejadPost({ action: 'ejad_set_failover', mode: v }); save.disabled = false;
    showToast(x.ok ? 'Failover watchdog: ' + v : (x.j.error || 'Could not change it'), x.ok ? undefined : 'bad'); if (x.ok) load();
  };
  var old = window.ejadProvidersShown;
  window.ejadProvidersShown = function () { if (old) old(); load(); };
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
// ---- manual mode: the watchdog finds and tests a working model but only SUGGESTS it; the owner presses Apply ----
{
  let m = rd(H);
  if (!m.includes('id="ejad-failover-manual-js"')) {
    if (!m.includes('value="manual"')) {
      if (!/<option value="script">/.test(m)) throw new Error('anchor missing: failover mode select');
      m = m.replace(/<option value="script">/, () => '<option value="manual">Manual: suggest, I decide</option><option value="script">');
    }
    if (!m.includes('id="pvp-fpending"')) {
      const re = /(<div\s+id="pvp-flog"[^>]*>\s*<\/div>)/;
      if (!re.test(m)) throw new Error('anchor missing: failover log div');
      const ROLES = ['worker', 'router', 'tester', 'merger', 'checker', 'watchdog', 'reviewer', 'teammate', 'reproducer'].map((r) => `<option value="${r}">${r}</option>`).join('');
      m = m.replace(re, (x) => x + `<div id="pvp-fpending"></div><div class="pvp-row" style="margin-top:8px"><select id="pvp-frole" aria-label="Role to move to a working model">${ROLES}</select><button type="button" class="btn btn-sm" id="pvp-fnow2">Find a working model now</button></div>`);
    }
    const JS2 = `<script id="ejad-failover-manual-js">
(function () {
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  async function load() {
    var box = document.getElementById('pvp-fpending'); if (!box) return;
    try {
      var res = await fetch('/api/ejad/failover', { headers: getAuthHeaders() }); if (!res.ok) return;
      var d = await res.json(); box.textContent = '';
      Object.keys(d.pending || {}).forEach(function (role) {
        var p = d.pending[role]; var row = el('div', null, 'pvp-row'); row.style.margin = '8px 0';
        var t = el('strong', 'Suggestion: move ' + role + ' from ' + p.from + ' to ' + p.to + '. '); row.append(t);
        var ap = el('button', 'Apply', 'btn btn-sm btn-primary'); ap.type = 'button';
        ap.onclick = async function () { ap.disabled = true; var x = await ejadPost({ action: 'ejad_failover_apply', role: role }); showToast(x.ok ? role + ' now uses ' + p.to : (x.j.error || 'Could not apply'), x.ok ? undefined : 'bad'); load(); };
        var no = el('button', 'Dismiss', 'btn btn-sm'); no.type = 'button';
        no.onclick = async function () { await ejadPost({ action: 'ejad_failover_dismiss', role: role }); load(); };
        row.append(ap, no); box.append(row);
      });
    } catch (e) { /* keeps its last view */ }
  }
  var go = document.getElementById('pvp-fnow2');
  if (go) go.onclick = async function () {
    var role = document.getElementById('pvp-frole').value; go.disabled = true; var t = go.textContent; go.textContent = 'Testing models\\u2026';
    var x = await ejadPost({ action: 'ejad_failover_run', role: role }); go.disabled = false; go.textContent = t;
    var ev = x.ok && x.j.events && x.j.events[0];
    showToast(x.ok ? (ev ? (ev.result === 'switched' ? role + ': ' + ev.from + ' \\u2192 ' + ev.to : role + ': ' + ev.result) : 'Nothing to do') : (x.j.error || 'Failed'), x.ok ? undefined : 'bad'); load();
  };
  var old = window.ejadProvidersShown;
  window.ejadProvidersShown = function () { if (old) old(); load(); };
  setInterval(function () { if (!document.hidden) load(); }, 15000);
})();
</script>
`;
    const i = m.lastIndexOf('</body>');
    m = m.slice(0, i) + JS2 + m.slice(i);
    fs.writeFileSync(H, m);
  }
}
console.log('failover patch applied');

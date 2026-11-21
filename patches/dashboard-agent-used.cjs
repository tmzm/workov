// Workov: which model each agent really uses, for the Office's agent card. GET /api/wv/agent-used answers:
//   workers: {"<project>/<NNN>": {model, runtime, phase}}  the model a ticket's worker was started with (the dispatcher's ledger entry in the
//                                                          project's job/router-state.json), or, when the ledger has none, the model the
//                                                          layered settings resolve to for that ticket
//   roles:   {"<role>": {model, runtime, source}}          what the global layer sets for every role (the fallback when nobody is working)
// Read-only. Builds on dashboard-settings-layers.cjs (it uses its resolver helpers).
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
def wv_agent_used():
    """The model in use per running worker (from the ledger, else resolved) and the global model of every role."""
    w = wv_settings_mod()
    hub = str(REPO_ROOT)
    cfg = w.read_json(Path(hub) / "specs" / "worker-fleet.config.json")
    res = w.resolve(cfg)
    harness = str(cfg.get("harness") or "opencode")
    roles = {}
    for role, spec in (res["effective"].get("models") or {}).items():
        if not isinstance(spec, dict):
            continue
        runtime = (spec.get("runtime") or harness) if role in ("worker", "planner", "designer") else harness
        node = spec.get("claude") if runtime == "claude" else spec.get("opencode")
        model = (node or {}).get("model") or ((spec.get("opencode") or {}).get("model")) or ((spec.get("claude") or {}).get("model")) or ""
        key = "models.%s.%s.model" % (role, "claude" if runtime == "claude" else "opencode")
        roles[role] = {"model": ("Claude " + model) if runtime == "claude" and model else model, "runtime": runtime, "source": res["sources"].get(key, "")}
    workers = {}
    for p in wv_settings_projects():
        st = w.read_json(Path(p["root"]) / "job" / "router-state.json")
        for e in st.get("dispatched") or []:
            if not isinstance(e, dict) or not str(e.get("ticket", ""))[:3].isdigit():
                continue
            num = str(e["ticket"])[:3]
            sett = e.get("settings") if isinstance(e.get("settings"), dict) else {}
            model, runtime = e.get("model") or sett.get("model") or "", sett.get("runtime") or ""
            if not model:
                r2 = w.load(hub, p["name"], p["root"], num)
                runtime = str(w.get(r2, "models.worker.runtime") or "opencode")
                model = w.get(r2, "models.worker.opencode.model") or "" if runtime != "claude" else "claude/" + str(w.get(r2, "models.worker.claude.model") or "sonnet")
            workers[p["name"] + "/" + num] = {"model": model, "runtime": runtime or ("claude" if str(model).startswith("claude/") else "opencode"), "phase": e.get("lastPhase") or ""}
    return {"workers": workers, "roles": roles}

`;
if (!s.includes('def wv_agent_used')) {
  if (!s.includes('def wv_settings_mod')) throw new Error('apply dashboard-settings-layers.cjs first');
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const g = '        if path == "/api/logs":';
  must(g);
  s = s.replace(g, () => '        if path == "/api/wv/agent-used":\n            try:\n                self._send_json(200, wv_agent_used())\n            except Exception as e:\n                self._send_json(500, {"error": str(e)})\n            return\n\n' + g);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: /api/wv/agent-used');

// Workerov: the roster tells the truth about providers, and every agent file can be switched (apply after dashboard-answered.cjs).
//  - "Agent roster" header: "opencode" is the runtime (the program), not the provider. It now says which providers the
//    active agents really use, and flags a MIXED fleet (for example 9 agents on Kilo and one still on OpenCode Go).
//  - the Agents tab lists every OpenCode agent file (implementer, orchestrator...), not only the roles in the fleet config,
//    so a leftover agent on a capped provider can be found and switched; a one-line summary says "All agents on X" or "Mixed".
//  - provider names come from the models.dev catalog (Kilo Gateway, not "kilo").
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def wv_provider_name')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('def wv_agent_roster():', String.raw`def wv_provider_name(pid):
    if pid in WV_PROVIDERS:
        return WV_PROVIDERS[pid]
    try:
        for p in json.loads((REPO_ROOT / "job" / "provider-catalog-v3.json").read_text(encoding="utf-8")):
            if p.get("id") == pid:
                return p.get("name") or pid
    except Exception:
        pass
    return pid


def wv_agent_roster():`);
  sub('provider = WV_PROVIDERS.get(model.split("/")[0], model.split("/")[0]) if "/" in model else "?"', 'provider = wv_provider_name(model.split("/")[0]) if "/" in model else "?"');
  sub('    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}', String.raw`    names = {r["role"] for r in roles}
    for f in sorted(glob.glob(str(REPO_ROOT / ".opencode" / "agents" / "*.md"))):
        n = Path(f).stem
        if n not in names and n != "planner" and not n.startswith("wv-"):
            roles.append({"role": n, "model": wv_agent_file_model(n), "claude": ""})
    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}`);
  sub(`    if not isinstance(entry, dict):
        return 404, {"error": f"No role {role} in the fleet config."}
    entry.setdefault("opencode", {})["model"] = model
    wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\\n")
    changed = ["specs/worker-fleet.config.json"]`, String.raw`    has_file = (REPO_ROOT / ".opencode" / "agents" / f"{role}.md").exists()
    if not isinstance(entry, dict) and not has_file:
        return 404, {"error": f"No role {role} in the fleet config or the agent files."}
    changed = []
    if isinstance(entry, dict):
        entry.setdefault("opencode", {})["model"] = model
        wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
        changed.append("specs/worker-fleet.config.json")`);
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('wv-roster-css')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("document.getElementById('wv-roster-note').textContent = '(active runtime: ' + (data.harness || '?') + ')';",
    "const live = (data.agents || []).filter(a => a.runtime === data.harness), cnt = {};\n        live.forEach(a => { cnt[a.provider] = (cnt[a.provider] || 0) + 1; });\n        const parts = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x]).map(k => k + ' ×' + cnt[k]);\n        const note = document.getElementById('wv-roster-note');\n        note.textContent = '(' + (data.harness || '?') + ' runtime · ' + (parts.length > 1 ? 'MIXED providers: ' : 'provider: ') + parts.join(', ') + ')';\n        note.style.color = parts.length > 1 ? 'var(--lamp-attn)' : '';");
  sub("    body.append(intro);\n", "    body.append(intro);\n    var cnt = {}; d.roles.filter(function (r) { return r.role !== 'planner'; }).forEach(function (r) { var p = provOf(r.model); cnt[p] = (cnt[p] || 0) + 1; });\n    var parts = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).map(function (k) { return k + ' ×' + cnt[k]; });\n    body.append(el('p', 'pvp-mix' + (parts.length > 1 ? ' mixed' : ''), (parts.length > 1 ? 'Mixed providers: ' : 'All agents on ') + parts.join(', ')));\n");
  const css = '<style id="wv-roster-css">\n#pvp .pvp-mix { margin: var(--s2) 0 0; font-weight: 600; color: var(--lamp-run); }\n#pvp .pvp-mix.mixed { color: var(--lamp-attn); }\n</style>\n';
  must(h, '</head>');
  h = h.replace('</head>', () => css + '</head>');
  fs.writeFileSync(H, h);
}
console.log('roster patch applied');

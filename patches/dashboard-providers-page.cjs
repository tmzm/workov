// Workerov: providers page (cards from the models.dev catalog) + a choosable planner (apply after dashboard-connect.cjs).
//  - GET /api/wv/catalog: every provider OpenCode knows (models.dev), cached 24 h in job/provider-catalog.json, with a
//    "get key" link for the common ones and the provider's website for the rest.
//  - wv_set_planner: the ticket writer runs on Claude (sonnet/opus/haiku) or on any connected OpenCode model.
//  - plan.cjs reads that choice; with an OpenCode model it runs the same wv-planner instructions through opencode.
//  - A full-screen Providers page inside the dashboard (same sign-in as the dashboard), opened from the Providers panel
//    or at /#providers.
const fs = require('fs');
const path = require('path');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const P = '.claude/scripts/plan.cjs';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };

// ---------- server ----------
let s = rd(S);
if (!s.includes('def wv_catalog')) {
  const FN = String.raw`
WV_KEY_URLS = {
    "openrouter": "https://openrouter.ai/keys", "anthropic": "https://console.anthropic.com/settings/keys",
    "openai": "https://platform.openai.com/api-keys", "google": "https://aistudio.google.com/apikey",
    "groq": "https://console.groq.com/keys", "deepseek": "https://platform.deepseek.com/api_keys",
    "mistral": "https://console.mistral.ai/api-keys", "xai": "https://console.x.ai",
    "togetherai": "https://api.together.ai/settings/api-keys", "cerebras": "https://cloud.cerebras.ai",
    "fireworks-ai": "https://fireworks.ai/account/api-keys", "perplexity": "https://www.perplexity.ai/settings/api",
    "nvidia": "https://build.nvidia.com/settings/api-keys", "huggingface": "https://huggingface.co/settings/tokens",
    "cohere": "https://dashboard.cohere.com/api-keys", "kilo": "https://app.kilo.ai",
    "opencode": "https://opencode.ai/auth", "opencode-go": "https://opencode.ai/auth",
    "zai": "https://z.ai/manage-apikey/apikey-list", "moonshotai": "https://platform.moonshot.ai/console/api-keys",
}
WV_POPULAR = ("openrouter", "anthropic", "openai", "google", "opencode", "opencode-go", "kilo", "groq", "deepseek", "mistral", "xai",
                "togetherai", "cerebras", "fireworks-ai", "perplexity", "nvidia", "huggingface", "cohere", "zai", "moonshotai")


def wv_connected_ids():
    try:
        return sorted(json.loads(wv_auth_path().read_text(encoding="utf-8")).keys())
    except Exception:
        return wv_connected()


def wv_catalog(refresh=False):
    """-> (providers, stale). The catalog is public data from models.dev; nothing about this project is sent."""
    cache = REPO_ROOT / "job" / "provider-catalog.json"
    old = None
    try:
        if cache.exists():
            old = json.loads(cache.read_text(encoding="utf-8"))
            if not refresh and time.time() - cache.stat().st_mtime < 86400:
                return old, False
    except Exception:
        old = None
    try:
        import urllib.request
        req = urllib.request.Request("https://models.dev/api.json", headers={"user-agent": "wv-fleet-dashboard/1.0"})
        raw = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except Exception:
        return (old or []), True
    out = []
    for pid, p in raw.items():
        if not isinstance(p, dict):
            continue
        ms = p.get("models") or {}
        free = sum(1 for m in ms.values() if isinstance(m, dict) and (m.get("cost") or {}).get("input") == 0)
        out.append({"id": pid, "name": p.get("name") or pid, "doc": p.get("doc") or "", "keyUrl": WV_KEY_URLS.get(pid, ""),
                    "models": len(ms), "free": free, "popular": pid in WV_POPULAR})
    try:
        wv_atomic_write(cache, json.dumps(out))
    except Exception:
        pass
    return out, False


def wv_set_planner(choice):
    choice = str(choice or "")
    path = wv_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    entry = cfg.setdefault("models", {}).setdefault("planner", {})
    if choice in ("claude:sonnet", "claude:opus", "claude:haiku"):
        entry["runtime"] = "claude"
        entry.setdefault("claude", {})["model"] = choice.split(":")[1]
    elif re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+", choice):
        known = wv_model_list()
        if known and choice not in known:
            return 400, {"error": f"{choice} is not in the list from opencode models."}
        entry["runtime"] = "opencode"
        entry.setdefault("opencode", {})["model"] = choice
    else:
        return 400, {"error": "Choose claude:sonnet, claude:opus, claude:haiku or a model like provider/model."}
    wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return 200, {"ok": True, "planner": choice, "note": "Applies to the next ticket plan."}

`;
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);
  must(s, 'WV_ACTIONS = ("wv_connect_provider",');
  s = s.replace('WV_ACTIONS = ("wv_connect_provider",', 'WV_ACTIONS = ("wv_set_planner", "wv_connect_provider",');
  must(s, '    if action == "wv_connect_provider":');
  s = s.replace('    if action == "wv_connect_provider":', () => '    if action == "wv_set_planner":\n        return wv_set_planner(req.get("choice"))\n    if action == "wv_connect_provider":');
  must(s, '"connected": wv_connected(),');
  s = s.replace('"connected": wv_connected(),', () => '"connected": wv_connected_ids(), "planner": wv_planner_state(cfg),');
  must(s, '\ndef wv_providers():');
  s = s.replace('\ndef wv_providers():', () => '\ndef wv_planner_state(cfg):\n    p = (cfg.get("models") or {}).get("planner") or {}\n    return {"runtime": p.get("runtime") or "claude", "claude": (p.get("claude") or {}).get("model") or "sonnet", "opencode": (p.get("opencode") or {}).get("model") or ""}\n\n\ndef wv_providers():');
  must(s, '        if path == "/api/wv/providers":');
  s = s.replace('        if path == "/api/wv/providers":', () => '        if path == "/api/wv/catalog":\n            cat, stale = wv_catalog("refresh=1" in (parsed.query or ""))\n            self._send_json(200, {"providers": cat, "connected": wv_connected_ids(), "stale": stale})\n            return\n\n        if path == "/api/wv/providers":');
  fs.writeFileSync(S, s);
}

// ---------- plan.cjs: run the planner on Claude or on an OpenCode model ----------
let p = rd(P);
if (!p.includes('PLANNER_RUNTIME')) {
  must(p, "const model = opt('--model') || 'sonnet';");
  p = p.replace("const model = opt('--model') || 'sonnet';", () => [
    "// PLANNER_RUNTIME: --model wins; else the dashboard's choice in specs/worker-fleet.config.json (models.planner).",
    "const cliModel = opt('--model');",
    "let model = cliModel || 'sonnet';",
    "let runtime = cliModel && cliModel.includes('/') ? 'opencode' : 'claude';",
    "if (!cliModel) {",
    "  try {",
    "    const pc = (JSON.parse(fs.readFileSync('specs/worker-fleet.config.json', 'utf8')).models || {}).planner || {};",
    "    if (pc.runtime === 'opencode' && pc.opencode && pc.opencode.model) { runtime = 'opencode'; model = pc.opencode.model; }",
    "    else if (pc.claude && pc.claude.model) model = pc.claude.model;",
    "  } catch { /* keep the default */ }",
    "}",
  ].join('\n'));
  must(p, "const cli = ['-p', '--agent', 'wv-planner'");
  must(p, "const child = spawn('claude', cli, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });");
  p = p.replace("const cli = ['-p', '--agent', 'wv-planner', '--model', model, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];\nif (resume) cli.push('--resume', resume);\ncli.push(prompt);\nconst child = spawn('claude', cli, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });", () => [
    "let child;",
    "if (runtime === 'opencode') {",
    "  // The same ticket-writer instructions, run by OpenCode on the chosen model. The prompt goes through a file so no",
    "  // quoting can break it on Windows.",
    "  const body = fs.readFileSync('.claude/agents/wv-planner.md', 'utf8').replace(/\\r\\n/g, '\\n').replace(/^---\\n[\\s\\S]*?\\n---\\n/, '');",
    "  fs.mkdirSync('.opencode/agents', { recursive: true });",
    "  fs.writeFileSync('.opencode/agents/wv-planner.md', `---\\ndescription: Writes one fleet ticket (rd.md + eval.md) from a task brief\\nmode: primary\\nmodel: ${model}\\n---\\n${body}`);",
    "  const promptFile = path.join('job', `planner-prompt-${nnn}.md`);",
    "  fs.writeFileSync(promptFile, prompt);",
    "  const ocArgs = ['run', '--agent', 'wv-planner', '-m', model, '--format', 'json'];",
    "  if (resume) ocArgs.push('--session', resume);",
    "  ocArgs.push(`Read ${promptFile.replace(/\\\\/g, '/')} and do what it says.`);",
    "  child = spawn('opencode', ocArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });",
    "} else {",
    "  const cli = ['-p', '--agent', 'wv-planner', '--model', model, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];",
    "  if (resume) cli.push('--resume', resume);",
    "  cli.push(prompt);",
    "  child = spawn('claude', cli, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });",
    "}",
  ].join('\n'));
  // OpenCode JSON events
  must(p, "    if (ev.type === 'system' && ev.subtype === 'init') {");
  p = p.replace("    if (ev.type === 'system' && ev.subtype === 'init') {", () => [
    "    if (runtime === 'opencode') {",
    "      if (ev.sessionID && ev.sessionID !== session) { session = ev.sessionID; line(`session ${session}`); }",
    "      const part = ev.part || {};",
    "      if (ev.type === 'text' && part.text) { lastResult = part.text; part.text.split('\\n').filter((l) => l.trim()).forEach((l) => line(l)); }",
    "      else if (ev.type === 'tool_use') line(`→ ${part.tool} ${clip(JSON.stringify((part.state || {}).input), 220)}`);",
    "      else if (ev.type === 'step_finish' && part.reason === 'stop') line(`■ done · ${model}`);",
    "      continue;",
    "    }",
    "    if (ev.type === 'system' && ev.subtype === 'init') {",
  ].join('\n'));
  // opencode exits 0 even on a provider error: an unfinished plan is a stopped planner either way
  must(p, "  if (code !== 0 && phase !== 'done' && phase !== 'waiting-user')");
  p = p.replace("  if (code !== 0 && phase !== 'done' && phase !== 'waiting-user')", () => "  if ((code !== 0 || runtime === 'opencode') && phase !== 'done' && phase !== 'waiting-user')");
  fs.writeFileSync(P, p);
}

// ---------- dashboard page ----------
let h = rd(H);
if (!h.includes('id="pvp"')) {
  const dir = path.join(__dirname, 'providers-page');
  const css = fs.readFileSync(path.join(dir, 'page.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'page.js'), 'utf8');
  const HTML = `<style>\n${css}</style>
<div id="pvp" hidden role="dialog" aria-modal="true" aria-label="Providers"><div class="pvp-wrap">
  <div class="pvp-head"><button type="button" class="btn btn-sm" id="pvp-close">← Back</button><h2>Providers</h2><span class="pvp-sub" id="pvp-sub"></span><span class="pvp-spacer"></span><button type="button" class="btn btn-sm" id="pvp-refresh">Refresh list</button></div>
  <section class="pvp-plan"><h3>Planner</h3><p>Who plans the task and writes the ticket. Claude uses your Claude plan; any connected provider works too.</p>
    <div class="pvp-row"><select id="pvp-planner" aria-label="Planner model"></select><button type="button" class="btn btn-sm btn-primary" id="pvp-save">Save</button><button type="button" class="btn btn-sm" id="pvp-ptest">Test</button></div></section>
  <div class="pvp-row" style="margin-bottom:10px"><input id="pvp-search" type="search" placeholder="Search providers" aria-label="Search providers"></div>
  <div class="pvp-chips" role="group" aria-label="Filter"><button type="button" class="pvp-chip" data-f="all" aria-pressed="true">All</button><button type="button" class="pvp-chip" data-f="connected" aria-pressed="false">Connected</button><button type="button" class="pvp-chip" data-f="popular" aria-pressed="false">Popular</button><button type="button" class="pvp-chip" data-f="free" aria-pressed="false">Has free models</button></div>
  <div class="pvp-grid" id="pvp-grid"></div><button type="button" class="btn btn-sm" id="pvp-more" hidden>Show more</button>
</div></div>
<script>\n${js}</script>\n`;
  must(h, '</body>');
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + HTML + h.slice(i);
  // the old panel: no planner row (it is chosen on the page), and a button that opens the page
  must(h, 'd.roles.forEach(r => {');
  h = h.replace('d.roles.forEach(r => {', () => "d.roles.filter(r => r.role !== 'planner').forEach(r => {");
  must(h, 'cf.append(pin, dl, kin, cb); box.append(cf);');
  h = h.replace('cf.append(pin, dl, kin, cb); box.append(cf);', () => "const pb = mk('button', 'Open the Providers page (cards, get-key links, planner)', 'btn btn-sm btn-primary'); pb.type = 'button'; pb.onclick = () => window.wvOpenProvidersPage(); box.append(pb);\n        cf.append(pin, dl, kin, cb); box.append(cf);");
}
fs.writeFileSync(H, h);
console.log('providers page patch applied');

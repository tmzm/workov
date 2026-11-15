// Ejad: Claude as a provider on your Claude plan, usable wherever the fleet runs Claude Code (apply after
// ejad-dashboard-providers-v2.cjs and ejad-designer.cjs).
//  - Providers tab: a pinned "Claude (your Claude plan)" card, connected when `claude auth status` says you are signed in.
//    No key to paste. Its dialog says what Claude is used for and what it cannot be used for.
//  - Agents tab: a Designer picker next to the Planner (Claude Sonnet/Opus/Haiku or any connected model).
//  - Implementer: "claude" joins copilot/kilo/antigravity/codex; the worker hands each build step to Claude Code on your plan.
//  - Test button for Claude models (sends one tiny prompt through Claude Code).
// Not possible, and the dialog says so: running OpenCode-run agents (router, tester, merger...) on plan models.
// Anthropic does not allow third-party tools to use a Claude plan login; those agents need an Anthropic API key.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def ejad_claude_status')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('EJAD_CLIS = {"copilot": "copilot", "kilo": "kilo", "antigravity": "agy", "codex": "codex"}', 'EJAD_CLIS = {"copilot": "copilot", "kilo": "kilo", "antigravity": "agy", "codex": "codex", "claude": "claude"}');
  sub('\ndef ejad_run_action(action, req, tid):', String.raw`
_ejad_claude_cache = [0.0, {"loggedIn": False, "method": ""}]


def ejad_claude_status():
    """Whether Claude Code is signed in on this computer. Only the yes/no and the method leave this function."""
    if time.time() - _ejad_claude_cache[0] < 60:
        return _ejad_claude_cache[1]
    st = {"loggedIn": False, "method": ""}
    try:
        r = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True, timeout=20, shell=(os.name == "nt"), creationflags=EJAD_NOWIN)
        d = json.loads(r.stdout)
        st = {"loggedIn": bool(d.get("loggedIn")), "method": str(d.get("authMethod") or "")}
    except Exception:
        pass
    _ejad_claude_cache[0], _ejad_claude_cache[1] = time.time(), st
    return st


def ejad_claude_entry():
    st = ejad_claude_status()
    return {"id": "claude", "name": "Claude (your plan)", "doc": "https://claude.com/claude-code", "keyUrl": "", "models": 3, "free": 0,
            "popular": True, "env": [], "method": "plan", "alsoLogin": False, "priceMin": None, "priceMax": None, "ctxMax": 0,
            "tools": 3, "reasoning": 3, "vision": 3, "api": "", "sdk": "Claude Code (" + (st["method"] or "not signed in") + ")",
            "sample": [{"id": "sonnet", "free": False}, {"id": "opus", "free": False}, {"id": "haiku", "free": False}], "claudeLoggedIn": st["loggedIn"]}


def ejad_test_claude(model):
    if model not in ("sonnet", "opus", "haiku"):
        return 400, {"error": "Choose sonnet, opus or haiku."}
    try:
        r = subprocess.run(["claude", "-p", "reply with the single word ok", "--model", model, "--output-format", "text"], capture_output=True, text=True, timeout=120, shell=(os.name == "nt"), creationflags=EJAD_NOWIN, cwd=str(REPO_ROOT))
    except subprocess.TimeoutExpired:
        return 200, {"ok": False, "model": model, "detail": "No answer within 120 seconds."}
    out = (r.stdout or "").strip()
    return 200, {"ok": r.returncode == 0 and bool(out), "model": model, "detail": (out or (r.stderr or "No output").strip())[:300]}


def ejad_designer_state(cfg):
    p = (cfg.get("models") or {}).get("designer") or {}
    return {"runtime": p.get("runtime") or "claude", "claude": (p.get("claude") or {}).get("model") or "sonnet", "opencode": (p.get("opencode") or {}).get("model") or ""}


def ejad_set_designer(choice):
    choice = str(choice or "")
    path = ejad_config_path()
    cfg = json.loads(path.read_text(encoding="utf-8"))
    entry = cfg.setdefault("models", {}).setdefault("designer", {})
    if choice in ("claude:sonnet", "claude:opus", "claude:haiku"):
        entry["runtime"] = "claude"
        entry.setdefault("claude", {})["model"] = choice.split(":")[1]
    elif re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+", choice):
        known = ejad_model_list()
        if known and choice not in known:
            return 400, {"error": f"{choice} is not in the list from opencode models."}
        entry["runtime"] = "opencode"
        entry.setdefault("opencode", {})["model"] = choice
    else:
        return 400, {"error": "Choose claude:sonnet, claude:opus, claude:haiku or a model like provider/model."}
    ejad_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return 200, {"ok": True, "designer": choice, "note": "Applies to the next mockup."}

` + '\ndef ejad_run_action(action, req, tid):');
  sub('EJAD_ACTIONS = ("ejad_router_restart",', 'EJAD_ACTIONS = ("ejad_set_designer", "ejad_test_claude", "ejad_router_restart",');
  sub('    if action == "ejad_router_restart":', '    if action == "ejad_set_designer":\n        return ejad_set_designer(req.get("choice"))\n    if action == "ejad_test_claude":\n        return ejad_test_claude(str(req.get("model") or ""))\n    if action == "ejad_router_restart":');
  sub('"planner": ejad_planner_state(cfg),', '"planner": ejad_planner_state(cfg), "designer": ejad_designer_state(cfg),');
  sub('            self._send_json(200, {"providers": cat, "connected": ejad_connected_ids(), "stale": stale})',
    '            ce = ejad_claude_entry()\n            ids = ejad_connected_ids() + (["claude"] if ce["claudeLoggedIn"] else [])\n            self._send_json(200, {"providers": [ce] + [p for p in cat if p.get("id") != "claude"], "connected": ids, "stale": stale})');
  sub('    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,60}", str(pid or "")):', '    pid = "anthropic" if pid == "claude" else pid\n    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,60}", str(pid or "")):');
  fs.writeFileSync(S, s);
}

// Claude Code as an implementer: the worker hands each build step to it.
const IMPL = '.claude/scripts/implementers.json';
if (fs.existsSync(IMPL)) {
  const spec = JSON.parse(rd(IMPL));
  if (!spec.claude) {
    spec.claude = ['claude', '-p', '{prompt}', '--permission-mode', 'acceptEdits', '--allowedTools',
      'Read,Edit,Write,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git add:*),Bash(git commit:*),Bash(node:*),Bash(pnpm:*),Bash(npx:*)', '--disallowedTools', 'Bash(git push:*)'];
    fs.writeFileSync(IMPL, JSON.stringify(spec, null, 2) + '\n');
  }
}
const DEL = '.claude/scripts/delegate-task.sh';
if (fs.existsSync(DEL)) {
  let d = rd(DEL);
  if (!d.includes('copilot|kilo|antigravity|claude)')) {
    must(d, '  copilot|kilo|antigravity)');
    d = d.replace('  copilot|kilo|antigravity)', () => '  copilot|kilo|antigravity|claude)').replace('Allowed: codex, opencode, copilot, kilo, antigravity', 'Allowed: codex, opencode, copilot, kilo, antigravity, claude');
    fs.writeFileSync(DEL, d);
  }
}

let h = rd(H);
if (!h.includes('id="ejad-designer-sec"')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("var METHOD = { key: 'API key', login: 'Sign in', env: 'Env variables' };", "var METHOD = { key: 'API key', login: 'Sign in', env: 'Env variables', plan: 'Your plan' };");
  sub("  function howTo(p) {\n    var box = el('div', 'pvp-how'); var ol = el('ol'); var href = p.keyUrl || p.doc;", String.raw`  function planHow(p) {
    var box = el('div', 'pvp-how'); var ol = el('ol');
    step(ol, p.claudeLoggedIn ? 'You are signed in to Claude Code, so this provider is connected. There is no key to paste.' : 'Sign in once: open a terminal and run claude auth login.');
    step(ol, 'Used by the fleet wherever it runs Claude Code: the Planner, the Designer (mockups), Claude’s final review, and the Implementer when you pick claude.');
    step(ol, 'Choose it under Agents & planner: Planner and Designer take Claude Sonnet, Opus or Haiku; the Implementer row has a claude option.');
    step(ol, 'Press Test to send one tiny prompt through Claude Code.');
    box.append(ol, el('p', 'pvp-note', 'Not possible: the router, tester, merger and the other OpenCode agents cannot run on plan models. Anthropic does not allow other tools to use a Claude plan sign-in. For those, connect Anthropic with an API key.'));
    return box;
  }
  function howTo(p) {
    if ((p.method || 'key') === 'plan') return planHow(p);
    var box = el('div', 'pvp-how'); var ol = el('ol'); var href = p.keyUrl || p.doc;`);
  sub("  function actions(p, on, inDialog) {\n    var m = p.method || 'key'; var act = el('div', 'pvp-act');", String.raw`  function actions(p, on, inDialog) {
    var m = p.method || 'key'; var act = el('div', 'pvp-act');
    if (m === 'plan') {
      ['sonnet', 'opus', 'haiku'].forEach(function (mod) {
        var b = el('button', 'btn btn-sm', 'Test ' + mod); b.type = 'button'; b.disabled = !p.claudeLoggedIn;
        b.onclick = async function () {
          b.disabled = true; var t = b.textContent; b.textContent = 'Testing…';
          var x = await ejadPost({ action: 'ejad_test_claude', model: mod });
          b.textContent = t; b.disabled = false;
          toast(x.ok ? (x.j.ok ? 'Claude ' + mod + ' works' : 'Claude ' + mod + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), !(x.ok && x.j.ok));
        };
        act.append(b);
      });
      return act;
    }`);
  sub("[k, k + (d.clis[k] ? '' : '  (not installed)')]", "[k, (k === 'claude' ? 'claude (Claude Code, your plan)' : k) + (d.clis[k] ? '' : '  (not installed)')]");
  sub('<section class="pvp-plan"><h3>Agents</h3>', `<section class="pvp-plan" id="ejad-designer-sec"><h3>Designer (mockups)</h3><p>Who designs the mockup of a ticket: it studies the app's design system and real screens, applies the UI/UX rules and checks its own screenshots. Claude uses your Claude plan; any connected provider works too. <strong id="pvp-dnow"></strong></p>
      <div class="pvp-row"><select id="pvp-designer" aria-label="Designer model"></select><button type="button" class="btn btn-sm btn-primary" id="pvp-dsave">Save</button></div></section>
    <section class="pvp-plan"><h3>Agents</h3>`);
  const JS = `<script id="ejad-designer-js">
(function () {
  function el(tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
  async function load() {
    var sel = document.getElementById('pvp-designer'); if (!sel) return;
    try {
      var res = await fetch('/api/ejad/providers', { headers: getAuthHeaders() }); if (!res.ok) return;
      var d = await res.json(); var st = d.designer || { runtime: 'claude', claude: 'sonnet' };
      sel.textContent = '';
      var g = document.createElement('optgroup'); g.label = 'Claude (your Claude plan)';
      ['sonnet', 'opus', 'haiku'].forEach(function (m) { var o = el('option', 'Claude ' + m); o.value = 'claude:' + m; g.append(o); });
      sel.append(g);
      (d.connected || []).forEach(function (id) {
        var ms = (d.models || []).filter(function (m) { return m.indexOf(id + '/') === 0; }); if (!ms.length) return;
        var og = document.createElement('optgroup'); og.label = id;
        ms.forEach(function (m) { var o = el('option', m.slice(id.length + 1) + (/-free$/.test(m) ? '  (free)' : '')); o.value = m; og.append(o); });
        sel.append(og);
      });
      var v = st.runtime === 'opencode' && st.opencode ? st.opencode : 'claude:' + (st.claude || 'sonnet');
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { var x = el('option', v + ' (current)'); x.value = v; sel.prepend(x); }
      sel.value = v; document.getElementById('pvp-dnow').textContent = 'Now: ' + v;
    } catch (e) { /* the picker keeps its last view */ }
  }
  var save = document.getElementById('pvp-dsave');
  if (save) save.onclick = async function () {
    var v = document.getElementById('pvp-designer').value; save.disabled = true;
    var x = await ejadPost({ action: 'ejad_set_designer', choice: v }); save.disabled = false;
    showToast(x.ok ? 'Designer is now ' + v + ' (next mockup)' : (x.j.error || 'Could not change the designer'), x.ok ? undefined : 'bad'); if (x.ok) load();
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
console.log('claude patch applied');

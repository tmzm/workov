// Ejad: show every fleet agent with its model and provider in the dashboard. worker-fleet's Agents section lists only
// running workers, so nobody could see which model a role uses. The server now answers GET /api/agent-roster from
// specs/worker-fleet.config.json (models) and the agent files' frontmatter (.opencode/agents, .claude/agents), and the
// page shows it as a table under the Agents heading. Read-only; writes nothing.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
EJAD_PROVIDERS = {"opencode-go": "OpenCode Go", "opencode": "OpenCode Zen (free tier)", "anthropic": "Anthropic"}


def ejad_frontmatter(path):
    """name/model/mode/description from the YAML frontmatter of an agent file (flat keys only)."""
    out = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    if not lines or lines[0].strip() != "---":
        return out
    for ln in lines[1:]:
        if ln.strip() == "---":
            break
        m = re.match(r"^(name|model|mode|description|tools):\s*(.*)$", ln)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def ejad_agent_roster():
    """One row per agent file: runtime, model, provider, effort, and whether config and file disagree."""
    cfg = get_config()
    models = cfg.get("models", {}) if isinstance(cfg.get("models"), dict) else {}
    rows = []
    for runtime, folder in (("opencode", ".opencode/agents"), ("claude", ".claude/agents")):
        for f in sorted(glob.glob(str(REPO_ROOT / folder / "*.md"))):
            fm = ejad_frontmatter(f)
            name = fm.get("name") or Path(f).stem
            conf = (models.get(name) or {}).get(runtime) or {}
            file_model = fm.get("model", "")
            model = conf.get("model") or file_model or "?"
            if runtime == "claude":
                provider = "Anthropic (Claude Code)"
            else:
                provider = EJAD_PROVIDERS.get(model.split("/")[0], model.split("/")[0]) if "/" in model else "?"
            row = {
                "agent": name, "runtime": runtime, "model": model, "provider": provider,
                "effort": conf.get("effort") or "", "mode": fm.get("mode", ""),
                "role": (fm.get("description", "").split(". ")[0])[:140],
                "source": "config" if conf.get("model") else "agent file",
            }
            if conf.get("model") and file_model and conf["model"] != file_model:
                row["fileModel"] = file_model
            rows.append(row)
    return {"harness": cfg.get("harness", ""), "agents": rows}

`;
if (!s.includes('def ejad_agent_roster')) {
  must('\ndef ejad_mockup_path(tdir):');
  s = s.replace('\ndef ejad_mockup_path(tdir):', () => `${FN}\ndef ejad_mockup_path(tdir):`);
  const a = '        if path == "/api/logs":';
  must(a);
  s = s.replace(a, () => '        if path == "/api/agent-roster":\n            self._send_json(200, ejad_agent_roster())\n            return\n\n' + a);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: /api/agent-roster');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="ejad-roster"')) {
  const mark = '        <div id="matrix-grid" class="matrix-grid">';
  if (!h.includes(mark)) throw new Error('anchor missing: matrix-grid');
  h = h.replace(mark, () => `        <details id="ejad-roster" class="ejad-roster" style="margin-bottom:12px;">
          <summary>Agent roster: model and provider of every agent <span id="ejad-roster-note" class="note-s"></span></summary>
          <div style="overflow-x:auto;"><table class="ejad-roster-table" style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr><th align="left">Agent</th><th align="left">Runs on</th><th align="left">Model</th><th align="left">Provider</th><th align="left">Effort</th><th align="left">Role</th></tr></thead>
            <tbody id="ejad-roster-body"></tbody>
          </table></div>
        </details>
` + mark);
  const call = '    ejadPollPermissions(); setInterval(ejadPollPermissions, 2000);';
  if (!h.includes(call)) throw new Error('anchor missing: ejadPollPermissions');
  h = h.replace(call, () => `    async function ejadLoadRoster() {
      try {
        const res = await fetch('/api/agent-roster', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const body = document.getElementById('ejad-roster-body');
        body.textContent = '';
        (data.agents || []).forEach(a => {
          const tr = document.createElement('tr');
          const active = a.runtime === data.harness;
          const cells = [a.agent, a.runtime + (active ? ' (active)' : ''), a.model + (a.fileModel ? '  [agent file says ' + a.fileModel + ']' : ''), a.provider, a.effort || '-', a.role || ''];
          cells.forEach((t, i) => { const td = document.createElement('td'); td.style.padding = '4px 8px'; td.style.borderTop = '1px solid var(--line, #8884)'; if (i === 2) td.className = 'mono'; td.textContent = t; tr.append(td); });
          if (!active) tr.style.opacity = '0.6';
          body.append(tr);
        });
        document.getElementById('ejad-roster-note').textContent = '(active runtime: ' + (data.harness || '?') + ')';
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    ejadLoadRoster();
` + call);
  fs.writeFileSync(H, h);
}
console.log('index.html: agent roster');

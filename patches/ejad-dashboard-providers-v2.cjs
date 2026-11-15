// Ejad: Providers page v2 (apply after ejad-dashboard-providers-tab.cjs).
//  - inner tabs: Providers (cards) and Agents & planner; provider-first model pickers; the worker highlighted
//  - every provider card: logo (served from this dashboard, cached from models.dev), facts (price, context, abilities,
//    API address, SDK, variables, sample models) and HOW TO CONNECT, because not every provider takes a single key:
//      key   = paste an API key here
//      login = sign in with `opencode auth login` (GitHub Copilot)
//      env   = several values set as environment variables (AWS Bedrock, Azure, Vertex, Cloudflare...)
const fs = require('fs');
const path = require('path');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

// ---------- server ----------
let s = rd(S);
if (!s.includes('def ejad_logo')) {
  const FN = String.raw`
EJAD_LOGIN_ONLY = ("github-copilot",)
EJAD_LOGIN_ALSO = ("anthropic", "openai")
EJAD_ENV_ALIAS = ("google", "zenifra")


def ejad_connect_info(pid, env):
    if pid in EJAD_LOGIN_ONLY:
        return {"method": "login", "alsoLogin": False}
    if len(env) > 1 and pid not in EJAD_ENV_ALIAS:
        return {"method": "env", "alsoLogin": False}
    return {"method": "key", "alsoLogin": pid in EJAD_LOGIN_ALSO}


def ejad_provider_facts(p, ms):
    rows = [m for m in ms.values() if isinstance(m, dict)]
    paid = [m["cost"]["input"] for m in rows if isinstance(m.get("cost"), dict) and isinstance(m["cost"].get("input"), (int, float)) and m["cost"]["input"] > 0]
    ctx = [(m.get("limit") or {}).get("context") or 0 for m in rows]
    sample = sorted(((m.get("id") or k, (m.get("cost") or {}).get("input") == 0) for k, m in ms.items() if isinstance(m, dict)), key=lambda t: (not t[1], t[0]))[:5]
    return {
        "priceMin": min(paid) if paid else None, "priceMax": max(paid) if paid else None, "ctxMax": max(ctx) if ctx else 0,
        "tools": sum(1 for m in rows if m.get("tool_call")), "reasoning": sum(1 for m in rows if m.get("reasoning")),
        "vision": sum(1 for m in rows if "image" in ((m.get("modalities") or {}).get("input") or [])),
        "api": p.get("api") or "", "sdk": p.get("npm") or "", "sample": [{"id": i, "free": f} for i, f in sample],
    }


def ejad_logo(pid):
    """SVG bytes of a provider's logo, cached under job/provider-logos/. models.dev answers an unknown id with a generic
    placeholder; that placeholder is recognised and treated as no logo."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,60}", str(pid or "")):
        return None
    d = REPO_ROOT / "job" / "provider-logos"
    f, miss, dflt = d / (pid + ".svg"), d / (pid + ".none"), d / "_default.svg"
    if f.exists():
        return f.read_bytes()
    if miss.exists() and time.time() - miss.stat().st_mtime < 7 * 86400:
        return None
    import urllib.request

    def get(name):
        req = urllib.request.Request("https://models.dev/logos/" + name + ".svg", headers={"user-agent": "ejad-fleet-dashboard/1.0"})
        return urllib.request.urlopen(req, timeout=15).read()
    try:
        d.mkdir(parents=True, exist_ok=True)
        if not dflt.exists():
            dflt.write_bytes(get("zzz-no-such-provider"))
        data = get(pid)
        if data == dflt.read_bytes() or b"<svg" not in data[:2000].lower():
            miss.write_text("")
            return None
        f.write_bytes(data)
        return data
    except Exception:
        return None

`;
  must(s, '\ndef ejad_run_action(action, req, tid):');
  s = s.replace('\ndef ejad_run_action(action, req, tid):', () => `${FN}\ndef ejad_run_action(action, req, tid):`);

  must(s, '        ms = p.get("models") or {}\n');
  s = s.replace('        ms = p.get("models") or {}\n', () => '        ms = p.get("models") or {}\n        env = [e for e in (p.get("env") or []) if isinstance(e, str)]\n');
  const a = s.indexOf('        out.append({"id": pid, "name": p.get("name") or pid,');
  const endMark = '"popular": pid in EJAD_POPULAR})';
  const b = s.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('anchor missing: catalog append');
  s = s.slice(0, a) + '        out.append({"id": pid, "name": p.get("name") or pid, "doc": p.get("doc") or "", "keyUrl": EJAD_KEY_URLS.get(pid, ""),\n                    "models": len(ms), "free": free, "popular": pid in EJAD_POPULAR, "env": env[:6],\n                    **ejad_connect_info(pid, env), **ejad_provider_facts(p, ms)})' + s.slice(b + endMark.length);
  must(s, '"provider-catalog.json"');
  s = s.replace('"provider-catalog.json"', '"provider-catalog-v3.json"');

  must(s, '        if path == "/api/ejad/catalog":');
  s = s.replace('        if path == "/api/ejad/catalog":', () => [
    '        if path == "/api/ejad/logo":',
    '            data = ejad_logo((urllib.parse.parse_qs(parsed.query).get("id") or [""])[0])',
    '            if not data:',
    '                self.send_error(404, "No logo")',
    '                return',
    '            self.send_response(200)',
    '            self.send_header("Content-Type", "image/svg+xml")',
    '            self.send_header("Content-Length", str(len(data)))',
    '            self.send_header("X-Content-Type-Options", "nosniff")',
    '            self.send_header("Content-Security-Policy", "default-src \'none\'; style-src \'unsafe-inline\'")',
    '            self.send_header("Cache-Control", "private, max-age=604800")',
    '            self.end_headers()',
    '            self.wfile.write(data)',
    '            return',
    '',
    '        if path == "/api/ejad/catalog":',
  ].join('\n'));
  fs.writeFileSync(S, s);
}

// ---------- page ----------
let h = rd(H);
if (!h.includes('id="pvp-tab-agents"')) {
  const dir = path.join(__dirname, 'providers-page');
  const css = fs.readFileSync(path.join(dir, 'v2.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'agents.js'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'v2.js'), 'utf8');
  const sec = h.indexOf('<section id="tab-providers"');
  if (sec < 0) throw new Error('anchor missing: tab-providers (apply ejad-dashboard-providers-tab.cjs first)');
  const start = h.lastIndexOf('<style>', sec);
  const tail = h.indexOf('window.ejadProvidersShown', sec);
  const end = h.indexOf('</script>', tail) + '</script>'.length;
  if (start < 0 || tail < 0) throw new Error('anchor missing: old providers block');
  const HTML = `<style>
${css}</style>
<section id="tab-providers" class="tab-content" aria-labelledby="h-providers"><h1 id="h-providers" class="sr-only">Providers</h1>
<div id="pvp"><div class="pvp-wrap">
  <div class="pvp-head"><h2>Providers</h2><span class="pvp-sub" id="pvp-sub"></span><span class="pvp-spacer"></span><button type="button" class="btn btn-sm" id="pvp-refresh">Refresh list</button></div>
  <div class="pvp-tabs" role="tablist" aria-label="Providers sections">
    <button type="button" role="tab" class="pvp-tab" id="pvp-tab-providers" aria-controls="pvp-panel-providers" aria-selected="true">Providers <span class="n" id="pvp-count"></span></button>
    <button type="button" role="tab" class="pvp-tab" id="pvp-tab-agents" aria-controls="pvp-panel-agents" aria-selected="false" tabindex="-1">Agents &amp; planner</button>
  </div>
  <div class="pvp-panel" role="tabpanel" id="pvp-panel-providers" aria-labelledby="pvp-tab-providers" tabindex="0">
    <div class="pvp-toolbar"><input id="pvp-search" type="search" placeholder="Search providers" aria-label="Search providers" autocomplete="off">
      <div class="pvp-chips" role="group" aria-label="Filter providers"><button type="button" class="pvp-chip" data-f="all" aria-pressed="true">All</button><button type="button" class="pvp-chip" data-f="connected" aria-pressed="false">Connected</button><button type="button" class="pvp-chip" data-f="popular" aria-pressed="false">Popular</button><button type="button" class="pvp-chip" data-f="free" aria-pressed="false">Has free models</button></div></div>
    <p class="sr-only" id="pvp-live" aria-live="polite"></p>
    <div class="pvp-grid" id="pvp-grid"></div><button type="button" class="btn btn-sm" id="pvp-more" hidden>Show more</button>
  </div>
  <div class="pvp-panel" role="tabpanel" id="pvp-panel-agents" aria-labelledby="pvp-tab-agents" tabindex="0" hidden>
    <section class="pvp-plan"><h3>Planner</h3><p>Who plans the task and writes the ticket. Claude uses your Claude plan; any connected provider works too. <strong id="pvp-pnow"></strong></p>
      <div class="pvp-row"><select id="pvp-planner" aria-label="Planner model"></select><button type="button" class="btn btn-sm btn-primary" id="pvp-save">Save</button><button type="button" class="btn btn-sm" id="pvp-ptest">Test</button></div></section>
    <section class="pvp-plan"><h3>Agents</h3><div id="pvp-agents-body"></div></section>
  </div>
<dialog id="pvp-dialog" aria-labelledby="pvp-dlg-title"><div class="pvp-dlg-head" id="pvp-dlg-head"></div><div class="pvp-dlg-body" id="pvp-dlg-body"></div><div class="pvp-dlg-foot" id="pvp-dlg-foot"></div></dialog>
</div></div></section>
<script>
${js}</script>`;
  h = h.slice(0, start) + HTML + h.slice(end);
  fs.writeFileSync(H, h);
}
console.log('providers v2 patch applied');

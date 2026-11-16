// Workerov: connect any number of providers from the dashboard, test a model, and a Planner role (apply after providers2).
//  - wv_connect_provider writes the key into OpenCode's own auth file (local to this computer); wv_disconnect_provider
//    removes it; wv_test_model sends one tiny prompt so a provider is proven to work before it is used.
//  - Keys are redacted from job/audit.jsonl and never returned by any endpoint. The dashboard already asks for its
//    token on every non-local request, and the public tunnel is HTTPS.
//  - "planner" becomes a switchable role next to router/worker/reviewer.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };
let s = rd(S);

if (!s.includes('def wv_connect_provider')) {
  const FN = String.raw`
def wv_auth_path():
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "opencode" / "auth.json"


def wv_connect_provider(provider, key):
    provider, key = str(provider or "").strip(), str(key or "").strip()
    if not re.fullmatch(r"[a-z][a-z0-9._-]{1,40}", provider):
        return 400, {"error": "Give a provider id such as openrouter, anthropic, openai, google or kilo."}
    if not re.fullmatch(r"\S{8,600}", key):
        return 400, {"error": "The key looks wrong: 8 to 600 characters, no spaces."}
    path = wv_auth_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return 500, {"error": "OpenCode's auth file is unreadable; not touching it."}
    data[provider] = {"type": "api", "key": key}
    path.parent.mkdir(parents=True, exist_ok=True)
    wv_atomic_write(path, json.dumps(data, indent=2))
    _wv_models_cache[0] = 0.0
    wv_opencode_reload()
    return 200, {"ok": True, "provider": provider, "models": len([m for m in wv_model_list() if m.startswith(provider + "/")])}


def wv_disconnect_provider(provider):
    provider = str(provider or "").strip()
    path = wv_auth_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return 500, {"error": "OpenCode's auth file is unreadable; not touching it."}
    if provider not in data:
        return 404, {"error": f"{provider} is not connected."}
    del data[provider]
    wv_atomic_write(path, json.dumps(data, indent=2))
    _wv_models_cache[0] = 0.0
    wv_opencode_reload()
    return 200, {"ok": True, "provider": provider}


def wv_test_model(model):
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+", str(model or "")):
        return 400, {"error": "Give a model like provider/model."}
    try:
        r = subprocess.run(["opencode", "run", "-m", model, "reply with the single word ok"], capture_output=True, text=True, timeout=90, shell=(os.name == "nt"), creationflags=WV_NOWIN, cwd=str(REPO_ROOT))
    except subprocess.TimeoutExpired:
        return 200, {"ok": False, "model": model, "detail": "No answer within 90 seconds."}
    out = WV_ANSI_RE.sub("", (r.stdout or "") + (r.stderr or "")).strip().splitlines()
    err = [ln for ln in out if "Error" in ln]
    return 200, {"ok": not err and bool(out), "model": model, "detail": (err[-1] if err else (out[-1] if out else "No output"))[:300]}

`;
  must(s, '\ndef wv_run_action(action, req, tid):');
  s = s.replace('\ndef wv_run_action(action, req, tid):', () => `${FN}\ndef wv_run_action(action, req, tid):`);
  must(s, 'WV_ACTIONS = ("wv_models_preset",');
  s = s.replace('WV_ACTIONS = ("wv_models_preset",', 'WV_ACTIONS = ("wv_connect_provider", "wv_disconnect_provider", "wv_test_model", "wv_models_preset",');
  must(s, '    if action == "wv_models_preset":');
  s = s.replace('    if action == "wv_models_preset":', () => '    if action == "wv_connect_provider":\n        return wv_connect_provider(req.get("provider"), req.get("key"))\n    if action == "wv_disconnect_provider":\n        return wv_disconnect_provider(req.get("provider"))\n    if action == "wv_test_model":\n        return wv_test_model(req.get("model"))\n    if action == "wv_models_preset":');
  // never write a key to the audit log
  must(s, 'params = {k: v for k, v in req.items() if k not in ("action", "ticket")}');
  s = s.replace('params = {k: v for k, v in req.items() if k not in ("action", "ticket")}', 'params = {k: v for k, v in req.items() if k not in ("action", "ticket", "key")}');
  // planner role: shown even when the config has no entry yet, created on first switch
  must(s, '    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}');
  s = s.replace('    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}', () => '    if not any(r["role"] == "planner" for r in roles):\n        roles.append({"role": "planner", "model": wv_agent_file_model("planner"), "claude": ""})\n    clis = {name: bool(shutil.which(exe)) for name, exe in WV_CLIS.items()}');
  must(s, '    entry = (cfg.get("models") or {}).get(role)\n    if not isinstance(entry, dict):');
  s = s.replace('    entry = (cfg.get("models") or {}).get(role)\n    if not isinstance(entry, dict):', () => '    entry = (cfg.get("models") or {}).get(role)\n    if role == "planner" and not isinstance(entry, dict):\n        entry = cfg.setdefault("models", {}).setdefault("planner", {})\n    if not isinstance(entry, dict):');
  must(s, '\ndef wv_providers():');
  s = s.replace('\ndef wv_providers():', () => '\ndef wv_agent_file_model(role):\n    try:\n        m = re.search(r"^model:\\s*(\\S+)", (REPO_ROOT / ".opencode" / "agents" / f"{role}.md").read_text(encoding="utf-8"), re.M)\n        return m.group(1) if m else ""\n    except Exception:\n        return ""\n\n\ndef wv_providers():');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('wv-connect-form')) {
  const a = h.indexOf("box.append(mk('p', 'To connect another provider");
  if (a < 0) throw new Error('anchor missing: connect note');
  const b = h.indexOf('\n', a);
  const UI = String.raw`const cf = mk('div'); cf.id = 'wv-connect-form'; cf.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 10px;';
        const pin = document.createElement('input'); pin.setAttribute('list', 'wv-pv-ids'); pin.placeholder = 'provider (openrouter, kilo...)'; pin.setAttribute('aria-label', 'Provider id');
        const dl = document.createElement('datalist'); dl.id = 'wv-pv-ids'; ['openrouter', 'anthropic', 'openai', 'google', 'kilo', 'groq', 'mistral', 'xai', 'deepseek', 'together', 'opencode', 'opencode-go'].forEach(v => { const o = document.createElement('option'); o.value = v; dl.append(o); });
        const kin = document.createElement('input'); kin.type = 'password'; kin.autocomplete = 'off'; kin.placeholder = 'API key'; kin.setAttribute('aria-label', 'API key');
        const cb = mk('button', 'Connect', 'btn btn-sm'); cb.type = 'button';
        cb.onclick = async () => { cb.disabled = true; const x = await wvPost({ action: 'wv_connect_provider', provider: pin.value.trim(), key: kin.value.trim() }); kin.value = ''; cb.disabled = false; showToast(x.ok ? pin.value.trim() + ' connected (' + x.j.models + ' models). Press Test on a model to prove it works.' : (x.j.error || 'Could not connect'), x.ok ? undefined : 'bad'); if (x.ok) wvLoadProviders(); };
        cf.append(pin, dl, kin, cb); box.append(cf);
        const cl = mk('div'); cl.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px;';
        d.connected.forEach(n => { const rb = mk('button', n + '  ✕', 'btn btn-sm'); rb.type = 'button'; rb.title = 'Disconnect ' + n; rb.onclick = async () => { if (!confirm('Disconnect ' + n + '?')) return; const x = await wvPost({ action: 'wv_disconnect_provider', provider: n }); showToast(x.ok ? n + ' disconnected' : (x.j.error || 'Failed'), x.ok ? undefined : 'bad'); if (x.ok) wvLoadProviders(); }; cl.append(rb); });
        box.append(cl, mk('p', 'Connect as many providers as you like: type the provider id and paste its key. The key is stored only in OpenCode on this computer and is never shown again or written to the audit log. Test proves a model answers before you rely on it.', 'note-s'));`;
  h = h.slice(0, a) + UI + h.slice(b);
  const old = "          cell(tr, b);\n        });";
  if (!h.includes(old)) throw new Error('anchor missing: row apply');
  h = h.replace(old, () => "          cell(tr, b);\n          const tb = document.createElement('button'); tb.type = 'button'; tb.className = 'btn btn-sm'; tb.textContent = 'Test';\n          tb.onclick = async () => { tb.disabled = true; tb.textContent = 'Testing…'; const x = await wvPost({ action: 'wv_test_model', model: sel.value }); tb.disabled = false; tb.textContent = 'Test'; showToast(x.ok ? (x.j.ok ? sel.value + ' works' : sel.value + ' failed: ' + x.j.detail) : (x.j.error || 'Test failed'), x.ok && x.j.ok ? undefined : 'bad'); };\n          cell(tr, tb);\n        });");
  fs.writeFileSync(H, h);
}
console.log('connect patch applied');

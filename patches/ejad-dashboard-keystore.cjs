// Ejad: provider keys go where OpenCode 2 reads them (apply after ejad-dashboard-providers-v2.cjs).
// OpenCode 2 keeps its own credentials in its database and only accepts a typed key in an interactive terminal, so the
// dashboard's old write into ~/.local/share/opencode/auth.json was ignored. A provider key is accepted from the global
// config, provider.<id>.options.apiKey in ~/.config/opencode/opencode.jsonc (outside every repo, so it is never
// committed). Connect writes it there, Disconnect removes it, and keys that earlier versions of this dashboard left in
// auth.json are adopted once. A key is never returned by any endpoint or written to the audit log.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');

if (!s.includes('def ejad_global_config_path')) {
  const a = s.indexOf('def ejad_connect_provider(provider, key):');
  const b = s.indexOf('def ejad_test_model(model):');
  if (a < 0 || b < 0) throw new Error('anchor missing: connect/test functions (apply providers-v2 first)');
  const NEW = String.raw`def ejad_global_config_path():
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "opencode" / "opencode.jsonc"


def ejad_read_global_config():
    """The global OpenCode config as a dict. A file with comments is refused rather than rewritten without them."""
    p = ejad_global_config_path()
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def ejad_write_global_config(data):
    p = ejad_global_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    ejad_atomic_write(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def ejad_set_provider_key(data, provider, key):
    data.setdefault("provider", {}).setdefault(provider, {}).setdefault("options", {})["apiKey"] = key


def ejad_adopt_legacy_keys():
    """Move keys that earlier dashboard versions saved in auth.json into the global config (opencode and opencode-go are
    OpenCode's own integrations and are left alone)."""
    path = ejad_auth_path()
    try:
        legacy = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        todo = {k: v["key"] for k, v in legacy.items() if k not in ("opencode", "opencode-go") and isinstance(v, dict) and v.get("type") == "api" and v.get("key")}
        if not todo:
            return
        cfg = ejad_read_global_config()
        for k, v in todo.items():
            if not (((cfg.get("provider") or {}).get(k) or {}).get("options") or {}).get("apiKey"):
                ejad_set_provider_key(cfg, k, v)
        ejad_write_global_config(cfg)
        for k in todo:
            legacy.pop(k, None)
        ejad_atomic_write(path, json.dumps(legacy, indent=2))
        _ejad_models_cache[0] = 0.0
        ejad_opencode_reload()
    except Exception as e:
        print(f"[ejad] could not adopt legacy provider keys: {e}", file=sys.stderr)


def ejad_connect_provider(provider, key):
    provider, key = str(provider or "").strip(), str(key or "").strip()
    if not re.fullmatch(r"[a-z][a-z0-9._-]{1,40}", provider):
        return 400, {"error": "Give a provider id such as openrouter, anthropic, openai, google or kilo."}
    if not re.fullmatch(r"\S{8,600}", key):
        return 400, {"error": "The key looks wrong: 8 to 600 characters, no spaces."}
    try:
        cfg = ejad_read_global_config()
    except Exception:
        return 500, {"error": "OpenCode's global config has comments or is unreadable; not touching it. Add the key there by hand."}
    ejad_set_provider_key(cfg, provider, key)
    ejad_write_global_config(cfg)
    _ejad_models_cache[0] = 0.0
    ejad_opencode_reload()
    return 200, {"ok": True, "provider": provider, "models": len([m for m in ejad_model_list() if m.startswith(provider + "/")])}


def ejad_disconnect_provider(provider):
    provider = str(provider or "").strip()
    try:
        cfg = ejad_read_global_config()
    except Exception:
        return 500, {"error": "OpenCode's global config has comments or is unreadable; not touching it."}
    opts = (((cfg.get("provider") or {}).get(provider) or {}).get("options") or {})
    if "apiKey" not in opts:
        return 404, {"error": f"{provider} was not connected from this dashboard. OpenCode's own sign-ins are removed with opencode auth logout."}
    del opts["apiKey"]
    if not opts:
        cfg["provider"][provider].pop("options", None)
    if not cfg["provider"][provider]:
        del cfg["provider"][provider]
    ejad_write_global_config(cfg)
    _ejad_models_cache[0] = 0.0
    ejad_opencode_reload()
    return 200, {"ok": True, "provider": provider}


`;
  s = s.slice(0, a) + NEW + s.slice(b);
  // connected ids: dashboard keys (config) + OpenCode's own (auth.json lists the free tier and Go)
  const c = s.indexOf('def ejad_connected_ids():');
  const d = s.indexOf('def ejad_catalog(', c);
  if (c < 0 || d < 0) throw new Error('anchor missing: ejad_connected_ids');
  s = s.slice(0, c) + String.raw`def ejad_connected_ids():
    ejad_adopt_legacy_keys()
    ids = set()
    try:
        ids |= {k for k, v in (ejad_read_global_config().get("provider") or {}).items() if ((v or {}).get("options") or {}).get("apiKey")}
    except Exception:
        pass
    try:
        ids |= set(json.loads(ejad_auth_path().read_text(encoding="utf-8")).keys())
    except Exception:
        pass
    return sorted(ids) or ejad_connected()


` + s.slice(d);
  fs.writeFileSync(S, s);
}
// model ids of gateway providers have a second slash (kilo/nvidia/nemotron-3-ultra:free, openrouter/openai/gpt-5)
s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
s = s.split('[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+').join('[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+');
fs.writeFileSync(S, s);
console.log('keystore patch applied');

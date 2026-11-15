// Ejad: see the Claude account in use, its measured usage, and switch the account (apply after ejad-dashboard-claude.cjs).
//  - GET /api/ejad/claude (owner only, never the read-only link): the signed-in account from `claude auth status`
//    (email, organization, plan, login expiry) and token usage MEASURED from this computer's Claude Code session logs
//    (counts only, never message content): last 5 hours, today, last 7 days, and per model.
//    The plan's own limit percentages are shown only by Claude Code's /usage, so they are not available here and the page says so.
//  - ejad_claude_login: runs `claude auth login --claudeai [--email x]`, which opens a browser on THIS computer. Allowed only
//    from the computer itself (a phone through the tunnel could not complete it, and would be confusing).
//  - Claude cards and the Claude dialog show the account, the usage and the switch button.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def ejad_claude_account')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('\ndef ejad_run_action(action, req, tid):', String.raw`
def ejad_claude_account():
    try:
        r = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True, timeout=20, shell=(os.name == "nt"), creationflags=EJAD_NOWIN)
        d = json.loads(r.stdout)
        return {"loggedIn": bool(d.get("loggedIn")), "email": d.get("email", ""), "org": d.get("orgName", ""), "plan": d.get("subscriptionType") or d.get("planTier") or "",
                "method": d.get("authMethod", ""), "expiresAt": d.get("loginExpiresAt", "")}
    except Exception:
        return {"loggedIn": False, "email": "", "org": "", "plan": "", "method": "", "expiresAt": ""}


_ejad_usage = {"at": 0.0, "data": None, "busy": False}


def ejad_usage_compute():
    """Token counts from Claude Code's session logs (never their text). Approximate: a message counts once."""
    root = Path.home() / ".claude" / "projects"
    now = time.time()
    cut7, cut5 = now - 7 * 86400, now - 5 * 3600
    today = datetime.fromtimestamp(now).date()
    win = {"last5h": [0, 0, 0, 0], "today": [0, 0, 0, 0], "last7d": [0, 0, 0, 0]}
    per_model, seen, files = {}, set(), 0
    for f in root.rglob("*.jsonl"):
        try:
            if f.stat().st_mtime < cut7:
                continue
        except OSError:
            continue
        files += 1
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as fh:
                for ln in fh:
                    if '"output_tokens"' not in ln:
                        continue
                    try:
                        o = json.loads(ln)
                    except ValueError:
                        continue
                    m = o.get("message") if isinstance(o, dict) else None
                    u = m.get("usage") if isinstance(m, dict) else None
                    if not isinstance(u, dict):
                        continue
                    key = (m.get("id"), o.get("requestId"))
                    if key in seen:
                        continue
                    seen.add(key)
                    try:
                        ts = datetime.strptime(str(o.get("timestamp", ""))[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
                    except ValueError:
                        continue
                    if ts < cut7:
                        continue
                    v = [int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0), int(u.get("cache_creation_input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0)]
                    names = ["last7d"] + (["last5h"] if ts >= cut5 else []) + (["today"] if datetime.fromtimestamp(ts).date() == today else [])
                    for n in names:
                        for i in range(4):
                            win[n][i] += v[i]
                    mod = str(m.get("model") or "?")
                    if mod.startswith("<"):
                        continue
                    pm = per_model.setdefault(mod, [0, 0, 0, 0])
                    for i in range(4):
                        pm[i] += v[i]
        except OSError:
            continue
    keys = ("input", "output", "cacheWrite", "cacheRead")
    return {"at": utc_now_iso(), "files": files, "windows": {n: dict(zip(keys, v)) for n, v in win.items()},
            "models": sorted(({"model": k, **dict(zip(keys, v))} for k, v in per_model.items()), key=lambda r: -(r["input"] + r["output"] + r["cacheWrite"])), "measured": True}


def ejad_usage_refresh():
    if _ejad_usage["busy"]:
        return
    _ejad_usage["busy"] = True

    def work():
        try:
            _ejad_usage["data"] = ejad_usage_compute()
            _ejad_usage["at"] = time.time()
        except Exception as e:
            print(f"[ejad] claude usage failed: {e}", file=sys.stderr)
        finally:
            _ejad_usage["busy"] = False
    threading.Thread(target=work, daemon=True).start()


def ejad_claude_info():
    if time.time() - _ejad_usage["at"] > 180:
        ejad_usage_refresh()
    return {"account": ejad_claude_account(), "usage": _ejad_usage["data"], "computing": _ejad_usage["busy"]}


def ejad_claude_login(email):
    cmd = ["claude", "auth", "login", "--claudeai"]
    email = str(email or "").strip()
    if email:
        if not re.fullmatch(r"[^@\s]{1,64}@[^@\s]{1,120}", email):
            return 400, {"error": "That does not look like an email address."}
        cmd += ["--email", email]
    subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=(os.name == "nt"), creationflags=EJAD_DETACH if os.name == "nt" else 0)
    _ejad_claude_cache[0] = 0.0
    return 200, {"ok": True, "note": "A browser window is opening on this computer. Finish the sign-in there; this page updates when you are done."}

` + '\ndef ejad_run_action(action, req, tid):');
  sub('EJAD_ACTIONS = ("ejad_set_designer",', 'EJAD_ACTIONS = ("ejad_claude_login", "ejad_set_designer",');
  sub('    if action == "ejad_set_designer":', '    if action == "ejad_claude_login":\n        return ejad_claude_login(req.get("email"))\n    if action == "ejad_set_designer":');
  sub('                    code, payload = ejad_run_action(action, req, ticket_id)\n', '                    if action == "ejad_claude_login" and not self._is_local():\n                        code, payload = 403, {"error": "Switching the Claude account opens a browser on the computer itself. Do it from that computer."}\n                    else:\n                        code, payload = ejad_run_action(action, req, ticket_id)\n');
  sub('        if path == "/api/ejad/router":', '        if path == "/api/ejad/claude":\n            if self._is_viewer():\n                self._send_json(403, {"error": "This is a read-only link."})\n                return\n            self._send_json(200, ejad_claude_info())\n            return\n\n        if path == "/api/ejad/router":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('function claudePanel')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("      var p = await api('/api/ejad/providers');\n", "      var p = await api('/api/ejad/providers');\n      try { state.claude = await api('/api/ejad/claude'); } catch (e) { state.claude = null; }\n");
  sub("    c.append(meta, actions(p, on, false));", "    c.append(meta);\n    if (m === 'plan' && state.claude && state.claude.account && state.claude.account.loggedIn) c.append(el('div', 'pvp-meta', 'Signed in as ' + state.claude.account.email + (state.claude.account.plan ? ' \\u00B7 ' + state.claude.account.plan : '')));\n    c.append(actions(p, on, false));");
  // tolerant of reformatting (prettier may wrap this call over several lines)
  const reDlg = /(b\.append\(\s*el\('h3', 'pvp-dlg-h', 'About ' \+ p\.name\),\s*details\(p\),\s*el\('h3', 'pvp-dlg-h', 'How to connect \(' \+ METHOD\[p\.method \|\| 'key'\] \+ '\)'\),\s*howTo\(p\),?\s*\);)/;
  if (!reDlg.test(h)) throw new Error('anchor missing: dialog body append');
  h = h.replace(reDlg, (m) => m + "\n    if ((p.method || 'key') === 'plan') b.append(el('h3', 'pvp-dlg-h', 'Account and usage'), claudePanel());");
  sub('  /* ---------- details dialog', String.raw`  function fmtTok(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); }
  function claudePanel() {
    var box = el('div', 'pvp-claude');
    var acct = el('dl', 'pvp-facts'), use = el('div', 'pvp-usage'), sw = el('div', 'pvp-switch');
    box.append(acct, use, sw);
    function render(info) {
      acct.textContent = ''; use.textContent = '';
      if (!info) { acct.append(el('dt', 'Account'), el('dd', 'Only the owner can see this.')); return; }
      var a = info.account || {};
      fact(acct, 'Signed in', a.loggedIn ? 'Yes' : 'No: run claude auth login');
      fact(acct, 'Email', a.email); fact(acct, 'Organization', a.org); fact(acct, 'Plan', a.plan); fact(acct, 'Method', a.method);
      if (a.expiresAt) { var d = new Date(a.expiresAt); if (!isNaN(d)) fact(acct, 'Login expires', d.toLocaleString()); }
      var u = info.usage;
      if (!u) { use.append(el('p', 'pvp-note', 'Counting tokens from Claude Code’s session logs…')); return; }
      var t = el('table', 'pvp-agents'); var hd = t.createTHead().insertRow();
      ['Tokens used', 'Input', 'Output', 'Cache write', 'Cache read'].forEach(function (x) { var th = document.createElement('th'); th.scope = 'col'; th.textContent = x; hd.append(th); });
      var tb = t.createTBody();
      [['Last 5 hours', 'last5h'], ['Today', 'today'], ['Last 7 days', 'last7d']].forEach(function (r) {
        var w = u.windows[r[1]]; var tr = tb.insertRow();
        [r[0], fmtTok(w.input), fmtTok(w.output), fmtTok(w.cacheWrite), fmtTok(w.cacheRead)].forEach(function (x) { tr.insertCell().textContent = x; });
      });
      var wrap = el('div'); wrap.style.overflowX = 'auto'; wrap.append(t); use.append(wrap);
      if ((u.models || []).length) { var ml = el('p', 'pvp-note', 'Last 7 days by model: ' + u.models.slice(0, 5).map(function (m) { return m.model + ' ' + fmtTok(m.input + m.output + m.cacheWrite); }).join(' · ')); use.append(ml); }
      use.append(el('p', 'pvp-note', 'Measured from this computer’s Claude Code session logs (token counts only, every project and session), and approximate. Your plan’s own limit percentage is shown only inside Claude Code by /usage; it cannot be read from here.' + (info.computing ? ' Updating…' : '')));
    }
    function refresh() { api('/api/ejad/claude').then(function (i) { state.claude = i; render(i); if (i.computing || !i.usage) setTimeout(refresh, 6000); }).catch(function () { render(null); }); }
    render(state.claude); refresh();
    sw.append(el('h4', 'Switch account'), el('p', 'pvp-note', 'Every Claude job of the fleet (planner, designer, final review, the claude implementer) and any open Claude Code window uses the account signed in on this computer. Switching changes it for all of them.'));
    var row = el('div', 'pvp-row'); var em = el('input'); em.type = 'email'; em.placeholder = 'Email (optional)'; em.autocomplete = 'off'; em.setAttribute('aria-label', 'Email of the account to sign in with');
    var go = el('button', 'btn btn-sm btn-primary', 'Sign in with another account'); go.type = 'button';
    go.onclick = async function () {
      if (!confirm('Open the Claude sign-in on this computer? Finish it in the browser window that opens. This changes the account for every Claude job on this computer.')) return;
      go.disabled = true; var x = await ejadPost({ action: 'ejad_claude_login', email: em.value.trim() }); go.disabled = false;
      toast(x.ok ? x.j.note : (x.j.error || 'Could not start the sign-in'), !x.ok);
      if (x.ok) { var n = 0; var t = setInterval(function () { refresh(); if (++n > 36) clearInterval(t); }, 5000); }
    };
    row.append(em, go); sw.append(row);
    return box;
  }

  /* ---------- details dialog`);
  fs.writeFileSync(H, h);
}
console.log('claude account patch applied');

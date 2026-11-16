// Patches worker-fleet's dashboard (server + page) for Workerov: mockup tab and permission requests.
const fs = require('fs');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');

must(s, '"decision": read_file_safe(tdir / "user-decision.md"),');
if (!s.includes('"mockup": wv_mockup_path')) {
  s = s.replace('"decision": read_file_safe(tdir / "user-decision.md"),',
    '"decision": read_file_safe(tdir / "user-decision.md"),\n                "mockup": wv_mockup_path(tdir) is not None,');
}

const cspLine = `EVIDENCE_CSP = "default-src 'none'; sandbox"`;
must(s, cspLine);
if (!s.includes('def wv_mockup_path')) {
  s = s.replace(cspLine, `${cspLine}

# Workerov: interactive ticket mockups (scripts run in an opaque-origin sandbox, no network) and
# permission requests from the OpenCode approvals plugin (job/permissions/<id>.json).
MOCKUP_CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
              "font-src data:; frame-ancestors 'self'; sandbox allow-scripts")
PERMISSION_ID_RE = re.compile(r"^[a-z0-9-]{8,64}$")


def wv_mockup_path(tdir):
    """The ticket's mockup.html: the main checkout's copy, else the newest one in a worker worktree."""
    cands = [Path(tdir) / "mockup.html"]
    cands += [Path(p) for p in glob.glob(str(REPO_ROOT / ".claude" / "worktrees" / "*" / "specs" / "tickets" / Path(tdir).name / "mockup.html"))]
    found = [c for c in cands if c.is_file()]
    return max(found, key=lambda c: c.stat().st_mtime) if found else None


def wv_permissions():
    pdir = REPO_ROOT / "job" / "permissions"
    rows = []
    for f in (sorted(pdir.glob("*.json")) if pdir.is_dir() else []):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("status") == "pending":
            rows.append({k: d.get(k) for k in ("id", "agent", "action", "resources", "cwd", "createdAt")})
    return rows`);
}

const ticketRoute = '        if path.startswith("/api/ticket/"):';
must(s, ticketRoute);
if (!s.includes('"/api/mockup/"')) {
  s = s.replace(ticketRoute, `        if path == "/api/permissions":
            self._send_json(200, {"requests": wv_permissions()})
            return

        if path.startswith("/api/mockup/"):
            tid = path.split("/api/mockup/")[1].split("/")[0].strip()
            tdir = resolve_ticket_dir(tid) if is_valid_ticket_id(tid) else None
            mp = wv_mockup_path(tdir) if tdir else None
            if not mp:
                self._send_json(404, {"error": "No mockup.html for this ticket"})
                return
            body = mp.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", MOCKUP_CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

${ticketRoute}`);
}

const resetAction = '            elif action == "reset_telemetry":';
must(s, resetAction);
if (!s.includes('"decide_permission"')) {
  s = s.replace(resetAction, `            elif action == "decide_permission":
                pid = str(req.get("id", "")).strip()
                verdict = str(req.get("decision", "")).strip().lower()
                pfile = REPO_ROOT / "job" / "permissions" / f"{pid}.json"
                if not PERMISSION_ID_RE.match(pid) or verdict not in ("allow", "deny") or not pfile.is_file():
                    self._audit_action(req, "error:400")
                    self._send_json(400, {"error": "Invalid permission id or decision (allow|deny)."})
                    return
                d = json.loads(pfile.read_text(encoding="utf-8"))
                d.update({"status": verdict, "decidedAt": utc_now_iso()})
                pfile.write_text(json.dumps(d, indent=2) + "\\n", encoding="utf-8")
                self._audit_action(req, "ok")
                self._send_json(200, {"ok": True, "id": pid, "decision": verdict})
                return

${resetAction}`);
}
if (!/^import re\b/m.test(s) && !/^import [^\n]*\bre\b/m.test(s)) s = s.replace(/^import /m, 'import re\nimport ');
fs.writeFileSync(S, s);

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('dtab-mockup')) {
  const tabBtn = '      <button type="button" class="d-tab-btn" role="tab" id="dtab-eval"';
  must(h, tabBtn);
  h = h.replace(tabBtn, '      <button type="button" class="d-tab-btn" role="tab" id="dtab-mockup" data-dtab="mockup" aria-selected="false" aria-controls="d-tab-content-mockup" tabindex="-1">Mockup</button>\n' + tabBtn);
  const evalPanel = '      <div id="d-tab-content-eval" class="d-tab-content"';
  must(h, evalPanel);
  h = h.replace(evalPanel, `      <div id="d-tab-content-mockup" class="d-tab-content" role="tabpanel" aria-labelledby="dtab-mockup" style="display:none;">
        <p id="d-mockup-note" class="md">No mockup.html for this ticket yet.</p>
        <p><a id="d-mockup-open" class="btn" target="_blank" rel="noopener" hidden>Open the mockup in a new tab</a> <button type="button" class="btn" id="d-mockup-reload" hidden>Reload</button></p>
        <iframe id="d-mockup-frame" title="Ticket mockup" sandbox="allow-scripts" style="width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff" hidden></iframe>
      </div>
${evalPanel}`);
  const calls = '        <div id="attention-list" tabindex="-1">';
  must(h, calls);
  h = h.replace(calls, '        <div id="perm-list" aria-live="polite"></div>\n' + calls);
  const fill = "        renderMarkdown($('#d-text-eval'), data.eval || 'No eval.md file found.');";
  must(h, fill);
  h = h.replace(fill, fill + '\n        wvShowMockup(ticketId, !!data.mockup);');
  const idx = h.lastIndexOf('</script>');
  h = h.slice(0, idx) + `
    // ===== Workerov: mockup tab and permission requests =====
    function wvShowMockup(tid, has) {
      const url = '/api/mockup/' + encodeURIComponent(tid);
      const frame = $('#d-mockup-frame'), open = $('#d-mockup-open'), rel = $('#d-mockup-reload'), note = $('#d-mockup-note');
      frame.hidden = open.hidden = rel.hidden = !has; note.hidden = has;
      if (has) { frame.src = url + '?t=' + Date.now(); open.href = url; rel.onclick = () => { frame.src = url + '?t=' + Date.now(); }; }
      else { frame.removeAttribute('src'); }
    }
    async function wvPollPermissions() {
      try {
        const res = await fetch('/api/permissions', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const { requests } = await res.json();
        const box = $('#perm-list');
        box.textContent = '';
        (requests || []).forEach(r => {
          const row = document.createElement('div'); row.className = 'callout';
          const head = document.createElement('div'); head.className = 'head';
          head.textContent = 'Permission: ' + (r.agent || 'agent') + ' wants ' + r.action;
          const q = document.createElement('pre'); q.className = 'git-log';
          q.textContent = (r.resources || []).join('\\n') + (r.cwd ? '\\n(in ' + r.cwd + ')' : '');
          const bar = document.createElement('div');
          ['allow', 'deny'].forEach(dec => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (dec === 'allow' ? ' primary' : '');
            b.textContent = dec === 'allow' ? 'Allow' : 'Deny';
            b.onclick = async () => {
              if (!getStoredToken()) { openAuthModal(); return; }
              b.disabled = true;
              const res = await fetch('/api/action', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ action: 'decide_permission', id: r.id, decision: dec }) });
              if (res.status === 401) { dropRejectedToken(res); openAuthModal(); b.disabled = false; return; }
              if (!res.ok) { b.disabled = false; announce('Could not save the decision (HTTP ' + res.status + ').'); return; }
              wvPollPermissions();
            };
            bar.append(b, ' ');
          });
          row.append(head, q, bar); box.append(row);
        });
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    wvPollPermissions(); setInterval(wvPollPermissions, 2000);
` + h.slice(idx);
}
fs.writeFileSync(H, h);
console.log('patched');

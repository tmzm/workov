// Ejad: a read-only link next to the full-access link (apply after ejad-dashboard-roster.cjs).
//  - job/dashboard-auth.json gets a second secret, viewerToken. It is accepted everywhere the full token is (sign-in,
//    cookie, Bearer), but the server refuses every POST from it (403), so the visitor can look and cannot change anything.
//  - only the owner (full token, or this computer) is told the viewer token; it is masked in logs like the full token.
//  - System panel > Share: "Full access link", "Read-only link", "Reset read-only link" (a new token; old links stop working).
//  - a visitor on the read-only link sees a banner, disabled buttons and no share buttons.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };

let s = rd(S);
if (!s.includes('def get_viewer_token')) {
  const sub = (a, b) => { must(s, a); s = s.replace(a, () => b); };
  sub('def get_tunnel_url():', String.raw`def get_viewer_token(create=True):
    """The read-only token in job/dashboard-auth.json (viewerToken), created on first use."""
    auth_file = REPO_ROOT / "job" / "dashboard-auth.json"
    try:
        data = json.loads(auth_file.read_text(encoding="utf-8"))
    except Exception:
        return ""
    tok = str(data.get("viewerToken", "")).strip()
    if tok or not create or not data.get("authToken"):
        return tok
    tok = secrets.token_hex(16)
    data["viewerToken"] = tok
    ejad_atomic_write(auth_file, json.dumps(data, indent=2) + "\n")
    return tok


def ejad_rotate_viewer():
    auth_file = REPO_ROOT / "job" / "dashboard-auth.json"
    data = json.loads(auth_file.read_text(encoding="utf-8"))
    data["viewerToken"] = secrets.token_hex(16)
    ejad_atomic_write(auth_file, json.dumps(data, indent=2) + "\n")
    return 200, {"ok": True, "note": "Old read-only links no longer work."}


def get_tunnel_url():`);
  sub('        found.append(token)\n', '        found.append(token)\n        found.append(get_viewer_token(False))\n');
  sub(`        expected = get_auth_token()
        if not expected:
            return True
        return hmac.compare_digest(presented, expected)
`, `        expected = get_auth_token()
        if not expected:
            return True
        if hmac.compare_digest(presented, expected):
            return True
        viewer = get_viewer_token()
        return bool(viewer) and hmac.compare_digest(presented, viewer)

    def _is_viewer(self) -> bool:
        """True when the request presented the read-only token (and not the full one)."""
        presented = self._presented_token()
        expected = get_auth_token()
        if not presented or not expected or hmac.compare_digest(presented, expected):
            return False
        viewer = get_viewer_token()
        return bool(viewer) and hmac.compare_digest(presented, viewer)
`);
  sub(`    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
`, `    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if self._is_viewer():
            self._send_json(403, {"error": "This is a read-only link: it can look but not change anything."})
            return
`);
  sub('                "authenticated": self._is_authenticated(),\n', '                "authenticated": self._is_authenticated(),\n                "role": "viewer" if self._is_viewer() else "owner",\n');
  // the viewer token is a masked secret in every JSON response, so the owner gets it from a raw owner-only endpoint
  sub('        if path == "/api/ejad/logo":', String.raw`        if path == "/api/share":
            if self._is_viewer():
                self._send_json(403, {"error": "This is a read-only link."})
                return
            body = json.dumps({"viewerToken": get_viewer_token()}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/ejad/logo":`);
  sub('EJAD_ACTIONS = ("ejad_set_planner",', 'EJAD_ACTIONS = ("ejad_rotate_viewer", "ejad_set_planner",');
  sub('    if action == "ejad_set_planner":', '    if action == "ejad_rotate_viewer":\n        return ejad_rotate_viewer()\n    if action == "ejad_set_planner":');
  fs.writeFileSync(S, s);
}

let h = rd(H);
if (!h.includes('id="ejad-share-js"')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("return !!(stateData && stateData.authenticated === true && getStoredToken());", "return !!(stateData && stateData.authenticated === true && stateData.role !== 'viewer' && getStoredToken());");
  sub("      const copyBtn = document.getElementById('copy-url-btn');\n      if (copyBtn) {", "      if (window.ejadApplyRole) ejadApplyRole();\n      const copyBtn = document.getElementById('copy-url-btn');\n      if (copyBtn) {");
  sub('    <div class="sys-theme">', `    <div class="sys-share">
      <div class="theme-head"><span class="stat-label" id="share-label">Share</span></div>
      <span class="theme-sub" id="share-sub">A link signs the visitor in when they open it.</span>
      <div class="seg" role="group" aria-labelledby="share-label share-sub">
        <button type="button" class="btn" id="copy-full-btn"><svg class="i" aria-hidden="true"><use href="#i-copy"/></svg>Full access</button>
        <button type="button" class="btn" id="copy-view-btn"><svg class="i" aria-hidden="true"><use href="#i-copy"/></svg>Read-only</button>
      </div>
      <button type="button" class="btn btn-sm" id="rotate-view-btn" style="margin-top:6px">Reset read-only link</button>
    </div>
    <div class="sys-theme">`);
  const CSS = `<style id="ejad-share-css">
.sys-share { display: grid; gap: var(--s2); padding-bottom: var(--s3); margin-bottom: var(--s3); border-bottom: 1px solid var(--line); }
#ejad-viewer-banner { position: sticky; top: 0; z-index: 60; background: var(--lamp-attn); color: var(--text-on-lamp); padding: var(--s2) var(--s4); font-size: var(--fs-small); font-weight: 600; text-align: center; }
[data-role="viewer"] .sys-share, [data-role="viewer"] #copy-url-btn { display: none !important; }
</style>
`;
  must(h, '</head>');
  h = h.replace('</head>', () => CSS + '</head>');
  const JS = `<script id="ejad-share-js">
(function () {
  var viewerTok = '', loadingTok = false;
  function fetchViewerTok() {
    if (loadingTok) return; loadingTok = true;
    fetch('/api/share', { headers: getAuthHeaders() }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { viewerTok = j.viewerToken || ''; }).catch(function () { /* the button says so */ }).then(function () { loadingTok = false; });
  }
  window.ejadApplyRole = function () {
    var viewer = !!(stateData && stateData.role === 'viewer');
    if (!viewer && !viewerTok) fetchViewerTok();
    document.documentElement.setAttribute('data-role', viewer ? 'viewer' : 'owner');
    var b = document.getElementById('ejad-viewer-banner');
    if (viewer && !b) {
      b = document.createElement('div'); b.id = 'ejad-viewer-banner'; b.setAttribute('role', 'status');
      b.textContent = 'Read-only link: you can look at everything but cannot change anything.';
      document.body.prepend(b);
    }
    if (b) b.hidden = !viewer;
  };
  function link(kind) {
    var base = (stateData && typeof stateData.tunnelUrl === 'string' && stateData.tunnelUrl) ? stateData.tunnelUrl : window.location.href;
    var url; try { url = new URL(base, window.location.href); } catch (e) { url = new URL(window.location.href); }
    url.searchParams.delete('token'); url.hash = '';
    var tok = kind === 'view' ? viewerTok : getStoredToken();
    if (typeof tok !== 'string' || !tok) return null;
    url.searchParams.set('token', tok);
    return url.toString();
  }
  function copy(text, ok) {
    var fail = function () { showToast('This browser blocked clipboard access, so nothing was copied. Open the dashboard over HTTPS or on localhost.', 'bad'); };
    var fb = function () {
      var done = false;
      try { var ta = document.createElement('textarea'); ta.setAttribute('aria-hidden', 'true'); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; ta.value = text; document.body.append(ta); ta.select(); done = document.execCommand('copy'); ta.remove(); } catch (e) { done = false; }
      if (done) showToast(ok); else fail();
    };
    try { var p = navigator.clipboard && navigator.clipboard.writeText(text); if (p && p.then) p.then(function () { showToast(ok); }, fb); else fb(); } catch (e) { fb(); }
  }
  var full = document.getElementById('copy-full-btn'), view = document.getElementById('copy-view-btn'), rot = document.getElementById('rotate-view-btn');
  if (full) full.onclick = function () {
    var u = link('full'); if (!u) { showToast('Sign in first: this browser has no access token to put in the link.', 'bad'); return; }
    copy(u, 'Full-access link copied. Anyone who opens it can change things.');
  };
  if (view) view.onclick = function () {
    var u = link('view'); if (!u) { showToast('The read-only link is not available yet. Wait a second and try again.', 'bad'); return; }
    copy(u, 'Read-only link copied. Anyone who opens it can look but not change anything.');
  };
  if (rot) rot.onclick = async function () {
    if (!confirm('Reset the read-only link? Every read-only link already shared stops working.')) return;
    var x = await ejadPost({ action: 'ejad_rotate_viewer' });
    showToast(x.ok ? 'Read-only link reset. Copy the new one.' : (x.j.error || 'Could not reset'), x.ok ? undefined : 'bad');
    if (x.ok) { viewerTok = ''; fetchViewerTok(); }
  };
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('readonly patch applied');

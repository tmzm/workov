// Workov: the Office, a 3D view of the fleet. Every ticket stage is a room, every agent a person at a desk.
//  - the dashboard server serves the page and its assets (Three.js, the models) from .claude/dashboard/office/ under
//    GET /api/office/<file>, behind the same auth as every other /api route and with its own CSP (the page needs
//    module scripts and workers that the app page's CSP forbids).
//  - an "Office" entry under More opens it in a frame. The frame is only loaded while the tab is open, so the
//    3D scene never runs in the background.
//  - the page reads /api/wv/projects, /api/state, /api/wv/router, /api/wv/steps and /api/agent-roster, and falls
//    back to a sample simulation when they do not answer (page opened on its own).
// Apply after dashboard-nav-chat (it needs the More menu).
const fs = require('fs');
const path = require('path');

// 1. assets
const SRC = path.join(__dirname, 'office'), DST = '.claude/dashboard/office';
fs.mkdirSync(DST, { recursive: true });
fs.cpSync(SRC, DST, { recursive: true });
console.log('office: assets copied to ' + DST);

// 2. server route
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };
const FN = String.raw`
WV_OFFICE_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                   ".glb": "model/gltf-binary", ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json"}
WV_OFFICE_CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                 "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:; "
                 "object-src 'none'; base-uri 'none'; frame-ancestors 'self'")


def wv_office_serve(handler, req_path):
    """Static files of the Office page. Only files under .claude/dashboard/office, nothing outside it."""
    root = (REPO_ROOT / ".claude" / "dashboard" / "office").resolve()
    rel = urllib.parse.unquote(req_path[len("/api/office/"):]) or "index.html"
    target = (root / rel).resolve()
    if root != target and root not in target.parents or not target.is_file():
        handler._send_json(404, {"error": "not found"})
        return
    ctype = WV_OFFICE_TYPES.get(target.suffix.lower())
    if not ctype:
        handler._send_json(404, {"error": "not found"})
        return
    data = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Content-Security-Policy", WV_OFFICE_CSP)
    handler.end_headers()
    handler.wfile.write(data)

`;
if (!s.includes('def wv_office_serve')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const a = '        if path == "/api/logs":';
  must(a);
  s = s.replace(a, () => '        if path.startswith("/api/office/"):\n            wv_office_serve(self, path)\n            return\n\n' + a);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: /api/office/');

// 3. the tab
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const fail = (m) => { throw new Error('anchor missing: ' + m); };
if (!h.includes('id="tab-office"')) {
  if (!h.includes('id="views-more"')) fail('views-more (apply dashboard-nav-chat first)');
  const btn = '<button type="button" class="tab-btn" data-tab="office"><svg class="i" aria-hidden="true"><use href="#i-office"/></svg><span class="lbl">Office</span></button>';
  h = h.replace(/(<div id="views-more"[^>]*>[\s\S]*?)(\n?\s*<\/div>)/, (m, a, b) => a + '\n' + btn + b);
  if (!/<symbol id="i-audit"/.test(h)) fail('i-audit symbol');
  h = h.replace(/<symbol id="i-audit"/, () => '<symbol id="i-office" viewBox="0 0 24 24"><path d="M4 21V5l8-2v18M12 8h8v13M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2M3 21h18"/></symbol>\n  <symbol id="i-audit"');
  h = h.replace(/(const VIEW_HASH = \{)/, '$1\n        office: \'office\',').replace(/(const HASH_VIEW = \{)/, '$1\n        office: \'office\',');
  if (!h.includes("office: 'office'")) fail('VIEW_HASH');
  if (!/<section id="tab-ports"/.test(h)) fail('tab-ports');
  h = h.replace(/<section id="tab-ports"/, () => `<section id="tab-office" class="tab-content" aria-labelledby="h-office"><h1 id="h-office" class="sr-only">Office</h1>
<iframe id="office-frame" class="office-frame" title="The Workov office" allow="fullscreen"></iframe></section>
<section id="tab-ports"`);
  h = h.replace('</head>', () => '<style id="wv-office-css">\n.office-frame { display: block; width: 100%; height: calc(100vh - 150px); min-height: 420px; border: 0; border-radius: var(--r-panel, 8px); background: var(--surface-1); }\n@media (max-width: 767px) { .office-frame { height: calc(100vh - 130px); } }\n</style>\n</head>');
  const JS = `<script id="wv-office-js">
(function () {
  var frame = document.getElementById('office-frame'); if (!frame) return;
  var base = window.wvNavSync;
  window.wvNavSync = function (tab) {
    if (base) base(tab);
    var token = new URLSearchParams(location.search).get('token');
    if (tab === 'office') { if (!frame.getAttribute('src')) frame.src = '/api/office/index.html' + (token ? '?token=' + encodeURIComponent(token) : ''); }
    else if (frame.getAttribute('src')) frame.removeAttribute('src');
  };
})();
</script>
`;
  const i = h.lastIndexOf('</body>');
  h = h.slice(0, i) + JS + h.slice(i);
  fs.writeFileSync(H, h);
}
console.log('index.html: office tab');

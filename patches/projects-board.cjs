// Workerov: one board for every project on the computer.
//  - dashboard-server.py: GET /api/wv/projects merges the tickets of every registered fleet (~/.workerov/fleets.json) and says
//    which one has a worker alive; a thread also starts the router loop of every other registered project that has
//    work, so this one dashboard drives them all.
//  - index.html: an "All projects" tab (next to Board) that lists them. Only one worker runs at a time across projects
//    (router-loop.sh holds back new dispatches while another project's worker is alive).
// Idempotent. Apply after the dashboard patches.
const fs = require('fs');
const path = require('path');

// ---- server ----
{
  const F = '.claude/scripts/dashboard-server.py';
  let s = fs.readFileSync(F, 'utf8');
  if (!s.includes('def wv_projects()')) {
    const crlf = s.includes('\r\n');
    s = s.replace(/\r\n/g, '\n');
    const code = fs.readFileSync(path.join(__dirname, 'projects-board.server.py.txt'), 'utf8').replace(/\r\n/g, '\n');
    const a = 'def wv_wanted():';
    if (!s.includes(a)) throw new Error('anchor missing: def wv_wanted');
    s = s.replace(a, code + a);
    const r = '        if path == "/api/wv/overview":';
    if (!s.includes(r)) throw new Error('anchor missing: /api/wv/overview route');
    s = s.replace(r, '        if path == "/api/wv/projects":\n            self._send_json(200, wv_projects())\n            return\n\n' + r);
    fs.writeFileSync(F, crlf ? s.replace(/\n/g, '\r\n') : s);
    console.log('projects board: server patched');
  }
}

// ---- dashboard page ----
{
  const H = '.claude/dashboard/index.html';
  let h = fs.readFileSync(H, 'utf8');
  const crlf = h.includes('\r\n');
  h = h.replace(/\r\n/g, '\n');
  if (!h.includes('id="tab-projects"')) {
    const full = fs.readFileSync(path.join(__dirname, 'projects-board.section.html'), 'utf8').replace(/\r\n/g, '\n');
    const cut = full.indexOf('      <script>');
    const section = full.slice(0, cut);
    const script = full.slice(cut).trimEnd() + '\n';
    // 1. the tab button, right after Board
    const btn = /(<button[^>]*data-tab="kanban"[\s\S]*?<\/button\s*>)/.exec(h);
    if (!btn) throw new Error('anchor missing: Board tab button');
    h = h.replace(btn[1], btn[1] + '\n          <button type="button" class="tab-btn" data-tab="projects">\n            <svg class="i" aria-hidden="true"><use href="#i-board" /></svg\n            ><span class="lbl">All projects</span>\n          </button>');
    // 2. the panel, before Audit
    if (!h.includes('      <!-- Audit -->')) throw new Error('anchor missing: Audit panel');
    h = h.replace('      <!-- Audit -->', section + '      <!-- Audit -->');
    // 3. hash maps, so the tab keeps a URL
    for (const name of ['VIEW_HASH', 'HASH_VIEW']) {
      const k = `const ${name} = {\n        chat: 'chat',`;
      if (!h.includes(k)) throw new Error('anchor missing: ' + name);
      h = h.replace(k, k + "\n        projects: 'projects',");
    }
    // 4. the script, last, so it wraps the final wvNavSync
    const i = h.lastIndexOf('</body>');
    if (i < 0) throw new Error('anchor missing: </body>');
    h = h.slice(0, i) + script + h.slice(i);
    fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
    console.log('projects board: dashboard page patched');
  }
}

#!/usr/bin/env node
// ejad-land.cjs — token-free delivery for worker-fleet tickets at Ejad (GitLab MR + Plane + Ejad HR).
//   node .claude/scripts/ejad-land.cjs land <NNN> <branch> [--dry-run]
//   node .claude/scripts/ejad-land.cjs status <branch>          -> prints opened | merged | closed | none
// Ticket folder specs/tickets/NNN-*/: rd.md must carry "**Plane:** <IDENT>-<n>" (and may carry
// "**Ejad HR task:** <uuid>"). Optional delivery pack in <ticket>/delivery/: mr-title.txt, mr.md
// (screenshots as ![caption](screens/NN-name.png)), tracker.md, screens/*.png. Without it, the title
// comes from rd.md's first heading and the body from results.md.
// Secrets come only from the environment (or Windows user env vars): PLANE_API_KEY, HR_EMAIL, HR_PASS;
// the GitLab token from `glab config get token --host <host>`. Nothing secret is printed or written.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Per-person settings: ~/.claude/ejadtask.json (see profile.example.json in ejad-fleet).
const PROFILE = (() => {
  const file = process.env.EJADTASK_PROFILE || path.join(require('node:os').homedir(), '.claude', 'ejadtask.json');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}: copy profile.example.json from ejad-fleet and fill it in`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();
const ME = { gitlab: PROFILE.gitlabUserId, hr: PROFILE.ejadHrEmployeeId };
const REVIEWER = () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = (PROFILE.reviewers || []).find((x) => !x.until || today <= x.until);
  return r ? r.gitlabUserId : null;
};
const PLANE = { base: `${(PROFILE.planeBaseUrl || 'https://plane.ejad.net').replace(/\/$/, '')}/api/v1`, ws: PROFILE.planeWorkspace || 'ejad' };
const HR = PROFILE.ejadHrApi || 'https://hr.ejad.net/api/v1';
const [mode, a1, a2] = process.argv.slice(2);
const DRY = process.argv.includes('--dry-run');

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
function env(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return '';
  try {
    return sh('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`]);
  } catch {
    return '';
  }
}
function gitlab() {
  const url = sh('git', ['remote', 'get-url', 'origin']);
  const m = /^(?:git@([^:]+):|https?:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error('cannot parse origin remote');
  const host = m[1] || m[2];
  const token = sh('glab', ['config', 'get', 'token', '--host', host]);
  if (!token) throw new Error(`no glab token for ${host}`);
  return { api: `https://${host}/api/v4/projects/${encodeURIComponent(m[3])}`, token };
}
async function req(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(/\?.*/, '')} -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const json = (method, headers, body) => ({ method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const log = (...a) => console.log(...a);
const write = async (label, fn) => (DRY ? log('[dry-run]', label) : (await fn(), log('ok', label)));

async function mrFor(gl, branch) {
  const list = await req(`${gl.api}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at`, { headers: { 'PRIVATE-TOKEN': gl.token } });
  return list.find((m) => m.state === 'opened') || list[0] || null;
}

function ticket(nnn) {
  const dir = fs.readdirSync('specs/tickets').find((d) => d.startsWith(`${nnn}-`));
  if (!dir) throw new Error(`ticket ${nnn} not found in specs/tickets`);
  const root = path.join('specs/tickets', dir);
  // The delivery pack is not committed: look in the main checkout, then in the worker worktrees.
  const packs = [root, ...(fs.existsSync('.claude/worktrees') ? fs.readdirSync('.claude/worktrees').map((w) => path.join('.claude/worktrees', w, root)) : [])];
  const packRoot = packs.find((r) => fs.existsSync(path.join(r, 'delivery'))) || root;
  const read = (f) => {
    const base = f.startsWith('delivery/') ? packRoot : root;
    return fs.existsSync(path.join(base, f)) ? fs.readFileSync(path.join(base, f), 'utf8') : '';
  };
  const rd = read('rd.md');
  const plane = (/\*\*Plane:\*\*\s*([A-Z][A-Z0-9]*-\d+)/.exec(rd) || [])[1];
  if (!plane) throw new Error(`rd.md of ${dir} has no "**Plane:** <IDENT>-<n>" line`);
  return {
    root, packRoot, screenDir: path.join(packRoot, 'delivery'), plane,
    hrTask: (/\*\*Ejad HR task:\*\*\s*([0-9a-f-]{36})/.exec(rd) || [])[1] || null,
    title: read('delivery/mr-title.txt').trim() || `feat: ${((/^#\s+(.+)$/m.exec(rd) || [])[1] || dir).trim()}`,
    body: read('delivery/mr.md') || read('results.md') || `Ticket ${dir}.`,
    tracker: read('delivery/tracker.md').trim() || `Delivered ticket ${dir}.`,
    screens: fs.existsSync(path.join(packRoot, 'delivery/screens')) ? fs.readdirSync(path.join(packRoot, 'delivery/screens')).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [],
  };
}

async function uploadScreens(gl, t, body) {
  for (const f of t.screens) {
    const ref = `screens/${f}`;
    if (!body.includes(ref)) continue;
    if (DRY) { log('[dry-run] upload', ref); continue; }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(t.screenDir, ref))]), f);
    const up = await req(`${gl.api}/uploads`, { method: 'POST', headers: { 'PRIVATE-TOKEN': gl.token }, body: form });
    body = body.split(ref).join(up.url);
    log('ok upload', f);
  }
  return body;
}

async function plane(t, mrUrl) {
  const key = env('PLANE_API_KEY');
  if (!key) return log('skip Plane: PLANE_API_KEY not set');
  const H = { 'X-API-Key': key };
  const [ident, seq] = t.plane.split('-');
  const projects = await req(`${PLANE.base}/workspaces/${PLANE.ws}/projects/`, { headers: H });
  const project = (projects.results || projects).find((p) => p.identifier === ident);
  if (!project) throw new Error(`Plane project ${ident} not found`);
  const P = `${PLANE.base}/workspaces/${PLANE.ws}/projects/${project.id}`;
  let item = null;
  for (let cursor = ''; !item; ) {
    const page = await req(`${P}/issues/?per_page=100${cursor ? `&cursor=${cursor}` : ''}`, { headers: H });
    item = (page.results || []).find((i) => String(i.sequence_id) === seq) || null;
    if (item || !page.next_page_results) break;
    cursor = page.next_cursor;
  }
  if (!item) throw new Error(`Plane item ${t.plane} not found`);
  const states = await req(`${P}/states/`, { headers: H });
  const review = (states.results || states).find((s) => /review/i.test(s.name));
  const html = `<p>${t.tracker.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n+/g, '<br>')}</p><p>MR: <a href="${mrUrl}">${mrUrl}</a></p>`;
  await write(`Plane ${t.plane} comment`, () => req(`${P}/issues/${item.id}/comments/`, json('POST', H, { comment_html: html })));
  if (review && item.state !== review.id) await write(`Plane ${t.plane} -> ${review.name}`, () => req(`${P}/issues/${item.id}/`, json('PATCH', H, { state: review.id })));
}

async function ejadHr(t, mrUrl, title) {
  const email = env('HR_EMAIL');
  const pass = env('HR_PASS');
  if (!email || !pass) return log('skip Ejad HR: HR_EMAIL/HR_PASS not set');
  const login = await req(`${HR}/auth/login`, json('POST', {}, { email, password: pass }));
  const H = { Authorization: `Bearer ${login.accessToken || login.token}` };
  let id = t.hrTask;
  if (!id) {
    const line = `Imported from Plane ${t.plane}`;
    for (let p = 1, projects; !id; p++) {
      projects = await req(`${HR}/projects?limit=100&page=${p}`, { headers: H });
      for (const pr of projects.items || []) {
        for (let q = 1; !id; q++) {
          const tasks = await req(`${HR}/projects/${pr.id}/tasks?limit=100&page=${q}`, { headers: H });
          id = ((tasks.items || []).find((x) => (x.description || '').includes(line)) || {}).id || null;
          if (q >= (tasks.meta?.pages ?? 1)) break;
        }
        if (id) break;
      }
      if (p >= (projects.meta?.pages ?? 1)) break;
    }
  }
  if (!id) return log(`skip Ejad HR: no task mirrors ${t.plane}`);
  await write('Ejad HR -> REVIEW', () => req(`${HR}/tasks/${id}`, json('PATCH', H, { status: 'REVIEW', assigneeId: ME.hr })));
  await write('Ejad HR MR link', () => req(`${HR}/tasks/${id}/links`, json('POST', H, { url: mrUrl, label: title.slice(0, 80) })));
  await write('Ejad HR comment', () => req(`${HR}/tasks/${id}/comments`, json('POST', H, { body: `${t.tracker}\nMR: ${mrUrl}`.slice(0, 4000) })));
}

// A headless delivery pack (.delivery/<task>/, from /ejadtask): same shape as a ticket's delivery folder.
function pack(dir, planeId) {
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const sdir = path.join(dir, 'screens');
  return {
    root: dir, screenDir: dir, plane: planeId, hrTask: null,
    title: read('mr-title.txt').trim(), body: read('mr.md'), tracker: read('tracker.md').trim(),
    screens: fs.existsSync(sdir) ? fs.readdirSync(sdir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [],
  };
}

// Push and open or update the MR. draft=true (the fleet's merger): nothing is marked delivered yet;
// Claude's review then runs `deliver`, which marks it ready and moves Plane and Ejad HR.
async function openMr(t, branch, draft) {
  if (!t.title || !t.body) throw new Error('the delivery pack has no mr-title.txt or mr.md');
  const gl = gitlab();
  await write(`git push origin ${branch}`, () => sh('git', ['push', 'origin', branch]));
  const body = await uploadScreens(gl, t, t.body);
  const reviewer = REVIEWER();
  const fields = { title: t.title, description: body, assignee_ids: [ME.gitlab], reviewer_ids: reviewer ? [reviewer] : [], remove_source_branch: false };
  let mr = await mrFor(gl, branch);
  if (mr && mr.state === 'opened') {
    await write(`update MR !${mr.iid}${draft ? ' (draft)' : ' (ready)'}`, async () => (mr = await req(`${gl.api}/merge_requests/${mr.iid}`, json('PUT', { 'PRIVATE-TOKEN': gl.token }, { ...fields, draft }))));
  } else {
    await write(`create MR${draft ? ' (draft)' : ''}`, async () => (mr = await req(`${gl.api}/merge_requests`, json('POST', { 'PRIVATE-TOKEN': gl.token }, { ...fields, draft, source_branch: branch, target_branch: 'main' }))));
  }
  return mr?.web_url || '(dry-run MR url)';
}

async function land(nnn, branch) {
  const url = await openMr(ticket(nnn), branch, true);
  log(`MR_URL ${url}`);
}

async function deliver(t, branch) {
  const url = await openMr(t, branch, false);
  await plane(t, url);
  await ejadHr(t, url, t.title);
  log(`MR_URL ${url}`);
}

(async () => {
  const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  if (mode === 'land' && a1 && a2) return land(a1, a2);
  if (mode === 'deliver' && a1 && /^\d+$/.test(a1) && a2) return deliver(ticket(a1), a2);
  if (mode === 'deliver' && a1 && opt('--pack') && opt('--plane')) return deliver(pack(opt('--pack'), opt('--plane')), a1);
  if (mode === 'status' && a1) {
    const mr = await mrFor(gitlab(), a1);
    return log(mr ? mr.state : 'none');
  }
  console.error([
    'usage: ejad-land.cjs land <NNN> <branch>                         (fleet merger: push + draft MR)',
    '       ejad-land.cjs deliver <NNN> <branch>                      (after review: MR ready, Plane, Ejad HR)',
    '       ejad-land.cjs deliver <branch> --pack <dir> --plane <ID>  (headless delivery pack)',
    '       ejad-land.cjs status <branch>',
    '       add --dry-run to print the writes without doing them',
  ].join('\n'));
  process.exit(2);
})().catch((e) => {
  console.error(`ejad-land: ${e.message}`);
  process.exit(1);
});

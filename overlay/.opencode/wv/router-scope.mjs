// router-scope.mjs: the one router serves several projects from one session, one project per cycle. This is the guard that
// keeps it inside that project: ~/.workerov/router-project.json names the project of the cycle in progress, and the
// router agent may only change files under its folder and only run shell commands that name that folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
const within = (p, root) => norm(p) === root || norm(p).startsWith(root + '/');
const HARMLESS = /^\s*(date|echo|pwd|sleep)\b/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Returns null when the request is fine (or the guard does not apply), otherwise the reason to deny it.
export function routerScopeDenial(event, cwd = process.cwd(), home = os.homedir()) {
  if (String(event.agent || '') !== 'router') return null;
  const turn = readJson(path.join(home, '.workerov', 'router-project.json'));
  if (!turn || !turn.root) return null;
  const mine = norm(turn.root);
  const tmp = norm(os.tmpdir());
  const action = String(event.action || '');
  const resources = (event.resources || []).map(String);
  const hint = `This cycle belongs to project ${turn.name} (${turn.root}). Use absolute paths under it, and start shell commands with cd "${turn.root}" && .`;
  if (action === 'edit' || action === 'write') {
    for (const r of resources) {
      const abs = path.isAbsolute(r) ? r : path.resolve(cwd, r);
      if (!within(abs, mine) && !within(abs, tmp)) return `Not allowed: ${abs} is outside ${turn.name}. ${hint}`;
    }
    return null;
  }
  if (action === 'shell' || action === 'bash') {
    const others = (readJson(path.join(home, '.workerov', 'fleets.json')) || [])
      .map((f) => norm(f && f.root)).filter((r) => r && r !== mine && !mine.startsWith(r + '/') && !r.startsWith(mine + '/'));
    for (const c of resources) {
      if (HARMLESS.test(c)) continue;
      const text = norm(c);
      if (others.some((o) => text.includes(o))) return `Not allowed: this command names another project. ${hint}`;
      if (!text.includes(mine)) return `Not allowed: the command does not run inside ${turn.name}. ${hint}`;
    }
  }
  return null;
}

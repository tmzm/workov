// The one start screen. It checks everything while it loads, starts the fleet when all is well and goes straight to the
// dashboard in this same window. Only when a required step is missing does it turn into the onboarding list.
'use strict';
const $ = (id) => document.getElementById(id);
const force = /[?&]force=1/.test(location.search);
let busy = false, launching = false, timer = 0;
function h(tag, cls, text, parent) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; }
const PENDING = ['Claude account', 'Git Bash', 'Python 3', 'Node.js', 'OpenCode', 'Fleet folder'];

function pending() {
  const list = $('list'); list.replaceChildren();
  for (const n of PENDING) { const row = h('div', 'step', null, list); h('span', 'mark', '·', row); const i = h('div', 'info', null, row); h('b', null, n, i); }
}
function rows(r) {
  const list = $('list'); list.replaceChildren();
  for (const it of r.items) {
    if (r.ready && !force && it.ok) continue;
    const row = h('div', 'step ' + (it.ok ? 'ok' : 'bad') + (it.id === 'claude' ? ' primary' : ''), null, list); row.setAttribute('role', 'listitem');
    h('span', 'mark', it.ok ? '✓' : it.required ? '!' : '–', row);
    const info = h('div', 'info', null, row), t = h('b', null, it.name, info); if (!it.required) h('span', 'opt', 'optional', t);
    h('span', null, it.ok ? it.detail : it.hint + (it.detail ? ' · ' + it.detail : ''), info);
    if (!it.ok) {
      const label = { 'claude-login': 'Sign in to Claude', link: 'Get it', 'pick-fleet': 'Choose folder' }[it.action];
      const b = h('button', 'btn' + (it.id === 'claude' ? ' primary' : ''), label, row); b.type = 'button';
      b.onclick = async () => {
        if (busy) return; busy = true; b.disabled = true;
        if (it.action === 'claude-login') { $('msg').textContent = 'Finish signing in in your browser…'; await fleetSetup.claudeLogin(); $('msg').textContent = ''; }
        else if (it.action === 'pick-fleet') await fleetSetup.pickFleet(); else await fleetSetup.open(it.link);
        busy = false; check();
      };
    }
  }
}
async function launch() {
  if (launching) return; launching = true; clearInterval(timer);
  $('title').textContent = 'Starting Ejad Fleet'; $('lead').textContent = 'Starting the dashboard, router and phone link…'; $('bar').hidden = false;
  const r = await fleetSetup.launch();
  if (r && r.ok) return; // the window is already moving to the dashboard
  launching = false; $('bar').hidden = true; $('lead').textContent = 'The dashboard did not start in time. Check Python and the fleet folder, then try again.'; $('foot').hidden = false; timer = setInterval(check, 4000);
}
async function check() {
  if (busy || launching) return;
  const r = await fleetSetup.checks(); if (!r) return;
  if (r.ready && !force) { rows(r); return launch(); }
  $('bar').hidden = true; $('foot').hidden = false; rows(r);
  $('title').textContent = r.ready ? 'Setup and checks' : 'Let’s finish setting up';
  $('lead').textContent = r.ready ? 'Everything required is in place.' : r.claude.loggedIn ? 'A required tool is missing. Fix it below and this screen continues by itself.' : 'Claude comes first: the chat, planner and designer run on your Claude account. This screen continues by itself when each step is done.';
  $('go').hidden = !r.ready; if (!timer) timer = setInterval(check, 4000);
}
$('recheck').onclick = check;
$('notify').onclick = () => fleetSetup.testNotification();
$('go').onclick = () => { force ? fleetSetup.launch() : launch(); };
window.addEventListener('focus', check); // coming back from the browser or an installer re-checks by itself
pending(); check();

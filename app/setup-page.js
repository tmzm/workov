'use strict';
const $ = (id) => document.getElementById(id);
let busy = false;
function h(tag, cls, text, parent) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; }
async function render() {
  const r = await fleetSetup.checks(), list = $('list'); list.replaceChildren();
  for (const it of r.items) {
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
        busy = false; render();
      };
    }
  }
  $('go').disabled = !r.ready; $('go').title = r.ready ? '' : 'Finish the required steps first';
}
$('recheck').onclick = render;
$('notify').onclick = () => fleetSetup.testNotification();
$('go').onclick = () => fleetSetup.done();
window.addEventListener('focus', render); // coming back from the browser or an installer re-checks by itself
render();

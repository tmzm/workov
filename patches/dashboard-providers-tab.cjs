// Workerov: Providers becomes a navbar tab (like Graph and Telemetry) and leaves the Board (apply after dashboard-providers-page.cjs).
//  - the full-screen overlay becomes the content of <section id="tab-providers">, reached at #providers
//  - the per-agent model table and the implementer picker (formerly the Board's Providers panel) move into that tab
//  - the Board's Providers panel and the old provider-id + key form are removed (the cards replace them)
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
const sub = (a, b) => { must(a); h = h.replace(a, () => b); };
const cut = (startMark, endMark, endLineToo) => {
  const a = h.indexOf(startMark); if (a < 0) throw new Error('anchor missing: ' + startMark.slice(0, 90));
  let b = h.indexOf(endMark, a); if (b < 0) throw new Error('anchor missing: ' + endMark.slice(0, 90));
  if (endLineToo) { b = h.indexOf('\n', b); }
  else b += endMark.length;
  const ls = h.lastIndexOf('\n', a) + 1;
  h = h.slice(0, ls) + h.slice(b + (endLineToo ? 1 : 0));
};

if (!h.includes('id="tab-providers"')) {
  // 1. the Board loses its Providers panel
  cut('<details id="wv-providers"', '</details>', true);

  // 2. navbar button after Telemetry, plus an icon
  sub('<span class="lbl">Telemetry</span></button>', '<span class="lbl">Telemetry</span></button>\n      <button type="button" class="tab-btn" data-tab="providers"><svg class="i" aria-hidden="true"><use href="#i-plug"/></svg><span class="lbl">Providers</span></button>');
  sub('<symbol id="i-audit"', '<symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4"/></symbol>\n  <symbol id="i-audit"');
  must("audit: 'audit' };"); h = h.split("audit: 'audit' };").join("audit: 'audit', providers: 'providers' };"); // VIEW_HASH and HASH_VIEW
  sub('if (tabId === \'graph\') drawGraphEdges();', "if (tabId === 'graph') drawGraphEdges();\n      if (tabId === 'providers' && window.wvProvidersShown) window.wvProvidersShown();");

  sub('.views { display: grid; grid-template-columns: repeat(6, 1fr);', '.views { display: grid; grid-template-columns: repeat(7, 1fr);'); // seven tabs on a phone
  // 3. overlay -> tab section, with the agents table inside
  sub('<div id="pvp" hidden role="dialog" aria-modal="true" aria-label="Providers"><div class="pvp-wrap">', '<section id="tab-providers" class="tab-content" aria-labelledby="h-providers"><h1 id="h-providers" class="sr-only">Providers</h1>\n<div id="pvp"><div class="pvp-wrap">');
  sub('<button type="button" class="btn btn-sm" id="pvp-close">← Back</button>', '');
  sub('<span class="pvp-sub" id="pvp-sub"></span>', '<span class="pvp-sub" id="pvp-sub"></span>');
  sub('  <div class="pvp-row" style="margin-bottom:10px"><input id="pvp-search"', '  <section class="pvp-plan"><h3>Agents <span class="note-s" id="wv-pv-note"></span></h3><p>Switch the model of each agent, and the implementer.</p><div id="wv-pv-body" style="overflow-x:auto;"></div></section>\n  <div class="pvp-row" style="margin-bottom:10px"><input id="pvp-search"');
  sub('<button type="button" class="btn btn-sm" id="pvp-more" hidden>Show more</button>\n</div></div>', '<button type="button" class="btn btn-sm" id="pvp-more" hidden>Show more</button>\n</div></div></section>');
  sub('#pvp { position: fixed; inset: 0; z-index: 900; background: var(--bg); color: var(--text); overflow-y: auto; font-family: var(--font-ui); }\n#pvp[hidden] { display: none; }', '#pvp { color: var(--text); font-family: var(--font-ui); }');

  // 4. the page script: no overlay, load when the tab is shown
  cut("  function open() { root.hidden = false;", "  if (location.hash === '#providers') open();\n", false);
  sub("(function () {\n  var root = document.getElementById('pvp');", "(function () {\n  var root = document.getElementById('pvp');\n  function open() { var t = document.querySelector('.tab-btn[data-tab=\"providers\"]'); if (t) t.click(); }\n  window.wvOpenProvidersPage = open;\n  window.wvProvidersShown = function () { load(); if (typeof wvLoadProviders === 'function') wvLoadProviders(); };");

  // 5. the old panel's connect-by-name form goes; the banner button opens the tab
  cut("const cf = mk('div'); cf.id = 'wv-connect-form'", "box.append(cl, mk('p', 'Connect as many providers", true);
  cut("document.getElementById('wv-providers').addEventListener('toggle'", "wvLoadProviders(); });", true);
  h = h.replace(/go\.onclick = \(\) => \{ const tab = document\.querySelector\('\.tab-btn\[data-tab="kanban"\]'\);[^\n]*\n/, () => "go.onclick = () => { window.wvOpenProvidersPage(); };\n");
  h = h.replace('You can switch the model below under Providers.', 'Switch the model or connect another provider in the Providers tab.');
  fs.writeFileSync(H, h);
}
console.log('providers tab patch applied');

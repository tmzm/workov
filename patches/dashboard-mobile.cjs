// Workerov: mobile pass over every tab (apply after dashboard-router.cjs). Checked at 390x844 on Board, Ring, Graph,
// Telemetry, Providers, Ports, Audit, the System panel and the Router panel. Findings fixed here:
//  - the Providers and Ports tabs had near-identical icons, and "Telemetry" and "Providers" touched in the bottom bar
//  - the Ring's slot button was an 18px-wide target
//  - 10.8px helper text in the Agents tab
//  - a large empty gap above the Providers page on phones
//  - the old "Phone link" button duplicated the new Share > Full access button
//  - the Router panel's buttons were disabled with no word on why when this browser is not signed in
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 100)); };
if (!h.includes('id="wv-mobile-css"')) {
  const sub = (a, b) => { must(a); h = h.replace(a, () => b); };
  sub('<symbol id="i-audit"', '<symbol id="i-prov" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></symbol>\n  <symbol id="i-audit"');
  sub('<use href="#i-plug"/></svg><span class="lbl">Providers</span>', '<use href="#i-prov"/></svg><span class="lbl">Providers</span>');
  const CSS = `<style id="wv-mobile-css">
#copy-url-btn { display: none !important; } /* replaced by System > Share > Full access */
#pvp .pvp-role small { font-size: var(--fs-small); }
@media (max-width: 767px) {
  .views .tab-btn { padding-inline: 2px; min-width: 0; }
  .views .tab-btn .lbl { font-size: 11.5px; letter-spacing: -0.02em; }
  #pvp .pvp-wrap { padding-top: var(--s2); }
}
@media (pointer: coarse) {
  #tab-ring button[aria-label^="Slot"] { position: relative; }
  #tab-ring button[aria-label^="Slot"]::after { content: ""; position: absolute; inset: 0 -13px; }
}
</style>
`;
  sub('</head>', CSS + '</head>');
  sub("      document.getElementById('rt-restart').disabled = !ok; document.getElementById('rt-dispatch').disabled = !ok;",
    "      document.getElementById('rt-restart').disabled = !ok; document.getElementById('rt-dispatch').disabled = !ok;\n      var si = document.getElementById('rt-signin');\n      if (!si) { si = el('p', 'These buttons need the dashboard PIN: sign in with the Access badge in the System panel.'); si.id = 'rt-signin'; si.className = 'note-s'; document.querySelector('#wv-router .rt-acts').after(si); }\n      si.hidden = ok;");
  fs.writeFileSync(H, h);
}
console.log('mobile patch applied');

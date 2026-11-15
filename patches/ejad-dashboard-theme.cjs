// Ejad: the "Tmzm" theme, the dashboard in the colours of tareqmozayek.com (gold on ink, vellum in light mode).
// A third style next to Andon and Cyberpunk in the System panel. It follows the system's dark/light setting.
// Tokens come from the portfolio's app/globals.css; the bracket motif { } from its logo marks section titles.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };
const sub = (a, b) => { must(a); h = h.replace(a, () => b); };

if (!h.includes('data-theme="tmzm"')) {
  sub("if (t === 'dark' || t === 'light' || t === 'cyberpunk') document.documentElement", "if (t === 'dark' || t === 'light' || t === 'cyberpunk' || t === 'tmzm') document.documentElement");

  const CSS = `/* Tmzm: gold on ink (dark) or vellum (light), after the portfolio. One accent voice: gold. */
:root[data-theme="tmzm"] {
  color-scheme: dark;
  --bg: #0f0e0b; --surface-1: #1a1813; --surface-2: #25221b; --surface-3: #2e2a22;
  --line: #3a352b; --line-strong: #6b6456;
  --text: #ece9e2; --text-2: #cfcac0; --text-3: #a29c90; --text-on-lamp: #0f0e0b;
  --lamp-run: #6fcf7f; --lamp-attn: #e8a33d; --lamp-stop: #f0a08f; --lamp-info: #c9a14a;
  --lamp-ready: #ece9e2; --lamp-off: #7d7668;
  --readout-bg: #14120e; --readout-text-muted: #a29c90;
  --btn-primary-bg: #c9a14a; --btn-primary-text: #0f0e0b; --focus: #d2ab57;
  --scrim: rgb(8 7 5 / 0.7); --purple: #c8b6e8;
  --font-ui: "Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --font-display: "Big Shoulders Display", "Oswald", "Bahnschrift", "Arial Narrow", system-ui, sans-serif;
  --r-control: 2px; --r-panel: 2px;
  --shadow-float: 0 12px 32px -8px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(201 161 74 / 0.18);
}
@media (prefers-color-scheme: light) {
  :root[data-theme="tmzm"] {
    color-scheme: light;
    --bg: #f4f3ef; --surface-1: #fbfaf7; --surface-2: #efece4; --surface-3: #e6e1d4;
    --line: #dcd6c8; --line-strong: #8f8672;
    --text: #16140f; --text-2: #3b372e; --text-3: #625c50; --text-on-lamp: #fbfaf7;
    --lamp-run: #2f8a44; --lamp-attn: #8f5f0c; --lamp-stop: #b3412c; --lamp-info: #7d5f1c;
    --lamp-ready: #3b372e; --lamp-off: #8a8372;
    --readout-bg: #fbfaf7; --readout-text-muted: #625c50;
    --btn-primary-bg: #c9a14a; --btn-primary-text: #0f0e0b; --focus: #7d5f1c;
    --scrim: rgb(22 20 15 / 0.45); --purple: #6b46c1;
    --shadow-float: 0 12px 32px -10px rgb(22 20 15 / 0.28), 0 2px 6px rgb(22 20 15 / 0.12);
  }
}
:root[data-theme="tmzm"] h2.sec { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; }
:root[data-theme="tmzm"] h2.sec::before { content: "{ "; color: var(--btn-primary-bg); font-family: var(--font-mono); }
:root[data-theme="tmzm"] h2.sec::after { content: " }"; color: var(--btn-primary-bg); font-family: var(--font-mono); }
:root[data-theme="tmzm"] .stat-value { font-family: var(--font-display); }
`;
  sub('/* texture and type */', CSS + '/* texture and type */');

  sub('<button type="button" class="btn" data-theme-style="cyberpunk" aria-pressed="false"><svg class="i" aria-hidden="true"><use href="#i-neon"/></svg>Cyberpunk</button>',
    '<button type="button" class="btn" data-theme-style="cyberpunk" aria-pressed="false"><svg class="i" aria-hidden="true"><use href="#i-neon"/></svg>Cyberpunk</button>\n        <button type="button" class="btn" data-theme-style="tmzm" aria-pressed="false"><svg class="i" aria-hidden="true"><use href="#i-andon"/></svg>Tmzm</button>');

  sub("cyberpunk: 'Cyberpunk' };", "cyberpunk: 'Cyberpunk', tmzm: 'Tmzm' };");
  sub("if (mode === 'dark' || mode === 'light' || mode === 'cyberpunk') root.setAttribute('data-theme', mode);", "if (mode === 'dark' || mode === 'light' || mode === 'cyberpunk' || mode === 'tmzm') root.setAttribute('data-theme', mode);");
  sub("$$('[data-theme-style]').forEach(b => b.setAttribute('aria-pressed', (b.getAttribute('data-theme-style') === 'cyberpunk') === (mode === 'cyberpunk') ? 'true' : 'false'));",
    "$$('[data-theme-style]').forEach(b => { const st = b.getAttribute('data-theme-style'); b.setAttribute('aria-pressed', (st === 'cyberpunk' || st === 'tmzm' ? st === mode : mode !== 'cyberpunk' && mode !== 'tmzm') ? 'true' : 'false'); });");
  sub(`      if (style === 'cyberpunk') {
        if (cur !== 'cyberpunk') { safeStorageSet('mc.theme.andon', cur); applyTheme('cyberpunk', true); }
        return;
      }
      if (cur !== 'cyberpunk') return;`,
  `      if (style === 'cyberpunk' || style === 'tmzm') {
        if (cur !== style) { if (cur !== 'cyberpunk' && cur !== 'tmzm') safeStorageSet('mc.theme.andon', cur); applyTheme(style, true); }
        return;
      }
      if (cur !== 'cyberpunk' && cur !== 'tmzm') return;`);
  fs.writeFileSync(H, h);
}
console.log('theme patch applied');

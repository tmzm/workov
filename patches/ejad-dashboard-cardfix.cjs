// Ejad: a provider card never grows wider than its grid column (apply after ejad-dashboard-providers-v2.cjs).
// A grid card sizes itself to its longest unbreakable text, so "Claude (your plan)" plus the Connected badge pushed the
// card past its column and the badge outside it. minmax(0, 1fr) lets the card shrink, and names wrap instead of clipping.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="ejad-cardfix-css"')) {
  const css = '<style id="ejad-cardfix-css">\n#pvp .pvp-card { min-width: 0; grid-template-columns: minmax(0, 1fr); }\n#pvp .pvp-top { min-width: 0; }\n#pvp .pvp-card .pvp-name, #pvp .pvp-dlg-head .pvp-name { white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; line-height: 1.25; }\n#pvp .pvp-badge.ok { white-space: nowrap; }\n</style>\n';
  if (!h.includes('</head>')) throw new Error('anchor missing: </head>');
  h = h.replace('</head>', () => css + '</head>');
  fs.writeFileSync(H, h);
}
console.log('card fix applied');

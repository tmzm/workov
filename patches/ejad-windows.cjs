// Windows fix for worker-fleet's start-dashboard.sh: Python prints CRLF there, so the port read from the config
// ends with a carriage return and the start fails with "invalid port: 3080". Strip CR from the captured values.
// (Function replacements: a "$'" in a replacement string would be read as a special pattern.)
const fs = require('fs');
const f = '.claude/scripts/start-dashboard.sh';
let t = fs.readFileSync(f, 'utf8');
const CR = "$'\\r'";
const a = '    PORT="${CONFIG_OUT%%$\'\\n\'*}"';
if (!t.includes('CONFIG_OUT="${CONFIG_OUT//')) {
  if (!t.includes(a)) throw new Error('start-dashboard.sh anchor missing');
  t = t.replace(a, () => `    CONFIG_OUT="\${CONFIG_OUT//${CR}/}"\n${a}`);
}
const b = '    NEW_PORT="$(sd_py pick "$PORT" "$CONFIG_FILE" 2>/dev/null || true)"';
if (t.includes(b) && !t.includes('NEW_PORT="${NEW_PORT//')) t = t.replace(b, () => `${b}\n    NEW_PORT="\${NEW_PORT//${CR}/}"`);
fs.writeFileSync(f, t);
console.log('start-dashboard.sh patched');

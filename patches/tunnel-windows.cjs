// Workerov: stop start-dashboard.sh from leaking one cloudflared per restart on Windows.
// The script recognises its own earlier tunnel through the pid file, a /proc or lsof working directory and a POSIX pid,
// none of which exist for a Windows process, so every start opened another connector and --stop closed none. On
// Windows the tunnel is now found by its command line, which names the port: with a connector for this port already
// running the script reuses it (and stops duplicates), and --stop ends every connector for this port.
const fs = require('fs');
const F = '.claude/scripts/start-dashboard.sh';
let s = fs.readFileSync(F, 'utf8');
if (!s.includes('win_tunnels()')) {
  const fn = fs.readFileSync(require('path').join(__dirname, 'tunnel-windows.sh'), 'utf8');
  const a = 'tunnel_check() {\n';
  if (!s.includes(a)) throw new Error('anchor missing: tunnel_check');
  s = s.replace(a, fn + a);
  const b = '  TUNNEL_REUSE=0\n  pid="$(tunnel_pid "$kind")"';
  if (!s.includes(b)) throw new Error('anchor missing: TUNNEL_REUSE');
  s = s.replace(b, '  TUNNEL_REUSE=0\n  if [ "$kind" = cloudflared ] && [ "$(win_tunnels "$port" keep1)" -ge 1 ]; then TUNNEL_REUSE=1; return 0; fi\n  pid="$(tunnel_pid "$kind")"');
  const c = '  stop_tunnel cloudflared\n';
  if (!s.includes(c)) throw new Error('anchor missing: stop_tunnel');
  s = s.replace(c, '  win_tunnels "$PORT" all >/dev/null\n' + c);
  fs.writeFileSync(F, s);
  console.log('tunnel-windows patch applied');
}

// Ejad: let start-dashboard.sh use a Cloudflare NAMED tunnel (a fixed address on the user's own domain) instead of a
// random quick-tunnel address. worker-fleet's config has dashboard.tunnel.namedTunnel but nothing reads it. With
//   "dashboard": { "tunnel": { "provider": "cloudflared", "namedTunnel": "fleet", "hostname": "fleet.example.com" } }
// the script runs `cloudflared tunnel run --url http://127.0.0.1:<port> fleet` and publishes https://<hostname>/.
// Without namedTunnel or hostname it behaves exactly as before (quick tunnel). The tunnel and its DNS record are created
// once by the user: cloudflared tunnel login / create <name> / route dns <name> <hostname>.
const fs = require('fs');
const F = '.claude/scripts/start-dashboard.sh';
let s = fs.readFileSync(F, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };
if (!s.includes('EJAD_NAMED')) {
  // 1. stop/reuse logic must recognise `tunnel run --url`
  const re = String.raw`"cloudflared": re.compile(r"(?<!\S)(?:\S*/)?cloudflared\s+tunnel\s+--url\s+http://127\.0\.0\.1:(\d+)(?!\S)"),`;
  must(re);
  s = s.replace(re, () => String.raw`"cloudflared": re.compile(r"(?<!\S)(?:\S*/)?cloudflared\s+tunnel\s+(?:run\s+)?--url\s+http://127\.0\.0\.1:(\d+)(?!\S)"),`);

  // 2. read the named tunnel settings
  const top = 'if [ "$PROVIDER" = "cloudflared" ]; then\n  if command -v cloudflared';
  must(top);
  s = s.replace(top, () => `EJAD_NAMED=""; EJAD_HOST=""
if [ "$PROVIDER" = "cloudflared" ] && [ -f "$JOB_DIR/../specs/worker-fleet.config.json" ]; then
  EJAD_CFG="$(python3 -I -c 'import json,sys;t=json.load(open(sys.argv[1])).get("dashboard",{}).get("tunnel",{});print(str(t.get("namedTunnel",""))+"|"+str(t.get("hostname","")))' "$JOB_DIR/../specs/worker-fleet.config.json" 2>/dev/null | tr -d '\\r')"
  EJAD_NAMED="\${EJAD_CFG%%|*}"; EJAD_HOST="\${EJAD_CFG#*|}"
  [ -n "$EJAD_HOST" ] || EJAD_NAMED=""
fi

` + top);

  // 3. start it
  const start = '      nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$JOB_DIR/cloudflared.log" 2>&1 &';
  must(start);
  s = s.replace(start, () => `      if [ -n "$EJAD_NAMED" ]; then
        echo "Using the named tunnel $EJAD_NAMED ($EJAD_HOST)"
        nohup cloudflared tunnel run --url "http://127.0.0.1:$PORT" "$EJAD_NAMED" > "$JOB_DIR/cloudflared.log" 2>&1 &
      else
        nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$JOB_DIR/cloudflared.log" 2>&1 &
      fi`);

  // 4. the address is known up front; wait for the tunnel to connect
  const url = `        TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\\.trycloudflare\\.com' "$JOB_DIR/cloudflared.log" | tail -n 1 || true)`;
  must(url);
  s = s.replace(url, () => `        if [ -n "$EJAD_NAMED" ]; then
          if grep -q 'Registered tunnel connection' "$JOB_DIR/cloudflared.log"; then TUNNEL_URL="https://$EJAD_HOST"; fi
        else
${url}
        fi`);
  fs.writeFileSync(F, s);
}
console.log('start-dashboard.sh: named tunnel support');

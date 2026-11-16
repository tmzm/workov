#!/usr/bin/env bash
# tunnel.sh on|off|status: the one switch for remote access to this fleet's dashboard (Cloudflare tunnel).
#   off     provider = local and every connector for this dashboard's port is stopped: nothing is exposed.
#   on      provider = cloudflared (the named tunnel and hostname in the config are kept) and the tunnel is started.
#   status  shows the provider, the port and how many connectors are running.
# Run from anywhere inside the fleet folder:  bash .claude/scripts/tunnel.sh on
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG="$ROOT/specs/worker-fleet.config.json"
PY="$(command -v python3 || command -v python)"
read_cfg() { "$PY" - "$CFG" "$1" <<'PYEOF'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8")).get("dashboard", {})
print(c.get("port", 3080) if sys.argv[2] == "port" else c.get("tunnel", {}).get("provider", "cloudflared"))
PYEOF
}
set_provider() { "$PY" - "$CFG" "$1" <<'PYEOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
c.setdefault("dashboard", {}).setdefault("tunnel", {})["provider"] = sys.argv[2]
with open(p, "w", encoding="utf-8") as f:
    json.dump(c, f, indent=2, ensure_ascii=False); f.write("\n")
PYEOF
}
count() { powershell.exe -NoProfile -NonInteractive -Command "@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { \$_.CommandLine -match 'tunnel (run )?--url http://127\.0\.0\.1:$(read_cfg port)( |\$)' }).Count" 2>/dev/null | tr -d '\r' || echo "?"; }
case "${1:-status}" in
  off)
    set_provider local
    # shellcheck disable=SC1090
    source <(sed -n '/^win_tunnels() {/,/^}/p' "$ROOT/.claude/scripts/start-dashboard.sh")
    win_tunnels "$(read_cfg port)" all >/dev/null
    echo "Remote access OFF: provider=local, connectors left: $(count)" ;;
  on)
    set_provider cloudflared
    bash "$ROOT/.claude/scripts/start-dashboard.sh" --tunnel cloudflared | tail -4
    echo "Remote access ON: provider=cloudflared, connectors running: $(count)" ;;
  status)
    echo "provider=$(read_cfg provider) port=$(read_cfg port) connectors=$(count)" ;;
  *) echo "usage: bash .claude/scripts/tunnel.sh on|off|status" >&2; exit 2 ;;
esac

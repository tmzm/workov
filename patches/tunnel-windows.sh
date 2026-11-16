# Windows only: stop duplicate cloudflared connectors for <port> (mode keep1: all but the oldest, all: every one) and
# print how many were kept. Matches the command line, which names the port, so another project's tunnel is never touched.
win_tunnels() {
  local port="$1" mode="$2" out=""
  [[ "$port" =~ ^[0-9]+$ ]] || { echo 0; return 0; }
  command -v powershell.exe >/dev/null 2>&1 || { echo 0; return 0; }
  out="$(powershell.exe -NoProfile -NonInteractive -Command "\$p=@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { \$_.CommandLine -match 'tunnel (run )?--url http://127\.0\.0\.1:$port( |\$)' } | Sort-Object CreationDate); \$k=if ('$mode' -eq 'all') {0} else {1}; \$p | Select-Object -Skip \$k | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }; [Math]::Min(\$p.Count,\$k)" 2>/dev/null | tr -d '\r')"
  echo "${out:-0}"
}


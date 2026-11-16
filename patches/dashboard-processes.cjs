// Workerov: a "Background processes" button in the dashboard's System panel. It only shows inside the desktop app
// (window.fleetShell, given by the app's preload) and opens the app's own window that lists what the fleet runs in the
// background and stops a process after a warning. A browser, a phone or the tunnel never sees the button.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (!h.includes('id="sys-processes"')) {
  const anchor = '<dl class="sys-status sys-narrow" id="sys-status">';
  if (!h.includes(anchor)) throw new Error('anchor missing: sys-status');
  const block = `<div id="sys-processes" hidden style="margin: 0 0 14px">
          <button type="button" class="btn" id="sys-processes-btn" style="width: 100%">Background processes…</button>
          <div style="color: var(--text-3); font-size: 12px; margin-top: 6px">See what runs in the background and stop it if it is stuck.</div>
          <script>
            (function () {
              var s = window.fleetShell, box = document.getElementById('sys-processes');
              if (!s || !s.openProcesses || !box) return;
              box.hidden = false;
              document.getElementById('sys-processes-btn').addEventListener('click', function () { s.openProcesses(); });
            })();
          </script>
        </div>
        `;
  h = h.replace(anchor, block + anchor);
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
  console.log('background processes button added');
}

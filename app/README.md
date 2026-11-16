# Workerov (Windows app)

A tray app that starts with Windows, keeps the dashboard and the routers running, and shows the one dashboard in its own
window. It also hosts the chat, first-run setup, notifications, the Background processes window and **Add project…**.

## Run it
- Develop: `npm install`, then `npm start` (clear `ELECTRON_RUN_AS_NODE` first if you run it from VS Code's terminal: VS Code sets it).
- Build the installer: `npm run dist` writes `dist-installer/Workerov Setup <version>.exe` (NSIS, per user, no admin). It appears in
  Settings > Apps and in Start, and upgrades in place (stable `appId`). Start with Windows is the tray toggle.
- The installer bundles the fleet kit (`install.sh`, patches, overlay, `wv-bin`, the vendored worker-fleet) as
  `resources/kit`, which **Add project…** runs. In development the kit is this repository.
- Test without a window: `Workerov.exe --selftest` prints the checks as JSON. `WV_TEST_DIR=<folder>` gives a test run its own
  settings and instance lock; `WV_NO_AUTOSTART=1` skips the Windows startup entry.

## Projects and the window

- **Add project…** (tray menu, the first-run page, and the dashboard's **All projects** tab): pick a repository. The app runs the
  bundled `install.sh`, which creates the project's fleet home under `~/Workerov/fleets/<name>` and registers it in
  `~/.workerov/fleets.json`. The repository itself is not touched. The first project becomes the dashboard's home; later
  ones appear on the same board.
- **Window:** opens maximized the first time, then where and how big you left it (position, size, maximized), also after a
  quit. A saved position on a screen that is gone falls back to a default.
- Settings: `%APPDATA%\Workeve\config.json` (the folder name is kept so settings survive renames: `fleet`, `autostart`,
  `window`, `chatCwd`). Log: `%APPDATA%\Workeve\launcher.log`.
- The dashboard is started with the fleet's own `start-dashboard.sh`, so a healthy server is reused, never doubled.
- The window loads only `127.0.0.1`. The dashboard token is read by the app and never given to the page.

## Chat and setup

- **Chat tab:** inside this app the dashboard gets a Chat tab. It runs Claude on your Claude plan through the bundled Agent SDK:
  streamed replies, thinking rows, one row per tool call (diffs for edits), a live plan, Allow/Deny cards, slash commands and
  skills, MCP servers, plugins, attachments and past chats. It follows the dashboard's theme and talks to the app over local IPC
  only; it does not exist in a browser or on the phone link, except the phone chat below.
- **Working folder:** the folder button picks where Claude works: any path, a fleet home, a worker's worktree or a recent folder.
- **First-run setup:** checks Claude (installed, signed in, plan, with a Sign in button), then Git Bash, Python, Node, OpenCode,
  a project (with **Add a project**) and cloudflared (optional). It re-checks by itself and reopens from the tray (Setup &
  checks) when a required step goes missing.
- **Notifications:** provider problem, stuck router, a ticket that stopped building, a model switch waiting for you, Claude waiting
  for permission or finished (only when the window is not in front).
- **Phone chat:** the full-access dashboard link shows a Chat tab while this app runs (served by the dashboard at `/chat/`). It is
  kept safe: the app listens on 127.0.0.1 only; the server allows it for the full-access token from another device only; a short list
  of actions; no "Allow all" from the phone; the audit log keeps the action name, never your prompt. Tray: "Chat from the phone link".
- **Timeline logs:** a ticket's Logs tab and the Router panel show the agents' work like the chat does (Timeline) or as text.

## Background processes

Tray menu → **Background processes…**, or the button in the dashboard's System panel. It lists what the fleet runs, grouped as
Dashboard, Router, Agents, Tests and builds, Chat and Network, each with its memory (a test run includes its browser and bundler).
**Stop…** asks first and explains what could break, then ends that process and the ones it started. Workerov itself is never
listed, and a stop re-reads the live list so a reused process id is never hit by mistake. Windows only.

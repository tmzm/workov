# Workeve (Windows app)

A tray app that starts with Windows, keeps the fleet dashboard, router loop and tunnel running, and shows the dashboard in its own window.

## Run it
- Build: `npm install`, unzip Electron once if its installer fails (see below), then `npm run pack`.
- Output: `dist/Workeve-win32-x64/Workeve.exe` (run it; a gold `{ }` icon appears in the tray).
- Test without a window: `Workeve.exe --selftest` writes `%APPDATA%\Workeve\selftest.json`.
- Start hidden in the tray: `--hidden` (what the Windows startup entry uses).

## Notes
- Config: `%APPDATA%\Workeve\config.json` (`fleet` = the fleet folder, `autostart`). Log: `%APPDATA%\Workeve\launcher.log`.
- It starts the fleet with the fleet's own `start-dashboard.sh`, so it reuses a healthy server instead of starting a second one.
- The window loads only `127.0.0.1`. The dashboard token is read by the app and never given to the page.
- Quit leaves the fleet running. Set `WV_NO_AUTOSTART=1` to launch without registering startup.
- If `npm run pack` says `electron.exe` is missing: electron's zip extractor can fail silently on some Windows setups. Unzip `%LOCALAPPDATA%\electron\Cache\*\electron-v*-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.
- If you run it from VS Code's terminal, clear `ELECTRON_RUN_AS_NODE` first (VS Code sets it).


## Chat, setup and installer (stage 2)

- **Chat tab**: inside this app the dashboard gets a Chat tab (Board, Chat, Providers, Telemetry stay on the bar; Ring,
  Graph, Ports and Audit are under More). It runs Claude on your Claude plan through the bundled Agent SDK: streamed
  replies, thinking rows, one collapsible row per tool call (diffs for edits), a live plan, Allow/Deny cards, slash
  commands and skills, MCP servers, plugins, attachments (files, pasted or dropped images) and past chats. It follows the
  dashboard's live theme. It talks to this app over local IPC only; the tab does not exist in a browser or on the phone link.
- **Working folder**: the folder button picks where Claude works: browse to any path, the fleet folder, a worker's
  worktree (`<fleet>-NNN-...`) or a recent folder.
- **First-run setup**: a welcome window checks Claude first (installed, signed in, account and plan, with a Sign in button),
  then Git Bash, Python, Node, OpenCode, the fleet folder and cloudflared (optional). It re-checks by itself and opens again
  from the tray (Setup & checks) whenever a required step goes missing. Without a Claude sign-in the chat is locked; workers
  still run on the connected providers.
- **Notifications**: provider problem, stuck router, a ticket that stopped building, a model switch waiting for you, Claude
  waiting for permission or finished (only when the window is not in front). The installer gives the app its own Windows identity
  so they are reliable. "Test notification" is in Setup.
- **Installer**: `npm run dist` builds `dist-installer/Workeve Setup <version>.exe` (NSIS, per user, no admin). It appears in
  Settings > Apps (uninstall there) and in Start. Start with Windows is the tray toggle and also shows in Settings > Apps > Startup.
  Silent install/uninstall for testing: `Setup.exe /S /D=<folder>` and `Uninstall Workeve.exe /currentuser /S`.
- **Mockups**: `mockup/build-mockups.py` regenerates the three theme mockups and `chat.css`/`chat.html` from `mockup/chat-base.html`,
  `chat.template.html` and `chat-extra.css`. Edit those, not the generated files.

## Workeve: phone chat and timeline logs

- **Name and logo**: the app is Workeve. The gold braces icon is the logo (installer, taskbar, start screen, chat header).
  Settings moved from `%APPDATA%\EjadFleet` to `%APPDATA%\Workeve` (copied automatically on first start).
- **Chat from the phone link**: the full-access dashboard link shows a Chat tab when this app is running. The page is the same
  chat, served by the dashboard server (`/chat/`), and the conversation is shared with the desktop one. How it is kept safe:
  the app listens on 127.0.0.1 only (secret in `job/chat-bridge.json`); the server allows it only for the full-access token from
  another device (never the read-only link, never this computer); a short list of actions; no "Allow all" from the phone; no
  folder dialogs (folders come from a list); the audit log keeps the action name, never your prompt. Tray: "Chat from the phone
  link" turns it off. With the app closed there is no chat.
- **Timeline logs**: a ticket's Logs tab and the Router panel show the agents' work like the chat does (Timeline, default) or as
  plain text (Text). Per agent: formatted messages, folded thinking, one row per tool (command with output, diffs for edits,
  reads, searches), the plan as a checklist. Patches: `agent-steps.cjs` (server, `/api/wv/steps`) and
  `dashboard-steps.cjs` (page; it inlines `app/chat-md.js`).

## Background processes

Tray menu → **Background processes…**, or the **Background processes…** button in the dashboard's System panel. The
window lists what the fleet runs on this computer, grouped as Dashboard, Router, Agents, Tests and builds, Chat and
Network, each with its memory (a test run includes its browser and bundler). **Stop…** asks first and explains what
could break; it then ends that process and the ones it started. Nothing else is stopped: Workerov itself is never
listed, and a stop re-reads the live list so a reused process id can never be hit by mistake. Windows only.

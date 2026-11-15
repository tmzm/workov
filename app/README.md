# Ejad Fleet (Windows app)

A tray app that starts with Windows, keeps the fleet dashboard, router loop and tunnel running, and shows the dashboard in its own window.

## Run it
- Build: `npm install`, unzip Electron once if its installer fails (see below), then `npm run pack`.
- Output: `dist/Ejad Fleet-win32-x64/Ejad Fleet.exe` (run it; a gold `{ }` icon appears in the tray).
- Test without a window: `Ejad Fleet.exe --selftest` writes `%APPDATA%\EjadFleet\selftest.json`.
- Start hidden in the tray: `--hidden` (what the Windows startup entry uses).

## Notes
- Config: `%APPDATA%\EjadFleet\config.json` (`fleet` = the fleet folder, `autostart`). Log: `%APPDATA%\EjadFleet\launcher.log`.
- It starts the fleet with the fleet's own `start-dashboard.sh`, so it reuses a healthy server instead of starting a second one.
- The window loads only `127.0.0.1`. The dashboard token is read by the app and never given to the page.
- Quit leaves the fleet running. Set `EJAD_NO_AUTOSTART=1` to launch without registering startup.
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
- **Installer**: `npm run dist` builds `dist-installer/Ejad Fleet Setup <version>.exe` (NSIS, per user, no admin). It appears in
  Settings > Apps (uninstall there) and in Start. Start with Windows is the tray toggle and also shows in Settings > Apps > Startup.
  Silent install/uninstall for testing: `Setup.exe /S /D=<folder>` and `Uninstall Ejad Fleet.exe /currentuser /S`.
- **Mockups**: `mockup/build-mockups.py` regenerates the three theme mockups and `chat.css`/`chat.html` from `mockup/chat-base.html`,
  `chat.template.html` and `chat-extra.css`. Edit those, not the generated files.

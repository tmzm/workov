# Workerov

A desktop app and a fleet of AI agents that plans, builds, reviews and delivers software tickets with little supervision.
Claude plans and reviews; cheaper models build. You watch one board, answer a few questions, and every ticket ends as a
merge request.

- **One app, one dashboard, one board, one router** for every project on the computer.
- **One worker at a time** across all projects, and **one router turn at a time**, so a normal laptop is enough.
- **Your repositories are never touched.** Each project's fleet lives in its own managed folder; work reaches your repo
  the normal way, as a pushed branch and a draft merge request.

## Install

1. Install the prerequisites: Git for Windows (Git Bash), Python 3, Node.js, [OpenCode](https://opencode.ai) and Claude Code.
2. Run `Workerov Setup <version>.exe`. It installs per user, shows up in the Windows app list, can start with Windows, and
   upgrades in place.
3. Start Workerov. The first screen checks everything and signs you in to Claude.
4. **Add your first project:** pick the project's repository (a folder that contains `.git`). Workerov creates the project's
   fleet for you. Add more projects any time from the tray menu (**Add project…**) or the **All projects** tab.

The installer bundles the fleet kit (`install.sh`, the patches, the vendored worker-fleet), so nothing else needs
downloading. Without the app, `bash install.sh <repository>` does the same from a checkout of this repository.

## How it fits together

| Piece | What it is |
|---|---|
| **Workerov app** (`app/`) | The window, tray, chat, notifications, the **Background processes** window and **Add project…**. It remembers where its window was. |
| **Dashboard** (port 3080) | The only dashboard. The Board shows the tickets of every project with a project filter; **All projects** adds Dispatch/Pause per ticket and shows whose router turn it is. Tickets of any project open in the same drawer with the same buttons. |
| **Fleet home** (`~/Workerov/fleets/<project>`) | A clone of the project's repository with the fleet installed in it: agents, scripts, `specs/tickets`, `job/`. The dashboard serves every project from its own fleet home, one request at a time, in that project's folder. |
| **Router** | One router session for every project. `router-loop.sh` runs from the hub only; each cycle `wv-turn.py --pick` chooses the project (a project with a live worker, a ticket in progress or an answered question is always served; ready tickets start in fair turns, and only when no worker runs anywhere) and the cycle message names it. The router runs from a neutral folder (`~/Workerov/router`) that belongs to no project, so a path it gets wrong never touches a project. Idle or switched-off projects cost nothing. |
| **Machine limits** | `heavy-run` shims put install/test/lint/build in one machine-wide queue, even when an agent runs them in PowerShell or Git Bash. |
| **Registry** | `~/.workerov/fleets.json` lists the projects (written by `install.sh`). |

## The ticket flow

The fleet asks you at three points, in every project:

1. **Before skipping anything.** A screenshot or check that cannot run (no test account, credential or tool) is never skipped
   by an agent. The ticket blocks with a question and two options.
2. **Draft MR ready:** you choose the review: fleet reviewer, Claude, both, or skip.
3. **After the review:** you choose whether to deliver. Yes: the MR becomes ready and the trackers are updated. No: the ticket
   ends and nothing else is touched.

A **Draft** ticket waits for you: only **Dispatch** starts work. MR descriptions are capped (Summary 3 bullets, Implementation
5, Notes 4, one line each) and delivery refuses one that is longer.

For the Ejad workflow, `/task ejad` (rules in `commands/task-modes/ejad.md`) takes tasks from Ejad HR first, keeps the Plane
mirror in line with it, writes the plan as a fleet ticket, and delivers (GitLab MR, Ejad HR, Plane). Per-person settings are
in `~/.claude/ejadtask.json` (see `profile.example.json`); credentials are read from the environment only (`HR_EMAIL`,
`HR_PASS`, `PLANE_API_KEY`) and never written anywhere.

## Layered settings

Which model and runtime a ticket runs with is resolved in one place, `wv-bin/wv-settings.py`, from four layers, lowest to highest:
kit defaults (`wv-settings-defaults.json`), global (the hub's `specs/worker-fleet.config.json`), project (its entry in the hub's
`specs/projects.json`, `fleet.settings`) and ticket (`settings` in the project's `job/stage/<NNN>.json`). A layer has an `enabled` flag
(a missing flag means on; `false` skips the whole layer) and only overrides the keys it lists. Dicts merge key by key; values and lists
are replaced whole. `dashboard.port` and secrets are never layered.

- Read: `python wv-bin/wv-settings.py resolve --hub HUB --project NAME --base PROJECT --ticket 012 [--key models.worker.runtime]`
  prints the effective settings and which layer set each key. Node scripts use `.claude/scripts/wv-settings.cjs`.
- Write: `... set --scope project|ticket ... --values '{"models":{"worker":{"runtime":"claude"}}}' --enabled true`, or the
  "Settings layers" section on the dashboard's Agents tab: every agent (router, worker, teammate, reviewer, reproducer, tester, merger,
  checker, watchdog, planner, designer) in the Global, Project and Ticket scope, with the layer each value comes from. The router, watchdog and
  designer run once for the whole fleet, so they can only be set globally. A change applies from the next agent start, never mid-run.
- Old headers: `python wv-bin/wv-migrate-settings.py` (dry run; `--apply` writes) moves a project config that differs from the hub into
  a disabled project layer and a not-done ticket's `**Worker harness:**` / `**Worker model:**` header into its ticket layer. After that
  a header in `rd.md` overrides nothing.

## Safety

- Remote access (a Cloudflare tunnel) is **off** by default. `bash .claude/scripts/tunnel.sh on | off | status` is the one
  switch; the dashboard listens on this computer.
- Agents never run `git clean`, hard resets or force removals on work that is not committed: it is salvaged first.
- A permission policy (`overlay/.opencode/plugins/approvals.js`) allows safe commands, denies dangerous ones and asks you
  for the rest on the dashboard.
- The **Background processes** window lists what the fleet runs and stops a process only after a warning.

## Update and remove

- **Update the app:** run the new installer over the old one; settings and projects are kept.
- **Update a fleet:** `bash install.sh <repository>` again (idempotent). Projects added through the app are upgraded in place.
- **Remove a project's fleet from a working copy** (old in-place installs): `bash uninstall.sh <repository>`. It archives the
  tickets first, restores any tracked file it changed and removes only what the installer added.

## Layout of this repository

```
app/                the Electron app (main.js, add-project.js, processes.js, chat…)
commands/           the /task command and its modes
overlay/            agents, scripts and the permission plugin copied into every fleet
patches/            idempotent edits to the vendored worker-fleet (GitLab landing, one board, drafts, locks…)
wv-bin/             the pnpm/ng shims, the heavy-run lock and wv-turn.py / wv-busy.py (installed to ~/.wv-bin)
vendor/worker-fleet the upstream fleet this builds on (see below)
install.sh          creates or upgrades a project's fleet
uninstall.sh        removes an in-place install
```

## worker-fleet

The multi-agent build line (router, worker, tester, reviewer…, the Fleet Control dashboard) comes from worker-fleet, kept as a
local copy in `vendor/worker-fleet` because it has no package registry. The patches anchor on its text and stop with
"anchor missing" if a newer version changed it. Check that its license allows redistribution before you publish this
repository.

## License

Proprietary. All rights reserved. See `LICENSE`.

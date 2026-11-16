# wv-fleet

Claude plans and reviews; cheaper AIs build. One `/task ejad` command takes a task from Plane through a short plan,
a mockup, the build, the review and the delivery (GitLab MR, Plane, Ejad HR) — with a live dashboard, or headless.

It adds an Workerov layer on top of [worker-fleet](#worker-fleet) (the multi-agent build line with the Fleet Control
dashboard):

| Piece | What it does |
|---|---|
| `commands/task-modes/ejad.md` | The `/task ejad` Claude Code command: sync Plane ↔ Ejad HR, pick and claim a task, write the plan as a fleet ticket (or a handoff prompt in headless mode), mockup, review, deliver, hours. |
| `overlay/.claude/scripts/land.cjs` | Token-free delivery: push, GitLab MR (title, description, screenshots, assignee, reviewer), Plane comment + Review, Ejad HR task REVIEW + link + comment. |
| `overlay/.opencode/plugins/approvals.js` | Permission policy for OpenCode agents: safe work is allowed, dangerous commands are denied, everything else waits for **Allow / Deny** on the dashboard (and a phone push). |
| `overlay/.claude/scripts/implementers.json` | The headless command lines of the implementer CLIs: OpenCode (default), Copilot, Kilo, Antigravity. |
| `patches/` | Small edits to worker-fleet: GitLab landing instead of GitHub, Workerov commit rules and delivery pack, mockup-first tickets, Copilot/Kilo/Antigravity delegation, a **Mockup** tab and the permission panel in the dashboard. |

## Install

Requirements: Git Bash, `git`, `node`, `python3`, [`opencode`](https://opencode.ai) logged in to OpenCode Go,
`glab` logged in to `git.ejad.net`, Claude Code. Optional: `copilot`, `kilo`, `agy`, and `agent-browser`
(`npm i -g agent-browser`) for the fleet's browser checks.

```bash
git clone <this repo> ~/wv-fleet
bash <this repo>/install.sh <target-repo>      # worker-fleet comes from vendor/worker-fleet unless you pass --worker-fleet <path-or-git-url>
```

Tested with worker-fleet config schema `4.0.0` plus the unreleased dashboard additions (Ring view, ticket done
time, per-ticket run summary: upstream tickets 091–093). The patches anchor on upstream text and stop with
"anchor missing" if a newer worker-fleet changed it.

Windows notes: the patches make the watchdog, wake watcher and dashboard run on Windows (Git Bash, never WSL bash),
show OpenCode agent sessions in each ticket's Logs tab, and `.claude/scripts/router-loop.sh` keeps the
OpenCode router cycling without a terminal (`bash .claude/scripts/router-loop.sh`).

Planning on the fleet: `/task ejad` hands planning to the Claude ticket writer `ejad-planner`
(`overlay/.claude/agents/wv-planner.md`, Sonnet), started by
`node .claude/scripts/plan.cjs <NNN-slug> job/briefs/<NNN>.md`. The ticket shows as `specifying` with the writer
as its agent, and every planner step streams into `job/logs/<NNN>-planner.log`, which is the ticket's Logs tab.

The installer:
1. installs worker-fleet into the repo, then restores any file the team tracks (the team's files always win);
2. sets the models (OpenCode Go: router `glm-5.3`, workers `kimi-k2.7-code`, reviewer `deepseek-v4-pro`, the rest
   `glm-5.3-flash`), GitLab landing, 2 workers, app port 4200, $3 per ticket;
3. adds the Workerov layer and keeps every installed file out of git (`.git/info/exclude`, local only);
4. copies `/task ejad` to `~/.claude/commands/` and creates `~/.claude/ejadtask.json` from
   `profile.example.json` if you have none.

Then, once per person:
- fill in `~/.claude/ejadtask.json` (your Plane, GitLab and Ejad HR ids, and your reviewers with an optional
  `until` date);
- set the Windows user environment variables `HR_EMAIL`, `HR_PASS` (Ejad HR) and `PLANE_API_KEY` (Plane → Profile
  settings → API tokens). They are read from the environment only and never written anywhere;
- check it: `python3 .claude/scripts/selftest.py` in the repo (on Windows two checks fail by design: Unix file
  modes, and the example password in an e2e spec).

Update: `git pull` here and run `install.sh` again. It is idempotent.

## Daily use

### Fleet mode (default when worker-fleet is installed)

1. **Start the line** (once per session), in the repo:
   - `opencode --agent router` (or `claude --agent router --name router --permission-mode auto`)
   - the dashboard: `bash .claude/scripts/start-dashboard.sh`, then open `http://localhost:3080`
2. **Prepare a task** in Claude Code: `/task ejad` (picks the next unblocked task) or `/task ejad HR-484`.
   Claude syncs Plane and Ejad HR, claims the task, and writes a ticket `specs/tickets/NNN-*/` (`rd.md` with the
   decisions, API contract, states, texts and steps; `eval.md` with pass/fail checks) as **draft**.
3. **Approve** the ticket on the dashboard (or tell Claude "approve"). The router dispatches a worker in its own
   worktree.
4. **Watch it work** on the dashboard: the board, each worker's phase, the Logs tab (live tail), the **Mockup** tab,
   and the **Needs you** list:
   - **Mockup ready** — the worker builds `mockup.html` first when the ticket has `## Mockup`; open the Mockup tab,
     then answer *approve* or your changes;
   - **Permission** — an agent wants something outside the safe list: **Allow** or **Deny** (no answer in 15 minutes
     = deny);
   - **Question** — a product decision: answer it there.
5. **Landing is automatic**: tester and reviewer pass → the merger runs `land.cjs` → MR on GitLab, Plane in
   Review, Ejad HR in REVIEW, with screenshots and the summary from the worker's delivery pack.
6. **Optional final review by Claude**: `/task ejad HR-484 review`. Findings go back to the ticket as rework and the
   fleet fixes them.
7. **Hours**: `/task ejad HR-484 deliver` shows the days worked and logs the hours you give.

Pick another implementer for a ticket with `/task ejad HR-484 with copilot` (or `kilo`, `antigravity`): the ticket
gets `## Implementer`, and the worker delegates the build steps to that CLI and still reviews and tests them.

### Headless mode (no dashboard)

`/task ejad HR-484 headless`: Claude writes a short plan and a ready-to-paste prompt. Paste it into any AI
(OpenCode, Copilot, Kilo, Antigravity, Codex…). The implementer builds, runs the three reviews, and leaves a delivery
pack in `.delivery/HR-484/`. Then:
- `/task ejad HR-484 review` — Claude checks the work once and gives a fix prompt if needed;
- `/task ejad HR-484 deliver` — push, MR, Plane, Ejad HR and hours, in seconds.

## Configuration

| File | Change |
|---|---|
| `specs/worker-fleet.config.json` | models per role, parallel workers, ports, budgets (re-run `python3 .claude/scripts/apply-setup.py --preset custom` after editing) |
| `.claude/scripts/implementers.json` | command lines of the implementer CLIs (`{prompt}` is replaced) |
| `.opencode/plugins/approvals.js` | the permission policy (`ALLOW_SHELL`, `DENY_SHELL`) |
| `~/.claude/ejadtask.json` | your ids and reviewers |
| phone pushes | `python3 .claude/scripts/apply-setup.py --notify-ntfy <your-secret-topic>` and the ntfy app |

Copilot is limited to the tools listed in `implementers.json`. Kilo and Antigravity have no blanket auto-approve
here: give them allow rules in their own settings (Kilo's permission config; Antigravity's
`~/.gemini/antigravity-cli/settings.json` `permissions.allow`), or they stop at the first tool they may not use.

## Safety

- Nothing installed is committed; the team's tracked files are restored.
- Agents never push; only `land.cjs` pushes (never with force) after the tester and reviewer passed.
- The approvals plugin denies `git push`, force, deletes outside the worktree, outside network calls and new
  dependencies, and asks you for anything not on the safe list.
- Mockups run in a sandbox (no network, opaque origin) inside the dashboard.
- Secrets come only from environment variables; the dashboard masks tokens in every response.

## worker-fleet

worker-fleet is not bundled: pass its folder or git URL to `install.sh`. It is used by the team already (ticket 003);
ask its author before publishing a copy of it.

## Machine limits

The installer adds three guards so a small machine is not run out of memory:

- `tunnel-windows`: `start-dashboard.sh` reuses the cloudflared connector already running for its port (and stops
  duplicates); `--stop` ends every connector for that port. Before this, each restart left one more connector behind.
- `resource-rules`: every fleet agent is told to use the package manager the project pins in `packageManager` (never
  npm in a pnpm project) and to run heavy commands through `heavy-run.sh`.
- `heavy-run.sh <command...>`: a machine-wide lock, so only one install, test, build or lint runs at a time across all
  fleets on the computer. A lock whose owner has died is taken over.

### Turning remote access on and off

`bash .claude/scripts/tunnel.sh off | on | status` (run in the fleet folder) is the one switch for the Cloudflare tunnel.
`off` sets `dashboard.tunnel.provider` to `local` and stops every connector for the dashboard's port, so nothing is
exposed; `on` sets it back to `cloudflared` (a configured named tunnel and hostname are kept) and starts the tunnel.
While the provider is `local`, neither the app nor `start-dashboard.sh` opens a tunnel.

`overlay/wv-bin/` holds `.cmd` shims for `pnpm`, `npm`, `npx` and `ng` (all calling `wv-wrap.sh`), installed to `~/.wv-bin` and put first on `PATH` by `router-loop.sh`. The agents run their commands in PowerShell, so the shims are `.cmd` files: an extensionless file on `PATH` makes Windows ask which app should open it. A
heavy subcommand (`install`, `test`, `lint`, `build`, `format`, `e2e`) goes through `heavy-run.sh`, so only one runs at a
time on the machine even when an agent forgets the rule. Other commands pass straight through to the real tool.

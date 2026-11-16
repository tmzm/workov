# worker-fleet: Multi-Harness Ticket Autopilot & Fleet Control Dashboard

A multi-harness orchestration workflow for **Claude Code**, **OpenCode (`opencode`)** and **ChatGPT / OpenAI Codex CLI (`codex`)**. You describe features; worker-fleet turns them into tickets, builds them in parallel in isolated git worktrees, tests them in a real browser, has an independent reviewer audit every diff, and lands them on `main` (or opens PRs), with a live web/mobile dashboard on top.

Ticket-driven specifications (`rd.md` + `eval.md`), worktree-isolated parallel `worker` agents, coordinated Agent Teams (`teammate`), automated browser testing via Vercel `agent-browser` (`tester` + `checker` + `reproducer`), a script-scheduled watchdog, model switching via `/setup`, and a **Fleet Control Dashboard (:3080)** reachable over Cloudflare Tunnel or ngrok.

Related docs: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) (symptom / cause / fix), [CONTRIBUTING.md](CONTRIBUTING.md) (presets, agents, ticket conventions), [CHANGELOG.md](CHANGELOG.md), and the visual guide [worker-fleet-guide.html](worker-fleet-guide.html).

---

## Contents

1. [How it works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Quickstart: from install to first dispatched ticket](#quickstart-from-install-to-first-dispatched-ticket)
4. [Upgrading an existing install](#upgrading-an-existing-install)
5. [Ticket lifecycle and statuses](#ticket-lifecycle-and-statuses)
6. [Router autopilot](#router-autopilot)
7. [Fleet Control Dashboard](#fleet-control-dashboard)
8. [Notifications](#notifications)
9. [Configuration reference](#configuration-reference)
10. [Landing modes (direct vs PR)](#landing-modes-direct-vs-pr)
11. [Security model](#security-model)
12. [Self-tests](#self-tests)
13. [File structure](#file-structure)

---

## How it works

```text
/write-tickets  ->  rd.md + eval.md  (status: draft)
      you approve ->  ready
router  ->  isolated worker (own worktree, port, test account)
              build -> tester (runs eval.md) -> reviewer (audits diff vs rd.md) -> commit
router  ->  merger lands it on main (or opens a PR)  ->  checker smoke-tests main
```

- **Specs, not prompts.** Every feature is a folder `specs/tickets/NNN-slug/` with requirements (`rd.md`) and an executable pass/fail verification spec (`eval.md`).
- **Isolation.** Each worker builds in its own git worktree on its own dev-server port and test account, so tickets run in parallel without stepping on each other.
- **Two gates.** The `tester` runs every `eval.md` check verbatim; the `reviewer` rejects out-of-scope changes and `Do not touch` violations before anything is committed.
- **Autopilot with guard rails.** Crash adoption, bounded retries, per-ticket budget caps and human escalation are built into the router (see [Router autopilot](#router-autopilot)).

---

## Prerequisites

1. **CLI harness** (at least one): Claude Code (`claude`), OpenCode (`opencode`), optionally OpenAI Codex CLI (`codex`).
2. **Vercel `agent-browser` CLI** for browser verification:
   ```bash
   npm install -g agent-browser
   ```
   The tester, checker and reproducer call it through `bash .claude/scripts/browser.sh <args>`, a resolver that picks the first working binary: `$AGENT_BROWSER_BIN`, then `agent-browser` on `PATH`, then known install locations (`bash .claude/scripts/browser.sh --resolve` prints the choice). A broken PATH shim is skipped. Note that the installed agent-browser has no `fetch` command, so `HTTP` eval checks fall back to `curl`.
   Each agent drives the browser in its own session, never agent-browser's shared default one: it gets the name once from `bash .claude/scripts/browser.sh --session-for <role> <NNN>` (for example `worker-fleet-tester-061`; the prefix is `project.name` from the config, else the main checkout's directory name, so projects with different names never share a session) and passes `--session <name>` on every call. `bash .claude/scripts/browser.sh session list` shows the open sessions; agents close their own and never run `close --all`.
3. **Python 3.8+** and **bash**. The scripts use only the standard library.
4. **git** (worktrees), and optionally **`gh`** (PR landing mode) and **`cloudflared`** or **`ngrok`** (remote access from your phone).

---

## Quickstart: from install to first dispatched ticket

### Step 1: Install

**Option A: install into an existing repo with the installer** (from a worker-fleet checkout):

```bash
bash .claude/scripts/install.sh /path/to/your-repo
```

The installer is idempotent and non-destructive: it copies agents, skills, scripts, the dashboard and `opencode.json`, creates the `specs/` skeleton only if absent, moves any file it would overwrite to `<target>/.worker-fleet-backup/<timestamp>/`, and stamps `.claude/worker-fleet.version`. It never edits your `.gitignore`; it prints a hint for `job/`, `.claude/worktrees/`, `__pycache__/` and `.worker-fleet-backup/`. From inside Claude Code or OpenCode you can run `/setup install_into=/path/to/your-repo`.

`bash .claude/scripts/install.sh --help` (or `-h`) prints the usage. Before copying anything, the installer walks every destination and refuses the whole run (exit 1, nothing half-installed) if a path on the way is a symlink, including a symlinked or dangling `specs/worker-fleet.config.json` or `specs/tickets/BOARD.md`. It also stops with a clear error naming the path when `.worker-fleet-backup` is a regular file or an unwritable directory, and it compares physical paths so a symlinked target cannot sneak into the source checkout.

**Option B: copy.** Use this repo directly, or copy `.claude/`, `.opencode/`, `.agents/`, `opencode.json` and `specs/` into your project.

### Step 2: Configure with `/setup`

In Claude Code or OpenCode, run `/setup` for an interactive interview, or pass flags in one shot:

```text
/setup harness=both preset=hybrid-bridge max_workers=4 dashboard=on tunnel=cloudflared
```

You can also run the generator script directly:

```bash
python3 .claude/scripts/apply-setup.py --preset hybrid-bridge --harness both --tunnel cloudflared
```

Built-in presets:

| Preset | Stack |
| --- | --- |
| `hybrid-bridge` | Opus router, Sonnet workers, OpenAI o3/Codex review delegation |
| `claude-default` | High-effort Opus router, Sonnet workers and reviewers |
| `deepseek-lean` | Sonnet/DeepSeek-Chat router, DeepSeek-Reasoner workers and reviewers (lowest cost) |
| `opencode-openai` | Native OpenCode stack: GPT-5 router and workers, o3 reviewers |

Useful `apply-setup.py` flags (run `python3 .claude/scripts/apply-setup.py -h` for all):

| Flag | Effect |
| --- | --- |
| `--budget-usd FLOAT` / `--budget-turns INT` | Default per-ticket budget caps (default `10.0` USD and `300` turns) |
| `--landing direct\|pr` | Merge straight to `main` (default) or open GitHub PRs |
| `--max-workers N` | Maximum parallel workers |
| `--tunnel cloudflared\|ngrok\|local` | Tunnel provider for the dashboard |
| `--port N` | Dashboard port (default `3080`) |
| `--main-port N` | Main checkout (checker) dev server port (default `3000`) |
| `--reproducer-port N` | Reproducer dev server port (default `3090`) |
| `--worker-base-port N` | First worker port: worker slot N uses base + N - 1 (default `3101`) |
| `--remote-actions on\|off` | Allow dashboard actions from a remote device |
| `--auto-dispatch-on-approve on\|off` | An Approve wakes the router (`on`, the default) or waits for Dispatch now or the next cycle (`off`) |
| `--watchdog-mode script\|agent` / `--watchdog-interval SECONDS` | Watchdog mode and scheduler cadence |
| `--regression-every-n-merges N` | Full regression sweep cadence (`0` disables) |
| `--worker-delegate none\|codex\|opencode` | Optional implementation delegation for workers |
| `--regenerate-token` | Rotate the dashboard auth token |
| `--show-token` | Print the full dashboard auth token in the summary (by default only the last 4 characters are shown) |

The `apply-setup.py` summary masks the dashboard token. Read the full value from `job/dashboard-auth.json` or pass `--show-token`.

**Ports for several projects.** Every role uses this project's ports from `specs/worker-fleet.config.json`: the checker `concurrency.mainPort`, the reproducer `concurrency.reproducerPort`, workers `concurrency.workerBasePort` and up, and the dashboard `dashboard.port`. Two projects that run at once need different ports: set them with `--main-port`, `--reproducer-port`, `--worker-base-port` and `--port`. `apply-setup.py` refuses ports that clash inside one project, records each main checkout in `~/.worker-fleet/projects.json`, and prints `WARNING: port overlap` naming any other registered project that uses the same ports. It never changes ports by itself. The test accounts (`t000`, `t090`, `t001`, ...) live in each app's own data, so they clash only when two projects share one database.

Running `apply-setup.py` is idempotent. It first migrates older configs one step at a time (a `2.0.0` config upgrades to `3.0.0`, then to `4.0.0`, logging each change) and exits `3` if the config comes from a newer worker-fleet than the script.

### Step 3: Write tickets with `/write-tickets`

```text
/write-tickets Add user authentication and settings dashboard
```

The skill reads your codebase first, interviews you one question at a time, picks an eval template for your stack (web, api, cli or library), validates dependencies (no dangling or cyclic `Runs`), and writes `specs/tickets/NNN-slug/rd.md`, `eval.md` and a row in `specs/tickets/BOARD.md` with status `draft`. Optional `rd.md` sections tune a ticket: `## Retries`, `## Budget`, `## Landing`, `## Delegatable subtasks`.

A ticket folder holds `rd.md`, `eval.md`, `contract.md` (team tickets), and, once built, `results.md` (the human narrative), **`results.json`** (the machine-readable record) and `evidence/`. `results.json` carries the automated build/lint/test/typecheck outcomes, one `checks[]` entry per `E-N` check (id, title, status, evidence path, exit code), the reviewer verdict and the budget used. The router's verification gate reads `results.json`; it falls back to parsing `results.md` only for legacy tickets that predate it. A missing or corrupt `results.json` counts as a failed verification and bounces the ticket back to the same worker.

### Step 4: Approve (`ready`)

```text
Mark ticket 001 ready on the board.
```

Or click **Approve & Mark Ready** in the dashboard. Tickets stay `draft` until you approve them.

### Step 5: Start Fleet Control (optional but recommended)

```bash
bash .claude/scripts/start-dashboard.sh
```

Prints the tunnel URL (`https://xxxx.trycloudflare.com/`), the local URL (`http://127.0.0.1:3080/`) and the token masked to its last 4 characters; neither the output nor `job/dashboard-url.txt` carries the token. In an interactive terminal it also prints a QR code that **carries the token** and signs your phone in, so never share a picture of it; when the output is not a terminal (the router, a pipe, a log) the QR code is skipped. Run the script again in a terminal to see the QR code: it reuses the running dashboard and tunnel. Stop it with `bash .claude/scripts/start-dashboard.sh --stop`. `start-dashboard.sh --help` prints the usage and starts nothing. An unknown flag is rejected (exit 2) before anything starts. The recognised flags are `--port`, `--tunnel`, `--stop` and `--help`.

**Several projects at once.** Run `start-dashboard.sh` in each repository and every project gets its own dashboard on its own port:

- Before starting, the script asks whoever holds its port who they are (`GET /api/identity`) and reuses only its own project's dashboard.
- If another project's dashboard (or any other process) holds the configured port, the script starts this project's dashboard on the **next free port** (the first free one in the next 10 ports, skipping this project's own app, reproducer and worker ports), says so, and saves it to `dashboard.port` and `concurrency.dashboardPort` in this project's `specs/worker-fleet.config.json`. The next start reuses that port.
- An explicit `--port <port>` is never changed: if that port is held by something else, the start is refused (exit 1) with a message naming the holder.
- `--stop` only stops this project's dashboard server (and the tunnels recorded in `job/*.pid`), never another project's.

Each dashboard shows its project name in the page header and in the browser tab (`<name> - worker-fleet Fleet Control (:<port>)`), and every push notification is titled `[<name>] worker-fleet: <event>`. The name comes from the optional `project.name` field in `specs/worker-fleet.config.json` and defaults to the project's directory name:

```json
"project": {"name": "My Shop"}
```

The name is cleaned to at most 40 plain-ASCII characters and is read again on every page load and push, so a change needs no restart.

### Step 6: Run the router

**Claude Code:**
```bash
claude --agent router --name router --permission-mode auto
```
Then prompt: `Build all ready tickets on the board.`

**OpenCode:**
```bash
opencode --agent router
```

The router dispatches `ready` tickets (P0 before P1 before P2, then board order) to workers, each on its own port (`concurrency.workerBasePort + N - 1`: `:3101`, `:3102`, ... by default) and test account (`t001`, `t002`, ...). You only get pulled in for genuine product decisions.

---

## Upgrading an existing install

This project was called agent-hive before (and Super-Agent before that). Tickets 089 and 090 renamed it to worker-fleet, and the old names are no longer read: there is no fallback for the old config path, the old environment variables, the old dashboard identity value or the old session cookie. To bring an existing install over, follow these steps in order.

1. **Stop the old dashboard and the router.** Run `bash .claude/scripts/start-dashboard.sh --stop` and end the router session. Without the stop, the new script finds the old dashboard through its pid-file fallback and reuses that server instead of starting the new one. `--stop` works on the old server, because it goes by the pid file and the command line, not by the dashboard's identity.
2. **Update the files.** Run `git pull` in a worker-fleet checkout. For a repo you installed into, run `bash .claude/scripts/install.sh <target-repo>` again from a worker-fleet checkout. It moves `specs/super-agent.config.json` and `.claude/super-agent.version` to their new names. It never touches an old `.super-agent-backup/` folder, which you may delete.
3. **Migrate the config.** Run `python3 .claude/scripts/apply-setup.py`. It moves `specs/super-agent.config.json` to `specs/worker-fleet.config.json`, migrates the config to schema version `4.0.0` (rewriting `{"env": "AGENT_HIVE_<NAME>"}` references to `WORKER_FLEET_<NAME>`), registers the checkout in `~/.worker-fleet/projects.json`, and lists the `AGENT_HIVE_*` variables that are still set. The old registry folder `~/.agent-hive/` is no longer read and may be deleted. Until this step has run, the dashboard and the scripts that read the config refuse to run while only the old config exists.
4. **Rename your secrets.** Rename every `AGENT_HIVE_<NAME>` environment variable to `WORKER_FLEET_<NAME>` wherever it is set (shell profile, CI, service). Do it before the restart, because the dashboard and the router read the environment when they start. Secrets stored as `{"secretRef": ...}` in `job/notify-secrets.json` keep working unchanged.
5. **Restart.** Run `bash .claude/scripts/start-dashboard.sh`, then start the router again with `claude --agent router --name router --permission-mode auto` (or `opencode --agent router`).
6. **Sign in again.** The session cookie is now `wf_session`. The old `sa_session` cookie is never accepted, and the dashboard expires it on the next visit. The browser stores the token under `worker_fleet_token`, and the page removes the old `super_agent_token` entry without reading it. Open the token link or QR code once, or enter the token on the first action. The token itself is unchanged.

Until you rename the folder (or set `project.name`), the project name in the dashboard header, the push titles and the browser session names is still the folder name, for example `agent-hive`.

---

## Ticket lifecycle and statuses

`specs/tickets/BOARD.md` is the single source of truth. Every surface uses one status enum:

| Status | Meaning | Set by |
| --- | --- | --- |
| `specifying` | A ticket writer is writing it | `/write-tickets` (flips it to `draft` when finished) |
| `draft` | Written, awaiting your review | `/write-tickets` |
| `ready` | Approved for dispatch | you (or the router on your behalf) |
| `in-progress` | A worker is building it | router (mirrors the worker heartbeat) |
| `blocked` | Waiting on a product decision | router (mirrors the heartbeat) |
| `in-review` | PR opened, waiting for human review (PR landing mode) | merger |
| `done` | Landed on `main` | merger |
| `failed` | Retries exhausted | router |
| `budget-exceeded` | Hit its USD or turn cap | router |

Board columns: `# | Title | Status | Mode (solo/team) | Prio (P0/P1/P2) | Runs (alongside, or after/waits for NNN)`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full grammar.

---

## Router autopilot

The router keeps its state in a durable ledger (`job/router-state.json`), so a crash or restart loses nothing:

- **Adopt.** After a restart it reconciles the ledger against live worktrees and worker heartbeats (`job/status.json`). A fresh heartbeat means the worker is adopted and resumed, never re-dispatched. A stale or missing one is reaped (evidence salvaged first) and the ticket returns to `ready`. One summary line per cycle.
- **Retry.** A stalled or failed worker is re-dispatched automatically up to `maxRetries` (default **2**, so at most 3 attempts; override per ticket with `## Retries`). Each retry gets a `## Previous attempt findings` block with the last status note, tester FAILs and reviewer items. Exhausted tickets become `failed`.
- **Budget.** Every ticket is capped at **$10.00 estimated cost and 300 worker turns** by default (`apply-setup.py --budget-usd/--budget-turns`, or `## Budget` in the ticket). Turns are a hard `maxTurns` stop; cost is monitored every cycle. The USD figure counts only spend from the ticket's first dispatch in the run onward: spend on writing or planning the ticket, and on earlier runs, stays visible in telemetry but never counts against the cap. A ticket that hits a cap becomes `budget-exceeded` and is never auto-retried. Before each USD check the router asks the dashboard who it is (`GET /api/identity`); when the port is held by another project's dashboard, or the dashboard predates budget counting (no `byTicketBudget`), it warns once (`USD cap not enforced: ...`) and only the turn cap applies until this project's dashboard is (re)started.
- **Escalation.** When three tickets fail in one run, the router stops dispatching and asks you to `continue`, `skip failed`, or `stop run`.
- **Death surfacing.** Agent deaths (provider limit, crash) are classified; a provider-wide outage pauses dispatch and resumes with a health probe, and a single death counts as one failed attempt and is re-dispatched automatically with the findings handed over.
- **Verification from `results.json`.** When a worker reports done, the router checks `results.json` against `eval.md` (every `E-N` present and `PASS`, evidence files exist) before it merges; it never re-parses prose when the JSON exists.
- **Continue / resume.** After a provider-limit outage or a stopped swarm, type `continue` (or `resume`) in the router chat, or click **Resume Swarm** in the dashboard. The button shows only while the swarm is degraded or paused and writes `job/control/_swarm.json`. The router runs a resume cycle: assess the board, ledger and heartbeats, adopt or reap dead worktrees, re-dispatch ready tickets up to the concurrency cap by priority, clear the degraded state, and report one line. Swarm health is kept in `job/swarm-state.json`.
- **Remote control.** Pause, resume, stop a worker, or re-run the checker from the dashboard; the dashboard writes an intent file under `job/control/` and the router (the only actor that touches agents) executes it on its next cycle. Stop also works on a ticket that waits for your decision (`blocked`): the router drops the question and puts the ticket back to `ready` (no retry consumed); press Pause first if it should not be dispatched again yet. **Dispatch now** on the board shows how many ready tickets can start, writes `job/control/_dispatch.json`, and makes the router dispatch them at once, P0 first, up to the worker limit; it is disabled while the swarm is degraded (use Resume swarm).
- **Wake on approval.** The router arms `.claude/scripts/router-wake.sh` in the background (Claude Code's background mode). An Approve in the dashboard, a dashboard control intent (Stop, Pause, Resume, Re-run checker, Resume swarm) or a dashboard decision then wakes an idle router within seconds, with no chat message. The watcher costs no tokens while it waits and exits after an hour at most, when the router arms it again. On OpenCode it is not armed, so changes wait for your next message. To approve several tickets and release them together, set `dispatch.autoOnApprove: false` (`apply-setup.py --auto-dispatch-on-approve off`): an Approve no longer wakes the router by itself, so you can approve several tickets and then press **Dispatch now** (ticket 080); tickets approved meanwhile can still start when the router wakes for another reason (a worker finishing, a chat message); use Pause to hold one.
- **Post-merge checks.** The `checker` smoke-tests `main` after merges, and walks every flow in `specs/regression.md` (a full regression sweep) after every N merges (`regression.everyNMerges`, default `1`). A confirmed break goes to the `reproducer`.
- **Optional delegation.** With `--worker-delegate codex|opencode`, workers may route `## Delegatable subtasks` listed in a ticket through `delegate-task.sh <cli> exec`, always self-reviewing the diff; the tester and reviewer gates are unchanged.

Notifications (push alerts to ntfy, Telegram or Slack) are tracked as a separate ticket on the board and are documented here once they land.

---

## Fleet Control Dashboard

Zero-dependency Python server (`.claude/scripts/dashboard-server.py`) plus a single self-contained UI file (`.claude/dashboard/index.html`, no CDN, font or build step), on `:3080` by default.

The UI is built as the line's **andon board**: status lives only in round lamps, which light only where the line calls for a human, and everything else stays quiet. It has **six views**: **Board**, **Ring**, **Graph**, **Telemetry**, **Ports** and **Audit**. The URL hash keeps the view and the open ticket (`#board`, `#ring`, `#graph`, `#telemetry`, `#ports`, `#audit`, `#ticket/050`), so a reload or a shared link lands in the same place.

- **Needs you.** The Board starts with a call list of everything that wants the owner: a degraded or paused swarm (with **Resume swarm**), a worker's question (quoted from its heartbeat, with **Answer** and **Open**), dead, failed, over-budget and stalled work, and one row for drafts waiting for approval. Each ticket appears once. When nothing needs you it says so, with the running, ready and done counts. The Board button in the views navigation carries the row count.
- **Phone use.** Every view works at 360-430 px with no sideways page scroll and 44 px touch targets. Below 768 px the views move to a **bottom nav**, the header becomes an app bar with a one-line swarm status, the status items and actions move into the **System panel** (a bottom sheet), the stage columns stack and collapse (Building starts open), and a ticket opens **full screen** with its action dock (priority, Pause, Re-run checker, and an isolated two-tap Stop worker) pinned to the bottom. The browser's Back gesture closes the ticket.
- **Light and dark themes.** The theme follows the system setting. The System panel can force **Auto**, **Dark** or **Light**; the choice is stored in this browser (`localStorage` `mc.theme`).

- **Board and Agents.** The board is four stage columns side by side (Plan, Queue, Building and Done), with an andon strip of stations that jump to a stage and a ticket filter (`/` focuses it). Every card shows its own status as a lamp and a word; Blocked, Failed and Over budget cards also carry a symbol and an outline, stay in Building and count in its header ("Building 9 · 4 need you"). Done is grouped by day (Today, Yesterday and Earlier; Today starts open) and a filter match opens its group. Cards show the priority (P0, P2), the pipeline stage, `stalled` or `dead` flags and dependencies. A card being built also shows a three-step track (Build, Review and Merge) with the current step lit, `Attempt N of M` and a thin bar with what it has spent against its cap (`$6.99 of $10`, amber from 70% and red from 100%); a failed or over-budget card says how it stopped when the fleet still knows. In Plan, Queue and Building a ticket that waits for another ticket in the same column stands under the ticket that blocks it, indented, with a connector line. On a screen 1024 px wide or more with a mouse, a draft can be dragged onto the Queue column to approve it, after a confirm step; the ticket drawer's Approve button stays the way to do it on a phone, a touch screen or with the keyboard. The Agents section lists each worker with its phase, note and burn meters; active and completed workers are split, and stale worktrees can be reaped from the UI.
- **Project identity (several projects at once).** The header and the browser tab name the project (`project.name` in the config, else the directory name), and each project's dashboard runs on its own port (see [Step 5](#step-5-start-fleet-control-optional-but-recommended)). `GET /api/identity` answers `{app, project, projectSource, root, port, pid}` (no token or config data; loopback reads need no token, other clients do) so tooling, and a second project's `start-dashboard.sh`, can tell whose dashboard holds a port. Pushes from `notify.sh` carry the same name: `[<name>] worker-fleet: <event>`.
- **Ring.** The whole fleet as one picture of three concentric parts: a core with one segment per worker slot (lit in the lamp colour of the ticket that holds it, with "5 of 8" and Running, Idle, Paused or Degraded in the centre), a ring of the tickets that wait (the ones that need you, in review or running without a slot always drawn one by one; ready, draft and being-written tickets one by one up to 14, 6 on a phone, then one count badge per status), and a rim with one tick per done ticket (the newest five lit, "+N older" above 200). Under it sit the "Needs you" list from the Board's own data and count chips that open one list per status; a click, tap or Enter on any ticket opens the ticket drawer, and ticks take the arrow keys on a wide screen. Three small CSS animations (a highlight around the core while the fleet runs, a very slow turn of the rim, a pulse on tickets that need you) all stop under reduced motion and forced colours. The Board stays the default view.
- **Graph.** The line's map of open work, built from the `Runs` column: rows by state (Stopped, In flight, Ready, Draft) and columns by how many levels of open work stand ahead (Clear, Waiting · 1 level, ...), with a "Can start now" line first, dispatch-ready rings, schematic lines from each dependency to the ticket that waits on it, and each card saying what it waits on and what it unblocks. Done tickets sit on a **Show done** shelf, **Find** reaches any ticket by id or title, and on a phone the same rows stack as lists.
- **Live updates (SSE).** The server pushes board, worker heartbeat, audit, config, swarm (`job/swarm-state.json`), router ledger (`job/router-state.json`: pipeline sub-badges, pause state, Dev Ports and burn bars) and remote-control intent (`job/control/`) changes over Server-Sent Events (`GET /api/events`, backed by a 1-second file watcher), so the UI updates instantly and the header shows `LIVE`. If the stream drops, the UI falls back to the 3-second poll (`POLL` badge) and retries the stream every 60 seconds.
- **Ticket drawer.** The Requirements (`rd.md`), Evaluation (`eval.md`) and Contract tabs render Markdown as formatted text; Results shows a per-check PASS/FAIL **checks grid** rendered from `results.json` plus recent commits; Evidence holds the full-resolution `agent-browser` screenshots and text logs; Logs follows the tail of the worker's logs.
- **Worker log streaming.** Workers tee their dev-server, tester and reviewer output into bounded files `job/logs/<ticket>-<phase>.log` via `.claude/scripts/log.sh` (2 MB cap per file; the tail keeps a `... truncated ...` marker). Read the last ~200 lines in the Logs tab or via `GET /api/logs?ticket=NNN&tail=N` (token required for non-loopback clients).
- **Audit.** Every `POST /api/action` (success or failure) appends a JSON line to `job/audit.jsonl` (timestamp, action, ticket, params, hashed client IP, outcome); the **Audit** view and token-protected `GET /api/audit` show the tail, and the view asks for the access token when this browser has none.
- **Telemetry.** Parses Claude Code session logs (`~/.claude/projects/`), the OpenCode SQLite database (`~/.local/share/opencode/opencode.db`) and Codex session logs (`~/.codex/sessions/`) for token burn, estimated USD, cache-hit savings and per-ticket attribution. The logic lives in `.claude/scripts/telemetry.py`, which attributes usage to real session and agent ids, prices it from the `telemetry.rates` table in the config, and powers a **window selector** (`run` since the router's start, `today`, `all`), an hourly **cost trend** chart, a **Reset baseline** button, and per-worker **burn meters** (turns and estimated USD counted since the ticket's first dispatch, against the ticket budget, amber from 75% and red at 100%) in the Agents section and a per-ticket table that sets the counted figure beside the ticket's total. Every cost is an estimate and is labelled `~ est.` in the UI.
- **Ports.** Port health and the latest watchdog report. The server runs `watchdog-check.sh --json` on startup and every `watchdog.intervalSeconds` (default 60) and writes `job/watchdog-report.json`; the LLM watchdog is only invoked, on demand, for anomalies the report cannot classify.
- **Mobile unblocking and actions.** Approve drafts, change priority, answer a blocked worker's question (written to `specs/tickets/NNN-slug/user-decision.md`), pause/resume/stop tickets and re-run the checker. All actions need the PIN token.

Manual operations:

```bash
bash .claude/scripts/watchdog-check.sh               # human-readable health report
bash .claude/scripts/watchdog-check.sh --json        # machine-readable report
bash .claude/scripts/watchdog-check.sh --reap        # dry-run: stale worker worktrees
bash .claude/scripts/watchdog-check.sh --reap --apply   # salvage then remove them
bash .claude/scripts/start-dashboard.sh --stop       # stop dashboard and tunnels
```

---

## Notifications

`bash .claude/scripts/notify.sh <event> "<message>" [ticket-id] [--dry-run]` pushes a message to your phone through pluggable providers: **ntfy** (primary, no account needed), **Telegram** and **Slack**. Providers live in `specs/worker-fleet.config.json` under `notifications.providers[]`; provider secrets (bot token, webhook, ntfy password) are not stored in the config, see [Notification secrets](#notification-secrets). `notify.sh` always uses the main checkout's config, `job/notify-secrets.json` and `job/logs/notify.log`, also when a worker runs it from its worktree under `.claude/worktrees/`. The dashboard stays the always-available fallback channel. With no provider configured the script is a silent no-op (exit `0`). A delivery failure is logged to `job/logs/notify.log` and never fails the caller. `--dry-run` prints the config path it used and the per-provider target and payload (secrets and the chat id are masked), and makes no network call.

### ntfy in 30 seconds

1. Pick a hard-to-guess topic name, e.g. `worker-fleet-k3x9q2` (on the public `ntfy.sh` server the topic is the only access control).
2. Install the ntfy app (iOS or Android) and subscribe to that topic.
3. Register it: `python3 .claude/scripts/apply-setup.py --notify-ntfy worker-fleet-k3x9q2`, or add the entry by hand:

```json
"notifications": { "providers": [
  { "type": "ntfy", "target": "worker-fleet-k3x9q2", "events": "all" }
] }
```

A bare topic posts to `https://ntfy.sh/<topic>`; a `target` starting with `http://` or `https://` is used as-is (self-hosted server).

### Telegram bot

1. In Telegram, message `@BotFather`, send `/newbot` and follow the prompts; copy the bot token it returns.
2. Open a chat with your new bot and send it any message (a bot cannot write first).
3. Find your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.chat.id`.
4. Store the bot token as described in [Notification secrets](#notification-secrets) and add the provider with a reference instead of the token:

```json
{ "type": "telegram", "botToken": { "secretRef": "telegram-1" }, "chatId": "<chat id>", "events": ["budget_exceeded", "needs_human"] }
```

   Use `{ "env": "WORKER_FLEET_TG_TOKEN" }` to read the token from an environment variable instead. Pasting the token inline and running `python3 .claude/scripts/apply-setup.py` right away also works: it moves the value to `job/notify-secrets.json` and leaves a `secretRef` behind.

### Slack webhook

1. Create a Slack app at `https://api.slack.com/apps` (From scratch), then enable **Incoming Webhooks**.
2. Choose **Add New Webhook to Workspace**, pick a channel and copy the webhook URL.
3. Store the webhook URL as described in [Notification secrets](#notification-secrets) and add the provider with a reference instead of the URL:

```json
{ "type": "slack", "webhook": { "secretRef": "slack-1" }, "events": "all" }
```

   Use `{ "env": "WORKER_FLEET_SLACK_WEBHOOK" }` to read it from an environment variable instead. Pasting the URL inline and running `python3 .claude/scripts/apply-setup.py` right away also works: it moves the value to `job/notify-secrets.json` and leaves a `secretRef` behind.

### Notification secrets

Three provider fields are secrets: the Telegram `botToken`, the Slack `webhook` and the ntfy `auth` (`<user>:<password>` for a protected topic, sent as Basic auth). They never live in the tracked config. A secret field takes one of three forms:

| Form | Example | Resolves to |
| --- | --- | --- |
| Reference | `{"secretRef": "telegram-1"}` | `secrets["telegram-1"]` in the gitignored `job/notify-secrets.json` |
| Environment | `{"env": "WORKER_FLEET_TG_TOKEN"}` | that environment variable |
| Inline (deprecated) | a plain string | itself, until `apply-setup.py` moves it |

An ntfy entry for a protected topic keeps the topic in `target` and the credentials in `auth`:

```json
{ "type": "ntfy", "target": "https://ntfy.example.com/alerts", "auth": {"secretRef": "ntfy-1"}, "events": "all" }
```

`job/notify-secrets.json` (gitignored with the rest of `job/`) holds the values:

```json
{
  "version": 1,
  "secrets": {
    "telegram-1": "<bot token from BotFather>",
    "slack-1": "<Slack incoming webhook URL>",
    "ntfy-1": "<user>:<password>"
  }
}
```

If you write the file by hand, run `chmod 600 job/notify-secrets.json`; `apply-setup.py` always writes it with mode `0600` and fixes a looser mode on its next run. A secret id matches `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, and an environment variable name must start with `WORKER_FLEET_` (so an edit to the tracked config cannot point a secret at an unrelated variable such as a cloud key).

- **Migration.** `python3 .claude/scripts/apply-setup.py` moves any inline secret it finds (a Telegram `botToken`, a Slack `webhook`, or `<user>:<password>@` in an ntfy `target` URL) into `job/notify-secrets.json` on its next run, leaves a reference behind, and never prints a value. It is idempotent: a second run changes nothing.
- **Resolution.** `notify.sh` and the dashboard resolve references when they need them. A secret that cannot be resolved is a logged delivery failure, never a crash.
- **`chatId` stays in the config.** It is an identifier that is useless without the bot token, and `notify.sh --dry-run` masks it.
- After `apply-setup.py` has run, `specs/worker-fleet.config.json` holds no notification secret and is safe to commit.

An ntfy topic is not treated as a secret: it is the address, and anyone who knows the topic can read and post to it on a public server, so committing the config publishes it. Use a hard-to-guess topic, or a protected topic with `auth`. Do not put credentials in `--notify-ntfy` (they reach shell history and the process list; `apply-setup.py` still moves them) or in a `?auth=` query, which is not migrated.

`python3 .claude/scripts/selftest.py` fails (`no_provider_secrets_in_files`) when a Telegram bot token, a Slack webhook or URL credentials sit in a file git would commit. If a secret already reached a commit, rotate it: see [Rotating a leaked notification secret](TROUBLESHOOTING.md#rotating-a-leaked-notification-secret).

### Events

`events` is `"all"` (the default when omitted) or a list of these names:

| Event | Fired when |
| --- | --- |
| `worker_blocked` | A worker is blocked on a decision. The message carries the question and options plus a deep link `<dashboard-url>/?ticket=NNN#decision` that opens the decision modal. |
| `budget_exceeded` | A ticket hit its budget cap. |
| `retries_exhausted` | A ticket used up its retries. |
| `ticket_done` | A ticket was merged. |
| `regression_confirmed` | A regression sweep confirmed a break. |
| `needs_human` | The router needs a human: a product decision, an escalation, or resuming a degraded swarm. |
| `watchdog_stall` | A worker's heartbeat is older than `watchdog.stallThresholdMinutes` (default 15) and its phase is not `done`, `failed` or `blocked`. In script mode the dashboard server pushes it once per stall episode, also when no router is running, and again only after that heartbeat was fresh again or gone; in agent mode the watchdog analyst pushes it. |

An unknown `type`, a missing required field or an unknown event name is a hard config error: `apply-setup.py` refuses to write the config and `notify.sh` exits `3`, naming the offending provider index. The deep link never contains the dashboard PIN token.

The dashboard header shows a bell chip (`no providers`, or e.g. `ntfy ✓ telegram ✓`), and `GET /api/state` returns `notifications.providers[]` with secrets masked as `****` plus the last 2 characters. The bot token, webhook URL and chat id are never served by the dashboard or printed by `notify.sh`. A secret that cannot be resolved shows as `****` on the dashboard, and its deliveries are logged as `secret unresolved` in `job/logs/notify.log`.

---

## Configuration reference

`specs/worker-fleet.config.json` (written by `/setup`, schema version `4.0.0`) is the central config. Key blocks: `harness`, `preset`, `models.<agent>`, `concurrency` (ports, `maxParallelWorkers`), `dashboard`, `watchdog` (`mode`, `intervalSeconds`, `stallThresholdMinutes`), `regression.everyNMerges`, `budget.defaults`, `landing`. The dashboard auth token is **not** stored here; it lives in the gitignored `job/dashboard-auth.json`.

---

## Landing modes (direct vs PR)

- **direct** (default): the merger merges verified tickets straight into `main`. Full autopilot.
- **pr**: `python3 .claude/scripts/apply-setup.py --landing pr`, or `## Landing` with `- Mode: pr` in a single ticket. The merger pushes the branch and opens a GitHub PR (body from `results.md` and evidence links); the ticket shows `in-review` and the router polls the PR until it is merged, then marks it `done`. Requires `gh` and an `origin` remote; `apply-setup.py` warns (non-fatal) when either is missing.

---

## Security model

The dashboard is deny-by-default and authenticates on the **client's socket address**; the `Host` header can only make a request stricter.

- **Local** means a loopback socket (`127.0.0.0/8`, `::1`) that carries none of the proxy headers: not `X-Forwarded-For`, not `CF-Connecting-IP`, and not any other proxy header (`Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `CF-Ray`, `CDN-Loop`, `True-Client-IP`, `Via`). The cloudflared and ngrok tunnels reach the server from loopback but always add such headers, so tunnel visitors are never local.
- A local request must also carry a `Host` that names `localhost` or an IP address (any port, or none), or no `Host` at all. Any other name is remote, which is the defence against **DNS rebinding** (a web page that makes its own domain resolve to 127.0.0.1): such a page gets the sign-in page and `401`, like any visitor without the token.
- Local clients (the browser on the host, the router's `curl` of `/api/telemetry`) may read without a token.
- LAN and tunnel visitors are **remote**. Without the token (`Authorization: Bearer`, `X-Auth-Token`, or the `wf_session` cookie) they get only a minimal "Sign in" page for `/` and `401` from every `/api/*` route. The sign-in page is the `?token=` bootstrap below in a form: it has no script and shows no project data.
- `POST /api/action` **always requires the token, even from loopback**, and the token is accepted **only in a header** (`Authorization: Bearer` or `X-Auth-Token`): the `wf_session` cookie alone is not accepted for actions, and a token in a query string is rejected. An action is refused with `403` when its `Origin` is not the dashboard's own (the `Host`, the tunnel URL or `X-Forwarded-Host`), or when its `Sec-Fetch-Site` is `same-site` or `cross-site` (every other port on `localhost` is the same site, so a page served by another dev server cannot trigger actions). It is refused with `415` unless the content type is `application/json`. The dashboard's buttons send the stored token in a header, and a browser that has only the cookie asks for the token first.
- First visit uses a one-time `/?token=<PIN>` bootstrap: the server sets an HttpOnly, SameSite=Lax `wf_session` cookie (30 days; also `Secure` when the visit came through the tunnel over https) and the page strips the parameter, so the PIN never persists in browser history or logs. A local visit (the Localhost URL) sets **no cookie**, because cookies are not separated by port, so every other server on `127.0.0.1` would receive it; a local `/` also clears a `wf_session` cookie that an earlier version set.
- **Five failed token attempts from one visitor lock that visitor out for 10 minutes** (in memory; resets on server restart). The lockout is counted **per visitor** and is keyed by the socket address for LAN clients, by the visitor address the configured tunnel reports for tunnel visitors, and by a separate key for the host. The tunnel key is chosen by `dashboard.tunnel.provider`: the `CF-Connecting-IP` header for `cloudflared`, the last (right-most) `X-Forwarded-For` entry for `ngrok`. With `local`, or a missing or unknown provider, every tunnel visitor shares one key. Keep the provider set to the tunnel you run, because `start-dashboard.sh --tunnel` does not change the config. A distinct wrong token **counts once**: an open tab re-sending a stale token adds nothing after its first failure. A blank credential (an empty cookie, `?token=` or Bearer) **never counts**, and local requests ignore the `wf_session` cookie, so another project's dashboard on another port cannot lock you out.
- There is **no tunnel-wide limit**: failures from other addresses do not lock out your phone, and a tunnel visitor can never lock out the host (the host is never locked out by LAN or tunnel traffic). The failure table holds at most 1024 addresses, and an entry expires 10 minutes after its last failure; while the table is full, addresses it has not seen share one overflow entry per kind (LAN or tunnel), which locks after 5 more failures. While a **shared entry** is locked (the one key every tunnel visitor shares under `local` or a missing or unknown provider, or an overflow entry of a full table), the **correct token** still gets in on every channel, and wrong tokens still get `429` and are not counted. This needs a token of at least **32 characters** (`apply-setup.py` generates 32); with a shorter hand-set token a locked shared entry refuses everyone, and a visitor's own lock still refuses even the correct token until it ends. The `[auth]` log lines hash the address with a random **per-process salt** (the same address hashes differently after a restart) and cut the path at 200 characters.
- Evidence files are served inert: PNG, JPEG, GIF and WebP as images and everything else (HTML, SVG, logs) as `text/plain`, always with `nosniff`, a sandbox Content-Security-Policy and `no-store`.
- **Responses never carry a secret.** Every JSON response and every text evidence file is served with the dashboard token, each configured notification secret (Telegram `botToken`, Slack `webhook`, also when kept in `job/notify-secrets.json` or an environment variable) and any `token=<32 hex>` value and the password in a `<scheme>://<user>:<password>@` URL, masked to `****` plus its last 2 characters, in keys as in values. Secrets shorter than 8 characters are not masked, and images are served unchanged.
- The app page is served with a strict `Content-Security-Policy`: a script runs only with the page's per-response `nonce`, and the page connects to and loads images from the dashboard itself only. It cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The browser keeps the token in `localStorage` for actions and the phone link, and the policy is what keeps an injected script from running or sending it elsewhere.
- No CORS headers are sent; the UI is served same-origin.
- The token lives only in gitignored `job/dashboard-auth.json`. A token that was ever committed is treated as burned and rotated by `apply-setup.py`; rotate on demand with `--regenerate-token`.
- Evidence paths are validated against traversal, remote actions can be disabled with `--remote-actions off`, and every action is audited.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for token rotation and lockout recovery.

---

## Self-tests

Run before merging any workflow change; the suite must pass:

```bash
python3 .claude/scripts/selftest.py              # full suite
python3 .claude/scripts/selftest.py --list       # check names
python3 .claude/scripts/selftest.py --filter auth  # subset
```

It builds a throwaway fixture repo, starts the real dashboard on an ephemeral port, and asserts the auth model, action validation, board parsing, evidence path safety, audit logging, `apply-setup.py` idempotence and no-secrets-in-tracked-files. The idempotence check ignores gitignored runtime artifacts (`job/`, `__pycache__/`, logs, temp files), so a scheduler rewriting `job/watchdog-report.json` cannot make it flake, while a real change to a generated file still fails it. Cheap pre-commit gates:

```bash
python3 -m compileall -q .claude/scripts
for f in .claude/scripts/*.sh; do bash -n "$f" || exit 1; done
```

---

## File structure

```text
.
├── .claude/
│   ├── settings.json                  # Enables Agent Teams & subagent depth 3
│   ├── dashboard/
│   │   └── index.html                 # Single-file Fleet Control web/mobile UI
│   ├── scripts/
│   │   ├── apply-setup.py             # Config migrations + multi-harness & agent generator
│   │   ├── dashboard-server.py        # Zero-dependency API + telemetry server (:3080)
│   │   ├── start-dashboard.sh         # Starts server + Cloudflare Tunnel/ngrok + QR code
│   │   ├── install.sh                 # Installs worker-fleet into an existing repo
│   │   ├── telemetry.py               # Token/cost attribution, run windows, history, price table
│   │   ├── browser.sh                 # Resolves a working agent-browser binary (AGENT_BROWSER_BIN override)
│   │   ├── selftest.py                # Zero-dependency self-test suite
│   │   ├── log.sh                     # Bounded (2 MB) log appender for job/logs/
│   │   ├── delegate-task.sh           # Hybrid CLI delegation bridge (Codex / OpenCode)
│   │   ├── router-wake.sh             # Zero-token wake watcher the router arms in the background (ticket 079)
│   │   └── watchdog-check.sh          # Stall, port & worktree checks (dashboard scheduler runs it every watchdog.intervalSeconds)
│   ├── skills/
│   │   ├── setup/
│   │   │   └── SKILL.md               # /setup interactive & flag-based configurator
│   │   └── write-tickets/
│   │       └── SKILL.md               # /write-tickets interview skill (rd.md + eval.md)
│   └── agents/
│       ├── router.md                  # Main orchestrator (Opus, high effort)
│       ├── watchdog.md                # On-demand one-shot analyst (router invokes it for unclassified anomalies)
│       ├── worker.md                  # Solo ticket builder (worktree-isolated)
│       ├── teammate.md                # Agent Team collaborator (contract.md)
│       ├── tester.md                  # Runs eval.md checks via browser.sh -> agent-browser
│       ├── reviewer.md                # Audits git diff against rd.md before commit
│       ├── merger.md                  # Lands passed branches (direct merge or PR) & updates board
│       ├── checker.md                 # Post-merge smoke test and regression sweep on port 3000
│       └── reproducer.md              # Bug reproducer & autofixer on port 3090
├── .agents/
│   └── skills -> ../.claude/skills    # Symlink so Codex-style harnesses find the skills
├── .opencode/
│   └── agents/                        # Auto-generated OpenCode subagent configs
├── opencode.json                      # Auto-generated OpenCode project configuration
├── specs/
│   ├── worker-fleet.config.json        # Central source of truth written by /setup
│   ├── regression.md                  # Curated R-N smoke flows walked by the checker's full mode
│   └── tickets/
│       ├── BOARD.md                   # Master ticket board (Status, Mode, Prio, Runs)
│       └── NNN-slug/                  # rd.md, eval.md, results.md + results.json, contract.md (team), evidence/
├── job/                               # Gitignored runtime state
│   ├── router-state.json              # Router run ledger
│   ├── status.json                    # Worker heartbeat (one per worktree)
│   ├── dashboard-auth.json            # Dashboard auth token (never committed)
│   ├── watchdog-report.json           # Latest script-mode watchdog report
│   ├── audit.jsonl                    # Append-only audit trail of dashboard actions
│   ├── swarm-state.json               # Swarm health (running / degraded) written by the router
│   ├── router-wake.lock/              # Single-watcher lock of router-wake.sh (pid file)
│   ├── router-wake-state.json         # Wake watcher baseline and last exit
│   ├── control/                       # Remote-control intents consumed by the router (NNN.json, _swarm.json, _dispatch.json)
│   └── logs/                          # Bounded worker phase logs (<ticket>-<phase>.log)
├── worker-fleet-guide.html              # Self-contained visual architecture & setup guide
├── TROUBLESHOOTING.md                 # Symptom / cause / fix runbook
├── CONTRIBUTING.md                    # Presets, agents, ticket conventions, migrations
├── CHANGELOG.md                       # Keep-a-Changelog release notes
├── .gitignore                         # Ignores runtime job/ and worktree artifacts
└── README.md
```

# Changelog

All notable changes to worker-fleet are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the workflow config schema follows [Semantic Versioning](https://semver.org/) (`version` in `specs/worker-fleet.config.json`).

## [Unreleased]

### Renamed to worker-fleet (tickets 089 and 090)
- Names: `agent-hive` -> `worker-fleet`; `Super-Agent` -> `Worker Fleet`; `Mission Control` -> `Fleet Control`.
- Config: `specs/super-agent.config.json` -> `specs/worker-fleet.config.json`; `apply-setup.py` moves the file and migrates the config schema to `4.0.0`.
- Environment variables: `AGENT_HIVE_` -> `WORKER_FLEET_`. Session cookie: `sa_session` -> `wf_session`.
- Visual guide: `agent-hive-guide.html` -> `worker-fleet-guide.html`.
- There is `no fallback`: the old config path, the old environment variables, the old identity value and the old cookie are no longer read. Existing installs follow [Upgrading an existing install](README.md#upgrading-an-existing-install).
- History was rewritten to the new names, mechanically: the entries below, `specs/PRD-v3.md` and the finished tickets `001-088`. Paths of the original checkout (`/home/tee/ai/agent-hive`) and the browser session names derived from its folder name are kept as recorded.

### Changed
- Branding: the project is named **worker-fleet** everywhere. The visual guide is now `worker-fleet-guide.html` (was `claude-worker-fleet-guide.html`); the README, dashboard title and header, server and `apply-setup.py` banners, and the `/setup` skill header use the new name. Config and on-disk filenames such as `specs/worker-fleet.config.json`, `.claude/worker-fleet.version` and `.worker-fleet-backup/` are unchanged on purpose.

### Added
- Fleet Control: a **Ring view** (ticket 091), a second tab after Board that draws the fleet as one picture: a core with a segment per worker slot, a ring of waiting tickets and a rim with a tick per done ticket, with a "Needs you" list and count chips under it, three small CSS animations that stop under reduced motion, and a phone layout. The Board is unchanged and stays the default.
- `TROUBLESHOOTING.md` (symptom / cause / fix for the common failure modes) and `CONTRIBUTING.md` (presets, notify providers, agents, ticket conventions, selftest and migration discipline).

## [3.0.0]

Config schema `3.0.0`. Tickets 001-023 first, then the follow-ups 025-035, one line each. Only the notification layer (012) is marked *(pending merge)*: it was specified for 3.0.0 but had not landed on `main` when this entry was written. Check `specs/tickets/BOARD.md` for its status.

- **001**: Dashboard auth hardening: authenticate on the socket address (not the Host header), token required for every POST including loopback, 5-failure/10-minute lockout, no wildcard CORS, one-time `?token=` cookie bootstrap.
- **002**: One canonical ticket status enum (`draft`, `ready`, `in-progress`, `blocked`, `done`, `failed`, `budget-exceeded`, `in-review`) with `BOARD.md` as the source of truth; dashboard token moved out of the tracked config into gitignored `job/dashboard-auth.json`.
- **003**: Router state persistence: durable run ledger `job/router-state.json`, crash adoption of fresh workers, reaping of stale worktrees (`watchdog-check.sh --reap`).
- **004**: Worker retry policy: bounded automatic retries (default 2) with previous-attempt findings handed to the next worker, `failed` on exhaustion, and a `needs-human` pause after three failures in a run.
- **005**: Enforced per-ticket budget caps ($10.00 and 300 turns by default): `maxTurns` hard stop, per-cycle USD monitoring, `budget-exceeded` (never auto-retried).
- **006**: Board priorities: `Prio` column (`P0`/`P1`/`P2`), P0-first dispatch, priority badges and remote re-prioritisation in the dashboard.
- **007**: Machine-readable `results.json` alongside `results.md`.
- **008**: Project-type eval templates (web, api, cli, library) with explicit check types `Browser`, `HTTP`, `CLI`, `Test`.
- **009**: Team contract template and lock protocol for `contract.md`, plus the reviewer's contract rule.
- **010**: Regression sweep: curated `specs/regression.md` walked by the checker's `full` mode after every merge (`regression.everyNMerges`).
- **011**: Log streaming: bounded `job/logs/` files via `log.sh`, `GET /api/logs` (token required except for loopback reads), and a Logs tab in the ticket drawer.
- **012**: Notification layer: `notify.sh` with ntfy, Telegram and Slack providers and event wiring *(pending merge)*.
- **013**: Remote control: pause, resume, stop a worker and re-run the checker from the dashboard via control-file intents the router executes.
- **014**: Telemetry rework: accurate attribution, run windows, history, configurable rates and live burn.
- **015**: Audit trail: every `/api/action` appended to `job/audit.jsonl`, token-protected `GET /api/audit`, and an Audit tab.
- **016**: Dependency graph: normalized `Runs` grammar, write-time validation of dependencies, and a DAG view with dispatch-ready highlighting.
- **017**: Script-mode watchdog: the dashboard server schedules `watchdog-check.sh` and writes `job/watchdog-report.json`; the LLM watchdog becomes an optional on-demand analyst.
- **018**: Budget preset and honest pricing.
- **019**: Installer: idempotent, non-destructive `install.sh <target-repo>` with backups, version stamp and next-step hints; `/setup install_into=<path>`.
- **020**: Self-tests: zero-dependency `selftest.py` covering auth, validation, board parsing, evidence path safety, audit logging, `apply-setup.py` idempotence and secret hygiene.
- **021**: Config migrations: `apply-setup.py` upgrades `2.0.0` configs to `3.0.0` with a per-key log; configs from a newer worker-fleet abort with exit code 3.
- **022**: Optional PR landing mode: `landing: "pr"` makes the merger open a GitHub PR and leave the ticket `in-review` until the router sees it merged.
- **023**: Optional implementation delegation: workers may route `rd.md`-listed mechanical subtasks through `delegate-task.sh` when `models.worker.delegateCli` is `codex` or `opencode`.
- **025**: Agent-death surfacing: a dead worker, merger or watchdog session is marked `failed` with its cause, shown distinctly in the dashboard, provider-wide failures put the swarm in a `degraded` state that pauses dispatch, and single deaths auto-re-dispatch under the retry policy.
- **026**: Matrix cleanup: Active vs Completed/Failed split in the worker matrix and `watchdog-check.sh --reap-completed` (manual `--apply`) for merged worktrees.
- **027**: SSE event stream: `GET /api/events` pushes board, worker, audit and config changes to the dashboard (LIVE badge), with automatic fallback to 3-second polling.
- **028**: `continue` / Resume Swarm: one chat word or dashboard button (`job/control/_swarm.json`) runs a documented resume cycle for a stopped or degraded swarm.
- **029**: The selftest `apply_setup_idempotent` check ignores gitignored runtime artifacts, so it no longer flakes.
- **030**: `apply-setup.py` masks the dashboard auth token in its summary; the new `--show-token` flag prints it in full.
- **031**: `set_ticket_status` rewrites `BOARD.md` atomically under the board lock, like `set_ticket_priority`.
- **032**: Installer hardening: `install.sh --help`, a pre-flight symlink walk over every destination, physical-path overlap checks, literal pathspecs, and a clear error for an unusable backup dir.
- **033**: `browser.sh` resolves a working `agent-browser` binary (`AGENT_BROWSER_BIN`, `PATH`, known install locations) for the tester, checker and reproducer.
- **034**: Eval templates capture real exit codes (`set -o pipefail` around pipes into `tee`, explicit `exit=<code>`).
- **035**: Stale text cleanup: the dashboard title shows the port actually served, and the watchdog descriptions match the ticket-017 scheduler.

### Security
- 001 and 002 close the LAN auth bypass and remove the committed dashboard token (a previously committed token is treated as burned and rotated).

## [2.0.0]

- Multi-harness configurator (`/setup`): Claude Code, OpenCode and Codex CLI, four model presets, generated `.opencode/agents/*` and `opencode.json`.
- Fleet Control Dashboard (`:3080`) with Cloudflare Tunnel or ngrok access, evidence gallery and token telemetry.

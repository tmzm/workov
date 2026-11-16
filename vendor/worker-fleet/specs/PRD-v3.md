# Worker Fleet Workflow v3 — Improvement PRD

**Status:** draft (awaiting user review)
**Date:** 2026-11-07
**Source:** Full-codebase gap analysis of Worker Fleet Workflow v2 (`worker-fleet`) — all 9 agents, 2 skills, 5 scripts, dashboard server + UI, config, and docs were read line-by-line.
**Decisions locked with user:** All six improvement areas in scope · personal-use first, distribution second (phased) · full autopilot recovery · notification layer with ntfy/Telegram/Slack adapters · direct-to-main landing with optional PR mode · eval templates for web/API/CLI/library projects · enforced $ + turn budget caps · PRD-first, then tickets.

---

## 1. Executive summary

v2 is a working multi-harness agent swarm: ticket specs, worktree-isolated workers, tester/reviewer gates, merge + post-merge checks, and a zero-dependency Fleet Control dashboard with mobile tunnel access. It works — but it is **unsafe to expose** (real auth bypass + a committed secret), **fragile unattended** (no retry, budget, or crash-recovery policy), **opaque** (free-text results, heuristic telemetry, no logs, no push alerts), and **hard to share** (no installer, no self-tests, web-only eval templates).

v3 makes the swarm **safe, self-healing, observable, and distributable** — without breaking the zero-dependency constraint or the existing ticket/agent contracts.

---

## 2. What v2 is today (baseline)

- **Agents (9):** `router` (orchestrator, never codes) · `watchdog` (LLM agent looping a bash check every 10 min) · `worker` (solo tickets in git worktrees, heartbeat `job/status.json`) · `teammate` (team tickets via `contract.md`) · `tester` (runs `eval.md` verbatim, `agent-browser`) · `reviewer` (4-rule read-only diff audit) · `merger` (lands on main, marks done) · `checker` (post-merge smoke on :3000, repro×2) · `reproducer` (bug triage on :3090).
- **Skills (2):** `/setup` (presets → `apply-setup.py` regenerates agent frontmatter + `opencode.json`) · `/write-tickets` (interview → `rd.md` + `eval.md` + `BOARD.md`).
- **Fleet Control (:3080):** Python-stdlib server + single-file dark UI — live Kanban, worker/port matrix, evidence lightbox, token/cost telemetry (Claude/OpenCode/Codex log parsing), PIN-protected actions, Cloudflare/ngrok tunnel + QR.
- **Ticket flow:** `/write-tickets` → approve `ready` → router dispatches ≤ `maxParallelWorkers` workers on :3101+ → verify E-1..E-N + evidence → merge → check → unblock dependents.

---

## 3. Goals & non-goals

### Goals
1. **Safe to expose** — close every auth/secret hole; safe to tunnel and to push the repo.
2. **Runs unattended** — full autopilot: retries, stall recovery, budget enforcement, router-crash adoption; the user is pinged only for genuine product decisions.
3. **Observable** — machine-readable results, live logs, accurate cost telemetry, push notifications, audit trail.
4. **Verifies more** — tests + typecheck by default, project-type-aware eval templates, regression sweep, team contract template.
5. **Cheaper by default** — script-mode watchdog, per-ticket budgets, budget preset.
6. **Shareable** — installer, self-tests, config migrations, optional PR landing, troubleshooting docs.

### Non-goals (this cycle)
- Multi-user accounts/roles on the dashboard.
- Replacing the Python-stdlib server or bash scripts with Node/Go/services — the zero-dependency constraint stays.
- A native mobile app (dashboard stays a web page; PWA noted as future).
- Windows-native support beyond documented WSL guidance.
- Auto-fixing regressions beyond the existing reproducer flow.

---

## 4. Personas

- **Fleet owner (primary):** solo developer running the swarm on their own projects; wants it to run overnight, spend predictably, and only interrupt them for real decisions — on their phone.
- **Distributable user (secondary, Phase 5):** developer installing the workflow into an existing repo; expects one command, no breakage, and docs that answer failures without reading source.

---

## 5. Problem inventory (the missing ideas, with IDs)

### 🔴 A. Critical defects (found in v2 code)
| ID | Problem | Where |
| --- | --- | --- |
| P-1 | **LAN auth bypass:** `_is_authenticated()` returns `True` for any request whose `Host` header is not localhost/trycloudflare/ngrok. Server binds `0.0.0.0` → any LAN device gets full access incl. POST actions. | `dashboard-server.py` |
| P-2 | **Secret committed:** live `authToken` sits in tracked `specs/worker-fleet.config.json`; `job/` (correct home) is gitignored. Repo push = leaked PIN. | config + `.gitignore` |
| P-3 | **PIN in query string + wildcard CORS:** token travels in URLs (history/logs) and every endpoint answers `Access-Control-Allow-Origin: *`; no rate limiting on token guesses. | server + UI + `start-dashboard.sh` |
| P-4 | **Status model mismatch:** `BOARD.md` defines only `draft\|ready\|done`; dashboard can write `in-progress`/`blocked` into it; UI derives them from heartbeats; README promises 5 states. No single source of truth, no `failed`/`budget-exceeded` states. | board + server + agents |

### 🟠 B. Reliability & autopilot gaps
| ID | Problem |
| --- | --- |
| P-5 | No retry policy: a failed worker is never re-dispatched; no `maxRetries`, no failure context handoff, no `failed` terminal state. |
| P-6 | No stall recovery: watchdog alerts, but nothing kills/re-dispatches a stalled worker. |
| P-7 | No router crash recovery: router state lives only in its session; restart orphans worktrees and in-flight tickets (no adopt/reap). |
| P-8 | No budget caps: cost visible only after the burn; can't stop a runaway worker. `maxTurns` static per agent, no per-ticket budgets. |
| P-9 | No priorities: dispatch is board-table order only; no P0/P1/P2. |

### 🟡 C. Verification & quality gaps
| ID | Problem |
| --- | --- |
| P-10 | `results.md` is free text — router must parse markdown to verify; dashboard can't render per-check PASS/FAIL. No `results.json`. |
| P-11 | Default automated checks are only `build` + `lint` — no `test`, no `typecheck`. |
| P-12 | Eval templates assume a web app (`npm run dev` + `agent-browser`); unusable for APIs, CLIs, libraries. |
| P-13 | `contract.md` (team mode) has no template/schema — reinvented per team, lock protocol informal. |
| P-14 | No regression sweep: `checker` only walks the newest feature + neighbors; whole-app health is never re-verified. |

### 🟢 D. Dashboard & mobile gaps
| ID | Problem |
| --- | --- |
| P-15 | No log streaming: only the `status.json` heartbeat summary is visible; no worker/dev-server/agent logs, no `/api/logs`. |
| P-16 | No push notifications: user must poll; nothing reaches a phone when a worker blocks, budget hits, or a ticket lands. |
| P-17 | Only 3 remote actions (`set_ticket_status`, `submit_decision`, `trigger_watchdog`); can't pause a ticket, stop a worker, or re-run the checker from mobile. |
| P-18 | Telemetry is heuristic: Claude role attribution by filename/entrypoint guessing; **all** Codex tokens booked to "reviewer"; hard-coded price table; 100-file cap; no time windows, no run scoping, no trends/history, no reset. |
| P-19 | No audit trail of dashboard actions (who did what, when). |
| P-20 | No dependency visualization; the `Runs` free-text column is never validated or rendered as a graph. |

### 🔵 E. Ecosystem & distribution gaps
| ID | Problem |
| --- | --- |
| P-21 | No installer: the workflow only exists if you already have the folder; no idempotent `install into existing repo` path. |
| P-22 | No self-tests: server, auth, board parsing, action validation, `apply-setup` idempotency are all untested. |
| P-23 | No config migrations: schema version exists (`2.0.0`) but nothing migrates it. |
| P-24 | No PR landing mode: merger never pushes; teams/review workflows are impossible. |
| P-25 | Delegation (`delegate-task.sh`) wired for **reviews only**; no option to delegate well-scoped **implementation** to Codex/OpenCode. |
| P-26 | No troubleshooting/contributing/changelog docs; failure modes (port conflicts, stale worktrees, token rotation) are tribal knowledge. |

### 💸 F. Cost gaps
| ID | Problem |
| --- | --- |
| P-27 | Watchdog is an LLM agent looping a bash script every 10 min — hundreds of wasted tokens/day for a job a scheduler does for free. |
| P-28 | No budget-minded preset; price table hard-coded (drifts from real pricing); estimates not labeled as estimates. |

---

## 6. Roadmap overview

| Phase | Theme | Tickets | Depends on |
| --- | --- | --- | --- |
| **0** | Critical fixes (security + status model) | 001, 002 | — |
| **1** | Autopilot reliability | 003–006 | 002 |
| **2** | Verification rigor | 007–010 | 002 (007); alongside otherwise |
| **3** | Dashboard power | 011–016 | 001 (server/UI tickets); alongside otherwise |
| **4** | Cost optimization | 017–018 | 001, 003 |
| **5** | Ecosystem & distribution | 019–024 | 002 (022); alongside otherwise |

Phases 0–2 make it safe and self-healing (personal core). Phases 3–4 make it observable and cheap. Phase 5 makes it shareable.

---

## 7. Detailed requirements

### Phase 0 — Critical fixes

**FR-0.1 (P-1) Deny-by-default auth.** `_is_authenticated()` must authenticate by **client address** (`self.client_address[0]` in `127.0.0.0/8`/`::1`), not `Host`-header heuristics. Loopback without token: allowed read-only. Everything else (incl. LAN and tunnel): valid token required via `Authorization: Bearer` or `X-Auth-Token` header or session cookie only. `POST /api/action` requires a valid token **always**, including loopback.
**FR-0.2 (P-1) Rate limiting.** Failed auth attempts per IP: 5 strikes → 10-minute lockout (in-memory counter; no dependency).
**FR-0.3 (P-2) Secret out of the repo.** The canonical token lives **only** in `job/dashboard-auth.json` (gitignored). `specs/worker-fleet.config.json` stores no token (field removed / kept empty as reference only). `apply-setup.py` migrates on next run and **rotates** any token previously stored in the config (the current value is considered burned). `start-dashboard.sh` reads only `job/dashboard-auth.json`.
**FR-0.4 (P-3) No PIN in URLs; tight CORS.** First visit may carry `?token=…` exactly once: the server responds by setting an HttpOnly session cookie and the UI strips the query param (`history.replaceState`). Thereafter auth uses the cookie/header. Token in query is rejected for POST actions outright. `Access-Control-Allow-Origin` drops `*` → same-origin only (tunnel domain included).
**FR-0.5 (P-4) Canonical status model.** Single enum everywhere: `draft | ready | in-progress | blocked | done | failed | budget-exceeded | in-review (PR mode only)`.
 - `BOARD.md` is the **only** source of truth for ticket status; the dashboard renders derived display state (e.g. stalled worker badge) but never persists derived states to the board.
 - `set_ticket_status` validates against the enum and rejects unknown values.
 - Writers: `/write-tickets` → `draft`; user/router → `ready`; worker heartbeat → `in-progress`/`blocked` (router mirrors to board); merger → `done` (or `in-review`); router → `failed`/`budget-exceeded`.
 - Update `BOARD.md` header docs, `rd.md` template, both agent sets, README, and dashboard column rendering (adds `failed`/`budget-exceeded` columns).

### Phase 1 — Autopilot reliability

**FR-1.1 (P-7) Router state persistence & adoption.** Router maintains `job/router-state.json`: `{ runId, startedAt, dispatched: [{ticket, agentId, port, account, retries, budget:{usd,turns,turnsUsed,estCostUsd}, status}], pendingDecisions: [...] }`, rewritten on every dispatch/transition. On session start, the router reconciles this file with `git worktree list` and heartbeat freshness: fresh heartbeat → adopt (message the worker to resume); stale/no heartbeat → reap (safe `git worktree remove --force` after confirming no uncommitted spec evidence, ticket back to `ready`, counts as one retry).
**FR-1.2 (P-5) Retry policy.** Per-ticket `maxRetries` (default **2**, overridable in `rd.md`). A worker that ends non-done (fail, stall-kill, reap) is re-dispatched once per retry with a **failure handoff**: the previous attempt's `job/status.json` note + tester/reviewer findings injected into the new worker's prompt. Retries exhausted → ticket `failed`, alert, router continues with other tickets. Three `failed` tickets in one run → `needs-human` alert and autopilot pauses new dispatches.
**FR-1.3 (P-6) Stall kill.** When the watchdog reports a stalled worker (heartbeat > `stallThresholdMinutes`), the router stops that agent (`TaskStop`), marks the ticket back to `ready` (counts as a retry), and re-dispatches — no human input.
**FR-1.4 (P-8) Enforced budgets.** Per-ticket defaults (overridable in `rd.md` `## Budget`): **$5.00 estimated cost and 250 worker turns**.
 - Turns: worker spawned with `maxTurns = ticket budget`; worker reports `turnsUsed`/`estCostUsd` in every `status.json` update.
 - Dollars: router re-computes per-ticket cost each cycle from the telemetry module (see FR-3.5) and `job/router-state.json`.
 - Cap hit → router stops the worker, ticket → `budget-exceeded`, alert with burn summary. `budget-exceeded` tickets are never auto-retried.
**FR-1.5 (P-9) Board priorities.** New `Prio` column (`P0|P1|P2`, default `P1`). Router dispatch order: dependencies satisfied → `P0` before `P1` before `P2` → board order. `/write-tickets` writes the column; dashboard renders and sorts by it; `set_ticket_status` extended to update `Prio` too.

### Phase 2 — Verification rigor

**FR-2.1 (P-10) Machine-readable results.** New `specs/tickets/NNN-slug/results.json` schema (written by worker/tester, next to `results.md` which remains the human narrative):
```json
{
  "ticket": "NNN-slug", "branch": "…", "finishedAt": "ISO-8601",
  "automated": {"build": "PASS", "lint": "PASS", "test": "PASS|SKIP|FAIL", "typecheck": "PASS|SKIP|FAIL"},
  "checks": [{"id": "E-1", "title": "…", "status": "PASS|FAIL|SKIP", "evidence": "evidence/E-1.png", "exitCode": 0}],
  "reviewer": "APPROVED|CHANGES_REQUIRED",
  "budget": {"turnsUsed": 87, "estCostUsd": 1.42}
}
```
Router verification reads `results.json` (markdown parsing becomes fallback only). Dashboard ticket drawer renders per-check PASS/FAIL badges from it.
**FR-2.2 (P-11) Stronger defaults.** `/write-tickets` eval template includes `test` and `typecheck` rows whenever the repo has the corresponding scripts (detected during the mandatory codebase read); missing scripts → `SKIP` recorded explicitly, never silently.
**FR-2.3 (P-12) Project-type eval variants.** Four templates selected automatically by `/write-tickets` from the detected stack, with matching tester check types:
 - **web** (current) — dev server + `agent-browser` (check type `Browser`)
 - **api** — server + HTTP assertions via `agent-browser fetch`/`curl` (status codes, JSON payloads) (check type `HTTP`)
 - **cli** — run commands, assert stdout/exit codes, save logs as evidence (check type `CLI`)
 - **library** — unit tests + build output + (optional) consumer smoke via a temp example project (check type `Test`)
 `tester.md` instructions extended to treat check `Type` as authoritative.
**FR-2.4 (P-13) Team contract template.** `contract.md` gets a fixed skeleton: shared API routes & payloads, DB/state schema, shared types, **file-ownership map** (glob per teammate), integration seams, and a `**Locked:** yes|no` flag with named confirmations. `/write-tickets` scaffolds it for `team` tickets; `teammate.md` requires the lock flag before implementation; reviewer Rule 0 becomes "contract locked & respected".
**FR-2.5 (P-14) Regression sweep.** Optional `specs/regression.md` (curated smoke list of critical flows, written once via `/write-tickets regression` or generated from past evals). `checker` gains `full` mode that walks it; triggered (a) manually from the dashboard, (b) optionally after every N merges (config `regression.everyNMerges`, default off), (c) on demand by the router. Confirmed breaks route to `reproducer` as today.

### Phase 3 — Dashboard power

**FR-3.1 (P-15) Log streaming.** Workers/teammates/dev-servers tee output to `job/logs/<ticket>-<phase>.log` (bounded, last ~2 MB, rotated). Server adds `GET /api/logs?ticket=NNN[&tail=200]` (auth required). UI ticket drawer gains a **Logs** tab with tail view + auto-refresh.
**FR-3.2 (P-16) Notification layer.** New zero-dependency `.claude/scripts/notify.sh <event> <json>` posting to configured providers — **ntfy** (primary, no account), **Telegram bot**, **Slack webhook** — configured in `specs/worker-fleet.config.json` (`notifications.providers[]`, each `{type, target, events[]}`; validated by `/setup`). Events: `worker_blocked` (with the Option A/B question!), `budget_exceeded`, `retries_exhausted`, `ticket_done`, `regression_confirmed`, `needs_human`, `watchdog_stall`. The blocked-event message includes the decision question and a deep link to the dashboard decision modal — answering from the phone stays one tap. Any agent may fire `notify.sh`; the server also fires on board transitions it observes.
**FR-3.3 (P-17) Remote control.** New **control-file intents**: the dashboard POSTs to `/api/action` (`pause_ticket`, `resume_ticket`, `stop_worker`, `rerun_checker`), the server writes `job/control/<ticket>.json` (`{action, issuedAt, by}`), and the **router consumes the queue every cycle and executes** (TaskStop, re-dispatch, etc.), then clears the file. Audit-logged (FR-3.6). This keeps the server non-privileged and the router as the single actor touching agents.
**FR-3.4 (P-19) Audit trail.** Every `/api/action` call appends to `job/audit.jsonl`: `{ts, action, ticket, params, clientIpHash, outcome}`. New dashboard **Audit** tab (admin view, auth required).
**FR-3.5 (P-18) Telemetry rework.**
 - **Accurate attribution:** OpenCode — join `session`/`message` tables on real agent/session IDs; Claude — read `subagent_type`/session lineage from the JSONL records instead of filename guessing; Codex — attribute by the invoking script/context (review vs. reproduce), not a hard-coded "reviewer".
 - **Run scoping:** every router run stamps a `runId` (`job/router-state.json`); telemetry gains `?window=run|today|all` and a **Reset** action that clears the aggregation baseline (`job/telemetry-baseline.json`).
 - **History & trends:** server snapshots hourly aggregates to `job/telemetry-history.json` (bounded ring, e.g. 30 days); dashboard renders cost/tokens-per-day sparklines and per-ticket bars.
 - **Pricing:** rate table moves to `specs/worker-fleet.config.json` (`telemetry.rates`, preset defaults, user-overridable); all figures labeled **estimate**.
**FR-3.6 (P-20) Dependency graph.** `Runs` values normalized to a parseable form (`alongside` | `after: NNN[,NNN]`). `/write-tickets` validates references at write time; the server parses them into a DAG; the dashboard renders an SVG dependency graph per ticket and highlights dispatch-ready tickets; cycles are rejected at write time.

### Phase 4 — Cost optimization

**FR-4.1 (P-27) Script-mode watchdog.** The dashboard server schedules `watchdog-check.sh` natively every 60 s (config `watchdog.mode: "script"|"agent"`, default **script**), writing `job/watchdog-report.json` (stalls, ports, decisions, anomalies). The LLM `watchdog` agent becomes an optional **analyst** invoked by the router only when the report flags an anomaly it can't classify (or in `agent` mode for users who want conversational diagnosis). Result: watchdog token cost ≈ $0 in default mode.
**FR-4.2 (P-28) Budget preset & honest pricing.** New `budget` preset: cheapest sensible models per role (mini-class testers/checkers/mergers, mid-class workers, strong-but-cheap reviewer), documented cost-per-role table; `deepseek-lean` refreshed to current model IDs. Every cost figure in the UI labeled `~ est.` with rates sourced from config (FR-3.5).
**FR-4.3 (P-8 support) Turn accounting.** Workers self-report `turnsUsed` in heartbeats (FR-1.4); the dashboard worker matrix shows `turns 132/250` and `~$1.42 / $5.00` progress bars.

### Phase 5 — Ecosystem & distribution

**FR-5.1 (P-21) Installer.** `.claude/scripts/install.sh <target-repo>` — idempotent, non-destructive (backs up colliding files to `.worker-fleet-backup/<ts>/`), copies agents/skills/scripts/dashboard + specs skeleton, stamps `.claude/worker-fleet.version`, prints next steps (`/setup`, `/write-tickets`). `/setup` gains `install_into=<path>` flag. Install-over-existing-version upgrades config via migrations (FR-5.3).
**FR-5.2 (P-22) Self-tests.** `python3 .claude/scripts/selftest.py` — spins the server on an ephemeral port and asserts: FR-0.1 bypass is closed (LAN-spoofed Host rejected), FR-0.2 lockout works, board parsing, action validation, evidence path traversal blocked, `apply-setup.py` idempotency (run twice → zero diff), `notify.sh` dry-run. Exit 0/1; CI-ready; documented.
**FR-5.3 (P-23) Config migrations.** `apply-setup.py` gains a migration step keyed on `config.version` (2.0.0 → 3.0.0: remove token, add `notifications`, `watchdog.mode`, `telemetry.rates`, budget defaults), printing a migration log; unknown future versions refuse to run destructively.
**FR-5.4 (P-24) Optional PR landing.** Config `landing: "direct"|"pr"` (default direct) + per-ticket override in `rd.md`. PR mode: merger pushes the branch (`gh` CLI required, checked by `/setup`), opens a PR with `results.md` body + evidence links, board → `in-review`, dashboard links the PR; merger polls `gh pr view --json state` each cycle and marks `done` when merged. Full autopilot stays on direct mode; PR mode is the human-gate option.
**FR-5.5 (P-25) Implementation delegation (optional, off by default).** `models.worker.delegateCli` may be `codex|opencode`; when enabled, the worker may route **well-scoped, mechanical subtasks** (listed in `rd.md ## Delegatable subtasks`) through `delegate-task.sh <cli> exec`; the worker stays responsible: it reviews the delegated diff itself and the normal `tester`/`reviewer` gates still run. Guardrails: never for tickets with schema/architectural work; delegated output is quarantined to a branch before the worker inspects it.
**FR-5.6 (P-26) Docs pack.** `TROUBLESHOOTING.md` (port conflicts, stale worktrees, token rotation, tunnel failures, adoption/reap semantics), `CONTRIBUTING.md` (how to add a preset/adapter/agent, ticket conventions), `CHANGELOG.md`, README v3 rewrite covering new statuses, budgets, notifications, installer, and self-tests.

---

## 8. Non-functional requirements

- **N-1 Zero-dependency preserved:** server and scripts remain Python 3.8+ stdlib + bash. No npm/pip installs for the workflow itself. `notify.sh` uses `urllib`/`curl`.
- **N-2 Backward compatibility:** existing `BOARD.md` rows, ticket folders, and `rd.md/eval.md` files keep working; new columns/statuses degrade gracefully (missing `Prio` → `P1`; missing `results.json` → markdown fallback).
- **N-3 Security defaults:** deny-by-default auth, no secrets in tracked files (enforced by a selftest grep), bounded logs, path-traversal-safe evidence serving (already present — kept and tested).
- **N-4 Linux/macOS first:** `stat`/`lsof` fallbacks already present; Windows documented as WSL-only.
- **N-5 Cost ceilings:** every agent's `maxTurns` remains bounded; script watchdog introduces no token spend; notification payloads ≤ 1 KB.

---

## 9. Data & schema contracts (summary)

| Artifact | Contract |
| --- | --- |
| `job/dashboard-auth.json` | Sole home of `{authToken, dashboardPort, allowRemoteActions}` (existing shape, now canonical). |
| Status enum | `draft, ready, in-progress, blocked, done, failed, budget-exceeded, in-review` — board is truth. |
| `job/router-state.json` | Run + dispatch + retry + budget ledger (FR-1.1/1.2/1.4). |
| `job/status.json` (worker) | Existing fields + `turnsUsed`, `estCostUsd`, `attempt`. |
| `specs/tickets/NNN/results.json` | FR-2.1 schema; router gate + dashboard render source. |
| `job/control/<ticket>.json` | `{action, issuedAt, by}` intents consumed by the router. |
| `job/audit.jsonl` | Append-only action log. |
| `job/watchdog-report.json` | Machine-readable watchdog output (script mode). |
| `job/telemetry-history.json` | Bounded hourly aggregates (30-day ring). |
| Config additions | `notifications.providers[]`, `watchdog.mode`, `telemetry.rates`, `landing`, `budget.defaults {usd, turns}`, `regression.everyNMerges`; `tunnel.authToken` **removed**. |

---

## 10. Proposed ticket breakdown (for the `/write-tickets` pass after PRD approval)

| # | Title | Mode | Runs | Phase |
| --- | --- | --- | --- | --- |
| 001 | Auth hardening: deny-by-default, lockout, no-token-in-URL, tight CORS | solo | alongside | 0 |
| 002 | Canonical status model + secret relocation & token rotation | solo | alongside | 0 |
| 003 | Router state persistence, crash adoption & worktree reaping | solo | waits for 002 (status states) | 1 |
| 004 | Retry policy with failure handoff + `failed`/`needs-human` escalation | solo | waits for 002, 003 | 1 |
| 005 | Enforced per-ticket budgets ($ + turns) with status + alerts | solo | waits for 002, 003 | 1 |
| 006 | Board `Prio` column + priority dispatch + UI sorting | solo | waits for 002 | 1 |
| 007 | `results.json` schema, writer, router gate, dashboard check badges | solo | waits for 002 | 2 |
| 008 | Project-type eval templates (web/api/cli/library) + tester types | solo | alongside | 2 |
| 009 | Team `contract.md` template + lock protocol + reviewer Rule 0 | solo | alongside | 2 |
| 010 | Regression sweep (`specs/regression.md` + checker `full` mode) | solo | waits for 008 | 2 |
| 011 | Log streaming (`job/logs` + `/api/logs` + Logs tab) | solo | waits for 001 | 3 |
| 012 | Notification layer: `notify.sh` + ntfy/Telegram/Slack adapters + events | team | waits for 001 (server/config) | 3 |
| 013 | Remote control via control-file intents + UI buttons | solo | waits for 003 | 3 |
| 014 | Telemetry rework: attribution, run windows, history, config rates | solo | waits for 001 | 3 |
| 015 | Audit trail (`job/audit.jsonl` + Audit tab) | solo | waits for 001 | 3 |
| 016 | Dependency graph: normalized `Runs`, validation, SVG render | solo | waits for 002 | 3 |
| 017 | Script-mode watchdog (server-scheduled, agent optional) | solo | waits for 001, 003 | 4 |
| 018 | `budget` preset + refreshed `deepseek-lean` + honest cost labels | solo | waits for 014 | 4 |
| 019 | Installer (`install.sh` + `/setup install_into`) | solo | waits for 021 (version stamp) | 5 |
| 020 | Self-tests (`selftest.py`) | solo | waits for 001, 002 | 5 |
| 021 | Config migrations (2.0.0 → 3.0.0) | solo | waits for 002 | 5 |
| 022 | Optional PR landing mode | solo | waits for 002 (in-review status) | 5 |
| 023 | Optional implementation delegation for workers | solo | waits for 004 | 5 |
| 024 | Docs pack: TROUBLESHOOTING / CONTRIBUTING / CHANGELOG / README v3 | solo | waits for all prior (last) | 5 |

Team-mode note: **012** is the natural first `team` ticket (server adapter surface + agent wiring + dashboard config UI), exercising the new contract template (009) for real.

---

## 11. Success metrics

| Area | Metric | Target |
| --- | --- | --- |
| Security | Selftest auth-bypass probe (spoofed Host, LAN-simulated client) | Rejected 100% |
| Security | Secrets grep over tracked files | 0 hits |
| Reliability | Router killed mid-run → new router fully adopts state | ≤ 1 watchdog cycle, zero lost tickets |
| Reliability | Injected worker stall → auto kill + re-dispatch, no human input | ≥ 90% of test cases |
| Budget | Ticket exceeding cap → stopped + `budget-exceeded` + alert | 100%, within one cycle |
| Observability | Per-check PASS/FAIL visible in dashboard from `results.json` | All E-1..E-N rendered |
| Cost | Watchdog token spend in script mode (telemetry delta) | ≈ $0 |
| Cost | Per-ticket cost estimate visible **during** the run (not after) | Heartbeat refresh ≤ 60 s |
| Distribution | Fresh repo + `install.sh` + `/setup` + `/write-tickets` → first dispatched ticket | ≤ 10 minutes, no manual file edits |

---

## 12. Open questions (to settle at PRD review)

1. **Budget defaults** — are `$5 / 250 turns` per ticket the right defaults, or higher/lower for your typical tickets?
2. **Notification primary channel** — ntfy first (recommended); after that, Telegram or Slack as the second adapter to build in 012?
3. **Watchdog mode default** — `script` (recommended, ~$0) or keep `agent` as default for the first release and flip later?
4. **Naming** — keep "Worker Fleet Workflow v3" as the public name, or adopt the repo name ("worker-fleet") as the brand?
5. **Regression sweep cadence** — manual-only for now (recommended), or auto after every N merges (and what N)?

---

## 13. Out of scope (explicit)

Multi-user auth/roles · server rewrite in another runtime · native mobile app / PWA (future note only) · Windows-native beyond WSL docs · auto-fixing regressions beyond the reproducer flow · cross-machine distributed workers · marketplace/plugin system for third-party adapters.

---

*After you review and adjust this PRD, the next step is a single `/write-tickets` pass that materializes tickets 001–024 as `rd.md` + `eval.md` pairs on `BOARD.md` in `draft`, ready for you to mark `ready` in whatever batches you choose.*

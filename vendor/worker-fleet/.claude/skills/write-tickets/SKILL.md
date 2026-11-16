---
name: write-tickets
description: "Turn feature requests into tickets that workers can build in parallel without asking questions. Each feature gets its own folder with rd.md (the requirements) and eval.md (a concrete, pass/fail way to check the feature was built correctly, picking one of four project-type templates: web, api, cli, and library). Tickets start as draft and only become ready after the user approves them, and a board shows which tickets can run at the same time. Use this skill whenever the user asks to write tickets, spec out or scope a feature, write requirements, a PRD or acceptance criteria, break a feature list into work items, or plan features before building them, even if they never say \"ticket\". Use it whenever the user lists one or more things they want built and wants them written down rather than coded right away."
---

# Write Tickets

Turn each feature the user asks for into a self-contained ticket: a folder holding two files (`rd.md` and `eval.md`) — plus a third, `contract.md`, when the ticket is written for team mode — tracked in `specs/tickets/BOARD.md`.

- **rd.md**: The requirements. What to build and why, specific enough that an isolated worker agent can build it without asking follow-up questions.
- **eval.md**: The verification spec. Concrete steps — browser, HTTP, shell, or tests — that the `tester` agent runs on the finished work to get an unambiguous PASS or FAIL on each requirement.

The two files work as a pair. `rd.md` says what "done" means. `eval.md` proves it. Every functional requirement (`FR-X`) in `rd.md` must map to at least one acceptance check (`E-Y`) in `eval.md`.

## Ticket Status Model

Every surface (board, agents, dashboard server, UI) uses one canonical status enum, and `specs/tickets/BOARD.md` is the single source of truth: the value in its `Status` column is the ticket's state. Derived display state (e.g. a stalled-worker badge) may be computed for rendering but is never persisted to the board.

Statuses: `specifying` | `draft` | `ready` | `in-progress` | `blocked` | `done` | `failed` | `budget-exceeded` | `in-review`.

Who writes each state:
- `specifying` — `/write-tickets` (this skill), the moment a writer starts a ticket: the board row reserves the number and shows the ticket while it is written. The router never dispatches it.
- `draft` — `/write-tickets` (this skill), when the writer finishes the ticket.
- `ready` — the user (or the router on the user's behalf), when approving the ticket for dispatch.
- `in-progress` / `blocked` — the worker heartbeat, mirrored onto the board by the router.
- `done` — the merger, after the ticket lands on `main` (or `in-review` in PR mode, where the change waits for human review before landing).
- `failed` / `budget-exceeded` — the router, when a worker cannot recover (repeated failures or exhausted budget).

## Landing

How a verified ticket lands is configurable, and a ticket can override the global setting:

- **Global default**: the `landing` key in `specs/worker-fleet.config.json` — `"direct"` (merge straight to `main`, full autopilot; the default) or `"pr"` (the merger pushes the branch and opens a GitHub PR; the ticket waits `in-review` for human review, and the router polls the PR state until it is merged). Set it with `python3 .claude/scripts/apply-setup.py --landing direct|pr`.
- **Per-ticket override**: an optional `## Landing` section in the ticket's `rd.md`:

  ```markdown
  ## Landing
  - Mode: pr
  ```

  `- Mode: pr` wins over the global config for that ticket; `- Mode: direct` (or omitting the section) keeps the global value. Only add the section when the ticket genuinely needs to differ from the config default — most tickets omit it.

PR mode requires the `gh` CLI and an `origin` remote; when either is missing, `apply-setup.py` and the `/setup` skill print a non-fatal warning, and the merger aborts PR creation cleanly (ticket stays `ready`, nothing pushed).

## Writer visibility (specifying row and heartbeat)

A ticket being written must show on the board and in the dashboard, and its number must be reserved, from the moment the writer starts.

**Reserve first.**
- Before reading code at length, re-read `specs/tickets/BOARD.md` and pick the number (step 4).
- Create `specs/tickets/NNN-slug/rd.md` holding only the title line, `**Status:** specifying` and `**Mode:**`, and append the board row with status `specifying`.
- Commit just those two paths: `git commit -m "tickets: NNN reserve (specifying)" -- specs/tickets/NNN-slug/rd.md specs/tickets/BOARD.md`. A writer of several tickets reserves them all in one such commit. If another writer took the number meanwhile, take the next free one.
- If the commit fails because `.git/index.lock` exists or a merge is in progress (`.git/MERGE_HEAD`), wait and retry; never `git add -A`, stash, reset or revert. The commit also carries any other uncommitted board edits, such as the router's status flips; that is expected.
- **Finish**: the final commit holds the finished ticket folder, the row flipped to `draft` and the rd.md `**Status:** draft`. The `done` heartbeat (below) is written after it.

**Heartbeat.** The worker shape, in `job/status-writer-NNN.json` of the checkout the writer works in (`job/` is gitignored), one file per ticket:

```json
{
  "ticket": "NNN-slug",
  "phase": "reading-code | writing-spec | dry-run | waiting-user | done",
  "updatedAt": "<output of: date -u +%Y-%m-%dT%H:%M:%SZ>",
  "note": "<short summary of the current step>",
  "branch": null
}
```

- Write it right after the reserve commit (`reading-code`), on every phase change, and at least every 10 minutes inside a long phase (for example between dry-run checks). `updatedAt` is the output of `date -u +%Y-%m-%dT%H:%M:%SZ`, never typed. Use `waiting-user` while waiting for the user's answer. The last write, after the final commit, is `done`. A writer of several tickets keeps one file per ticket and refreshes each whenever it writes any.
- What reads it: the dashboard shows an active writer as an agent on its ticket. A writer heartbeat counts as quiet after 2 × `watchdog.stallThresholdMinutes` (30 minutes by default), never in `waiting-user` or `done`, and the router then only alerts the user.

**Telemetry.** When you spawn a writer as a sub-agent, its description contains `ticket NNN` (one ticket per writer, for example `Write ticket 070 specifying status`), so `telemetry.py` attributes the writer's spend to that ticket. A batch description such as "Write tickets 061-069" cannot be attributed.

## Workflow

### 1. Split the request into features
One ticket per feature. A feature is the smallest piece that can be shipped and verified on its own and delivers user value.
- "Add auth and a dashboard" -> two tickets.
- "Add a save button and make it persist the form" -> one ticket, because the button is useless without saving.
- Tell the user how you split large epics so they can adjust the split early.
- Record dependencies between tickets in both `rd.md` and `specs/tickets/BOARD.md`.

### 2. Read the codebase first
Inspect the repository briefly before interviewing the user:
- Stack and scripts in `package.json`, `Makefile`, `pyproject.toml`, etc. (dev server command, port flag, build, lint, test, typecheck, DB seed commands). `eval.md` must use the repo's real commands.
- Existing routes, components, schemas, and state patterns that the feature will touch.
- Any `CLAUDE.md`, `AGENTS.md`, or `README.md` conventions.

**Detect the project type.** Before writing any templates, classify the repo into exactly one of four project types, based on what the codebase read shows. Heuristics, in order of signals:

| Type | Detection signals | Eval verification style |
| --- | --- | --- |
| **web** | A dev-server script (e.g. `dev`, `start`, `serve`) AND a UI framework dependency (`react`, `vue`, `svelte`, `next`, `nuxt`, `angular`, `astro`) | `agent-browser` against a dev server on `$PORT` |
| **api** | A server without any UI framework dependency (`express`, `fastify`, `hono`, `gin`, `echo`, `django`, `actix`) | HTTP assertions against the running service on `$PORT` |
| **cli** | A `bin` entry in `package.json` / `[project.scripts]` in `pyproject.toml` / CLI-framework dependency (`commander`, `yargs`, `click`, `cobra`, `clap`, `typer`) / Makefile targets that build an executable | Run the built command with exact args; assert exit codes and output |
| **library** | A packaged module (`main` / `exports` / wheel output) with no dev-server script and no bin | Run the repo's unit tests scoped to the feature plus build/pack output existence |

Where to look for the signals: `package.json` (`scripts`, `bin`, `main`, `exports`, `dependencies`), `pyproject.toml` (`[project.scripts]`, entry points, dependencies), `Makefile` targets, and top-level framework config files (`next.config.*`, `vite.config.*`, `Cargo.toml`, etc.).

**Ambiguous?** Ask the user in the interview (step 3) — one question, recommended option first. This matters for polyglot repos: a repo that is mostly shell scripts plus a server, a monorepo with both a UI and an API, or a library that also ships a demo app. Never guess a project type silently; the wrong type produces evals the tester cannot run.

### 3. Interview the user (One question at a time)
Workers cannot ask the user questions once building starts (unless an unexpected codebase conflict arises). Settle every product and UX ambiguity now:
- Ask **one question at a time**.
- When presenting choices, list concrete options (A, B, C) with your recommended option first.
- Continue until a worker can implement the entire feature without guessing any user-facing behavior.
- Include the project-type question here when the detection in step 2 was ambiguous (e.g. "This repo looks like both an API and a web app — should evals verify it via HTTP or via the browser?").
- Ask about priority: "How urgent is this ticket — `P0` (critical, dispatched before everything else), `P1` (default), or `P2` (nice-to-have)?" Recommend `P1` unless the user signals urgency or a hotfix; record the answer in the `Prio` column of `specs/tickets/BOARD.md` (see step 8).

### 4. Choose location and ticket numbering
Place tickets in `specs/tickets/` at the project root:

```text
specs/tickets/
  BOARD.md
  001-user-login/
    rd.md
    eval.md
  002-task-board-drag-drop/
    rd.md
    eval.md
```

Use `NNN-short-kebab-slug`. Pick the number from the highest `NNN` among the board rows and the `specs/tickets/NNN-*` folders, plus one, so existing tickets are never overwritten, and reserve it at once (see **Writer visibility** above).

### 5. Write `specs/tickets/NNN-slug/rd.md`
Use this exact structure:

```markdown
# NNN: <Feature Title>

**Status:** specifying | draft | ready | in-progress | blocked | done | failed | budget-exceeded | in-review
**Mode:** solo | team

## Summary
<1-3 sentences stating what this feature does.>

## Why
<What user problem this solves and how it fits into the application.>

## User stories
- As a <role>, I can <action>, so that <benefit>.

## Functional requirements
- **FR-1**: <Specific, testable requirement, including exact UI copy, routes, states, and API behavior.>
- **FR-2**: <Specific, testable requirement.>

## Out of scope
- <Items explicitly excluded so the worker does not over-engineer.>

## Affected areas
- `path/to/file-or-dir` — <what will be created or modified>

## Do not touch
- `path/to/off-limits-file` — <owned by another ticket or core infrastructure>

## Dependencies
- `none` (or `NNN-other-ticket`: <why it must finish first>)

## Retries
<Optional section — omit it entirely to use the router default of 2 retries.>
- maxRetries: 2

## Budget
<Optional section — omit it entirely to use the config defaults: $10.00 estimated cost / 300 worker turns.>
- USD: 10.0
- Turns: 300

## Delegatable subtasks
<Optional section — omit it entirely for most tickets. Only list mechanical, low-risk, well-scoped items.>
- <e.g. "Generate the boilerplate CRUD endpoints from the existing pattern in `path/to/file`">

## Decisions made
**Agreed with the user:**
- <Decision summary from the Q&A>

**Decided by the ticket writer:**
- <Implementation details chosen to match existing repo patterns>
```

**Optional `## Retries` section.** Workers that fail, stall or get reaped are re-dispatched automatically up to the ticket's retry budget — default `maxRetries: 2` (3 attempts total), applied by the router's `## Retry & failure policy`. Add `## Retries` with `- maxRetries: <N>` only when a ticket deserves more (or fewer) attempts than the default — omitting the section is the normal, correct case. When you do add it, never renumber or reorder the existing sections above; `## Retries` is appended as its own optional section (the template places it after `## Dependencies`).

**Optional `## Budget` section.** Every ticket is enforced against a budget cap — default **$10.00 estimated cost / 300 worker turns** (`budget.defaults` in `specs/worker-fleet.config.json`, set via `apply-setup.py --budget-usd` / `--budget-turns`). The router spawns the worker with `maxTurns` equal to the turn budget and stops the ticket (status `budget-exceeded`, never auto-retried) when either cap is hit. Add `## Budget` with `- USD: <float>` and/or `- Turns: <int>` only when a ticket deserves a different cap than the defaults — a heavy ticket may need more, a cheap one less — and record the choice in `## Decisions made` when the user weighed in; omitting the section is the normal, correct case. As with `## Retries`, never renumber or reorder the existing sections; `## Budget` sits directly after `## Retries` in the template, and either optional section may be omitted independently.

**Optional `## Delegatable subtasks` section.** When the fleet owner has enabled worker delegation (`models.worker.delegateCli` set to `codex` or `opencode`; default `none`), a worker may hand items listed here to the delegate CLI via `delegate-task.sh <cli> exec`, then reviews the delegated diff itself — the `tester` and `reviewer` gates apply unchanged. Only list **mechanical, low-risk, well-scoped** items (e.g. "generate the boilerplate CRUD endpoints from the existing pattern", "add the repetitive test fixtures following `tests/fixtures/foo.py`"). Never list schema, architectural, security-sensitive or product-judgement work — tickets involving schema or architectural changes list **no** delegatable subtasks. Workers delegate nothing that is not explicitly listed, and nothing at all when the section is absent. Place it after `## Dependencies`/`## Retries`; never renumber or reorder the existing sections.

### 6. Write `specs/tickets/NNN-slug/eval.md`

Pick exactly one of the four templates below — the one matching the project type detected in step 2. Every template shares one automated-check contract:

- All four templates list **`build`**, **`lint`**, **`test`**, and **`typecheck`**, in that order.
- Run each against the repo's real scripts. When the repo has no script for one of them, the eval records it explicitly as `SKIP (repo has no <x> script)` with the reason — a script that doesn't exist is never silently omitted, so `results.md` can carry the SKIP forward.
- Substitute the repo's actual commands (e.g. `make test`, `pnpm build`, `python3 -m pytest`) — the script names in the SKIP notation stay canonical: build, lint, test, typecheck.
- **Exit codes through pipes.** `cmd | tee log; echo "exit=$?"` records `tee`'s exit code (always `0`), not `cmd`'s. The portable form is `( set -o pipefail; cmd 2>&1 | tee log ); echo "exit=$?" | tee -a log`. `${PIPESTATUS[0]}` works only in bash (zsh spells it `$pipestatus[1]`) and the agent's shell may be zsh, so evals use `set -o pipefail` in a subshell instead.
- **Guard-friendly steps.** The agent sandbox guard refuses many command forms (found when 031-033 could not be verified as written), so write every eval step to run unsplit under the default guard:
  - One simple command per step: no `for`/`while`/`until` loops, no heredocs, no multi-line inline scripts, no `$(...)` or backticks in a command that also pipes or chains with `;`/`||`, and no `HOME=`/`env -i` prefixes. Never `bash install.sh` inline.
  - A check that needs a loop, a fixture, concurrency, a hermetic environment or an installer run gets a small harness script committed under `specs/tickets/NNN-slug/harness/` and invoked by path (`python3 specs/tickets/NNN-slug/harness/<name>.py <args>`), one subcommand per step (`setup`, `e1`, ..., `cleanup`). The harness sets environments through `subprocess` with an `env=` dict, never a shell prefix, runs `install.sh` and other scripts itself, and prints the observations the pass criteria name.
  - A value a later step needs is written to a file by an earlier step (for example `/tmp/opencode/NNN-workdir`) and read by the harness, not re-derived with `$(...)` in a pipeline. Shell state does not persist between tool calls, so steps use literal paths and literal ports, or a `<PORT>` placeholder the tester replaces. Never leave `$PORT` unset inside a command or pattern.
  - The shell-syntax Lint check is one `bash -n <file>` command per script (`bash -n .claude/scripts/browser.sh`), not a loop over a glob.
  - `pgrep`/`pkill -f` patterns use the bracket trick (`pkill -f '[d]ashboard-server.py --port 3105$'`), so the pattern cannot match the shell that runs it. Avoid globs that may match nothing (zsh aborts the command): use `find ... | wc -l`.
  - In agent shells `grep` can be a zsh function that drops the `./` prefix of recursive output: do not anchor on `^./`, use `^(\./)?` or `--exclude-dir`.
  - Installer runs target fresh temp repos only, never the real checkout or any real repo. `start-dashboard.sh` and anything that can open a public tunnel run only in a throwaway fixture whose tunnel provider is `local`.
- **Base-dependent checks.** A harness mode that compares the checkout with the ticket's base commit (a `scope` diff, a `setup-base` build, a baseline or page taken from the base) resolves the base with one helper, `compare_base(mode)`, called first in that mode, before it starts a server, tunnel or browser.
  - The base is `git merge-base main HEAD`, or the commit given with `<mode> --base <rev>`, which every mode of the harness accepts.
  - When the base is HEAD and none of the ticket's product files differ from it, the mode prints `RESULT: SKIP (run on the ticket branch, or pass --base <rev>)` and exits 2 before it starts anything, so a merged `main` never gives a false PASS.
  - A worker's uncommitted changes count as a difference, so the check still runs before the commit.
  - The eval's pass criteria say that a SKIP does not pass.
  - To re-verify a merged ticket, check out its branch tip or pass `--base <its original merge base>`.
- **Browser sessions.** Every browser command in an eval or a harness names its own agent-browser session, because the default session is one browser shared by every agent on the machine, across projects, and parallel testers, checkers, reproducers and harnesses would take over each other's page:
  - eval steps write `--session <session>` right after `browser.sh`, and the tester puts its own session name there (see the web template's `## Setup`);
  - a harness that drives the browser gets its session name once from `.claude/scripts/browser.sh --session-for harness <NNN>` (for a second session, `harness <NNN>-<suffix>`), passes `--session <name>` on every call, and closes only its own sessions in `cleanup`;
  - a ticket writer's dry run uses `--session-for writer <NNN>`;
  - nothing runs `close --all` or uses the default session.

**### web template** — dev server + `Browser` checks

```markdown
# NNN: <Feature Title>: Evaluation

## Setup
1. Install dependencies if needed: `npm install`
2. Start the dev server on the assigned worker port (`$PORT`, default `3101`):
   `PORT=$PORT npm run dev`
3. Wait until `http://localhost:$PORT` responds with HTTP 200.
4. If a check compares this checkout with the ticket's base commit, its harness resolves the base with `compare_base(mode)` and supports `--base <rev>` (see **Base-dependent checks** above).
5. Browser checks run in the tester's own agent-browser session, never the shared default one: `<session>` below is the name printed by `bash .claude/scripts/browser.sh --session-for tester NNN`. Close it before the first check (`bash .claude/scripts/browser.sh --session <session> close`) and again after the last one; never run `close --all`.

## Automated checks
- **Build**: `npm run build` exits with code `0`.
- **Lint**: `npm run lint` exits with code `0`.
- **Test**: `npm run test` exits with code `0`.
- **Typecheck**: `npm run typecheck` exits with code `0`.
- A check the repo cannot run is recorded as `SKIP (repo has no <x> script)` in `results.md` — never dropped.

## Acceptance checks

### E-1: <Check Title> (Covers FR-1)
- Type: Browser (agent-browser)
- **Steps**:
  1. Run `bash .claude/scripts/browser.sh --session <session> open http://localhost:$PORT/<route>`
  2. Run `bash .claude/scripts/browser.sh --session <session> snapshot -i` and locate the target control ref (e.g., `@e1`).
  3. Interact via `bash .claude/scripts/browser.sh --session <session> fill <ref> "<value>"` / `bash .claude/scripts/browser.sh --session <session> click <ref>`.
  4. Run `bash .claude/scripts/browser.sh --session <session> snapshot -i` and verify <expected visible state/text>.
  5. Save proof: `bash .claude/scripts/browser.sh --session <session> screenshot specs/tickets/NNN-slug/evidence/E-1.png`
- **Pass criteria**: <Unambiguous observable outcome, HTTP status, or DOM text>.

## Edge case checks

### E-2: <Edge Case Title> (Covers FR-2)
- Type: Browser (agent-browser)
- **Steps**:
  1. <Steps to trigger empty state, invalid input, or error handling>
  2. Save proof: `bash .claude/scripts/browser.sh --session <session> screenshot specs/tickets/NNN-slug/evidence/E-2.png`
- **Pass criteria**: <Exact error message or fallback behavior>.

## Traceability
| Requirement | Check(s) |
| --- | --- |
| FR-1 | E-1 |
| FR-2 | E-2 |

## Definition of done
- [ ] All automated checks pass with exit code `0`, or are recorded as `SKIP (repo has no <x> script)` in `results.md`.
- [ ] Every acceptance and edge case check (`E-1`..`E-N`) is recorded as PASS in `results.md`.
- [ ] The worker also writes the machine-readable `specs/tickets/NNN-slug/results.json` (automated results, one `checks[]` entry per `E-N` with verbatim id/title, reviewer verdict, budget) — the router's verification gate reads it; `results.md` stays the human narrative.
- [ ] Screenshots/logs for every check are saved in `specs/tickets/NNN-slug/evidence/`.
- [ ] Diff reviewed by `reviewer` with zero violations of `Do not touch` or `Out of scope`.
```

**### api template** — running service + `HTTP` checks (no browser)

```markdown
# NNN: <Feature Title>: Evaluation

## Setup
1. Install dependencies if needed: `npm install`
2. Start the service on the assigned worker port (`$PORT`, default `3101`):
   `PORT=$PORT npm run start:api` (or the repo's actual server command)
3. Wait until the service accepts connections on `http://localhost:$PORT` (e.g. health endpoint returns HTTP 200).
4. If a check compares this checkout with the ticket's base commit, its harness resolves the base with `compare_base(mode)` and supports `--base <rev>` (see **Base-dependent checks** above).

## Automated checks
- **Build**: `npm run build` exits with code `0`.
- **Lint**: `npm run lint` exits with code `0`.
- **Test**: `npm run test` exits with code `0`.
- **Typecheck**: `npm run typecheck` exits with code `0`.
- A check the repo cannot run is recorded as `SKIP (repo has no <x> script)` in `results.md` — never dropped.

## Acceptance checks

### E-1: <Check Title> (Covers FR-1)
- Type: HTTP
- **Steps**:
  1. Request the exact endpoint with curl: `curl -s -i http://localhost:$PORT/<route>` (`-i` prints the status line and headers before the body; add `-X`, `-H` and `-d` as the check needs). `agent-browser` has no `fetch` command, so HTTP checks never go through `browser.sh`.
  2. Assert the exact expected status code, headers, and JSON payload fields listed in the eval.
  3. Save proof (raw response body): `( set -o pipefail; curl -s http://localhost:$PORT/<route> | tee specs/tickets/NNN-slug/evidence/E-1.json )`
- **Pass criteria**: <Exact status code, header values, and JSON fields, e.g. `HTTP 200` and `body.user.id == 42`.>

## Edge case checks

### E-2: <Edge Case Title> (Covers FR-2)
- Type: HTTP
- **Steps**:
  1. <Request that triggers the error path, e.g. invalid auth, missing field, wrong method>
  2. Assert the exact failure status/headers/payload the eval lists.
  3. Save proof: `( set -o pipefail; <the same curl command without -i> | tee specs/tickets/NNN-slug/evidence/E-2.json )`
- **Pass criteria**: <Exact error status code and error payload, e.g. `HTTP 401` with `body.error.code == "UNAUTHORIZED"`.>

## Traceability
| Requirement | Check(s) |
| --- | --- |
| FR-1 | E-1 |
| FR-2 | E-2 |

## Definition of done
- [ ] All automated checks pass with exit code `0`, or are recorded as `SKIP (repo has no <x> script)` in `results.md`.
- [ ] Every acceptance and edge case check (`E-1`..`E-N`) is recorded as PASS in `results.md`.
- [ ] The worker also writes the machine-readable `specs/tickets/NNN-slug/results.json` (automated results, one `checks[]` entry per `E-N` with verbatim id/title, reviewer verdict, budget) — the router's verification gate reads it; `results.md` stays the human narrative.
- [ ] Response bodies for every check are saved in `specs/tickets/NNN-slug/evidence/`.
- [ ] Diff reviewed by `reviewer` with zero violations of `Do not touch` or `Out of scope`.
```

**### cli template** — built commands + `CLI` checks (Setup has no dev server)

```markdown
# NNN: <Feature Title>: Evaluation

## Setup
1. Install dependencies if needed: `npm install`
2. Build if the repo requires it: `npm run build` (the checks below run the built command).
3. No dev server is started — commands under test run against checked-out + built code only.
4. If a check compares this checkout with the ticket's base commit, its harness resolves the base with `compare_base(mode)` and supports `--base <rev>` (see **Base-dependent checks** above).

## Automated checks
- **Build**: `npm run build` exits with code `0`.
- **Lint**: `npm run lint` exits with code `0`.
- **Test**: `npm run test` exits with code `0`.
- **Typecheck**: `npm run typecheck` exits with code `0`.
- A check the repo cannot run is recorded as `SKIP (repo has no <x> script)` in `results.md` — never dropped.

## Acceptance checks

### E-1: <Check Title> (Covers FR-1)
- Type: CLI
- **Steps**:
  1. Run the built command with its exact args: `node bin/app.js <exact args>` (or the repo's real invocation).
  2. Assert the exit code and the exact stdout/stderr substrings listed in the eval.
  3. Save proof (full output): `( set -o pipefail; <command> 2>&1 | tee specs/tickets/NNN-slug/evidence/E-1.log ); echo "exit=$?" | tee -a specs/tickets/NNN-slug/evidence/E-1.log`
- **Pass criteria**: <Exact exit code and output substrings, e.g. `exit 0` and stdout contains `usage:`.>

## Edge case checks

### E-2: <Edge Case Title> (Covers FR-2)
- Type: CLI
- **Steps**:
  1. <Command/args that trigger the failure path, e.g. missing required flag>
  2. Assert exit code and error output substrings.
  3. Save proof: `( set -o pipefail; <command> 2>&1 | tee specs/tickets/NNN-slug/evidence/E-2.log ); echo "exit=$?" | tee -a specs/tickets/NNN-slug/evidence/E-2.log`
- **Pass criteria**: <Exact exit code and error substring, e.g. `exit 2` and stderr contains `missing --required-flag`.>

## Traceability
| Requirement | Check(s) |
| --- | --- |
| FR-1 | E-1 |
| FR-2 | E-2 |

## Definition of done
- [ ] All automated checks pass with exit code `0`, or are recorded as `SKIP (repo has no <x> script)` in `results.md`.
- [ ] Every acceptance and edge case check (`E-1`..`E-N`) is recorded as PASS in `results.md`.
- [ ] The worker also writes the machine-readable `specs/tickets/NNN-slug/results.json` (automated results, one `checks[]` entry per `E-N` with verbatim id/title, reviewer verdict, budget) — the router's verification gate reads it; `results.md` stays the human narrative.
- [ ] Command logs for every check are saved in `specs/tickets/NNN-slug/evidence/`.
- [ ] Diff reviewed by `reviewer` with zero violations of `Do not touch` or `Out of scope`.
```

**### library template** — repo tests + `Test` checks (Setup has no dev server)

```markdown
# NNN: <Feature Title>: Evaluation

## Setup
1. Install dependencies if needed: `npm install`
2. Build if needed so unit tests import real artifacts: `npm run build`
3. No dev server is started — verification runs through the package's own tests and build output.
4. If a check compares this checkout with the ticket's base commit, its harness resolves the base with `compare_base(mode)` and supports `--base <rev>` (see **Base-dependent checks** above).

## Automated checks
- **Build**: `npm run build` exits with code `0`.
- **Lint**: `npm run lint` exits with code `0`.
- **Test**: `npm run test` exits with code `0`.
- **Typecheck**: `npm run typecheck` exits with code `0`.
- A check the repo cannot run is recorded as `SKIP (repo has no <x> script)` in `results.md` — never dropped.

## Acceptance checks

### E-1: <Check Title> (Covers FR-1)
- Type: Test
- **Steps**:
  1. Run the repo's unit tests scoped to the feature: `npm run test -- path/to/feature.spec`
  2. Verify the build/pack output for the feature exists (e.g. `ls dist/<exported-file>`).
  3. Save proof: `( set -o pipefail; <test command> 2>&1 | tee specs/tickets/NNN-slug/evidence/E-1.log ); echo "exit=$?" | tee -a specs/tickets/NNN-slug/evidence/E-1.log`
- **Pass criteria**: <Test command exits with code `0` and the named tests report passing; listed output exists.>

## Edge case checks

### E-2: <Edge Case Title> (Covers FR-2)
- Type: Test
- **Steps**:
  1. <Tests covering the failure path, e.g. a spec asserting the SDK throws on bad input>
  2. Save proof: `( set -o pipefail; <test command> 2>&1 | tee specs/tickets/NNN-slug/evidence/E-2.log ); echo "exit=$?" | tee -a specs/tickets/NNN-slug/evidence/E-2.log`
- **Pass criteria**: <Exact test names that must pass, e.g. `2 passed, 0 failed`.>

## Traceability
| Requirement | Check(s) |
| --- | --- |
| FR-1 | E-1 |
| FR-2 | E-2 |

## Definition of done
- [ ] All automated checks pass with exit code `0`, or are recorded as `SKIP (repo has no <x> script)` in `results.md`.
- [ ] Every acceptance and edge case check (`E-1`..`E-N`) is recorded as PASS in `results.md`.
- [ ] The worker also writes the machine-readable `specs/tickets/NNN-slug/results.json` (automated results, one `checks[]` entry per `E-N` with verbatim id/title, reviewer verdict, budget) — the router's verification gate reads it; `results.md` stays the human narrative.
- [ ] Test logs for every check are saved in `specs/tickets/NNN-slug/evidence/`.
- [ ] Diff reviewed by `reviewer` with zero violations of `Do not touch` or `Out of scope`.
```

**Repo-type note (dogfooding).** Repos like worker-fleet itself — a bundle of shell/Python scripts plus a dashboard server, with no packaged UI app — are verified by running scripts, not by browsing. Write their tickets with the **cli** template for most tickets, and switch to the **web** template only for dashboard-UI tickets. This is exactly how this repo's current ticket batch's evals are written, and it is a good reference: read one recent ticket from this repo before writing new evals elsewhere.

**Dry run (before handing the ticket over).** Practise the eval against the current code, lightly:
- **Required: every check fails for the right reason, or passes when it should.** Run every acceptance check and harness mode against the current code. A check of new behaviour must FAIL, and its failing lines must name the missing behaviour, not a typo, a missing harness file, a busy port, a guard refusal or a crash. A check of existing behaviour (a regression guard, the automated checks) must PASS. Record each check's outcome in `## Decisions made`.
- **Optional: prototype the fix only for a novel or tricky check.** When a check uses a technique the repo has no precedent for, or depends on timing, concurrency or a browser measurement, you may build a rough fix in the throwaway copy to prove the check can pass. Never commit it, and name the prototyped checks in `## Decisions made`.
- **One throwaway copy, cleaned up.** Use at most one throwaway copy per ticket (a `git worktree`, or a directory under `/tmp/opencode/NNN-*` or your scratch area) and reuse it for every check. Before the final commit, stop every process you started, close browser sessions, remove the copy (`git worktree remove --force <dir>`, then `git worktree prune`) and every `/tmp/opencode/NNN-*` path, and confirm the ports you used are free.
- **The trade-off.** Without a prototype, a check that can never pass (a harness bug) shows up during the build instead of at writing time. The worker reports it as `blocked` with the failing lines, and the router or the user decides the harness fix.

### 7. Team tickets: scaffold `specs/tickets/NNN-slug/contract.md`

Every `team` ticket gets a third file, `contract.md`, scaffolded at ticket-writing time next to `rd.md` and `eval.md`. Use these exact sections and order:

```markdown
# Contract: NNN <Feature Title>

## Shared interfaces
<API routes + exact request/response payloads. One entry per endpoint: method, path,
request payload fields with types, response payload fields with types.>

## Schemas
<DB/state schema changes: tables/collections, migrations, persisted keys, file formats.>

## Shared types
<Shared TS/type modules and their definitions, with the file path each type lives in.>

## File ownership
One row per teammate, exactly this column shape, globs non-overlapping and together
covering every file the ticket may touch:

| teammate | owned globs |
| --- | --- |
| <telemetry> | `src/lib/telemetry/**` |
| <ingester> | `src/lib/ingest/**` |

## Integration seams
<Who calls whom, in what order, e.g. "voicemail.ts (owner <voice>) calls
`POST /transcribe` (owner <server>) after job completion.">

## Lock

**Locked:** no

Each named teammate adds a confirmation row (confirmed: `yes`) after agreeing to the
contract. The teammate who added the last missing row then flips the flag:

| teammate | confirmed |
| --- | --- |
| <telemetry> | no |
| <ingester> | no |
```

Rules for the scaffold, enforced downstream (see `teammate.md` / `reviewer.md`):

- Use **team mode only** for foundational or multi-surface tickets where 2+ agents will edit concurrently and would realistically collide: shared plumbing (interfaces, schemas, types), cross-cutting refactors, and anything going through `SendMessage` coordination. A solo ticket never needs `contract.md`.
- Ownership is expressed as **glob patterns**, non-overlapping; two teammates must never own the same file. Cover `## Affected areas` of `rd.md` across the globs.
- Confirmations use the teammate **names exactly as the router assigned them** (the router passes ownership assignments to teammates — if the user has not assigned names, pick short kebab-case role names in the interview and write them into both tables).
- Fill each spec area with real content when the codebase read (step 2) gives you the details; leave it with a concrete placeholder only when the answer is genuinely unknown at write time, and require the owning teammate to finalize it in the lock round.
- `**Locked:** no` ships with the scaffold. No application code may be edited until every confirmation row is `yes` and the flag reads `**Locked:** yes`.
- The dashboard renders `contract.md` in the ticket drawer's Contract tab once the folder exists — no extra work needed.

### 8. Update `specs/tickets/BOARD.md`
Create or update `specs/tickets/BOARD.md`:

```markdown
# Ticket Board

Status: `specifying` | `draft` | `ready` | `in-progress` | `blocked` | `done` | `failed` | `budget-exceeded` | `in-review`.
Mode: `solo` (one worker subagent) | `team` (agent team, for foundational or multi-surface tickets).
Prio: `P0` (critical, dispatched first) | `P1` (default) | `P2` (nice-to-have).
Runs: `alongside` (no dependencies, safe to run with other tickets) | `waits for NNN: reason`.

| # | Title | Status | Mode | Prio | Runs |
| --- | --- | --- | --- | --- | --- |
| 001 | <Title> | draft | team | P1 | alongside |
| 002 | <Title> | draft | solo | P1 | waits for 001: <reason> |
```

The `Prio` column records the ticket's dispatch priority. Allowed values are `P0` (critical — dispatched before every `P1`), `P1` (the default), and `P2` (nice-to-have); within the same priority the router falls back to board order. The value comes from the priority question in the interview (step 3) — use the default `P1` when the user did not express urgency.

The writer's final commit flips the row from `specifying` to `draft`. Leave it `draft` until the user reviews it and tells you which tickets to mark `ready`.

### 9. Maintain the regression list (`specs/regression.md`)

Every repo the fleet builds in keeps a curated smoke list at `specs/regression.md`: the critical flows (`R-1..R-N`) that the `checker` agent's `full` mode re-walks after merges. Create it when writing tickets for a repo that has no list yet, and extend it as critical flows land.

- **Create**: when a repo has no `specs/regression.md`, seed it from the template header in that file (or from an existing list) with 3-8 flows that must never break — typically: the app serves and its main screen renders, the primary read API returns valid JSON, the main UI interaction works, and the setup/build command exits 0. **Replace an inherited list wholesale**: every entry must be verifiable in THIS repo, not the repo the template came from.
- **Maintain**: when a landed ticket introduces a critical user flow (or its rd.md marks one), append an entry for it — append only, never renumber existing ids, and remove an entry only when its flow is deliberately deleted from the product.
- **Entry format** — the same shape as eval checks so the checker executes them verbatim, with types from the four project-type templates (`Browser`, `HTTP`, `CLI`, `Test`):

  ```markdown
  ### R-N: <flow title>
  - Type: Browser | HTTP | CLI | Test
  - **Steps**:
    1. <concrete, executable steps against the running app on main>
  - **Pass criteria**: <unambiguous observable outcome>
  ```

- Each entry must be self-contained and runnable verbatim on `main` (config-driven ports, no ticket-specific context).
- The router sweeps the list automatically after every N merges (`regression.everyNMerges` in `specs/worker-fleet.config.json`, default `1` = every merge; `0` disables), and a `CONFIRMED_BREAK` from a sweep carries the affected `R-N` id to `reproducer`.

### 10. Runs syntax and dependency validation (dependency graph)

The `Runs` column of `specs/tickets/BOARD.md` encodes the dependency edges between tickets. This skill validates those edges **at write time** — a dangling or cyclic dependency is caught in the interview (step 3), before any file is written.

**Normalized syntax (use this for every new ticket):**

- `alongside` — no dependencies; safe to run concurrently with other tickets.
- `after: 003, 005 — <reason>` — runs after tickets 003 AND 005; the reason follows an em dash (` — `) and says why the order matters. Multiple ids are comma-separated: `after: 001+003` is never written — that is `after: 001, 003 — <reason>`.

**Legacy syntax (parsed as equivalent, kept for backward compatibility):**

- `waits for 003: <reason>` — same edge as `after: 003 — <reason>`.
- `waits for 001+005: <reason>` — same edges as `after: 001, 005 — <reason>`.

Both forms parse to the same shape downstream: `parse_board_md()` in `.claude/scripts/dashboard-server.py` emits `"deps": ["003", "005"]` (the ids this ticket runs after) and `"dependents": ["007"]` (the ids that run after it) per ticket — direct edges only — served by `/api/state`, and the dashboard's **Graph** tab renders the board as a layered DAG with dispatch-ready highlighting.

**Write-time validation (run before writing rd.md / eval.md / board rows):**

1. **Every referenced id exists.** Each `NNN` in an `after:` / `waits for` list must match a ticket that exists on the board — an existing row or another ticket in the same batch being written. A dangling reference is surfaced to the user in the interview and fixed before anything is written.
2. **The graph is acyclic (DFS).** Build the dependency graph over the merged board state (existing rows plus the batch being written) and walk it depth-first; if any ticket transitively depends on itself, report the exact cycle (e.g. `994 → 995 → 994`) and fix it in the interview. A cyclic board can be neither topologically laid out nor dispatched.

The server's board parsing stays tolerant by design: if a cycle or a dangling reference reaches the board anyway, `/api/state` still returns 200 and the Graph view shows a warning banner instead of crashing — validation belongs at write time, never in the parser.

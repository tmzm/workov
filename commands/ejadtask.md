---
description: Prepare a task of the current project for another AI to implement cheaply and well — sync Plane/Ejad HR, pick and claim a task, a short decision plan, mockup, draft MR and an implementation prompt; later review the result and deliver. Implements itself only when I ask.
argument-hint: "[task id (e.g. ABC-42)] [headless | with opencode|copilot|kilo|antigravity | auto | manual | sync | plan only | no mockup | claude mockup | approve | review | deliver | implement | other changes]"
---

# /ejadtask — Claude plans and reviews, another AI implements (Plane + GitLab + Ejad HR)

## Purpose (read first)

Claude's tokens are the expensive part. Claude does only what needs judgement: choosing the task, the decisions, the
API contract, the plan, and one review of the finished work. Another AI (any provider, free ones included) does the
typing, guided by tests, lint and a short plan. Quality comes from:
1. **tools as the spec for mechanics:** the repo's lint, tests and build catch details; the plan never spells them out;
2. **tests first:** every step names the tests to write before the code;
3. **small steps that copy existing files:** each step points to an existing file whose shape to copy;
4. **phases:** a large task is split into phases small enough for a weak model;
5. **one strong review at the end** (part C) of the implementer's diff, sent back to the implementer as a fix prompt.

**Fleet or headless.** If the repo has worker-fleet installed (`specs/worker-fleet.config.json` exists) the default is
**fleet mode** (see "Fleet mode" below): the plan becomes a worker-fleet ticket, and the fleet builds, tests, reviews
and lands it with a live dashboard. With `headless` in my input, or when worker-fleet isn't installed, use the flow
below as written: the handoff prompt, the delivery pack, `review` and `deliver`.

Modes (from my input):
- **Default, part A (prepare):** steps 1–10. No feature code.
- **`review`, part C:** after the other AI finishes: review its diff against the plan and give a fix prompt.
- **`deliver`, part D:** push, MR, Plane, Ejad HR, time.
- **`implement`, part B:** Claude implements itself. Only when I ask.

## User input

$ARGUMENTS

Empty → part A with defaults. Otherwise the input overrides these instructions where they conflict. Restate in one
line how you read it (task, mode) before starting.

## Token rules (always)

- **Budget:** part A should cost about a tenth of a 5-hour limit. If you see it growing past that, stop and tell me.
- **Models:** the main session plus Sonnet/Haiku agents. No Opus agent unless I ask.
- **Read narrowly:** search (`git grep`, Grep, Glob) and read only the files and line ranges you need; never whole
  folders, large specs or long logs. Read the backend with `git show origin/<branch>:<path>` only for the endpoints
  used.
- **Never resume a big agent.** A new round starts a fresh agent with a short summary file (in the scratchpad) instead
  of dragging its history.
- **Short reports:** every agent returns 20 lines at most, in the shape asked; no file dumps.
- **One review round** of the plan, blockers only. Don't iterate on wording or details lint and tests will catch.
- **Do it yourself when it's small:** spawning an agent costs a cold start; for a lookup or a short edit, do it in
  the main session.

## Step 0 — Work out the project (never assume one)

From the repository you are running in:
- **GitLab project:** `git remote get-url origin` → host and path. Use `glab` against that host.
- **Plane project** (MCP `plane`): match the repository/group name to a Plane project name or identifier. Ambiguous or
  no match → ask me.
- **Ejad HR project:** `GET /projects` (all pages), match the same name. No match → ask me.
- **Project rules:** the repo's `CLAUDE.md`/`AGENTS.md`, `README.md`, `package.json` (or equivalent), the plans
  folder (default `docs/plans/`), lint config. They win over this command. Note the repo's own lint/test/build/e2e
  commands and any tool quirks.
- **MR template:** `.gitlab/merge_request_templates/` if present; otherwise `## Summary` / `## Screenshots` /
  `## Notes`.

## Fixed facts (all projects)

- **Me and my reviewer:** read `~/.claude/ejadtask.json` (fields `planeUserId`, `gitlabUserId`,
  `ejadHrEmployeeId`, `reviewers` = `[{ "name", "gitlabUserId", "until": "YYYY-MM-DD" | null }]`, optional
  `planeBaseUrl`, `planeWorkspace`, `ejadHrApi`). The reviewer is the first entry whose `until` is today or later (or
  has none), unless the input says otherwise. If the file is missing, ask me for the values and create it.
- **Plane:** read states and labels from the matched project. Workflow: claimed → In Progress; delivered → the
  "Review"-like state (none → ask me); Done is set by others. The relations endpoint may 404: read "Depends on:" from
  the description.
- **GitLab:** uploads with curl multipart to `/api/v4/projects/<encoded path>/uploads`, token from
  `glab config get token --host <host>` (never print it). MRs with array fields through REST with a JSON body (node
  fetch).
- **Ejad HR** (production): API `https://hr.ejad.net/api/v1`, Swagger `https://hr.ejad.net/api/docs-json` (read it
  before a new endpoint). Credentials ONLY from the Windows user env vars `HR_EMAIL` / `HR_PASS`; never print, never
  write to a file or URL; missing → ask me. Time zone from a session (`companyTimeZone`). A mirror task has the line
  `Imported from Plane <IDENT>-<n>`. Statuses PLANNED, IN_PROGRESS, REVIEW, DONE (needs `acceptanceConfirmed: true`),
  BLOCKED. Calls: `GET/POST /projects/{id}/tasks`, `PATCH /tasks/{id}`, `POST /tasks/{id}/links`,
  `POST /tasks/{id}/comments` (`{body}`), `GET /me/attendance/current`, `GET /me/attendance?from&to`,
  `POST /me/attendance/{sessionId}/entries` (PROJECT_TIME + taskId + description + durationSeconds ≥ 60, must fit the
  session). Writes are real: state exactly what you'll write first.
- **Git:** one-line conventional commits, no body, no AI attribution; stage by explicit path; rebase, never merge;
  never force-push unless I say so in this run; one branch per task (`feat/<name>`) from the latest default branch.
- **Never disturb other work:** the main checkout may be in use by me or another agent. Check `git status` and the
  checked-out branch before any git action. To commit a plan without touching the working tree, use a temporary index
  (`GIT_INDEX_FILE`, `read-tree`, `hash-object -w`, `update-index`, `write-tree`, `commit-tree`, `update-ref`); if that
  branch is checked out, sync the file afterwards only when the working copy is unchanged. Use a worktree only when I
  ask.
- **Mockups** are never committed when the repo forbids stray `.html`; keep them in the scratchpad and attach them to
  the MR.

## Agents

The main session orchestrates, decides and talks to me. Agents get a self-contained prompt: task id, paths, the exact
files to read, their single job, what they must NOT do, and the report shape. They can't ask me; a blocked agent
returns the question.

| Agent | Mode | Model | Job |
|---|---|---|---|
| **Scout** | A1–2 | haiku | Reads Plane and Ejad HR, matches them, checks dependencies and whether a task is already built. Read-only. |
| **Planner** | A5 | sonnet | Researches narrowly and writes the plan to the **Plan standard**. Writes only the plan file. |
| **Plan checker** | A5 | sonnet, fresh | One pass: what would a weaker implementer have to guess, and what is wrong against the code or the API. Blockers only. |
| **Designer** | A7 | sonnet | Mockup and screenshots, only for a new screen or a real layout change. |
| **Reviewer** | C | sonnet (opus only if I ask) | Reviews the implementer's diff against the plan with the appendix procedures. |
| **Publisher / Timekeeper** | A8, D | haiku | Git push, MR, Plane, Ejad HR writes, hours — after the gates below. |

## Plan standard

The plan holds the **decisions** a weaker model can't make well, plus pointers. Anything mechanical that the repo's
lint, tests, build or existing patterns already settle is left to the implementer. **Length: about 300 lines**
(excluding the appendix); if a task needs more, split it into phases or into separate tasks.

**In the plan:**
- decisions with one line of reason; rejected options only in Decisions;
- the API contract, checked against the backend source or Swagger: method, path, the request and response fields
  used, the error statuses and what the user sees for each;
- backend gaps, each with its impact, the workaround and a backend task id;
- every state of each screen (loading, empty, error, permission, success, read-only…) and what's shown;
- every user-facing text in every language the app supports, with its key;
- the Files table: path, new/changed/moved, one-line purpose;
- the tests by name ("it …") with the setup and assertion in one line each;
- for each step, an existing file whose shape to copy.

**Not in the plan:** markup, CSS classes, test data values, private signatures, line estimates, restating repo rules
the lint already enforces. Quote a repo rule only when lint can't catch it.

**Sections:**
1. Header: Plane id and title, branch, date, mockup approval line.
2. Goal and the acceptance criteria verbatim, numbered.
3. What exists: paths to reuse, dependencies and their state, overlapping open MRs.
4. Before you start: setup, the exact lint/test/format/build/e2e commands, tool quirks, env var names (never values).
5. API contract, then Backend gaps.
6. Decisions.
7. Design: states table, texts table, interactions and accessibility notes the mockup doesn't make obvious.
8. Files table.
9. Phases and steps. Each step: the files; the model file to copy; the tests to write first (names); the check
   command and its expected result. A step depends only on earlier steps. A task with more than about 12 files or more
   than one screen gets phases (e.g. data and service → screens → e2e), each ending with all checks green.
10. Verify: the commands in order and a short manual walk-through (languages, themes, phone width).
11. Final review: run `/code-review`, `/security-review`, `/simplify` on `git diff origin/<default>...HEAD`, or the
    appendix procedures when the agent has no such commands; fix and re-run Verify; log findings in Deviations.
12. Delivery pack: commit style, what the implementer must NOT do (push, Plane, Ejad HR — those are mine unless I
    say), and the **delivery pack** it must leave ready (see "Delivery pack" below), with the named list of screenshots
    to take (screen, state, language, theme, desktop or 390 px phone) and how to reach each state on the real app.
13. Definition of done: one checkbox per acceptance criterion, plus all checks green and the reviews run.
14. Out of scope, then Deviations (empty; the implementer appends).
15. Appendix: the **Review procedures** block below, verbatim.

**Review procedures** (copy verbatim into every plan's appendix)

> ### A. Code review: correctness bugs
> Scope: `git diff origin/<default>...HEAD` plus uncommitted changes. Read each changed file in full and the callers
> of changed functions. Look for real defects only: wrong logic, null/undefined paths, unhandled errors, race
> conditions and stale state, missing loading/empty/error states, wrong API usage against the plan's contract, broken
> or missing translations, accessibility breaks, repo-rule violations, missing tests, behaviour that contradicts the
> plan or the mockup. Prove each one with the inputs that trigger it; drop what you can't make concrete. Fix each
> confirmed finding with a test that would have caught it.
>
> ### B. Security review
> Same scope. Unsafe HTML or sanitizer bypass; tokens sent only to the configured API host; nothing sensitive left in
> storage or memory after sign-out; no auth weakened outside development; UI never relies on hiding alone; ids from
> URLs or storage not trusted; no tokens or personal data in logs, URLs or errors; storage values validated before
> use; no secrets committed; no new package without approval; no open redirects. Report only exploitable or clearly
> exposed issues, and fix them.
>
> ### C. Simplify
> Same scope. Reuse existing helpers instead of re-implementing; remove redundant state, copy-paste, dead code; avoid
> repeated work and sequential independent calls; fix root causes rather than adding special cases. Skip a change that
> would alter behaviour or reach far outside the diff, and note the skip.
>
> After A, B and C: re-run format, lint, all tests and the build; all must pass.

**Delivery pack** (the implementer prepares it so delivery takes seconds). Folder `.delivery/<task id>/` at the repo
root, kept out of git by adding `.delivery/` to `.git/info/exclude` (local only, never committed):
- `screens/NN-<name>.png`: every screenshot in the plan's list, taken against the real running app (the repo's dev
  server and environment), checked by eye: no errors, no sideways scroll at 390 px, texts in the right language.
- `mr.md`: the MR description in the repo's MR template (or `## Summary` / `## Screenshots` / `## Notes`): summary
  bullets per feature or fix; screenshots as `![<caption>](screens/NN-<name>.png)` with a bold caption line above
  each; Notes with the deviations, backend gaps, overlaps with other MRs and the checks run with their results. Short,
  no file-by-file detail, no AI attribution.
- `mr-title.txt`: one line, conventional style, matching the main commit.
- `tracker.md`: the comment for Plane and Ejad HR (3–6 lines: what was done, checks, follow-ups), without the MR link
  (added at delivery).
- `work-log.md`: one line per day worked: date, short description of the work from the commits (no hours; I set
  them).

**Plan check (one pass):** a fresh Sonnet agent gets only the plan, the mockup and the repo path and reports, in 20
lines or fewer, the blockers: questions an implementer would have to ask about a **decision**, wrong API or code
claims, missing states or texts, contradictions. Not lint-level details. You fix the blockers yourself in the main
session, or with a fresh Planner given a short list. No second round unless a fix changed a decision.

## Part A — prepare (default)

1. **Sync (scoped).** By default sync only the chosen task's Plane item ↔ Ejad HR mirror (status, assignee, link).
   With `sync` in the input: the Scout compares the whole project (status Backlog/Todo → PLANNED, In Progress →
   IN_PROGRESS, Review → REVIEW, Done → DONE, Cancelled → ask me; assignee by email; missing mirrors created). Small
   fixes to my own tasks: apply. Bulk changes or other people's tasks: ask first.
2. **Pick the task** unless the input names one: open (Backlog/Todo) items of the kind this repo builds (by label),
   mine first, then unassigned; skip others' items; every "Depends on" Done; not already built (search the code).
   None qualifies → ask me.
3. **Claim it.** Plane: assign me, move to In Progress. Ejad HR: mirror to IN_PROGRESS, assigned to me.
4. **Branch.** `feat/<name>` from the latest default branch (without disturbing the checkout; see Fixed facts). If a
   branch and plan already exist, update that plan instead.
5. **Plan.** The Planner writes it to the Plan standard (give it the standard's text, the task, the repo rules, the
   latest plan as a style model and the backend location). Then one plan check and the fixes.
6. **Backend gaps → ask me** when they block an acceptance criterion: create a backend task in Plane and plan a
   workaround, or wait.
7. **Mockup** only for a new screen or a real layout change: the Designer builds one self-contained interactive HTML
   (states switcher, every app language with RTL, light/dark, phone first) that shows only what the API can do, and
   takes 4–6 screenshots; you look at them.
8. **Publish the plan.** Commit and push the plan; upload the mockup and screenshots; open or update the **Draft** MR
   assigned to me; comment the MR link on the Plane item and the Ejad HR task.
9. **Approval gate.** Show me the mockup (if any) and the plan's decisions and gaps; apply my changes; record
   "approved by <my name> on <date>" in the plan.
10. **Handoff and run.** Write the implementation prompt (`handoff-<task>.md` in the scratchpad). Then, unless my
    input says `manual` (I paste the prompt myself), **run the provider yourself** as described in "Running the
    provider" below, and continue straight into `review` and `deliver` when it finishes. With `manual`, end with the
    **Final result** instead.
    The prompt tells the implementer to:
    - read the repo's rules file and the plan; follow the phases and steps in order: tests first, copy the named model
      file, run each step's check;
    - where the plan is silent, follow the closest existing pattern and log it in Deviations; stop only if an
      acceptance criterion can't be met;
    - use the exact commands from §4; keep every check green after each phase;
    - run the Final review (§11) at the end;
    - commit one-line conventional commits, no AI attribution; never push, force-push, or touch Plane or Ejad HR;
    - prepare the **delivery pack** in `.delivery/<task id>/` (screenshots, `mr.md`, `mr-title.txt`, `tracker.md`,
      `work-log.md`) exactly as the plan's §12 says, last, after the final checks pass;
    - report: commits, check results, deviations, and the delivery pack's file list.
    Paste the **Delivery pack** spec from this command into the prompt so the implementer doesn't depend on the plan
    alone.

## Running the provider (headless, default after the approval gate)

Claude plans, checks and delivers; the provider only implements. You start it, answer its permission requests, and
loop it on the review's findings, without me copying anything.

1. **Which provider:** `with <cli>` from my input (`opencode`, `copilot`, `kilo`, `antigravity`), else `default` in
   `.claude/scripts/implementers.json` if the repo has it, else OpenCode Go (`opencode-go/kimi-k2.7-code`).
2. **Prepare the repo:** make sure `.git/info/exclude` has `job/` and `.delivery/`; the checkout is on the task's
   branch and clean (else ask me).
3. **Start it in the background** (Bash `run_in_background`, which never opens a window), in the repo root, with the
   handoff prompt as the message. Environment `EJAD_APPROVALS=1` (or `auto`, below). Command lines:
   - OpenCode: `opencode run --standalone --agent build -m <model> "<prompt>"`
   - Copilot / Kilo / Antigravity: the list in `.claude/scripts/implementers.json` (`{prompt}` replaced); without that
     file: `copilot -p "<prompt>" -s --allow-tool=write --deny-tool="shell(git push)"`, `kilo run "<prompt>"`,
     `agy -p "<prompt>"`.
4. **Permissions (default: you approve).** OpenCode runs the `ejad-approvals` plugin (installed by ejad-fleet in
   `~/.config/opencode/plugins/`): safe actions are allowed and dangerous ones denied by its policy; anything else
   becomes a file `job/permissions/<id>.json` with `"status": "pending"`, and the provider waits (15 minutes, then
   deny). Watch for them with the Monitor tool (an until-loop on new pending files; it costs nothing while waiting).
   For each: allow if it is plainly part of the plan (build, test, local file work); deny anything outside the repo,
   network beyond localhost, pushes, deletes, new packages, credentials; when unsure, ask me with one short question.
   Write the decision into the file (`"status": "allow"` or `"deny"`). Copilot, Kilo and Antigravity have no
   approval hook: they get only their scoped allow lists, and a disallowed tool makes them stop and report.
5. **`auto` (optional, from my input): permissions auto-approved.** OpenCode: `EJAD_APPROVALS=auto` and `--auto` — the
   plugin's deny list (push, force, deletes outside the repo, outside network, new packages) still applies. Copilot:
   `--allow-all-tools --deny-tool="shell(git push)"`. Kilo: `--auto`. Antigravity: `--dangerously-skip-permissions`.
   Say in one line that auto is on and which provider runs, before starting.
6. **When it exits** (you're notified): run Part C. If there are findings, start the same provider again with the fix
   prompt (at most 2 fix rounds; OpenCode can continue its session with `--continue`). Then Part D. Ask me only for
   the hours, for an unsure permission, or if the provider fails twice.
7. **Report** in 5 lines at the end: provider, rounds, checks, MR, Plane/Ejad HR state.

## Part C — review the implementer's work (`review`)

1. Check the basics cheaply yourself: `git log --oneline origin/<default>..HEAD`, `git diff --stat`, then run lint,
   tests and the build (report exit codes only).
2. The **Reviewer** (fresh Sonnet) reviews the diff against the plan, the acceptance criteria and the mockup, with
   the appendix procedures. It returns at most 15 confirmed findings, each with file:line, the scenario and the fix.
   Also check the delivery pack: every listed screenshot exists and you look at each one (Read the PNG); `mr.md`
   matches the template and the real changes; nothing claims a check that didn't run.
3. Give me a **fix prompt** for the implementer (findings as a numbered list plus "re-run all checks"). Fix things
   yourself only when they are tiny or I ask. Repeat `review` once after the fixes if there were serious findings.

## Part D — deliver (`deliver`)

Mechanical, from the delivery pack (no re-reading the code, no re-writing texts). Steps 1–4 are one call, run from
the repo root with `.claude/scripts/ejad-land.cjs` if the repo has it, else `~/.claude/ejad-fleet/ejad-land.cjs`:
`node <ejad-land.cjs> deliver <branch> --pack .delivery/<task id> --plane <IDENT>-<n>` (run it with `--dry-run`
first; show me only a failure). Without either file, one script in the scratchpad:
1. Rebase on the latest default branch if needed (ask before any force push) and push.
2. Upload every `screens/*.png` to GitLab, replace each `screens/NN-<name>.png` link in `mr.md` with the uploaded
   URL.
3. Update the MR: title from `mr-title.txt`, description from `mr.md`, ready (not draft), assignee me, reviewer per
   the date rule.
4. Plane: comment `tracker.md` + the MR link, move to Review. Ejad HR: mirror to REVIEW, add the MR link and the same
   comment.
5. Hours: from `work-log.md`, show me the days and ask for the hours (one question), then log them on my sessions;
   never submit a day unless I say so.
6. Read back the MR, the Plane state and the Ejad HR status, and report in 5 lines. Leave `.delivery/` in place
   (local only).

## Part B — implement (`implement`)

Only when I ask: a Sonnet implementer (Opus only if I ask) follows the plan, then part C and part D.

## Fleet mode (default when worker-fleet is installed)

The fleet's router dispatches workers (OpenCode models from `specs/worker-fleet.config.json`), each in its own
worktree; a tester runs `eval.md`, a reviewer checks the diff, and the merger lands it with
`node .claude/scripts/ejad-land.cjs land NNN <branch>` (GitLab MR, Plane → Review, Ejad HR → REVIEW, no tokens).
Claude only writes the ticket and, optionally, reviews the result.

Part A changes:
- **Steps 1–3** as written (sync, pick, claim).
- **Step 4 (branch):** none. The fleet creates the worker branch from the checkout's `main`; check that the checkout
  is on `main` and clean, and pull it.
- **Step 5 (plan) → the ticket.** The Planner writes `specs/tickets/NNN-<slug>/rd.md` and `eval.md` in the format of
  the repo's existing tickets (read one, and `.claude/skills/write-tickets/SKILL.md` for the templates), with the next
  free `NNN`. `rd.md` holds the Plan standard's content (goal and acceptance criteria, what exists, API contract and
  gaps, decisions, states, texts, Files table, phases and steps with the file to copy) plus these lines and sections:
  `**Status:** draft`, `**Plane:** <IDENT>-<n>`, `**Ejad HR task:** <uuid>`, `## Screenshots` (the named list),
  `## Final review` (the Review procedures block), and `## Landing` with `- Mode: pr`. `eval.md` turns the acceptance
  criteria and the Verify section into numbered pass/fail checks `E-1…` (command or browser steps, expected result).
  Add the row to `specs/tickets/BOARD.md` with status `draft` and the `Runs` dependencies. Then the one plan check.
- **Step 7 (mockup):** for a new screen or a real layout change, the **worker** builds it (cheaper): add a
  `## Mockup` section to `rd.md` with what it must show (states, languages, themes, phone width, only what the API
  can do). The worker builds `mockup.html` first and waits; I see it in the dashboard's Mockup tab and answer
  *approve* or my changes. With `claude mockup` in my input, the Designer builds it instead and saves it as the
  ticket's `mockup.html` before the ticket goes to `ready`.
- **Implementer:** with `with copilot|kilo|antigravity` in my input, add `## Implementer` with that name to `rd.md`;
  the worker delegates the build steps to that CLI (command lines in `.claude/scripts/implementers.json`). Default:
  the worker's own OpenCode Go model.
- **Step 8:** commit the ticket folder and the board row on the local `main` (`docs(tickets): add ticket NNN for
  <IDENT>-<n>`), never push it on its own; it reaches GitLab with the ticket's MR.
- **Steps 9–10 → approval and start.** Tell me the ticket is `draft` on the board. I approve it on the Fleet Control
  dashboard (or say "approve", and you set it `ready`). If the router isn't running, give me the command:
  `opencode --agent router` in the repo (or `claude --agent router --name router --permission-mode auto`), and the
  dashboard URL `http://localhost:3080`.

After the fleet lands it (ticket `in-review`, **draft** MR open; Plane and Ejad HR not moved yet):
- **`review`:** Claude's final check of the MR diff (Part C). Findings go to `specs/tickets/NNN-<slug>/review.md`; if
  there are any, add a `## Rework` section to `rd.md` that points to it, set the ticket back to `ready`, and the
  router re-dispatches a worker with them.
- **`deliver`** (only after a clean review): `node .claude/scripts/ejad-land.cjs deliver NNN <branch>` marks the MR
  ready and moves Plane and Ejad HR to Review; then the hours.
- With `review deliver` together: deliver right after a clean review, without asking.

## Final result (end of part A)

```
## <Plane id> — <task title>
Project: <GitLab path> · Plane <project> · Ejad HR <project>

### Status
- Branch: <branch> · Plan: <path> — commit <hash> — checked ✔
- Mockup: <approved by <my name> on <date> | none needed> — <link>
- Draft MR: <url>
- Plane: <state> · Ejad HR: <code> <status>

### Done in this run
- Sync: <what changed, or "none">
- Backend gaps: <none | each with its task id>
- Hours: <logged per day | not logged>

### Open questions
- <each, or "none">

### Prompt to execute the plan
<the handoff prompt, in one fenced block>
```

Then one line: "When the implementer is done, run `/ejadtask <id> review`; when it's clean, `/ejadtask <id> deliver`."

At any point: if a dependency, permission, the backend or a failing check blocks progress, stop and ask me instead of
working around it.

# Contributing to worker-fleet

worker-fleet is a ticket-driven multi-agent workflow. Contributions are made the same way the product works: as tickets (`rd.md` + `eval.md`), built in an isolated worktree, verified by the tester and reviewer, and landed by the merger. This guide covers the rules for changing the workflow itself.

Read [README.md](README.md) first for the architecture and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for failure modes.

## The one rule: selftests must pass

```bash
python3 .claude/scripts/selftest.py              # full suite, zero dependencies
python3 .claude/scripts/selftest.py --list       # check names
python3 .claude/scripts/selftest.py --filter auth  # subset by substring
```

**No change to the workflow merges with a failing selftest.** The suite builds a throwaway fixture repo, starts the real dashboard server on an ephemeral port against it, and asserts the security and parsing invariants (auth, action validation, board parsing, evidence path safety, audit logging, `apply-setup.py` idempotence, secret hygiene). It never touches your live `job/` state or dashboard.

Also run the cheap gates before every commit:

```bash
python3 -m compileall -q .claude/scripts                          # Python compiles
for f in .claude/scripts/*.sh; do bash -n "$f" || exit 1; done    # shell syntax
```

When you add a security rule, a parser, or a config invariant, add a selftest check for it in the same change.

## Adding a model preset

Presets live in the `PRESETS` dict at the top of `.claude/scripts/apply-setup.py`, next to `claude-default`, `deepseek-lean`, `opencode-openai` and `hybrid-bridge`.

1. Add a new key to `PRESETS`. Copy an existing preset and edit it: it carries `harness` plus a `models` map with an entry per agent role (`router`, `worker`, `teammate`, `reviewer`, `reproducer`, `tester`, `merger`, `checker`, `watchdog`). Each role has a `claude` block (`model`, `effort`) and an `opencode` block (`model`, `reasoningEffort`); `worker` and `reviewer` may set `delegateCli` (`none`, `codex`, `opencode`).
2. `--preset` takes its choices from `PRESETS.keys()`, so the flag picks the new preset up automatically. Update the preset lists in `.claude/skills/setup/SKILL.md` and the README so users can discover it.
3. Run `python3 .claude/scripts/apply-setup.py --preset <name>` and confirm `.claude/agents/*.md` frontmatter and `.opencode/agents/*.md` regenerate as expected, then run it a second time to confirm nothing changes (idempotence is a selftest).
4. **Migration note.** Adding a preset does not change the config *schema*, so it needs no migration and no version bump. If your preset needs a new config key, that is a schema change: follow [Versioning and migration discipline](#versioning-and-migration-discipline).
5. Keep the budget in mind: a preset that swaps in a different model changes real cost. Say so in the ticket and the CHANGELOG entry.

## Adding a notify provider

Push notifications live in `.claude/scripts/notify.sh` (`notify.sh <event> "<message>" [ticket-id] [--dry-run]`), driven by the `notifications.providers[]` list in `specs/worker-fleet.config.json`. Three adapters ship today: `ntfy`, `telegram` and `slack`. The full interface (exit codes, payload shapes, log format) is in `specs/tickets/012-notification-layer/contract.md`. A new provider is an adapter plus its plumbing:

1. Define the provider entry shape: `{"type": "<name>", "<target field>": "...", "<secret field>": {"secretRef": "<id>"}, "events": [...] | "all"}`. A secret field holds `{"secretRef": "<id>"}` (resolved from the gitignored `job/notify-secrets.json`) or `{"env": "WORKER_FLEET_<NAME>"}`, never a plain string.
2. Add the adapter to `notify.sh`: add the type to `validate_provider` and `build_request` (`notify.sh` resolves each secret field before it builds the request, see `resolve_secrets`; format the message, keep the whole payload under 1 KB), and post it with `urllib` (one attempt, 10 s timeout, no retries, no `curl`, so secrets never show up on a process command line). Delivery failures are appended to `job/logs/notify.log` by `deliver()` and must never fail the caller. The `--dry-run` path prints the target and payload with secrets masked (`****` plus the last two characters) and makes no network call.
3. Teach `apply-setup.py` to validate the new `type` (`validate_notification_provider`: unknown types are a hard error naming the offending index, exit 1), add the new secret field to its inline-secret migration (`migrate_inline_notify_secrets`), and, if useful, add a convenience flag like `--notify-ntfy <topic>`.
4. Mask every secret field (token, webhook URL) wherever the dashboard prints provider status (`dashboard-server.py` notification summary): show at most the last two characters, and never serve the raw secret keys.
5. Test with `--dry-run` or a local mock HTTP server on `127.0.0.1` (`NOTIFY_CONFIG=<path>` points the script at a throwaway config; `NOTIFY_TELEGRAM_API=<url>` redirects the Telegram adapter), so CI never needs the network, and document setup steps in the README notifications section.

The canonical events are `worker_blocked`, `budget_exceeded`, `retries_exhausted`, `ticket_done`, `regression_confirmed`, `needs_human` and `watchdog_stall`; a `worker_blocked` message carries the deep link `<tunnel-or-local-url>/?ticket=NNN#decision`, which never includes the dashboard `?token=`.

Secrets belong in job/notify-secrets.json or WORKER_FLEET_ environment variables, never in the tracked config; never log them.

## Adding an agent

An agent is a markdown file with YAML frontmatter.

1. Create `.claude/agents/<name>.md` with frontmatter: `name`, `description` (one paragraph; this is what other agents read to decide whether to call it), `tools` (the minimum set; read-only agents get `Read, Grep, Glob, Bash`), `model`, and `effort`. The body is the agent's operating instructions.
2. Add a `models.<name>` entry (with `claude` and `opencode` blocks) to **every** preset in `PRESETS` in `apply-setup.py`, so `/setup` can assign it a model. An agent with no preset entry keeps whatever `model`/`effort` its file declares.
3. Regenerate the mirrors:

   ```bash
   python3 .claude/scripts/apply-setup.py
   ```

   This rewrites `model`/`effort` in `.claude/agents/*.md` and generates `.opencode/agents/<name>.md` plus `opencode.json`. Commit the regenerated files; never hand-edit `.opencode/agents/*`.
4. `.agents/skills` is a symlink to `.claude/skills`; skills need no extra copy.
5. If the router, a worker, or the tester should call the new agent, say so in `router.md` (the agents table) and keep the "never write code yourself" boundaries intact.
6. Update the README file-structure listing.

## Ticket conventions

Work is specified in `specs/tickets/NNN-slug/` (three-digit, zero-padded, never reused). Use `/write-tickets` to create tickets; it interviews you and enforces the format.

**`rd.md`** (requirements): `# NNN: Title`, `**Status:**`, `**Mode:**` (`solo` or `team`), then sections `Summary`, `Why`, `User stories`, `Functional requirements` (numbered `FR-1`, `FR-2`, ...), `Out of scope`, `Affected areas`, `Do not touch`, `Dependencies`, `Decisions made`. Optional sections: `## Retries` (`- maxRetries: N`), `## Budget` (`- USD: x`, `- Turns: n`), `## Landing` (`- Mode: pr`), `## Delegatable subtasks`. `Affected areas` and `Do not touch` are enforced: the reviewer rejects a diff that edits a forbidden file.

**`eval.md`** (verification): `Setup`, `Automated checks`, `Acceptance checks` and `Edge case checks` as `### E-N: Title (Covers FR-N)` entries, each with a `Type` (`Browser`, `HTTP`, `CLI` or `Test`), numbered `Steps`, and unambiguous `Pass criteria`; then a `Traceability` table and a `Definition of done`. Every `FR-N` maps to at least one `E-N`.

**`results.md`** (written by the worker): summary of changes, a PASS/FAIL table for build, lint and every `E-N` with links into `evidence/`, and the reviewer sign-off. Screenshots and logs live in `specs/tickets/NNN-slug/evidence/`.

**`results.json`** (written by the worker next to `results.md`; the router's verification gate reads it, and the markdown is only a fallback for legacy tickets): `ticket`, `branch`, `finishedAt`, `automated` (`build`/`lint`/`test`/`typecheck` as `PASS`/`FAIL`/`SKIP`), a `checks[]` array with exactly one entry per `E-N` in `eval.md` (`id` and `title` copied verbatim, `status`, `evidence` path relative to the ticket folder, `exitCode`), the final `reviewer` verdict (`APPROVED` or `CHANGES_REQUIRED`) and the `budget` used (`turnsUsed`, `estCostUsd`). `/write-tickets` adds a results.json line to every eval template's Definition of done. A missing or corrupt file is a failed verification and the ticket goes back to the same worker.

**Exit codes in eval steps (ticket 034).** Piping into `tee` records `tee`'s exit code, not the command's. Write every logged command as `( set -o pipefail; cmd 2>&1 | tee log ); echo "exit=$?"` so the real exit code reaches the evidence. `${PIPESTATUS[0]}` is bash-only; the subshell form works in any shell.

**`BOARD.md`** grammar (`specs/tickets/BOARD.md`) is the single source of truth. One table row per ticket:

```text
| # | Title | Status | Mode | Prio | Runs |
| 024 | Docs pack & worker-fleet branding | ready | solo | P1 | after: 023 — documents the final feature set |
```

- `Status`: `specifying` | `draft` | `ready` | `in-progress` | `blocked` | `done` | `failed` | `budget-exceeded` | `in-review`. `/write-tickets` writes `specifying` while a writer works and flips it to `draft` when finished; the user approves to `ready`; the router mirrors worker progress; the merger sets `done` (or `in-review` in PR landing mode); the router sets `failed` and `budget-exceeded`.
- `Mode`: `solo` or `team`. `Prio`: `P0` (dispatched first), `P1` (default), `P2`.
- `Runs`: `alongside` (no dependencies) or `after: 003, 005 — <reason>` (comma-separated ids, em dash before the reason). The legacy form `waits for 003: <reason>` / `waits for 001+005: <reason>` parses to the same edges, and the existing board still uses it. `/write-tickets` rejects dangling or cyclic references at write time, and the dashboard renders the edges as a dependency graph.
- Tickets that touch the same file should declare the dependency in `Runs` rather than race each other.

If you add a critical user flow, append an `R-N` entry to `specs/regression.md` (never renumber); the checker walks that list after merges.

## Versioning and migration discipline

`specs/worker-fleet.config.json` carries a `version` (currently `4.0.0`), and `apply-setup.py` owns the schema.

- **Any schema change must bump the version and register a migration.** Add a function to `apply-setup.py` and map the *old* version to it in the `MIGRATIONS` registry (see `migrate_2_to_3` and `migrate_3_to_4`). Migrations only add keys that are absent and never overwrite user-set values; they log each change as `+ key=value` (`migrate_3_to_4` is the one rewrite: it points `{"env": ...}` secret references at the new prefix and logs `~ key: old -> new`).
- Migrations run first, before preset or flag application, and are idempotent: a second run is a no-op.
- **Exit code 3 is reserved.** `apply-setup.py` exits `3` when the config comes from a *newer* worker-fleet than the script (`config is from a newer worker-fleet - upgrade worker-fleet first`), before writing anything. Never reuse `3` for another failure.
- A config without a `version` field is treated as `2.0.0`.
- The installer stamps `.claude/worker-fleet.version` in target repos and prints `upgraded from <old> to <new>` on a version change. `install.sh` moves a stamp that still has its pre-rename name (see [Upgrading an existing install](README.md#upgrading-an-existing-install)).

## Pull requests and landing

By default verified tickets merge straight to `main`. With `landing=pr` (`python3 .claude/scripts/apply-setup.py --landing pr`, or `## Landing` / `- Mode: pr` in a ticket) the merger pushes the branch and opens a PR instead (needs `gh` and an `origin` remote), and the ticket waits `in-review`.

Keep commits focused: one ticket, one branch (`feat(NNN): <title>`). A change needs: passing build/lint/selftest, a `results.md` with evidence, and an independent reviewer pass against `rd.md`.

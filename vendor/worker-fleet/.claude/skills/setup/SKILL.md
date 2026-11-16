---
name: setup
description: "Configure multi-harness settings, model presets (Claude Code, OpenCode, DeepSeek, ChatGPT/Codex), worker concurrency, port ranges, and the Fleet Control Dashboard (:3080) with Cloudflare Tunnel or ngrok. Run without arguments for an interactive interview, or pass flags directly like `harness=both preset=hybrid-bridge max_workers=4 dashboard=on tunnel=cloudflared`. Use this skill whenever the user asks to configure, setup, switch models, switch CLI harness, tune concurrency, setup OpenCode or Codex delegation, or configure the fleet control dashboard."
---

# /setup Skill: Multi-Harness & Fleet Control Configurator

Configure the worker-fleet workflow for your chosen CLI harnesses (**Claude Code**, **OpenCode**, and **ChatGPT / Codex CLI**), set model presets, configure concurrency and dev server ports, and provision the **Fleet Control Dashboard (:3080)** with secure remote tunneling.

---

## Operating Modes

### 1. One-Shot Flag Mode
If the user passes key-value flags in the prompt, apply them directly without interviewing:
```text
/setup harness=both preset=hybrid-bridge max_workers=4 dashboard=on tunnel=cloudflared
```
Supported flags:
- `preset=<claude-default | deepseek-lean | opencode-openai | hybrid-bridge | budget>`
- `harness=<claude | opencode | both>`
- `max_workers=<integer, e.g. 2, 4, 8>`
- `dashboard=<on | off>`
- `tunnel=<cloudflared | ngrok | local>`
- `remote_actions=<on | off>`
- `auto_dispatch_on_approve=<on | off>` (`--auto-dispatch-on-approve`): whether an Approve in the dashboard wakes the idle router at once (`on`, the default) or waits until you press Dispatch now or the router wakes for another reason (`off`). It writes `dispatch.autoOnApprove`; without the flag the key is left as it is.
- `main_port=<int>` (`--main-port`): the main checkout's (checker's) dev server port, default `3000`.
- `reproducer_port=<int>` (`--reproducer-port`): the reproducer's dev server port, default `3090`.
- `worker_base_port=<int>` (`--worker-base-port`): the first worker dev server port, default `3101`; worker slot N uses base + N - 1.
- `dashboard_port=<int>` (`--port`): the Fleet Control Dashboard port, default `3080`. Give each worker-fleet project on one machine its own ports (`main_port`, `reproducer_port`, `worker_base_port` and `dashboard_port`), so two projects can run at once.
- `landing=<direct | pr>` — how verified tickets land: `direct` merges straight to `main` (default, full autopilot); `pr` pushes the branch and opens a GitHub PR, leaving the ticket `in-review` for human review. **Warning (non-fatal)**: when `landing=pr` is set but the `gh` CLI is not on PATH or no `origin` git remote exists, `apply-setup.py` prints a warning — setup still completes, but the merger will abort PR creation cleanly (ticket stays `ready`, nothing pushed) until `gh` is installed and/or the remote is added.
- `install_into=<path>` — install the workflow into an EXISTING repo at `<path>` (see mode 3 below)

### 2. Interactive Interview Mode
If `/setup` is invoked with no flags, interview the user **one question at a time**, listing concrete options with your recommended choice first.

### 3. Install-Into Mode (`install_into=<path>`)
If the user passes `install_into=<path>` (or asks to install / share this workflow into another repo), run the installer instead of configuring the current one:

```bash
bash .claude/scripts/install.sh <path>
```

The installer is **idempotent and non-destructive**:
- The target must exist and be a git repo (otherwise it exits 1 with a clear error). It refuses (exit 1) if a directory it would write into (`.claude`, `.claude/agents`, `.worker-fleet-backup`, `specs`, ...) is a symlink in the target, so nothing is ever written outside the repo. A symlinked (or dangling) `specs/worker-fleet.config.json` or `specs/tickets/BOARD.md` in the target is refused the same way (exit 1, nothing written through it). The check covers every destination up front, so a refused run copies nothing. `bash .claude/scripts/install.sh --help` prints usage.
- It copies `.claude/agents/`, `.claude/skills/`, `.claude/scripts/`, `.claude/dashboard/`, `.claude/settings.json`, `.opencode/agents/`, `opencode.json`, and `.agents/skills/`, and creates the `specs/` skeleton (`specs/worker-fleet.config.json` with defaults, `specs/tickets/BOARD.md` with the empty header) only if absent.
- Any existing file that would be overwritten is first moved to `<path>/.worker-fleet-backup/<timestamp>/<relative-path>` (a fresh dir per run, even within the same second) — nothing is ever deleted. Only files git tracks in the source are installed, so untracked scratch files (`.env`, swap files) never reach the target.
- It stamps `<path>/.claude/worker-fleet.version` (installer-owned, rewritten in place without a backup; a symlinked stamp is refused); an existing older stamp prints `upgraded from <old> to <new>`.
- A second run with no source changes prints `already up to date` and changes nothing.

After a successful install, tell the user the printed next steps: run `python3 .claude/scripts/apply-setup.py` (or `/setup`) inside the target, then `/write-tickets`, then launch the router and the dashboard. Do **not** edit the target's `.gitignore` yourself — the installer prints a hint listing `job/` (it holds the dashboard auth token), `.claude/worktrees/`, `__pycache__/` and `.worker-fleet-backup/` (only entries not already ignored) and leaves that choice to the user. Relay that hint to the user.

#### Step 1: Target CLI Harness
Ask the user which CLI tools they plan to run:
- **(A) Both Claude Code & OpenCode / Codex [Recommended]**: Generates native agent definitions for both `.claude/agents/*.md` and `.opencode/agents/*.md`, registers `opencode.json`, and enables `delegate-task.sh` for Codex/OpenCode CLI passes.
- **(B) Claude Code Only**: Configures `.claude/agents/*.md` exclusively.
- **(C) OpenCode Only**: Optimizes for `opencode` with primary `router` mode and subagent roles.

#### Step 2: Model & Harness Preset
Present the 5 built-in presets:
- **(A) `hybrid-bridge` [Recommended]**: Claude `opus` orchestrator + Claude `sonnet` workers + OpenAI `o3` / `gpt-5` via OpenCode or `codex exec` for deep second-opinion code reviews and reproducer fixes.
- **(B) `claude-default`**: Pure Anthropic stack (Opus router on high effort, Sonnet workers/reviewers on high effort, Sonnet testers/mergers).
- **(C) `deepseek-lean`**: Ultra-low cost orchestrator (`sonnet` or `deepseek-chat`) + deep reasoning workers and reviewers (`deepseek-reasoner` / `sonnet`).
- **(D) `opencode-openai`**: Full OpenAI stack for OpenCode (`openai/gpt-5` router and workers, `openai/o3` reviewers and reproducers, `gpt-4.1-mini` testers).
- **(E) `budget`** (opt-in, never the default; `/setup preset=budget`): cost-sensitive stack. Trade-offs: cheap small roles (`tester`, `merger`, `checker`, `watchdog` on `openai/gpt-4.1-mini` / `haiku`), `router` and `reproducer` on `openai/gpt-4.1` / `sonnet`, workers and teammates at **medium** effort (`anthropic/claude-sonnet-4-5` / `sonnet`), and a **strong reviewer** (`openai/o3` / `sonnet` on high effort, because cheap reviews are a false economy). Expect lower spend, with weaker small-role judgement and less thorough workers than the default.
- **(F) Custom**: Let the user specify exact models per role.

All cost figures in the setup summary and the dashboard are **estimates** (`~ est.`), computed from the user-editable `telemetry.rates` block in `specs/worker-fleet.config.json` (USD per 1M tokens) — never invoices.

#### Step 3: Concurrency & Port Ranges
Confirm parallel worker settings:
- **(A) Standard [Recommended]**: 4 parallel workers, main app on `:3000`, dashboard on `:3080`, reproducer on `:3090`, workers on `:3101`..`:3104`.
- **(B) Custom**: Prompt for the max parallel workers (`--max-workers`), the main app port (`--main-port`), the reproducer port (`--reproducer-port`) and the first worker port (`--worker-base-port`). Recommend (B) when another worker-fleet project on this machine already uses the standard ports.

#### Step 4: Fleet Control Dashboard & Remote Tunnel
Configure live dashboard (:3080):
- **(A) Cloudflare Quick Tunnel [Recommended]**: Auto-starts Fleet Control with a temporary public HTTPS URL (`https://*.trycloudflare.com/`) with no account required.
- **(B) ngrok Tunnel**: Uses local ngrok agent.
- **(C) Localhost Only**: Binds strictly to `http://127.0.0.1:3080`.
- **(D) Disabled**: Turns off dashboard auto-start.

---

## Execution: Applying the Settings

Once choices are determined, run the deterministic setup script:

```bash
python3 .claude/scripts/apply-setup.py \
  --preset "<preset>" \
  --harness "<harness>" \
  --max-workers <max_workers> \
  --dashboard <on|off> \
  --tunnel <cloudflared|ngrok|local> \
  --remote-actions <on|off> \
  [--auto-dispatch-on-approve <on|off>] \
  [--main-port <main_port>] [--reproducer-port <reproducer_port>] \
  [--worker-base-port <worker_base_port>] [--port <dashboard_port>]
```

The script will:
1. Update `specs/worker-fleet.config.json` with the chosen configuration.
2. Update frontmatter in `.claude/agents/*.md` (`model`, `effort`, `autoCompactWindow`).
3. Generate `.opencode/agents/*.md` and root `opencode.json` for OpenCode compatibility.
4. Synchronize security credentials in `job/dashboard-auth.json`.
5. Ensure execution permissions on all helper scripts.
6. When `landing=pr` is set, check the `gh` CLI and `origin` remote and print a **non-fatal warning** if either is missing — surface that warning to the user verbatim (setup still succeeds; the merger aborts PR creation cleanly until the precondition is fixed).
7. Record this project's main checkout in `~/.worker-fleet/projects.json` and print a `WARNING: port overlap ...` line for every other registered project that uses one of the same ports. Surface each such line to the user verbatim and offer new ports (the port flags above). The script never changes a port by itself.

---

## Post-Setup Summary

After running `apply-setup.py`, print a clean summary to the user:
1. Active preset, target harness, and model mappings for key roles (`router`, `worker`, `reviewer`), plus the one-line `~ est.` cost-per-role rate table the script prints (sourced from `telemetry.rates`).
2. Concurrency limit and dev port assignments, plus every `WARNING: port overlap` line verbatim.
3. How to launch the router in Claude Code:
   ```bash
   claude --agent router --name router --permission-mode auto
   ```
4. How to launch the router in OpenCode:
   ```bash
   opencode --agent router
   ```
5. How to start the Fleet Control Dashboard:
   ```bash
   bash .claude/scripts/start-dashboard.sh
   ```
6. The summary shows the dashboard auth token masked (last 4 characters). Never pass `--show-token` and never print `job/dashboard-auth.json`; tell the user they can read the token from `job/dashboard-auth.json` themselves.

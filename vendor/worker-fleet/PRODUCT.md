# Product

<!-- impeccable:product-schema 1 -->

> Written by the ticket writer for ticket 053 from the user's brief and the repository. The user was not interviewed directly; the decisions came through the router and are marked **(user)**. Everything else is inferred from the code and docs and marked **(inferred)**. Ticket 053 copies this file to the repository root as `PRODUCT.md`.

## Platform

web

## Users
- **(inferred)** One owner, usually the developer who installed worker-fleet in their repository. They run a swarm of AI coding agents: a router, workers in git worktrees, a tester, a reviewer, a merger, a checker and a watchdog. They supervise it through Fleet Control.
- **(user)** Two scenes matter:
  - **At the desk**, on a laptop or a large monitor, next to the terminal that runs the router.
  - **Away from the desk**, on a phone at 360-430 CSS px, through a Cloudflare or ngrok tunnel, often one-handed and in short glances.

## Product Purpose
- Fleet Control answers three questions, in this order:
  1. Is anything stuck, dead or waiting for me?
  2. Where is each ticket in the pipeline?
  3. What has it cost?
- It also lets the owner act without the terminal:
  - approve a draft;
  - set a priority;
  - answer a blocked worker;
  - pause, resume or stop a worker;
  - re-run the checker;
  - reap merged worktrees;
  - resume a degraded swarm;
  - trigger the watchdog;
  - reset the telemetry baseline.
- Success means the owner can supervise a run from a phone without opening a laptop, and can trust that no one else can.

## Positioning
- **(inferred)** It is the control room of a file-backed, autonomous ticket pipeline.
- Every number and state on the page comes from a file the agents write:
  - `specs/tickets/BOARD.md`;
  - heartbeats in `job/status*.json`;
  - the router ledger `job/router-state.json`;
  - `job/swarm-state.json`;
  - telemetry from the harness session logs;
  - `job/audit.jsonl`.
- A generic Kanban tool cannot show agent heartbeats, pipeline stages, live budget burn or worktree health. This page can.

## Operating Context
- The dashboard runs per project, on its own port (ticket 051). It is served by `.claude/scripts/dashboard-server.py` from a single file, `.claude/dashboard/index.html`.
- Data arrives by SSE (`/api/events`), with 3 s polling as the fallback.
- Typical scale:
  - a board of 10-80 tickets, most of them `done` in a mature run;
  - 0-8 active workers;
  - 0-3 tickets that need the owner;
  - an audit trail of up to 5,000 actions.
- Ticket specs (`rd.md`, `eval.md`) are long Markdown documents that are read on the page.

## Capabilities and Constraints
- **(user)** The page must be fully usable on phones: no horizontal page scroll, touch targets of at least 44 px, readable type, and navigation that works one-handed.
- **(user)** A visitor who is not on this machine and has no valid token sees nothing of the app, only a sign-in screen (ticket 052).
- **(inferred)** No build step and no external CDN. The page is one self-contained HTML file that uses system fonts.
- **(inferred)** Deny-by-default auth, 5-strike lockout, a one-time `?token=` bootstrap that sets an HttpOnly `wf_session` cookie, the PIN prompt, and redaction of secrets in `/api/state` (tickets 001, 046, 052).
- **Statuses:** `specifying`, `draft`, `ready`, `in-progress`, `in-review`, `blocked`, `failed`, `budget-exceeded`, `done`.
- **Priorities:** `P0`, `P1`, `P2`.
- **Pipeline phases (047):** building, awaiting review, in review, changes requested, approved · awaiting merge, merging, held, paused, needs your decision.

## Brand Commitments
- The name is `worker-fleet`, and the surface is called "Fleet Control".
- **(inferred)** There is no logo asset, typeface or palette commitment beyond a dark UI. The current lightning-bolt emoji tile is not a brand asset.

## Evidence on Hand
- Real tickets 001-051 in `specs/tickets/` with rd.md, eval.md, results and evidence screenshots.
- Real telemetry comes from the harness logs. Nothing may be invented: no fake costs or fake agent counts in the shipped page.

## Product Principles
1. Exceptions first: what needs the owner outranks what is merely happening.
2. Every state is traceable to the file that produced it, and the page never invents state.
3. A phone is a first-class surface, not a shrunken desktop.
4. Destructive or costly actions always confirm, and always say what will happen.
5. Private by default: a remote visitor without the token learns nothing.

## Accessibility & Inclusion
- **(inferred)** WCAG 2.2 AA:
  - text contrast of at least 4.5:1;
  - full keyboard operation with visible focus;
  - screen-reader labels for every control and live status;
  - `prefers-reduced-motion` and `prefers-color-scheme` respected.

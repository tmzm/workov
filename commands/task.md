---
description: Prepare and run a task of any project (Ejad, The Inspiring Woman, Personal, or any other) on the worker fleet. Ejad mode is exactly /ejadtask; other modes use a profile file that is created on first use.
argument-hint: "[ejad | inspiring-women | personal | <profile name>] [task id or description] [headless | with <cli> | review | deliver | profile | other changes]"
---

# /task — one command for every kind of work

The fleet (router, planner, worker, tester, reviewer) does not care which project a task belongs to. What changes per
project is only the **profile**: where tasks come from, how branches and commits are named, what "checked" means, and
how work is delivered. `/task` picks the profile, then runs the same flow.

## 1. Pick the mode

The first word of my input names the mode. When it does not, decide from the current folder:

| Folder contains | Mode |
| --- | --- |
| `\Ejad\` or a `specs/worker-fleet.config.json` with Plane settings | `ejad` |
| `The Inspiring Woman` | `inspiring-women` |
| `\Personal\` | `personal` |
| anything else | ask me which mode (offer the existing profiles plus "new") |

## 2. Ejad mode

Read `~/.claude/commands/ejadtask.md` in full and follow it exactly, passing the rest of my input as its input. Nothing
about Ejad work changes: Plane sync, Ejad HR, GitLab MR, reviewers, hours, and every rule in that file stay as they are.
`/ejadtask` keeps working as the same thing.

## 3. Every other mode: the profile

A profile is one Markdown file, `~/.claude/task-profiles/<mode>.md`, with this shape:

```
# Profile: <mode>
- Repo: <absolute path of the project>
- Task source: <local board `specs/tickets/BOARD.md` | GitHub issues | GitLab issues | Plane project <id> | none: I describe it>
- Branch name: <e.g. feat/<slug>>
- Commit style: <e.g. conventional, single line>
- Checks: <the commands that prove a change is good: lint, test, build>
- Delivery: <push + PR on GitHub | MR on GitLab | leave in working tree | other>
- Rules: <anything specific: language, design system, never touch X>
```

Steps:
1. Read the profile. If the file does not exist, or a field is missing: **do not guess**. Inspect the repo first
   (git remote, package.json scripts, CLAUDE.md/AGENTS.md, branch history) to propose answers, then ask me only for what
   the repo could not tell you (AskUserQuestion, with the proposed answers as the options). Then **write the profile file**
   and carry on. `/task <mode> profile` re-opens it for changes.
2. Make sure the fleet is in the repo: it is when `specs/worker-fleet.config.json` exists. If not, offer to run
   `bash <workerov-fleet>/install.sh <repo>` (it only adds the fleet; the Ejad layer's Plane/HR parts stay unused for
   non-Ejad profiles) and wait for my yes.
3. Get the task: from the profile's task source (an id), or from my words if the source is `none` or I typed a
   description. Create the ticket on the repo's board exactly as `/ejadtask` does (rd.md with the short plan, tests
   first, small steps that copy existing files, the board row), but skip every Plane, Ejad HR and hours step. Use the
   profile's branch name, commit style and checks wherever the Ejad flow names its own.
4. The worker builds, tester and reviewer gate it, as on any fleet ticket. I watch it on the dashboard.
5. `review` and `deliver` follow the profile's Delivery line. The global rules in `~/.claude/CLAUDE.md` still apply to
   every commit and PR description (one-line conventional commits, no AI attribution, no force push).

## Rules

- A profile file never holds secrets. Tokens stay in environment variables.
- Never mix modes in one run: an Ejad ticket never reads another profile and the reverse.
- If the provider is capped or a model fails, say so and point me at the dashboard's Providers panel (Switch, Connect,
  Test) rather than retrying in a loop.

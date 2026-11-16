# Plan: projects, tickets per project, and a worktree view per ticket

Status: proposal, nothing built. Written for the Workeve owner.

## Goals
1. A **project** is the thing a ticket belongs to: Ejad HR web app, Inspiring Women, a personal project. Every ticket has exactly one.
2. Open a project and see its details, its tickets, and its **links**: Plane project, Ejad HR project, git remote / MR list, docs.
3. Open a ticket and see its **worktree**: branch, what changed, files, diffs, commits, uncommitted work. Live while a worker is building.

## Data model (small, file based like the rest of the fleet)
- `specs/projects.json`, one entry per project:
  `{ id, name, repo (absolute path), baseBranch, worktreeRoot, mode: "ejad" | "task", color,
     links: { plane: {workspace, project, url}, ejadHr: {projectId, url}, git: {remote, mrList}, docs: [..] },
     rules: "short text shown to workers", fleet: { maxWorkers, models? } }`
- A ticket names its project in `rd.md` (`**Project:** ejad-hr-web`), next to the existing `**Plane:**` and `**Ejad HR task:**` lines.
  Missing means the default project (today's repo), so nothing existing breaks.
- The board row stays as is; the dashboard reads the project from `rd.md` (same way it reads the HR task id today).

## Screens
- **Projects tab** (in the navbar, next to Board). Project cards: name, repo, open / building / in review / done counts,
  last activity. Open a card: details, links (each is a button), tickets of the project (board filtered), settings (edit the JSON from a form).
- **Board** gets a project filter and a colour chip on each card.
- **Ticket drawer, new "Worktree" tab** (next to Logs): 
  - header: branch, base, worktree folder, ahead / behind, last commit, worker state
  - **Changes**: file tree of `git diff base...branch` plus uncommitted files, with +/- counts; click a file for a diff
    (the same diff renderer the chat and the timeline logs use)
  - **Commits**: one-line list; click for its diff
  - buttons: open the folder, open the chat in this worktree (the chat folder menu already lists worktrees), copy the branch name
  - refresh every few seconds while the ticket is in progress; static otherwise
  - after the worktree is removed (ticket delivered) the tab falls back to the branch on the remote, or to `results.md` evidence

## Server pieces (dashboard-server.py patch, read-only git)
- `GET /api/wv/projects` (list, counts), `POST` action `wv_project_save` (create / edit / delete; validates paths)
- `GET /api/wv/worktree?ticket=NNN`: `git worktree list`, `rev-list --left-right --count`, `diff --numstat`, `status --porcelain`, `log`
- `GET /api/wv/worktree/diff?ticket=NNN&file=...`: one file's unified diff, size limited, path checked to stay inside the worktree
- every git call uses a fixed argument list (no shell), a timeout, and refuses paths outside the project repo

## Fleet pieces
- The router and `wv-worker-worktree` already create `<repo>-NNN-slug` worktrees; they read the repo and base branch from the ticket's project instead of from one global config.
- `/task` and `/task ejad` ask for the project when a ticket is created (default to the folder you are in).
- Landing mode, Plane and HR mirroring read their settings from the project (an `ejad` project mirrors, a `task` project does not).

## Phases (each one ships on its own)
1. **Worktree view** for the current single project (no new data needed): server endpoints plus the drawer tab. About a day.
2. **Projects as metadata**: `projects.json`, `**Project:**` line, Projects tab, board filter, links. About a day.
3. **Per-project fleet settings**: models, workers, landing, mirroring read from the project; ticket creation asks for the project. About a day.
4. **More than one repo** at once: one router cycle across projects, per-project worktree roots and ledgers, fair sharing of the worker limit. Largest piece, only when a second repo is really in use.

## Decisions to make before phase 2
- Should a ticket be able to belong to several projects (a change in two repos)? Proposal: no, split it into two tickets that wait for each other.
- Where does `projects.json` live when the fleet is installed in more than one repo? Proposal: one per fleet folder, and Workeve can switch between fleet folders (it already has "Choose fleet folder").
- Ejad HR project ids: read them once from the HR API (needs a working HR login) or type them in the form.

## Risks
- A worktree can contain thousands of changed files (generated code): list with a cap and say how many are hidden.
- Diffs of binary or huge files: refuse above a size and link to the folder instead.
- Paths in the API must never leave the repo: one helper checks every path, with a test.

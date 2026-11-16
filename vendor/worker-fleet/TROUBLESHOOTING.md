# worker-fleet Troubleshooting

Every section follows the same shape: **Symptom** (what you see), **Cause** (why it happens), **Fix** (commands you can paste). All commands run from the repository root. Paths such as `job/` are gitignored runtime state; `specs/tickets/BOARD.md` is the single source of truth for ticket status.

Quick reference:

| Symptom | Section |
| --- | --- |
| `Address already in use`, a worker cannot start its dev server | [Port conflicts](#port-conflicts) |
| `.claude/worktrees/` is full of old directories, `git worktree list` shows dead entries | [Stale worktrees](#stale-worktrees) |
| Dashboard rejects your token, or you leaked it | [Token rotation](#token-rotation) |
| You committed or shared a Telegram bot token, Slack webhook or ntfy password | [Rotating a leaked notification secret](#rotating-a-leaked-notification-secret) |
| No public URL, tunnel never appears, QR code points nowhere | [Tunnel failures](#tunnel-failures-cloudflared--ngrok) |
| The router session died or was restarted mid-run | [Router crash recovery and adoption](#router-crash-recovery-and-adoption) |
| A ticket is `budget-exceeded` | [Budget-exceeded recovery](#budget-exceeded-recovery) |
| A ticket is `failed`, or the run stopped with `needs-human` | [Failed tickets and retries](#failed-tickets-and-retries) |
| The phone shows a Sign in page | [The phone shows a Sign in page](#the-phone-shows-a-sign-in-page) |
| The dashboard on this computer shows Sign in or answers 401 | [The dashboard asks for a token on this computer](#the-dashboard-asks-for-a-token-on-this-computer) |
| HTTP 429 "locked out" on the dashboard | [Dashboard lockout](#dashboard-lockout) |
| A dashboard action returns 401, 403 or 415 | [Dashboard actions return 401, 403 or 415](#dashboard-actions-return-401-403-or-415) |
| `selftest.py` reports a FAIL | [Selftest failures](#selftest-failures) |
| The router bounces a finished ticket back to its worker | [Missing or corrupt results.json](#missing-or-corrupt-resultsjson) |
| Dispatch is paused after a provider-limit death | [Swarm degraded: continue / Resume Swarm](#swarm-degraded-continue--resume-swarm) |
| Browser checks fail with `agent-browser` exit 126 or "not found" | [agent-browser not working](#agent-browser-not-working) |
| `apply-setup.py` no longer prints my token | [Token rotation](#token-rotation) |

---

## Port conflicts

**Symptom.** A worker's dev server fails with `Address already in use`, the tester cannot reach `http://127.0.0.1:310x`, or the dashboard will not start on `:3080`. The watchdog report lists a `ports` entry that is `listening: true` for a port the router was about to assign (or one that went silent for a live worker).

**Cause.** Another process (a leftover dev server from a dead worker, a second dashboard, an unrelated app) holds the port. Defaults: main app `:3000`, dashboard `:3080`, reproducer `:3090`, workers `:3101`, `:3102`, ... (one per parallel worker).

**Fix.**

```bash
# Who owns the port?
ss -ltnp 'sport = :3101'          # or: lsof -i :3101

# See every watched port at a glance (JSON: "ports":[{"port":..,"listening":..}])
bash .claude/scripts/watchdog-check.sh --json

# Who is on the port? A worker-fleet dashboard names its project and root
curl -s http://127.0.0.1:<port>/api/identity

# Stop a leftover dashboard started by start-dashboard.sh
# (only stops this project's dashboard server, never another project's)
bash .claude/scripts/start-dashboard.sh --stop

# Move the dashboard to a free port and regenerate config
python3 .claude/scripts/apply-setup.py --port 3081
```

**Several projects on one machine.** `start-dashboard.sh` no longer treats any listener on its port as its own. It asks `GET /api/identity` who holds the port, reuses only this project's dashboard, and otherwise a second project's dashboard moves itself to the next free port (the first free one in the next 10 ports, skipping this project's own app, reproducer and worker ports) and saves it to this project's `specs/worker-fleet.config.json`. With an explicit `--port` it refuses instead (exit 1, naming the holder). A holder that answers no `/api/identity` is shown as "a process that is not this project's dashboard": find it with `ss -ltnp`. `--stop` only stops this project's dashboard server: if `job/dashboard-server.pid` holds a pid that is not this project's `dashboard-server.py`, it prints a notice, does not signal it and removes the pid file. Tunnels follow the same rule: `--stop` signals the pid in `job/cloudflared.pid` or `job/ngrok.pid` only when it is **this project's tunnel** (its command line and working directory), and a start reuses this project's tunnel only for the current port. A dashboard of this project that stops answering `/api/identity` (paused with Ctrl-Z, or overloaded) is still recognised by its **listening process** and reused, not started a second time.

If the owner is a dead worker's dev server, kill that process (`kill <pid>`) and, if its worktree is also stale, reap it (see [Stale worktrees](#stale-worktrees)). To give this project other ports, run `python3 .claude/scripts/apply-setup.py --main-port <n> --reproducer-port <n> --worker-base-port <n>`; it refuses ports that clash inside the project, and prints `WARNING: port overlap` when another project registered in `~/.worker-fleet/projects.json` uses the same ones.

---

## Stale worktrees

**Symptom.** `.claude/worktrees/` contains directories for workers that are long gone, `git worktree list` shows entries whose directories vanished, or a dead worker's branch blocks a fresh dispatch. The watchdog report lists a stall for a heartbeat that has not changed for longer than `watchdog.stallThresholdMinutes` (default 15).

**Cause.** A worker died (provider limit, crash, killed session) without cleaning up. Worktrees are never removed silently while they might hold unsalvaged evidence.

**Fix.** Reaping is salvage-before-remove: new files under `specs/tickets/NNN-slug/evidence/` and `results.md` are copied into the main checkout first, and the reap aborts (nothing destroyed) if salvage fails. Always dry-run first.

```bash
# What is registered?
git worktree list

# Dry-run: JSON report of stale worker worktrees (nothing removed)
bash .claude/scripts/watchdog-check.sh --reap

# Remove them (salvage first)
bash .claude/scripts/watchdog-check.sh --reap --apply

# Reap exactly one worktree that must still carry a stale job/status.json
bash .claude/scripts/watchdog-check.sh --reap --apply --path .claude/worktrees/<dir>

# Completed (merged) worktrees and husk directories: dry-run, then apply the safe set
bash .claude/scripts/watchdog-check.sh --reap-completed
bash .claude/scripts/watchdog-check.sh --reap-completed --apply

# Clear registry entries whose directory is already gone
git worktree prune
```

An `"action": "abort"` entry in the JSON means salvage failed for that worktree (or a stale lock could not be released): look at it by hand, copy anything valuable, then retry.

`--reap` never salvages, unlocks or removes a worktree that may be in use. It lists it with `"action": "keep"` and the `reason`: the heartbeat is fresh, cannot be parsed, has phase `done` or `blocked`, or its ticket is `done`, `in-review` or `blocked` on `specs/tickets/BOARD.md` (completed worktrees are left to `--reap-completed`); the worktree is locked by a live process or by hand; or a live process has its working directory inside it. A heartbeat's age is always the heartbeat file's `modification time`, never the `updatedAt` written inside it. A `live process` inside the worktree keeps it in both `--reap` and `--reap-completed`. Processes are listed from `/proc`, else with `lsof`; with neither, or if `git worktree list` fails, nothing is reaped. A hand lock is released with `git worktree unlock <dir>`; a Claude Code lock whose process is gone is released by the reaper before the removal. Leftover `job/status-*.json` heartbeats of done tickets are no longer reported as stalls and may be deleted by hand.

The router also reaps stale workers itself during every cycle; manual reaping is only for when no router is running.

---

## Token rotation

**Symptom.** The dashboard answers `401` to a token you believe is right, you pasted the token somewhere public, or `apply-setup.py` printed "Token rotated - the previously committed value is considered burned."

**Cause.** The dashboard auth token lives in the gitignored `job/dashboard-auth.json`, never in the tracked config. A token that was ever committed in `specs/worker-fleet.config.json` is considered burned and is rotated automatically the next time `apply-setup.py` runs. A rotated or regenerated token invalidates the old one and any browser session cookie issued for it.

**Fix.**

```bash
# Force a brand-new token
python3 .claude/scripts/apply-setup.py --regenerate-token

# Read it back
python3 -c "import json; print(json.load(open('job/dashboard-auth.json'))['authToken'])"
```

The `apply-setup.py` summary **masks the token** (it shows only the last 4 characters and where it is stored), so terminal scrollback and logs never hold the full secret. To print it once, run `python3 .claude/scripts/apply-setup.py --show-token`, or read `job/dashboard-auth.json` as above. Do not paste the output of `--show-token` into tickets, evidence files or chat. If the `apply-setup.py` summary or `job/dashboard-server.log` says the dashboard token does not look randomly generated, the token was set by hand: regenerate it with `python3 .claude/scripts/apply-setup.py --regenerate-token`.

Then open `http://127.0.0.1:3080/?token=<new token>` once: the server sets a 30-day `wf_session` cookie and the page strips the token from the address bar. If you use a tunnel, run `bash .claude/scripts/start-dashboard.sh` in a terminal: it prints the tunnel URL and a QR code that carries the fresh token. Never put the token in `specs/worker-fleet.config.json` or commit `job/`.

---

## Rotating a leaked notification secret

**Symptom.** A Telegram bot token, a Slack incoming-webhook URL or an ntfy password was committed, pasted into a ticket or chat, or shown in a log, or `selftest.py` reports a `no_provider_secrets_in_files` FAIL.

**Cause.** Notification secrets belong in the gitignored `job/notify-secrets.json` or in a `WORKER_FLEET_` environment variable, never in the tracked `specs/worker-fleet.config.json`. A value that ever reached a commit is in git history, and a bot token or webhook cannot be regenerated locally: the provider has to revoke it.

**Fix.** Revoke the leaked value at the provider first, then store the new one.

- **Telegram.** Message `@BotFather`, send `/revoke`, pick the bot, and store the new token it returns.
- **Slack.** Open the app's **Incoming Webhooks** page, remove the leaked webhook and add a new one for the channel.
- **ntfy.** Change the password on the server, for example `ntfy user change-pass <user>`.

Store the new value in `job/notify-secrets.json` (under the id the config references, for example `telegram-1`; keep the file mode `0600`) or in a `WORKER_FLEET_` environment variable (`{"env": "WORKER_FLEET_TG_TOKEN"}`). Or paste it inline into the provider entry and run `python3 .claude/scripts/apply-setup.py`: it moves the value into `job/notify-secrets.json` and never prints it. Then check that the provider resolves (the dry run masks the token and the chat id and sends nothing):

```bash
bash .claude/scripts/notify.sh needs_human "rotation test" --dry-run
```

Removing the commit from history is not enough: anyone who fetched it has the old value, so rotate it.

---

## Tunnel failures (cloudflared / ngrok)

**Symptom.** `start-dashboard.sh` prints "cloudflared binary not found in PATH. Defaulting to local access.", "Cloudflare quick tunnel taking longer to establish", or finishes with only a `127.0.0.1` URL. The QR code opens a dead page.

**Cause.** The tunnel binary is missing, offline, rate limited, or the quick tunnel has not published its URL yet. Quick-tunnel URLs are temporary and change on every start.

**Fix.**

```bash
# Is the binary installed?
command -v cloudflared || command -v ngrok

# What did the tunnel say?
tail -n 50 job/cloudflared.log      # Cloudflare quick tunnel
tail -n 50 job/ngrok.log            # ngrok (the public URL is on its "started tunnel" line)

# Restart cleanly
bash .claude/scripts/start-dashboard.sh --stop
bash .claude/scripts/start-dashboard.sh

# Switch provider for a single launch
bash .claude/scripts/start-dashboard.sh --tunnel ngrok
bash .claude/scripts/start-dashboard.sh --tunnel local   # no tunnel, loopback only

# Make the choice permanent
python3 .claude/scripts/apply-setup.py --tunnel local
```

ngrok needs a one-time `ngrok config add-authtoken <token>` before it will start a tunnel. The last URL is saved in `job/dashboard-url.txt`. **`start-dashboard.sh --help` prints the usage and starts nothing.** An unknown flag (for example the typo `--stpo`) or a `--port`/`--tunnel` without its value is rejected with exit code 2 before anything starts, so it can no longer open a public tunnel by accident. If a tunnel was left running by an older copy of the script or by a typo, stop it with `bash .claude/scripts/start-dashboard.sh --stop`, which stops this project's server and tunnels recorded in `job/*.pid` (a pid that belongs to anything else gets a notice and is left alone). The ngrok public URL is read from this project's own `job/ngrok.log` (its `started tunnel` line), so two projects' ngrok agents never swap URLs. Check with `ps aux | grep -E 'cloudflared|ngrok'` that nothing is left.

---

## Router crash recovery and adoption

**Symptom.** The router session crashed, hit a provider limit, or you closed it while workers were running. On restart you worry about double-built tickets or lost worktrees.

**Cause.** None to fix: the router is stateless by design. All durable state lives in `job/router-state.json` (the run ledger), `specs/tickets/BOARD.md`, the live git worktrees, and every worker's `job/status.json` heartbeat.

**Fix.** Just start the router again:

```bash
claude --agent router --name router --permission-mode auto
```

On its first cycle it reconciles every ledger entry: a worker whose heartbeat is fresher than `watchdog.stallThresholdMinutes` is **adopted** (messaged to resume, never re-dispatched), a missing or stale heartbeat is **reaped** (salvage first) and the ticket returns to `ready` with its `retriesUsed` kept, and an entry whose work already landed is **pruned**. It reports the whole reconcile as one line, e.g. `Reconciled run-20260214T101530Z-a1b2: adopted 1 (002), reaped 1 (005 -> ready), pruned 1.`

If it keeps reaping a worker you know is alive, check the heartbeat file the worker maintains:

```bash
cat .claude/worktrees/*/job/status.json     # phase, updatedAt, branch, attempt
cat job/router-state.json                   # the ledger
cat job/watchdog-report.json                # latest scheduler report (script mode)
```

A ledger corrupted by hand can be deleted (`rm job/router-state.json`); the router then rebuilds from the board and worktrees, but it loses the retry counters, so each ticket gets a fresh retry budget, and budget counting restarts from the next cycle for tickets still in flight (their `budgetSince` stamp is written again then).

---

## Budget-exceeded recovery

**Symptom.** A ticket's board status is `budget-exceeded`, its `results.md` ends with a `## Budget exceeded (auto - router)` block, and the router reported `Ticket NNN budget-exceeded: <turns> turns / $<cost> - <turns|USD> cap hit`.

**Cause.** The worker used up its turn budget (a deterministic `maxTurns` hard stop) or its estimated cost reached the USD cap. The USD figure counts only spend since the ticket's first dispatch in this run (the `budgetSince` stamp in `job/router-state.json`); spend on writing or planning the ticket stays visible on the dashboard but is never compared against the cap. Defaults: **$10.00 and 300 turns** per ticket. The router never auto-retries this state; a human decides whether the ticket deserves more budget.

**Fix.** Inspect what was spent, raise the cap, then set the ticket back to `ready`.

```bash
# What was burned?
tail -n 12 specs/tickets/NNN-slug/results.md
```

Raise the budget for this ticket only, by adding to its `rd.md`:

```markdown
## Budget
- USD: 20.00
- Turns: 500
```

or raise the defaults for every ticket:

```bash
python3 .claude/scripts/apply-setup.py --budget-usd 20 --budget-turns 500
```

Then change the ticket's `Status` to `ready` on `specs/tickets/BOARD.md` (or ask the router: "Mark ticket NNN ready"). The next dispatch starts a fresh attempt with the new budget. Retries and later dispatches in the same run keep counting from that first dispatch, so the raised cap must cover what the earlier attempts already spent. If the same ticket keeps blowing through budgets, split it into smaller tickets with `/write-tickets`.

---

## USD cap not enforced

**Symptom.** The router's cycle line says `USD cap not enforced: ...`.

**Cause.** The router checks each ticket's spend against its cap through this project's dashboard (`byTicketBudget` in `GET /api/telemetry`), after asking the dashboard on the configured port who it is (`GET /api/identity`). Either another project's dashboard holds the port (or one started before ticket 051, which cannot say whose it is), or this project's dashboard was started before ticket 050 and serves no `byTicketBudget`. Turn caps still apply: a worker is still hard-stopped at its turn budget, only the USD cap is off until this is fixed.

**Fix.**

```bash
# Whose dashboard answers on the configured port?
curl -s http://127.0.0.1:<port>/api/identity
# Stop this project's dashboard only, then start it again (it moves to the next free port if another project holds it)
bash .claude/scripts/start-dashboard.sh --stop
bash .claude/scripts/start-dashboard.sh
```

The router reads the port from `specs/worker-fleet.config.json` on its next cycle and the warning stops.

---

## Failed tickets and retries

**Symptom.** A ticket is `failed`; `results.md` contains a `## Failed attempt summary (auto - router)` block; or the router stopped dispatching and printed a `needs-human:` summary.

**Cause.** Every ticket gets `maxRetries` retries (default **2**, so at most 3 attempts). A stall, a worker that gave up, or repeated tester/reviewer failures consume retries; when none remain the ticket becomes `failed`. Each retry receives a `## Previous attempt findings` block (last status note, last tester FAIL lines, last reviewer CHANGES_REQUIRED items, at most 3). When **three** tickets fail within one run the router stops dispatching and asks you to choose `continue`, `skip failed`, or `stop run`.

**Fix.**

```bash
# Why did it fail?
tail -n 20 specs/tickets/NNN-slug/results.md
ls specs/tickets/NNN-slug/evidence/
ls job/logs/                                  # worker phase logs (<ticket>-dev/tester/reviewer.log)
```

- Fix the cause first: an `eval.md` check that cannot pass, a missing dependency, a contradiction between `rd.md` and the code. Edit the ticket if its spec is wrong.
- Give a fragile ticket more attempts with a `## Retries` section in its `rd.md`: `- maxRetries: 3`.
- Set the ticket's `Status` back to `ready` on `specs/tickets/BOARD.md` to start a fresh run for it. `failed` and `budget-exceeded` tickets are never retried automatically.
- To answer a `needs-human` escalation, reply in the router chat, or answer in the dashboard (it writes `specs/tickets/NNN-slug/user-decision.md`, which the router picks up).
- A worker that needs a product decision sets its heartbeat `phase` to `blocked`; answer it in the dashboard's ticket drawer or in chat to unblock it.

---

## The phone shows a Sign in page

**Symptom.** Opening the dashboard link on your phone (through the tunnel or on the LAN) shows a page titled "Sign in" with a token field instead of the dashboard.

**Cause.** The visitor has no valid `wf_session` cookie. That happens on the first visit, after the 30-day cookie expires, or after the token was rotated (a stale cookie also shows "That token was not accepted"). Tunnel and LAN visitors are remote and need the token; only the host itself is exempt.

**Fix.** Scan the QR code that `bash .claude/scripts/start-dashboard.sh` prints when you run it in a terminal, use the **Phone link** button of a dashboard that is signed in, or paste the token into the Sign in page (`python3 .claude/scripts/apply-setup.py --show-token` prints it). If the page says "Too many failed attempts", see [Dashboard lockout](#dashboard-lockout).

---

## The dashboard asks for a token on this computer

**Symptom.** On the host itself the dashboard shows the "Sign in" page, or `/api/*` answers `401`, without the tunnel.

**Cause.** It was opened under a name that is not `localhost` or an IP address (a hosts-file alias, a `*.localhost` name, or a reverse proxy that passes its own `Host`). Such a request counts as remote, which is the defence against DNS rebinding (a web page that makes its own domain resolve to 127.0.0.1).

**Fix.** Open `http://127.0.0.1:<port>/` or `http://localhost:<port>/`, or sign in with the token (`python3 .claude/scripts/apply-setup.py --show-token` prints it).

---

## Dashboard lockout

**Symptom.** Your phone or LAN machine shows the "Sign in" page with "Too many failed attempts", and its API calls return `429` with `{"error": "locked out"}`, even with the correct token. Reading the dashboard on the host machine itself (loopback, no proxy header) still works. With provider `local` (or a missing or unknown one), every tunnel visitor is locked at once while the host still works.

**Cause.** **Five failed token attempts from one visitor lock that visitor out for 10 minutes.** The lockout is counted per visitor: the socket address for LAN clients, the visitor address the tunnel reports for tunnel visitors, and a separate key for the host itself. Which header is trusted follows `dashboard.tunnel.provider` in `specs/worker-fleet.config.json`: `CF-Connecting-IP` for `cloudflared`, the last `X-Forwarded-For` entry for `ngrok`. Under `local`, or a missing or unknown provider, every tunnel visitor shares one key, so one stranger's failures lock every tunnel visitor (never the host). There is no tunnel-wide limit beyond that. A **shared entry** (that one key, or an overflow entry of a full table) never refuses the correct token when the token has at least **32 characters**, so "Too many failed attempts" with the right token means your own address failed 5 times or the token was hand-set shorter. The failure table holds at most 1024 addresses and an entry expires 10 minutes after its last failure. The lockout is in memory only. Local clients (loopback without a proxy header) may read state without a token, but `POST /api/action` always needs the token.

**Fix.**

```bash
# Option 1: wait 10 minutes.

# Option 2: restart the dashboard server (clears the in-memory lockout table)
bash .claude/scripts/start-dashboard.sh --stop
bash .claude/scripts/start-dashboard.sh

# Option 3: get the right token and try again
python3 -c "import json; print(json.load(open('job/dashboard-auth.json'))['authToken'])"

# Option 4: make the provider match the tunnel you run (start-dashboard.sh --tunnel does not change the config)
python3 .claude/scripts/apply-setup.py --tunnel cloudflared   # or: --tunnel ngrok
```

If you no longer trust the token, rotate it first (see [Token rotation](#token-rotation)). For a sustained attack, stop the tunnel and rotate the token. Stale browser cookies from a previous token also count as failed attempts: clear the site's cookies, then open `/?token=<token>` again.

**Locked on the first try.** If the sign-in page says "Too many failed attempts" on your first try with the right token, something else on your network spent the attempts. Every device on one home network shares the same tunnel key, so a wrong or stale token from any of them counts: an old saved token on another phone or browser, or a dashboard tab left open after the token changed. A distinct wrong token counts once (a stale token that is re-sent over and over adds nothing to the one failure it already caused), and a blank credential never counts. To get in: close other dashboard tabs and browsers that may hold the old token; wait for the time the page shows (the response carries a `Retry-After`, and an open dashboard tab pauses and resumes by itself); or switch the phone to mobile data, which gives it another address; or restart the dashboard. To find out what failed, read the `[auth] failure` lines in `job/dashboard-server.log`: each shows the hashed address (salted per process, so it changes when the dashboard restarts), the path, and the channel (`query`, `bearer`, `x-auth-token` or `cookie`), and a `[auth] locked` line follows the failure that locked the key.

---

## Dashboard actions return 401, 403 or 415

**Symptom.** A dashboard button, or your own `curl` to `POST /api/action`, answers `401` ("Actions need the token in an Authorization: Bearer or X-Auth-Token header"), `403` ("Cross-origin request rejected.") or `415` ("Content-Type must be application/json.").

**Cause.** An action is accepted only when all three hold: the token is in a header (`Authorization: Bearer` or `X-Auth-Token`; the `wf_session` cookie alone is not enough for actions), the request comes from the dashboard's own origin (an `Origin` that is not the `Host`, the tunnel URL or `X-Forwarded-Host`, or a `Sec-Fetch-Site` of `same-site` or `cross-site`, gives `403`), and the body is `application/json` (anything else gives `415`). A `401` in the browser opens the token prompt; enter the token once and the dashboard stores it.

**Fix.** Send the token in a header with a JSON body, and no foreign `Origin`:

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('job/dashboard-auth.json'))['authToken'])")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"set_ticket_priority","ticket":"013","prio":"P1"}' http://127.0.0.1:<dashboard.port>/api/action
```

---

## Selftest failures

**Symptom.** `python3 .claude/scripts/selftest.py` exits non-zero and prints one or more `FAIL` lines. This blocks merging workflow changes.

**Cause.** A change broke an invariant the suite guards: dashboard auth (loopback read, POST needs a token, LAN spoof rejected, lockout), action validation, board parsing, evidence path safety, audit logging, `apply-setup.py` idempotence, or secret hygiene (`no_secrets_tracked`, `no_live_token_in_files`, `state_hides_token`, `no_provider_secrets_in_files`, `notify_secrets_migrated`).

**Fix.**

```bash
python3 .claude/scripts/selftest.py --list                 # all check names
python3 .claude/scripts/selftest.py --filter auth_lockout  # rerun one check
python3 .claude/scripts/selftest.py                        # full run
```

The suite runs against throwaway fixtures and temporary servers and never changes your live dashboard or `job/` state; `no_live_token_in_files` only reads the live token from `job/dashboard-auth.json` to look for it, and never prints it. Read the FAIL message: it names the assertion and the expected value. Common causes: you changed an auth rule or a board column and not the code or fixture that depends on it; `apply-setup.py` is no longer idempotent (running it twice changed the config or generated files); a secret reached a tracked file. A `no_live_token_in_files` FAIL names the files that hold the token: delete or redact them, then rotate the token as in [Token rotation](#token-rotation). A `no_provider_secrets_in_files` FAIL names the files and lines that hold a provider secret (never the value). Run `python3 .claude/scripts/apply-setup.py` to move inline secrets out of the config, remove them from any other file, then rotate them as in [Rotating a leaked notification secret](#rotating-a-leaked-notification-secret). A check that prints `SKIP` is informational. Fix the root cause rather than editing the check, and add a new check when you add a security or parsing rule (see [CONTRIBUTING.md](CONTRIBUTING.md)).

---

## Missing or corrupt results.json

**Symptom.** A worker reports done, but the router messages the same worker with a problem such as `results.json missing`, `invalid JSON`, a missing field, or `E-3 has no PASS entry`; the ticket does not merge.

**Cause.** The router's verification gate reads `specs/tickets/NNN-slug/results.json`, not the prose in `results.md`. A **missing or corrupt `results.json` counts as a failed verification**, as does any field, `E-N` entry, evidence file or `reviewer` verdict that does not satisfy the gate. The ticket goes back to the *same* worker (not a new attempt) with the exact file, field or check id. Only legacy tickets that predate the file fall back to parsing `results.md`.

**Fix.** The worker rewrites the file; to check it yourself:

```bash
python3 -c "import json; d=json.load(open('specs/tickets/NNN-slug/results.json')); print(sorted(d)); print([(c['id'], c['status']) for c in d['checks']])"
```

Required keys: `ticket`, `branch`, `finishedAt`, `automated` (`build`, `lint`, `test`, `typecheck`), `checks` (one entry per `E-N` in `eval.md`, ids and titles verbatim, evidence paths relative to the ticket folder), `reviewer` (`APPROVED` to pass) and `budget`. See [CONTRIBUTING.md](CONTRIBUTING.md#ticket-conventions).

---

## Approved tickets wait until I message the router

**Symptom.** You approve a draft in the dashboard (or press Stop, Pause or Resume), and nothing happens until you type something in the router's terminal.

**Cause.** The router acts only inside a cycle, and an idle router starts one when something wakes it. The wake watcher `.claude/scripts/router-wake.sh` is what wakes it when a ticket becomes `ready`, a `job/control/*.json` intent appears or a `user-decision.md` is written. It does not run when:

- **the harness cannot re-invoke the router.** OpenCode has no background mode that re-invokes the session when a command exits, so the router never arms the watcher there and says so at session start. Changes wait for your next message.
- **the router was started before the watcher existed.** Its instructions are read once at session start. Restart the router session.
- **`dispatch.autoOnApprove` is `false`.** An Approve then deliberately does not wake the router; press **Dispatch now** or message the router. Check with `grep -A2 '"dispatch"' specs/worker-fleet.config.json`, and set it back with `python3 .claude/scripts/apply-setup.py --auto-dispatch-on-approve on`.

**Fix.** Press **Dispatch now** on the board to queue an immediate dispatch; on a harness without the wake watcher (OpenCode) it still waits for your next message. To check the watcher, which changes nothing:

```bash
bash .claude/scripts/router-wake.sh --status
```

It prints `router-wake: running (pid N)` or `router-wake: not running`. When it is not running and the router session is idle, message the router once; it arms the watcher again. A watcher that exited is re-armed by the router on its next cycle, and `bash .claude/scripts/router-wake.sh --stop` stops one on purpose.

A woken router can still decide not to dispatch: the ticket waits for a dependency in its `Runs` column that is not `done`, it is paused, all `concurrency.maxParallelWorkers` slots are busy, or the swarm is degraded (see [Swarm degraded](#swarm-degraded-continue--resume-swarm)). The router's one line (`Woke (...): nothing dispatched: ...`) says which.

---

## Swarm degraded: continue / Resume Swarm

**Symptom.** Workers died with a provider limit or outage, the dashboard shows the swarm as degraded or paused, and the router dispatches nothing even though tickets are `ready`.

**Cause.** A provider-wide failure puts the swarm in a `degraded` state (`job/swarm-state.json`) and pauses all dispatch so the router does not burn retries against a dead provider. The router probes the provider every `watchdog.intervalMinutes` and recovers by itself when it is healthy again; you can also resume manually.

**Fix.** Either of these runs the same resume cycle:

- Type `continue` (or `resume`) in the router chat.
- Click **Resume Swarm** in the dashboard. The button appears only while the swarm is degraded or paused; it writes `job/control/_swarm.json`, which the router consumes on its next cycle.

The router assesses the board, ledger and heartbeats, adopts or reaps dead worktrees, re-dispatches `ready` tickets up to the concurrency cap by priority, clears the degraded state and reports one line. Check the state with `cat job/swarm-state.json`.

---

## agent-browser not working

**Symptom.** Browser checks fail with `agent-browser: command not found` or exit code `126` (a broken shim, for example a Volta shim whose package was removed), or a tester reports every `Browser` check as blocked.

**Cause.** The `agent-browser` on `PATH` is not runnable. Agents do not call it directly; they go through the resolver `.claude/scripts/browser.sh`, which tries `$AGENT_BROWSER_BIN`, then `agent-browser` on `PATH`, then known install locations, and skips any candidate whose `--version` fails.

**Fix.**

```bash
bash .claude/scripts/browser.sh --resolve          # print the binary that will be used, or an error listing what was tried
npm install -g agent-browser                       # (re)install it
export AGENT_BROWSER_BIN=/absolute/path/to/agent-browser   # force a specific binary
```

The installed `agent-browser` has no `fetch` command, so `HTTP`-type eval checks fall back to `curl`, so a Browser outage never affects them.

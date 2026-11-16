# Regression Sweep List

This is the repo's curated smoke list of critical flows. The `checker` agent's **`full` mode** (regression sweep) walks every `R-N` entry below on `main` after merges — automatically per `regression.everyNMerges` in `specs/worker-fleet.config.json` (default `1` = after every merge; `0` disables the auto cadence), or on demand via a manual/dashboard trigger.

## How to use and maintain this list

- **Entry format** — one flow per entry, in the same shape as eval checks so the checker can execute them verbatim:

  ```markdown
  ### R-N: <flow title>
  - Type: Browser | HTTP | CLI | Test
  - **Steps**:
    1. <concrete, executable steps against the running app on main>
  - **Pass criteria**: <unambiguous observable outcome>
  ```

- **Types** (`Browser`, `HTTP`, `CLI`, `Test`) match the eval-check types defined by ticket 008's project-type templates.
- Each entry must be **self-contained and runnable verbatim on `main`** — no references to a specific ticket's context, ports from the repo's config only.
- **Add** an entry (append, never renumber) when a landed ticket introduces or marks a flow as critical; **remove** an entry only when the flow is deliberately deleted from the product.
- Keep the list short (the critical few, not a full test suite) — full sweeps run after every merge by default.
- A new repo replaces this list wholesale with flows verifiable in THAT repo via the `/write-tickets` skill (it documents creating and maintaining this file).
- A `CONFIRMED_BREAK` from a full sweep includes the affected `R-N` id and routes to `reproducer`.

## Flows (worker-fleet seed list)

### R-1: Dashboard serves and the board renders
- Type: Browser
- **Steps**:
  1. Open the Fleet Control dashboard at `http://localhost:<dashboard.port>` (port from `specs/worker-fleet.config.json`, default `3080`) with `agent-browser open`.
  2. Run `agent-browser snapshot -i` and locate the views navigation and the board's four stage columns: Plan, Queue, Building and Done.
  3. Done cards sit in three groups, Today, Yesterday and Earlier, and only Today starts open. If the snapshot shows no ticket card, open the Earlier group with `agent-browser click '#col-done .done-group[data-group="earlier"] .done-group-toggle'` and snapshot again.
  4. Save proof: `agent-browser screenshot specs/regression-evidence/R-1.png`.
- **Pass criteria**: The page loads (HTTP 200, no error page), the views navigation renders with a "Board" button, the board shows the four stage columns, and at least one ticket card from `specs/tickets/BOARD.md` is visible on the board (after step 3 when the open groups were empty).

### R-2: `/api/state` returns valid JSON with tickets array
- Type: HTTP
- **Steps**:
  1. Check the status and type without printing the body: `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:<dashboard.port>/api/state` (loopback GETs are token-exempt).
  2. Count dashboard-token values in the raw body, printing only the count: `curl -s http://127.0.0.1:<dashboard.port>/api/state | grep -c -E 'token=[0-9a-f]{32}'`
  3. Save proof, with every `token=` value masked before it reaches disk: `( set -o pipefail; curl -s http://127.0.0.1:<dashboard.port>/api/state | sed -E 's/token=[A-Za-z0-9_-]{8,}/token=****/g' | tee specs/regression-evidence/R-2.json > /dev/null ); echo "exit=$?"`
  4. Parse the saved body: `python3 -c "import json; d = json.load(open('specs/regression-evidence/R-2.json')); print(type(d.get('tickets')).__name__, len(d.get('tickets') or []))"`
- **Pass criteria**: step 1 prints `200 application/json; charset=utf-8`. Step 2 prints `0` (grep then exits 1, which is expected); any other number means `/api/state` serves the dashboard token again, which is a break. Step 3 prints `exit=0`. Step 4 prints `list <N>`, where N is the number of tickets on `specs/tickets/BOARD.md`.

### R-3: `/api/telemetry` returns valid JSON
- Type: HTTP
- **Steps**:
  1. Request `curl -s -i http://127.0.0.1:<dashboard.port>/api/telemetry` (loopback GETs are token-exempt).
  2. Parse the response body as JSON.
  3. Save proof: `( set -o pipefail; curl -s http://127.0.0.1:<dashboard.port>/api/telemetry | tee specs/regression-evidence/R-3.json )`
- **Pass criteria**: HTTP `200`, `Content-Type: application/json`, and the body parses as a JSON object (telemetry fields present, e.g. run/cost data).

### R-4: A ticket drawer opens showing rd/eval tabs
- Type: Browser
- **Steps**:
  1. Open the Fleet Control dashboard at `http://localhost:<dashboard.port>` and snapshot the board (`agent-browser snapshot -i`).
  2. Click a ticket card to open its drawer (`agent-browser click <ref>`). If no card is visible, first open the Done column's Earlier group: `agent-browser click '#col-done .done-group[data-group="earlier"] .done-group-toggle'`.
  3. Verify the drawer shows the "Requirements" tab content (rd.md), then click the "Evaluation" tab and verify it renders the eval content.
  4. Save proof: `agent-browser screenshot specs/regression-evidence/R-4.png`.
- **Pass criteria**: The drawer opens for the clicked ticket showing its id/title, the rd.md content renders in the "Requirements" tab, and switching to the "Evaluation" tab renders that ticket's eval.md content.

### R-5: `apply-setup.py` exits 0
- Type: CLI
- **Steps**:
  1. Run `python3 .claude/scripts/apply-setup.py` from the repo root on `main`.
- **Pass criteria**: Exit code `0`, stdout contains the setup-completed banner, and `specs/worker-fleet.config.json` remains valid JSON afterwards.

### R-6: Remote requests get only the sign-in page and 401
- Type: HTTP
- **Steps** (a request that carries a proxy header counts as remote even from loopback; needs a configured token in `job/dashboard-auth.json`, which `apply-setup.py` and `start-dashboard.sh` create):
  1. `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 203.0.113.7' http://127.0.0.1:<dashboard.port>/api/state`
  2. `curl -s -o /dev/null -w '%{http_code}\n' -H 'CF-Connecting-IP: 203.0.113.7' http://127.0.0.1:<dashboard.port>/api/telemetry`
  3. `curl -s -H 'X-Forwarded-For: 203.0.113.7' -o specs/regression-evidence/R-6.html -w '%{http_code} %{content_type}\n' http://127.0.0.1:<dashboard.port>/`
  4. `grep -c 'id="signin-form"' specs/regression-evidence/R-6.html`
  5. `grep -c -i -E 'fleet control|<script|project-name' specs/regression-evidence/R-6.html`
  6. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<dashboard.port>/api/telemetry`
- **Pass criteria**: steps 1 and 2 print `401`. Step 3 prints `401 text/html; charset=utf-8`. Step 4 prints `1`. Step 5 prints `0` (grep then exits 1, which is expected). Step 6 prints `200`: plain loopback reads stay open.

### R-7: Evidence is served inert and actions refuse other origins
- Type: HTTP
- **Steps** (ticket 056; uses evidence files committed by ticket 052; no token needed):
  1. `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:<dashboard.port>/api/evidence/052/E-2-signin.html`
  2. `curl -s -o /dev/null -D specs/regression-evidence/R-7-headers.txt http://127.0.0.1:<dashboard.port>/api/evidence/052/E-2-signin.html`
  3. `grep -c -i -E "^(x-content-type-options: nosniff|content-security-policy: default-src 'none'; sandbox)" specs/regression-evidence/R-7-headers.txt`
  4. `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:<dashboard.port>/api/evidence/052/E-6-app-390.png`
  5. `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-site' -d '{"action":"regression_probe"}' http://127.0.0.1:<dashboard.port>/api/action`
  6. `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"action":"regression_probe"}' http://127.0.0.1:<dashboard.port>/api/action`
- **Pass criteria**: step 1 prints `200 text/plain; charset=utf-8` (an HTML evidence file is never served as HTML). Step 3 prints `2`. Step 4 prints `200 image/png`. Step 5 prints `403` (another site's request is refused before auth). Step 6 prints `401` (an action without a header token is refused).

### R-8: Local reads need a local Host; the app page has a strict CSP
- Type: HTTP
- **Steps** (ticket 064; no token needed):
  1. `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: rebind.test' http://127.0.0.1:<dashboard.port>/api/state`
  2. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<dashboard.port>/api/state`
  3. `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -H 'Host: rebind.test' http://127.0.0.1:<dashboard.port>/`
  4. `curl -s -o /dev/null -D specs/regression-evidence/R-8-headers.txt http://127.0.0.1:<dashboard.port>/`
  5. `grep -c -i -E "^content-security-policy: .*script-src 'nonce-[0-9a-f]{32}'.*frame-ancestors 'none'" specs/regression-evidence/R-8-headers.txt`
- **Pass criteria**: step 1 prints `401` (a DNS-rebinding `Host` is remote). Step 2 prints `200` (plain loopback reads stay open). Step 3 prints `401 text/html; charset=utf-8` (the sign-in page). Step 5 prints `1`.

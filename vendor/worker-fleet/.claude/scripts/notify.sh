#!/usr/bin/env bash
# notify.sh — push-notification dispatcher (ticket 012).
#
# Usage:
#   bash .claude/scripts/notify.sh <event> "<message>" [ticket-id] [--dry-run]
#
# Events: worker_blocked budget_exceeded retries_exhausted ticket_done
#         regression_confirmed needs_human watchdog_stall
#
# Reads notifications.providers[] from specs/worker-fleet.config.json and posts
# the message to every provider subscribed to <event> (or "all"):
#   {"type":"ntfy","target":"<topic|URL>","auth":<secret>,"events":[..]|"all"}
#   {"type":"telegram","botToken":<secret>,"chatId":"<id>","events":[..]|"all"}
#   {"type":"slack","webhook":<secret>,"events":[..]|"all"}
# where <secret> (ticket 048) is {"secretRef":"<id>"} (resolved from the gitignored
# job/notify-secrets.json) or {"env":"WORKER_FLEET_<NAME>"}; an inline string still
# works but is deprecated (apply-setup.py moves it into job/notify-secrets.json).
# The config, secrets file, log and dashboard link base always come from the MAIN
# checkout (git common dir), also when a worker runs this from its worktree.
#
# Every push is titled "[<name>] worker-fleet: <event>" (ticket 051): the ntfy Title
# header, the first line of the Telegram text and the bold first line of the Slack
# text. <name> is project.name from the config, else the directory name of the
# main checkout, cleaned to at most 40 plain-ASCII characters.
#
# One delivery attempt per provider (10 s timeout, no retries). Delivery
# failures are appended to job/logs/notify.log and NEVER fail the caller.
# --dry-run prints the config path used and the per-provider target + payload
# (secrets and the chat id masked); it makes no network call and no log write.
#
# Exit codes: 0 ok / no matching provider / delivery failure (logged),
#             2 usage error, 3 hard config error (names the provider index).
#
# Test hooks: NOTIFY_CONFIG=<path> overrides the config file,
#             NOTIFY_TELEGRAM_API=<base URL> overrides https://api.telegram.org.
# Zero dependencies: bash + python3 standard library only.

set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export NOTIFY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

exec python3 -I - "$@" <<'PYEOF'
import datetime
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

EVENTS = [
    "worker_blocked",
    "budget_exceeded",
    "retries_exhausted",
    "ticket_done",
    "regression_confirmed",
    "needs_human",
    "watchdog_stall",
]
MAX_PAYLOAD = 1024          # bytes, whole request body
LOG_MAX_BYTES = 1024 * 1024  # notify.log is bounded to ~1 MB
TIMEOUT = 10

def resolve_root():
    """The main checkout from any worktree (ticket 048); the script root when git cannot say."""
    script_root = os.environ.get("NOTIFY_ROOT") or os.getcwd()
    try:
        res = subprocess.run(
            ["git", "-C", script_root, "rev-parse", "--git-common-dir"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            universal_newlines=True, timeout=5,
        )
        out = res.stdout.strip()
        if res.returncode == 0 and out:
            common = os.path.normpath(os.path.join(script_root, out))
            if os.path.basename(common) == ".git":
                return os.path.dirname(common)
    except Exception:
        pass
    return script_root


ROOT = resolve_root()
CONFIG_PATH = os.environ.get("NOTIFY_CONFIG") or os.path.join(ROOT, "specs", "worker-fleet.config.json")
# Ticket 089: the pre-rename config path. Never read; only tested for existence, so a
# project whose config was not migrated is refused instead of running on defaults.
LEGACY_CONFIG_REL = "specs/super-agent.config.json"
LOG_PATH = os.path.join(ROOT, "job", "logs", "notify.log")
SECRETS_PATH = os.path.join(ROOT, "job", "notify-secrets.json")
SECRET_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
SECRET_ENV_RE = re.compile(r"WORKER_FLEET_[A-Z0-9_]{1,64}")
SECRET_FIELDS = {"telegram": "botToken", "slack": "webhook", "ntfy": "auth"}
SECRET_REF_ERROR = 'must be a non-empty string, {"secretRef": "<id>"} or {"env": "WORKER_FLEET_<NAME>"}'
BOTH_CREDENTIALS_ERROR = "ntfy provider has credentials in both 'target' and 'auth': keep only 'auth'"
INLINE_HINT = "inline in the config (run apply-setup.py to move %s to job/notify-secrets.json)"
_secrets_file = []  # the parsed secrets map, read at most once per run
URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")

TAGS = {
    "worker_blocked": "raised_hand",
    "budget_exceeded": "moneybag",
    "retries_exhausted": "repeat",
    "ticket_done": "white_check_mark",
    "regression_confirmed": "rotating_light",
    "needs_human": "bell",
    "watchdog_stall": "hourglass",
}
PRIORITY = {
    "worker_blocked": "4",
    "budget_exceeded": "4",
    "retries_exhausted": "4",
    "needs_human": "4",
    "regression_confirmed": "4",
    "watchdog_stall": "3",
    "ticket_done": "3",
}


def clean_project_name(raw):
    """Ticket 051 FR-1: plain ASCII, at most 40 characters, safe in an HTTP header.
    Identical to dashboard-server.py's helper of the same name."""
    if not isinstance(raw, str):
        return ""
    s = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^A-Za-z0-9._ -]+", "-", s)
    s = re.sub(r"-{2,}", "-", s)
    s = s.strip(" -.")
    return s[:40].strip(" -.")


def project_identity():
    """Ticket 051 FR-1: (name, source) of this project: config project.name, else the
    directory name of ROOT (the main checkout), else 'project'. Never raises."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            config = json.load(fh)
        project = config.get("project") if isinstance(config, dict) else None
        if isinstance(project, dict):
            name = clean_project_name(project.get("name"))
            if name:
                return name, "config"
    except Exception:
        pass
    return clean_project_name(os.path.basename(os.path.normpath(ROOT))) or "project", "directory"


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def mask(secret):
    """Same rule as _mask_secret in dashboard-server.py: the last 2 characters
    are shown only for values of 4 or more characters."""
    secret = str(secret)
    return "****" + (secret[-2:] if len(secret) >= 4 else "")


def scrub(text, secrets=()):
    """Remove URLs and any known secret from a string destined for logs/stderr."""
    text = str(text)
    for s in secrets:
        if s:
            text = text.replace(s, "****")
    text = URL_RE.sub("<url>", text)
    return " ".join(text.split())[:200]


def log_line(event, index, ptype, status, http=None, error=None, secrets=()):
    parts = [now(), "event=%s" % event, "provider=%s:%s" % (index, ptype), "status=%s" % status]
    if http is not None:
        parts.append("http=%s" % http)
    if error:
        parts.append('error="%s"' % scrub(error, secrets).replace('"', "'"))
    line = " ".join(parts) + "\n"
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
        if os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            with open(LOG_PATH, "rb") as fh:
                fh.seek(-LOG_MAX_BYTES // 2, os.SEEK_END)
                fh.readline()  # drop the partial first line
                tail = fh.read()
            with open(LOG_PATH, "wb") as fh:
                fh.write(b"... truncated ...\n" + tail)
    except Exception:
        pass  # logging must never fail the caller


def usage_error(msg):
    sys.stderr.write("notify.sh: %s\n" % msg)
    sys.stderr.write('usage: notify.sh <event> "<message>" [ticket-id] [--dry-run]\n')
    sys.stderr.write("events: %s\n" % " ".join(EVENTS))
    sys.exit(2)


def config_error(event, index, msg, dry_run):
    where = "notifications.providers[%s]" % index if index is not None else "config"
    sys.stderr.write("notify.sh: ERROR: %s: %s\n" % (where, msg))
    if not dry_run:
        log_line(event, index if index is not None else "-", "config", "config-error", error=msg)
    sys.exit(3)


def parse_args(argv):
    dry_run = False
    pos = []
    for a in argv:
        if a == "--dry-run":
            dry_run = True
        elif a.startswith("--") and len(a) > 2:
            usage_error("unknown flag %s" % a)
        else:
            pos.append(a)
    if len(pos) < 2:
        usage_error("missing <event> and/or <message>")
    if len(pos) > 3:
        usage_error("too many arguments")
    event, message = pos[0], pos[1]
    if event not in EVENTS:
        usage_error("unknown event %r" % event)
    ticket = None
    if len(pos) == 3:
        m = re.match(r"^(\d{1,3})(?:-.*)?$", pos[2])
        if not m:
            usage_error("ticket-id must be a number like 004 (got %r)" % pos[2])
        ticket = m.group(1).zfill(3)
    else:
        m = re.search(r"[Tt]icket[ -]?#?(\d{1,3})", message)
        if m:
            ticket = m.group(1).zfill(3)
    return event, message, ticket, dry_run


def load_providers(event, dry_run):
    # Ticket 089, FR-17: with the default config path, a missing worker-fleet config next
    # to an old-name one is a config error (exit 3, nothing sent), never "no providers".
    if (not os.environ.get("NOTIFY_CONFIG") and not os.path.lexists(CONFIG_PATH)
            and os.path.lexists(os.path.join(ROOT, LEGACY_CONFIG_REL))):
        config_error(event, None, "specs/worker-fleet.config.json is missing but %s exists, and that file is "
                     "no longer read. Run python3 .claude/scripts/apply-setup.py to migrate it." % LEGACY_CONFIG_REL,
                     dry_run)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except FileNotFoundError:
        return [], {}
    except Exception as exc:
        config_error(event, None, "cannot read %s: %s" % (os.path.basename(CONFIG_PATH), scrub(exc)), dry_run)
    if not isinstance(config, dict):
        config_error(event, None, "config root must be a JSON object", dry_run)
    notif = config.get("notifications")
    if notif is None:
        return [], config
    if not isinstance(notif, dict):
        config_error(event, None, "notifications must be an object", dry_run)
    providers = notif.get("providers")
    if providers is None:
        return [], config
    if not isinstance(providers, list):
        config_error(event, None, "notifications.providers must be a list", dry_run)
    for i, p in enumerate(providers):
        err = validate_provider(p)
        if err:
            config_error(event, i, err, dry_run)
    return providers, config


def _nonempty(p, key):
    v = p.get(key)
    return isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip() != ""


def validate_provider(p):
    if not isinstance(p, dict):
        return "entry must be an object"
    ptype = p.get("type")
    if ptype not in ("ntfy", "telegram", "slack"):
        return "unknown type %r (expected ntfy, telegram or slack)" % (ptype if isinstance(ptype, str) else None)
    required = {"ntfy": ["target"], "telegram": ["botToken", "chatId"], "slack": ["webhook"]}[ptype]
    secret_field = SECRET_FIELDS[ptype]
    secret_kind = None
    for key in required:
        if key == secret_field:
            v = p.get(key)
            if v is None or (isinstance(v, str) and v.strip() == ""):
                return "%s provider needs a non-empty %r" % (ptype, key)
            secret_kind = classify_secret(v)[0]
            if secret_kind == "invalid":
                return "%s %r %s" % (ptype, key, SECRET_REF_ERROR)
        elif not _nonempty(p, key):
            return "%s provider needs a non-empty %r" % (ptype, key)
    if ptype == "ntfy":
        target = str(p["target"]).strip()
        if not re.match(r"^https?://[^\s/]+", target) and not re.match(r"^[A-Za-z0-9_-]{1,64}$", target):
            return "ntfy target must be a topic name ([A-Za-z0-9_-], max 64) or an http(s) URL"
        if "auth" in p:
            if classify_secret(p["auth"])[0] == "invalid":
                return "ntfy 'auth' %s" % SECRET_REF_ERROR
            if target_credentials(target):
                return BOTH_CREDENTIALS_ERROR
    if ptype == "slack" and secret_kind == "inline" and not re.match(r"^https?://[^\s/]+", str(p["webhook"]).strip()):
        return "slack webhook must be an http(s) URL"
    ev = p.get("events", "all")
    if ev != "all":
        if not isinstance(ev, list) or not all(isinstance(x, str) for x in ev):
            return 'events must be "all" or a list of event names'
        for x in ev:
            if x not in EVENTS:
                return "unknown event %r in events (valid: %s)" % (x, ", ".join(EVENTS))
    return None


def classify_secret(value):
    """Ticket 048: (kind, payload) of a secret field: inline (the stripped string), secretRef (id), env (name) or invalid."""
    if isinstance(value, dict):
        if len(value) == 1:
            ref = value.get("secretRef")
            if isinstance(ref, str) and SECRET_ID_RE.fullmatch(ref):
                return "secretRef", ref
            name = value.get("env")
            if isinstance(name, str) and SECRET_ENV_RE.fullmatch(name):
                return "env", name
        return "invalid", None
    if isinstance(value, bool) or not isinstance(value, (str, int)) or str(value).strip() == "":
        return "invalid", None
    return "inline", str(value).strip()


def target_credentials(target):
    """urlsplit() of an ntfy target URL that carries a username, else None."""
    try:
        parts = urllib.parse.urlsplit(str(target).strip())
        return parts if parts.username else None
    except ValueError:
        return None


def read_secrets_file():
    """job/notify-secrets.json 'secrets' map, read at most once; {} when missing or unreadable."""
    if not _secrets_file:
        found = {}
        try:
            with open(SECRETS_PATH, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            if isinstance(doc, dict) and isinstance(doc.get("secrets"), dict):
                found = doc["secrets"]
        except Exception:
            pass
        _secrets_file.append(found)
    return _secrets_file[0]


def resolve_secret(field, value):
    """Return (secret or None, source, reason or None); the secret is never put in source or reason."""
    kind, payload = classify_secret(value)
    if kind == "inline":
        return payload, "inline", None
    if kind == "secretRef":
        found = read_secrets_file().get(payload)
        source = "secretRef %s" % payload
        if isinstance(found, str) and found.strip():
            return found.strip(), source, None
        return None, source, "secret unresolved: %s (%s not found in job/notify-secrets.json)" % (field, source)
    source = "env %s" % payload
    found = os.environ.get(payload, "").strip() if kind == "env" else ""
    if found:
        return found, source, None
    return None, source, "secret unresolved: %s (%s is not set)" % (field, source)


def resolve_secrets(p):
    """Resolve the secret fields of a subscribed provider: (resolved, notes, reason).

    resolved maps field -> secret value; notes are the dry-run 'secret:' lines (no values);
    reason is the 'secret unresolved: ...' text when a field cannot be resolved, else None.
    """
    ptype = p["type"]
    field = SECRET_FIELDS[ptype]
    resolved, notes = {}, []
    if field in p:
        value, source, reason = resolve_secret(field, p[field])
        if reason:
            return resolved, notes, reason
        if ptype == "slack" and source != "inline" and not re.match(r"^https?://[^\s/]+", value):
            return resolved, notes, "secret unresolved: webhook (%s is not an http(s) URL)" % source
        resolved[field] = value
        if source == "inline":
            notes.append("%s %s" % (field, INLINE_HINT % "it"))
        else:
            notes.append("%s from %s" % (field, source))
    elif ptype == "ntfy" and target_credentials(p["target"]):
        notes.append("target URL credentials " + INLINE_HINT % "them")
    return resolved, notes, None


def subscribed(p, event):
    ev = p.get("events", "all")
    return ev == "all" or event in ev


def dashboard_base(config):
    """Tunnel-or-local dashboard base URL, always WITHOUT any query (never the ?token=)."""
    try:
        with open(os.path.join(ROOT, "job", "dashboard-url.txt"), "r", encoding="utf-8") as fh:
            raw = fh.read().strip()
        parts = urllib.parse.urlsplit(raw)
        if parts.scheme in ("http", "https") and parts.netloc and "@" not in parts.netloc:
            return "%s://%s" % (parts.scheme, parts.netloc)
    except Exception:
        pass
    port = 3080
    try:
        port = int(config.get("dashboard", {}).get("port") or config.get("concurrency", {}).get("dashboardPort") or 3080)
    except Exception:
        pass
    return "http://127.0.0.1:%d" % port


def fit(text, limit):
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    cut = raw[: max(limit - 3, 0)].decode("utf-8", "ignore")
    return cut + "..."


def compose(event, message, link, limit):
    """Body text (message plus optional link) whose UTF-8 size is <= limit."""
    tail = ("\n\nOpen the decision: " + link) if link else ""
    room = max(limit - len(tail.encode("utf-8")), 40)
    return fit(message, room) + tail


def build_request(p, event, message, link, resolved=None):
    """Return (target_display, url, headers, body_bytes, body_display, secrets).

    resolved maps a secret field to its resolved value (ticket 048); body_display masks the chat id.
    """
    resolved = resolved or {}
    title = "[%s] worker-fleet: %s" % (project_identity()[0], event)
    ptype = p["type"]
    if ptype == "ntfy":
        target = str(p["target"]).strip()
        url = target if re.match(r"^https?://", target) else "https://ntfy.sh/" + target
        parts = urllib.parse.urlsplit(url)
        host = parts.netloc.rsplit("@", 1)[-1]
        shown = urllib.parse.urlunsplit((parts.scheme, host, parts.path, "", ""))
        # urllib does not honour user:pass@ in URLs: send it as Basic auth instead.
        url = urllib.parse.urlunsplit((parts.scheme, host, parts.path, parts.query, ""))
        text = compose(event, message, link, 800)
        headers = {
            "Title": title,
            "Tags": TAGS[event],
            "Priority": PRIORITY[event],
            "Content-Type": "text/plain; charset=utf-8",
        }
        secrets = []
        if resolved.get("auth"):
            import base64
            cred = resolved["auth"]
            headers["Authorization"] = "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii")
            secrets = [cred] + [x for x in cred.split(":", 1) if x]
        elif parts.username:
            import base64
            cred = "%s:%s" % (urllib.parse.unquote(parts.username), urllib.parse.unquote(parts.password or ""))
            headers["Authorization"] = "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii")
            secrets = [parts.username, parts.password or ""]
        if link:
            headers["Click"] = link
        return shown, url, headers, text.encode("utf-8"), text, secrets
    if ptype == "telegram":
        token = resolved.get("botToken") or str(p["botToken"]).strip()
        chat_id = str(p["chatId"]).strip()
        base = (os.environ.get("NOTIFY_TELEGRAM_API") or "https://api.telegram.org").rstrip("/")
        url = "%s/bot%s/sendMessage" % (base, token)
        shown = "%s/bot%s/sendMessage" % (base, mask(token))
        limit = 700
        while True:
            text = title + "\n" + compose(event, message, link, limit)
            body = json.dumps(
                {"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
                ensure_ascii=False,
            )
            if len(body.encode("utf-8")) <= MAX_PAYLOAD or limit <= 100:
                break
            limit -= 100
        shown_body = json.dumps(
            {"chat_id": mask(chat_id), "text": text, "disable_web_page_preview": True},
            ensure_ascii=False,
        )
        return shown, url, {"Content-Type": "application/json; charset=utf-8"}, body.encode("utf-8"), shown_body, [token]
    # slack
    hook = resolved.get("webhook") or str(p["webhook"]).strip()
    limit = 700
    while True:
        text = "*" + title + "*\n" + compose(event, message, link, limit)
        body = json.dumps({"text": text}, ensure_ascii=False)
        if len(body.encode("utf-8")) <= MAX_PAYLOAD or limit <= 100:
            break
        limit -= 100
    return mask(hook), hook, {"Content-Type": "application/json; charset=utf-8"}, body.encode("utf-8"), body, [hook]


def deliver(index, p, event, req):
    _shown, url, headers, body, _disp, secrets = req
    secrets = list(secrets)
    try:
        r = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(r, timeout=TIMEOUT) as resp:
            code = resp.getcode()
        if 200 <= code < 300:
            log_line(event, index, p["type"], "ok", http=code)
        else:
            log_line(event, index, p["type"], "fail", http=code, error="unexpected status", secrets=secrets)
    except urllib.error.HTTPError as exc:
        log_line(event, index, p["type"], "fail", http=exc.code, error="HTTPError", secrets=secrets)
    except urllib.error.URLError as exc:
        log_line(event, index, p["type"], "fail", error="URLError: %s" % exc.reason, secrets=secrets)
    except Exception as exc:  # delivery must never fail the caller
        log_line(event, index, p["type"], "fail", error="%s: %s" % (type(exc).__name__, exc), secrets=secrets)


def main():
    event, message, ticket, dry_run = parse_args(sys.argv[1:])
    providers, config = load_providers(event, dry_run)
    link = None
    if event == "worker_blocked":
        base = dashboard_base(config)
        link = "%s/?ticket=%s#decision" % (base, ticket) if ticket else "%s/#decision" % base

    if dry_run:
        print('[dry-run] event=%s ticket=%s message="%s"' % (event, ticket or "-", fit(message, 200)))
        print("[dry-run] config: %s (%d provider(s))" % (os.path.abspath(CONFIG_PATH), len(providers)))
        pname, psource = project_identity()
        print("[dry-run] project: %s (from %s)" % (pname, psource))
    for index, p in enumerate(providers):
        ptype = p["type"]
        if not subscribed(p, event):
            if dry_run:
                print("[dry-run] provider[%d] %s: skipped (not subscribed to %s)" % (index, ptype, event))
            continue
        resolved, notes, reason = resolve_secrets(p)
        if reason:
            if dry_run:
                print("[dry-run] provider[%d] %s: %s" % (index, ptype, reason))
            else:
                log_line(event, index, ptype, "fail", error=reason)
            continue
        req = build_request(p, event, message, link, resolved)
        if dry_run:
            shown, _url, headers, body, disp, _secrets = req
            print("[dry-run] provider[%d] %s -> POST %s (payload %d bytes)" % (index, ptype, shown, len(body)))
            for note in notes:
                print("          secret: " + note)
            if ptype == "ntfy":
                print("          headers: " + ", ".join("%s: %s" % (k, v) for k, v in headers.items() if k not in ("Content-Type", "Authorization")))
            print("          body: " + disp.replace("\n", "\n                "))
            continue
        deliver(index, p, event, req)
    sys.exit(0)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # last-resort guard: a notifier bug must not fail the caller
    try:
        log_line("-", "-", "notify", "fail", error="internal %s: %s" % (type(exc).__name__, exc))
    except Exception:
        pass
    sys.exit(0)
PYEOF

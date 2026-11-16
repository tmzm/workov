#!/usr/bin/env python3
"""apply-setup.py: Deterministic generator and synchronization script for the
Claude Code / OpenCode / Codex worker-fleet Workflow v3.

Reads specs/worker-fleet.config.json, updates .claude/agents/*.md,
generates .opencode/agents/*.md and opencode.json, and synchronizes dashboard credentials.
It also records this project's main checkout in the user-level registry
~/.worker-fleet/projects.json and warns about port overlaps with other projects.
"""

import argparse
import copy
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


def _tiered_models(*, router, worker, reviewer, reproducer, small):
    """Build a full role map from five tiers (shared by deepseek-lean and budget).

    worker also feeds teammate; worker and reviewer carry `delegateCli: none`;
    tester/merger/checker/watchdog all use the `small` tier. Every role gets
    its own deep copy so later in-place edits never leak across roles.
    """
    own = copy.deepcopy
    return {
        "router": own(router),
        "worker": {**own(worker), "delegateCli": "none"},
        "teammate": own(worker),
        "reviewer": {**own(reviewer), "delegateCli": "none"},
        "reproducer": own(reproducer),
        "tester": own(small),
        "merger": own(small),
        "checker": own(small),
        "watchdog": own(small),
    }


PRESETS = {
    "claude-default": {
        "harness": "claude",
        "models": {
            "router": {
                "claude": {"model": "opus", "effort": "high"},
                "opencode": {"model": "anthropic/claude-opus-4", "reasoningEffort": "high"},
            },
            "worker": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
                "delegateCli": "none",
            },
            "teammate": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
            },
            "reviewer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
                "delegateCli": "none",
            },
            "reproducer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
            },
            "tester": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5"},
            },
            "merger": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5"},
            },
            "checker": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5"},
            },
            "watchdog": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5"},
            },
        },
    },
    # Refreshed 2026-11-08: "deepseek/deepseek-chat" and "deepseek/deepseek-reasoner"
    # are DeepSeek's current stable API aliases (they track the latest V3.x
    # release), so no versioned IDs are pinned and none are orphaned. Built with
    # the same tiered role mapping as the budget preset (see _tiered_models).
    "deepseek-lean": {
        "harness": "both",
        "models": _tiered_models(
            router={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "deepseek/deepseek-chat"},
            },
            worker={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "deepseek/deepseek-reasoner", "reasoningEffort": "high"},
            },
            reviewer={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "deepseek/deepseek-reasoner", "reasoningEffort": "high"},
            },
            reproducer={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "deepseek/deepseek-reasoner", "reasoningEffort": "high"},
            },
            small={
                "claude": {"model": "haiku", "effort": "medium"},
                "opencode": {"model": "deepseek/deepseek-chat"},
            },
        ),
    },
    # Cost-sensitive opt-in preset (ticket 018): cheap small roles, medium-effort
    # workers, strong reviewer (cheap reviews are a false economy). Not the default.
    "budget": {
        "harness": "both",
        "models": _tiered_models(
            router={
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1", "reasoningEffort": "high"},
            },
            worker={
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "medium"},
            },
            reviewer={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/o3", "reasoningEffort": "high"},
            },
            reproducer={
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/gpt-4.1", "reasoningEffort": "high"},
            },
            small={
                "claude": {"model": "haiku", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
        ),
    },
    "opencode-openai": {
        "harness": "opencode",
        "models": {
            "router": {
                "claude": {"model": "opus", "effort": "high"},
                "opencode": {"model": "openai/gpt-5", "reasoningEffort": "high"},
            },
            "worker": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/gpt-5", "reasoningEffort": "medium"},
                "delegateCli": "none",
            },
            "teammate": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/gpt-5", "reasoningEffort": "medium"},
            },
            "reviewer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/o3", "reasoningEffort": "high"},
                "delegateCli": "none",
            },
            "reproducer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/o3", "reasoningEffort": "high"},
            },
            "tester": {
                "claude": {"model": "haiku", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
            "merger": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1"},
            },
            "checker": {
                "claude": {"model": "haiku", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
            "watchdog": {
                "claude": {"model": "haiku", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
        },
    },
    "hybrid-bridge": {
        "harness": "both",
        "models": {
            "router": {
                "claude": {"model": "opus", "effort": "high"},
                "opencode": {"model": "openai/gpt-5", "reasoningEffort": "high"},
            },
            "worker": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
                "delegateCli": "none",
            },
            "teammate": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "anthropic/claude-sonnet-4-5", "reasoningEffort": "high"},
            },
            "reviewer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/o3", "reasoningEffort": "high"},
                "delegateCli": "codex",
            },
            "reproducer": {
                "claude": {"model": "sonnet", "effort": "high"},
                "opencode": {"model": "openai/o3", "reasoningEffort": "high"},
            },
            "tester": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
            "merger": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1"},
            },
            "checker": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
            "watchdog": {
                "claude": {"model": "sonnet", "effort": "medium"},
                "opencode": {"model": "openai/gpt-4.1-mini"},
            },
        },
    },
}


# --- Config schema versioning -------------------------------------------------
# Highest config version this script understands (see MIGRATIONS below).
CURRENT_CONFIG_VERSION = "4.0.0"

# Ticket 089: the config file and the secret-variable prefix this project used
# before the rename. They are named here and nowhere else in this script; they are
# only ever MOVED or WARNED about, never read as settings.
LEGACY_CONFIG_REL = "specs/super-agent.config.json"
LEGACY_ENV_PREFIX = "AGENT_HIVE_"
CONFIG_REL = "specs/worker-fleet.config.json"
ENV_PREFIX = "WORKER_FLEET_"

# Default telemetry rate table (USD per 1M tokens). Written to
# `telemetry.rates` in specs/worker-fleet.config.json (user-editable); the
# telemetry module (.claude/scripts/telemetry.py) reads it from there. Keys are
# matched as substrings of the model name; unmatched models get the cheapest
# rate and are flagged `rate: unknown`. All resulting costs are estimates.
DEFAULT_TELEMETRY_RATES = {
    "opus": {"in": 15.0, "out": 75.0, "cache": 1.5},
    "sonnet": {"in": 3.0, "out": 15.0, "cache": 0.3},
    "haiku": {"in": 0.8, "out": 4.0, "cache": 0.08},
    "gpt-5": {"in": 5.0, "out": 20.0, "cache": 1.25},
    "o3": {"in": 10.0, "out": 40.0, "cache": 2.5},
    "gpt-4.1-mini": {"in": 0.15, "out": 0.6, "cache": 0.075},
    "gpt-4.1": {"in": 2.0, "out": 8.0, "cache": 0.5},
    "deepseek": {"in": 0.14, "out": 0.28, "cache": 0.014},
}


def _version_tuple(value) -> tuple:
    """Parse a dotted version string like '2.0.0' into a comparable tuple."""
    parts = []
    for piece in str(value).split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def migrate_2_to_3(config: dict, changes: list) -> None:
    """Upgrade a 2.0.0 config to 3.0.0.

    Removes the committed `dashboard.tunnel.authToken` — the 002 token-hygiene
    block later in main() reuses its pop/rotate/burn semantics: a non-empty
    committed token is rotated into a fresh one in job/dashboard-auth.json and
    the burned warning is printed. Adds every 3.0.0 key with its default, but
    ONLY when the key is absent — user-set values are never overwritten.
    """
    tunnel = config.get("dashboard", {}).get("tunnel", {})
    if isinstance(tunnel, dict) and "authToken" in tunnel:
        committed = str(tunnel.get("authToken") or "")
        changes.append(f"- dashboard.tunnel.authToken ({'rotated' if committed else 'removed'})")

    def add(dotted: str, value, label=None):
        keys = dotted.split(".")
        node = config
        for key in keys[:-1]:
            child = node.get(key)
            if not isinstance(child, dict):
                child = {}
                node[key] = child
            node = child
        leaf = keys[-1]
        if leaf not in node:
            node[leaf] = value
            if label is not None:
                shown = label
            elif isinstance(value, str):
                shown = value
            else:
                shown = json.dumps(value)
            changes.append(f"+ {dotted}={shown}")

    add("notifications.providers", [])
    add("watchdog.mode", "script")
    add("watchdog.intervalSeconds", 60)
    add("telemetry.rates", DEFAULT_TELEMETRY_RATES, label="<preset rate table, USD per 1M tokens>")
    add("budget.defaults", {"usd": 10.0, "turns": 300})
    add("regression.everyNMerges", 1)
    add("landing", "direct")


def migrate_3_to_4(config: dict, changes: list) -> None:
    """Upgrade a 3.0.0 config to 4.0.0 (ticket 089: the rename to worker-fleet).

    Secret references of the form {"env": "<old prefix><REST>"} point at the new
    prefix. Only the reference changes: {"secretRef": ...} values, inline values,
    job/notify-secrets.json and every other key stay as they are. The user's real
    environment variables are not renamed here; main() lists them in a warning.
    """
    notifications = config.get("notifications")
    providers = notifications.get("providers") if isinstance(notifications, dict) else None
    if not isinstance(providers, list):
        return
    for idx, provider in enumerate(providers):
        if not isinstance(provider, dict):
            continue
        field = NOTIFY_SECRET_FIELDS.get(provider.get("type"))
        value = provider.get(field) if field else None
        if not isinstance(value, dict):
            continue
        name = value.get("env")
        if isinstance(name, str) and name.startswith(LEGACY_ENV_PREFIX):
            renamed = ENV_PREFIX + name[len(LEGACY_ENV_PREFIX):]
            value["env"] = renamed
            changes.append(
                f"~ notifications.providers[{idx}].{field}.env: {name} -> {renamed} (rename the environment variable)"
            )


# Migration registry — BUMP DISCIPLINE: any schema change must bump `version`
# and add a migration entry here mapping the old version to its upgrade
# function; a saved config is never mutated without one. 4.0.0 (ticket 089) is the
# move of the config file to specs/worker-fleet.config.json and the rename of the
# {"env": ...} secret prefix. The loop chains, each step moving the walking version
# to that step's own target. Exit code 3 is reserved exclusively for the
# future-version abort (see main()).
MIGRATIONS = {"2.0.0": migrate_2_to_3, "3.0.0": migrate_3_to_4}
# The version each step produces (the key of the next step, or CURRENT_CONFIG_VERSION).
MIGRATION_TARGETS = {"2.0.0": "3.0.0", "3.0.0": "4.0.0"}


def run_migrations(config: dict, quiet: bool = False) -> str:
    """Walk `config` from its own version to CURRENT_CONFIG_VERSION, one step at a time.

    Each step prints its own `[<from> -> <to>] migrated config` block (unless quiet).
    Returns the final version. The caller has already refused a newer version.
    """
    walking = str(config.get("version") or "2.0.0")
    while walking in MIGRATIONS and _version_tuple(walking) < _version_tuple(CURRENT_CONFIG_VERSION):
        log: list = []
        MIGRATIONS[walking](config, log)
        target = MIGRATION_TARGETS[walking]
        config["version"] = target
        if not quiet:
            print(f"[{walking} -> {target}] migrated config")
            for change in log:
                print(f"[{walking} -> {target}] {change}")
        walking = target
    return walking


def find_repo_root(start_dir: Path) -> Path:
    current = start_dir.resolve()
    for _ in range(5):
        if (current / ".claude").is_dir() or (current / "specs").is_dir() or (current / "README.md").is_file():
            return current
        if current.parent == current:
            break
        current = current.parent
    return start_dir.resolve()


def parse_frontmatter(content: str):
    if not content.startswith("---"):
        return {}, content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content

    raw_yaml = parts[1]
    body = parts[2]
    fm = {}
    for line in raw_yaml.strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            val = v.strip()
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                try:
                    val = json.loads(val) if val.startswith('"') else val[1:-1]
                except Exception:
                    val = val[1:-1]
            fm[k.strip()] = val
    return fm, body


def format_yaml_value(k: str, v) -> str:
    s = str(v)
    if s.isdigit():
        return s
    if k == "description" or ": " in s or "#" in s or '"' in s or s.startswith("{") or s.startswith("["):
        return json.dumps(s)
    return s


def serialize_frontmatter(fm: dict, body: str) -> str:
    lines = ["---"]
    for k, v in fm.items():
        if v is not None:
            lines.append(f"{k}: {format_yaml_value(k, v)}")
    lines.append("---")
    return "\n".join(lines) + body


NOTIFY_EVENTS = (
    "worker_blocked",
    "budget_exceeded",
    "retries_exhausted",
    "ticket_done",
    "regression_confirmed",
    "needs_human",
    "watchdog_stall",
)


# Ticket 048: notification secrets live OUTSIDE the tracked config. A secret field
# holds {"secretRef": "<id>"} (resolved from the gitignored job/notify-secrets.json)
# or {"env": "WORKER_FLEET_<NAME>"}; an inline value is deprecated and migrated below.
NOTIFY_SECRET_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
NOTIFY_SECRET_ENV_RE = re.compile(r"WORKER_FLEET_[A-Z0-9_]{1,64}")
NOTIFY_SECRET_FIELDS = {"telegram": "botToken", "slack": "webhook", "ntfy": "auth"}
NOTIFY_SECRET_REF_ERROR = "must be a non-empty string, {\"secretRef\": \"<id>\"} or {\"env\": \"WORKER_FLEET_<NAME>\"}"
NOTIFY_BOTH_CREDENTIALS_ERROR = "ntfy provider has credentials in both 'target' and 'auth': keep only 'auth'"
# Same three shapes as selftest.py's PROVIDER_SECRET_PATTERNS (written so that this file never matches them).
NOTIFY_SECRET_SHAPES = (
    re.compile(r"(?<![A-Za-z0-9_])(?:bot)?[0-9]{6,}:[A-Za-z0-9_-]{30,}"),
    re.compile(r"hooks\.slack\.com/services/T[A-Za-z0-9]{6,}/B[A-Za-z0-9]{6,}/[A-Za-z0-9]{16,}"),
    re.compile(r"https?://[^/@\s<>*]+:[^/@\s<>*]+@"),
)


def classify_notify_secret(value):
    """Ticket 048: classify a secret field. Returns (kind, payload).

    kind is "inline" (payload: the stripped string), "secretRef" (payload: the id),
    "env" (payload: the variable name) or "invalid" (payload: None).
    """
    if isinstance(value, dict):
        if len(value) == 1:
            ref = value.get("secretRef")
            if isinstance(ref, str) and NOTIFY_SECRET_ID_RE.fullmatch(ref):
                return "secretRef", ref
            name = value.get("env")
            if isinstance(name, str) and NOTIFY_SECRET_ENV_RE.fullmatch(name):
                return "env", name
        return "invalid", None
    if isinstance(value, bool) or not isinstance(value, (str, int)) or str(value).strip() == "":
        return "invalid", None
    return "inline", str(value).strip()


def ntfy_target_credentials(target):
    """Ticket 048: urlsplit() of an ntfy target URL that carries a username, else None."""
    try:
        parts = urlsplit(str(target).strip())
        return parts if parts.username else None
    except ValueError:
        return None


def validate_notification_provider(p) -> "str | None":
    """Ticket 012: return an error string for an invalid notifications.providers[] entry, else None.

    Mirrors the checks in .claude/scripts/notify.sh (contract: specs/tickets/012-notification-layer).
    Ticket 048: a secret field may also be a {"secretRef"} / {"env"} reference.
    """
    if not isinstance(p, dict):
        return "entry must be an object"
    ptype = p.get("type")
    if ptype not in ("ntfy", "telegram", "slack"):
        return "unknown type %r (expected ntfy, telegram or slack)" % (ptype if isinstance(ptype, str) else None)
    required = {"ntfy": ["target"], "telegram": ["botToken", "chatId"], "slack": ["webhook"]}[ptype]
    secret_field = NOTIFY_SECRET_FIELDS[ptype]
    secret_kind = None
    for key in required:
        v = p.get(key)
        if key == secret_field:
            if v is None or (isinstance(v, str) and v.strip() == ""):
                return "%s provider needs a non-empty %r" % (ptype, key)
            secret_kind = classify_notify_secret(v)[0]
            if secret_kind == "invalid":
                return "%s %r %s" % (ptype, key, NOTIFY_SECRET_REF_ERROR)
            continue
        if isinstance(v, bool) or not isinstance(v, (str, int)) or str(v).strip() == "":
            return "%s provider needs a non-empty %r" % (ptype, key)
    if ptype == "ntfy":
        target = str(p["target"]).strip()
        if not re.match(r"^https?://[^\s/]+", target) and not re.match(r"^[A-Za-z0-9_-]{1,64}$", target):
            return "ntfy target must be a topic name ([A-Za-z0-9_-], max 64) or an http(s) URL"
        if "auth" in p:
            if classify_notify_secret(p["auth"])[0] == "invalid":
                return "ntfy 'auth' %s" % NOTIFY_SECRET_REF_ERROR
            if ntfy_target_credentials(target):
                return NOTIFY_BOTH_CREDENTIALS_ERROR
    if ptype == "slack" and secret_kind == "inline" and not re.match(r"^https?://[^\s/]+", str(p["webhook"]).strip()):
        return "slack webhook must be an http(s) URL"
    ev = p.get("events", "all")
    if ev != "all":
        if not isinstance(ev, list) or not all(isinstance(x, str) for x in ev):
            return 'events must be "all" or a list of event names'
        for x in ev:
            if x not in NOTIFY_EVENTS:
                return "unknown event %r in events (valid: %s)" % (x, ", ".join(NOTIFY_EVENTS))
    return None


def has_inline_notify_secrets(providers) -> bool:
    """Ticket 048: True when a (validated) provider still holds an inline secret."""
    for p in providers:
        ptype = p.get("type")
        if ptype in ("telegram", "slack") and classify_notify_secret(p.get(NOTIFY_SECRET_FIELDS[ptype]))[0] == "inline":
            return True
        if ptype == "ntfy":
            if "auth" in p:
                if classify_notify_secret(p["auth"])[0] == "inline":
                    return True
            elif ntfy_target_credentials(p.get("target")):
                return True
    return False


def load_notify_secrets_doc(path: Path) -> dict:
    """Ticket 048: the parsed secrets file ({"version": 1, "secrets": {...}}); a missing file is empty.

    Raises ValueError when the file exists but is not a valid notify secrets file.
    """
    if not path.exists():
        return {"version": 1, "secrets": {}}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("unreadable") from exc
    if not isinstance(doc, dict):
        raise ValueError("not an object")
    stored = doc.get("secrets", {})
    if not isinstance(stored, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in stored.items()):
        raise ValueError("secrets is not an object of strings")
    doc["secrets"] = dict(stored)
    doc.setdefault("version", 1)
    return doc


def _notify_secret_id(ptype: str, value: str, stored: dict, referenced: set) -> str:
    """Reuse the id that already holds `value`, else the smallest free <type>-<n>."""
    for sid in sorted(stored):
        if stored[sid] == value:
            return sid
    n = 1
    while "%s-%d" % (ptype, n) in stored or "%s-%d" % (ptype, n) in referenced:
        n += 1
    return "%s-%d" % (ptype, n)


def migrate_inline_notify_secrets(providers, stored: dict) -> list:
    """Ticket 048: move every inline provider secret into `stored` (id -> value), in place.

    Replaces each moved value in `providers` with a {"secretRef": "<id>"} reference. Returns one
    description line per moved value, in provider order. Never prints or returns a value.
    """
    referenced = set()
    for p in providers:
        for v in p.values():
            if isinstance(v, dict) and isinstance(v.get("secretRef"), str):
                referenced.add(v["secretRef"])
    moved = []
    for idx, p in enumerate(providers):
        ptype = p.get("type")
        base = "notifications.providers[%d]" % idx
        if ptype in ("telegram", "slack"):
            field = NOTIFY_SECRET_FIELDS[ptype]
            kind, value = classify_notify_secret(p.get(field))
            if kind == "inline":
                sid = _notify_secret_id(ptype, value, stored, referenced)
                stored[sid] = value
                p[field] = {"secretRef": sid}
                moved.append("%s.%s -> %s" % (base, field, json.dumps(p[field])))
        elif ptype == "ntfy":
            if "auth" in p:
                kind, value = classify_notify_secret(p["auth"])
                if kind == "inline":
                    sid = _notify_secret_id(ptype, value, stored, referenced)
                    stored[sid] = value
                    p["auth"] = {"secretRef": sid}
                    moved.append("%s.auth -> %s" % (base, json.dumps(p["auth"])))
                continue
            parts = ntfy_target_credentials(p.get("target"))
            if parts is not None:
                value = unquote(parts.username) + ":" + unquote(parts.password or "")
                sid = _notify_secret_id(ptype, value, stored, referenced)
                stored[sid] = value
                host = parts.netloc.rsplit("@", 1)[-1]
                p["target"] = urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
                p["auth"] = {"secretRef": sid}
                moved.append("%s.target URL credentials -> auth %s" % (base, json.dumps(p["auth"])))
    return moved


def write_notify_secrets_file(path: Path, doc: dict) -> None:
    """Ticket 048: write the secrets file atomically with mode 0600 (temp file, fsync, replace)."""
    tmp = path.parent / (".notify-secrets.json.%d.tmp" % os.getpid())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(doc, indent=2, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def find_secret_shaped_values(node, path: str = "") -> list:
    """Ticket 048: dotted paths of every string in `node` that looks like a Telegram/Slack/URL-credential secret."""
    found = []
    if isinstance(node, dict):
        for k, v in node.items():
            found.extend(find_secret_shaped_values(v, "%s.%s" % (path, k) if path else str(k)))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found.extend(find_secret_shaped_values(v, "%s[%d]" % (path, i)))
    elif isinstance(node, str) and any(rx.search(node) for rx in NOTIFY_SECRET_SHAPES):
        found.append(path)
    return found


def mask_token(token: str) -> str:
    """Mask the dashboard auth token for console output (last 4 chars; short tokens fully masked)."""
    return "****" + (token[-4:] if len(token) >= 16 else "")


# Ticket 063: the same text and rule as dashboard-server.py's warn_if_weak_token.
WEAK_TOKEN_WARNING = (
    "the dashboard token in job/dashboard-auth.json does not look randomly generated "
    "(apply-setup.py generates 32 lowercase hex characters). A guessable token can be "
    "guessed through the tunnel, so regenerate it: "
    "python3 .claude/scripts/apply-setup.py --regenerate-token"
)


def token_looks_generated(token: str) -> bool:
    """True when the stripped token is 32 or more lowercase hex characters."""
    return re.fullmatch(r"[0-9a-f]{32,}", str(token).strip() if token is not None else "") is not None


def cost_per_role_line(config: dict, harness_key: "str | None" = None) -> str:
    """One-line ~ est. price table: per role, the given harness's model rate.

    `harness_key` ("claude" or "opencode") picks the harness; when omitted it
    follows the config's `harness` (opencode -> opencode, anything else -> claude).

    Rates come ONLY from `telemetry.rates` in the config (USD per 1M tokens);
    matching mirrors telemetry.py (longest key that is a substring of the model
    name). A model matching no key is shown as `rate?` rather than a made-up
    figure. Every figure is an estimate, never an invoice.
    """
    rates = {
        str(k).lower(): v
        for k, v in ((config.get("telemetry") or {}).get("rates") or {}).items()
        if isinstance(v, dict) and "in" in v and "out" in v
    }
    if harness_key is None:
        harness_key = "opencode" if config.get("harness") == "opencode" else "claude"
    parts = []
    for role, conf in (config.get("models") or {}).items():
        model = str((conf.get(harness_key) or {}).get("model", ""))
        match = next((k for k in sorted(rates, key=len, reverse=True) if k in model.lower()), None)
        if not model:
            continue
        if match is None:
            parts.append(f"{role} {model} rate?")
        else:
            parts.append(f"{role} {model} ~${float(rates[match]['in']):g}/~${float(rates[match]['out']):g} est.")
    return "; ".join(parts) if parts else "n/a"


PORT_ROLE_ORDER = ("main", "dashboard", "reproducer", "worker")


def _port_value(value):
    """Ticket 068 FR-1: a valid port is an int (not a bool) or an ASCII-digit string in 1..65535, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        digits = value.lstrip("0")
        if not (value.isascii() and value.isdigit()) or len(digits) > 5:
            return None
        value = int(digits or "0")
    if isinstance(value, int) and 1 <= value <= 65535:
        return value
    return None


def _port_workers(value) -> int:
    """Ticket 068 FR-1: maxParallelWorkers is an int (not a bool) or an ASCII-digit string >= 1, else 8."""
    if isinstance(value, bool):
        return 8
    if isinstance(value, str):
        if not (value.isascii() and value.isdigit()):
            return 8
        digits = value.lstrip("0")
        value = int(digits) if 0 < len(digits) <= 9 else (10 ** 9 if digits else 0)
    if isinstance(value, int) and value >= 1:
        return min(value, 10 ** 9)  # a huge count is kept (FR-4 refuses it) without huge-int formatting
    return 8


def project_ports_config(config) -> dict:
    """The FR-1 values of a config: main, dashboard, reproducer, worker base and worker count."""
    conf = config if isinstance(config, dict) else {}
    conc = conf.get("concurrency") if isinstance(conf.get("concurrency"), dict) else {}
    dash = conf.get("dashboard") if isinstance(conf.get("dashboard"), dict) else {}
    return {
        "main": _port_value(conc.get("mainPort")) or 3000,
        "dashboard": _port_value(dash.get("port")) or _port_value(conc.get("dashboardPort")) or 3080,
        "reproducer": _port_value(conc.get("reproducerPort")) or 3090,
        "base": _port_value(conc.get("workerBasePort")) or 3101,
        "workers": _port_workers(conc.get("maxParallelWorkers")),
    }


def project_ports(config) -> list:
    """Ticket 068 FR-1: the project's ports as (port, role) pairs: main, dashboard, reproducer, then each
    worker port in ascending order (worker ports above 65535 are dropped)."""
    v = project_ports_config(config)
    pairs = [(v["main"], "main"), (v["dashboard"], "dashboard"), (v["reproducer"], "reproducer")]
    for n in range(v["workers"]):
        if v["base"] + n > 65535:
            break
        pairs.append((v["base"] + n, "worker"))
    return pairs


def find_port_clash(config):
    """Ticket 068 FR-4: the lowest port two roles share, as (port, role A, role B) in PORT_ROLE_ORDER, or None."""
    by_port = {}
    for port, role in project_ports(config):
        by_port.setdefault(port, []).append(role)
    for port in sorted(by_port):
        roles = sorted(by_port[port], key=PORT_ROLE_ORDER.index)
        if len(roles) > 1:
            return port, roles[0], roles[1]
    return None


def registry_file() -> Path:
    """Ticket 068 FR-5: the user-level registry of worker-fleet main checkouts."""
    return Path.home() / ".worker-fleet" / "projects.json"


def _read_registry(path: Path):
    """The registry's project list; a missing file is an empty list; anything else raises ValueError."""
    if not path.is_file():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError, RecursionError) as exc:
        raise ValueError(getattr(exc, "strerror", None) or str(exc))
    projects = doc.get("projects") if isinstance(doc, dict) else None
    if not (isinstance(doc, dict) and doc.get("version") == 1 and isinstance(projects, list)
            and all(isinstance(x, str) and x for x in projects)):
        raise ValueError('unexpected content (expected {"version": 1, "projects": ["<path>", ...]})')
    return projects


def update_port_registry(repo_root: Path, config: dict) -> None:
    """Ticket 068 FR-5: register this main checkout in ~/.worker-fleet/projects.json and print a
    `WARNING: port overlap` line for every other registered project that shares a port. Prints paths,
    port numbers and role names only. Never changes a port or the exit code, and opens no socket."""
    if not (repo_root / ".git").is_dir():
        print(f"Port registry: skipped (not a main git checkout: {repo_root})")
        return
    reg = registry_file()
    try:
        projects = _read_registry(reg)
    except ValueError as exc:
        print(f"WARNING: cannot read {reg}: {exc}; this project was not registered and no overlap check ran.")
        return
    own = os.path.realpath(str(repo_root))
    kept = []
    for entry in projects:
        if entry in kept:
            continue
        if entry == own or os.path.isfile(os.path.join(entry, "specs", "worker-fleet.config.json")):
            kept.append(entry)
    if own not in kept:
        kept.append(own)
    if kept != projects or not reg.is_file():
        try:
            reg.parent.mkdir(parents=True, exist_ok=True)
            tmp = reg.parent / ("%s.%d.tmp" % (reg.name, os.getpid()))
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"version": 1, "projects": kept}, f, indent=2)
                    f.write("\n")
                os.replace(tmp, reg)
            except OSError:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            print(f"WARNING: cannot write {reg}: {exc.strerror or exc}; this project was not registered.")
    here = {}
    for port, role in project_ports(config):
        here.setdefault(port, role)
    overlapping = 0
    for other in kept:
        if other == own:
            continue
        other_conf = os.path.join(other, "specs", "worker-fleet.config.json")
        try:
            with open(other_conf, "r", encoding="utf-8") as f:
                other_config = json.load(f)
        except (OSError, ValueError, RecursionError) as exc:
            print(f"WARNING: cannot read {other_conf}: {getattr(exc, 'strerror', None) or exc}; skipped in the overlap check.")
            continue
        try:
            there = {}
            for port, role in project_ports(other_config):
                there.setdefault(port, role)
        except Exception as exc:
            print(f"WARNING: cannot read {other_conf}: {exc}; skipped in the overlap check.")
            continue
        common = sorted(set(here) & set(there))
        if not common:
            continue
        overlapping += 1
        items = ", ".join(f"{p} ({here[p]} here, {there[p]} there)" for p in common)
        print(
            f"WARNING: port overlap with the worker-fleet project at {other}: {items}. "
            "Both projects cannot run at once; give this project its own ports with "
            "--main-port, --reproducer-port, --worker-base-port or --port."
        )
    print(f"Port registry: {reg} lists {len(kept)} project(s); {overlapping} other project(s) overlap this one's ports.")


def move_legacy_config(repo_root: Path) -> None:
    """Ticket 089: move the config from its pre-rename path to the new one.

    Runs only without --config. An old regular file with no new file is renamed
    byte-identical. Both present: the new file wins, the old one is left alone and
    one WARNING line says so. An old path that is a symlink or not a regular file
    is refused (exit 1) with nothing moved or written.
    """
    old = repo_root / LEGACY_CONFIG_REL
    new = repo_root / CONFIG_REL
    if not os.path.lexists(old):
        return
    if os.path.lexists(new):
        print(f"WARNING: {LEGACY_CONFIG_REL} is no longer read; {CONFIG_REL} is used. Merge what you need from it, then delete it.")
        return
    if os.path.islink(old) or not os.path.isfile(old):
        print(
            f"ERROR: {LEGACY_CONFIG_REL} is a symlink or not a regular file; move it to {CONFIG_REL} yourself, then re-run.",
            file=sys.stderr,
        )
        sys.exit(1)
    os.rename(old, new)
    print(f"Moved {LEGACY_CONFIG_REL} to {CONFIG_REL} (commit the rename).")


def main():
    parser = argparse.ArgumentParser(description="Apply worker-fleet configuration")
    parser.add_argument("--config", help="Path to specs/worker-fleet.config.json", default=None)
    parser.add_argument("--preset", choices=list(PRESETS.keys()) + ["custom"], help="Model preset name")
    parser.add_argument("--harness", choices=["claude", "opencode", "both"], help="Target CLI harness")
    parser.add_argument("--max-workers", type=int, dest="max_workers", help="Maximum parallel workers")
    parser.add_argument("--dashboard", choices=["on", "off"], help="Enable/disable dashboard")
    parser.add_argument("--port", type=int, help="Fleet Control Dashboard port (default: 3080)")
    # Ticket 068: the project's own dev server ports.
    parser.add_argument(
        "--main-port",
        type=int,
        dest="main_port",
        metavar="INT",
        help="Main checkout (checker) dev server port (default: 3000)",
    )
    parser.add_argument(
        "--reproducer-port",
        type=int,
        dest="reproducer_port",
        metavar="INT",
        help="Reproducer dev server port (default: 3090)",
    )
    parser.add_argument(
        "--worker-base-port",
        type=int,
        dest="worker_base_port",
        metavar="INT",
        help="First worker dev server port; worker slot N uses base + N - 1 (default: 3101)",
    )
    parser.add_argument("--tunnel", choices=["cloudflared", "ngrok", "local"], help="Tunnel provider")
    parser.add_argument("--remote-actions", choices=["on", "off"], help="Allow remote actions from mobile")
    parser.add_argument(
        "--auto-dispatch-on-approve",
        choices=["on", "off"],
        dest="auto_dispatch_on_approve",
        help="An Approve wakes the idle router (on, the default) or waits for Dispatch now (off)",
    )
    parser.add_argument(
        "--regression-every-n-merges",
        type=int,
        dest="regression_every_n_merges",
        metavar="INT",
        help="Run the checker's full regression sweep after every N merges (default: 1 = every merge; 0 disables the auto cadence)",
    )
    parser.add_argument(
        "--landing",
        choices=["direct", "pr"],
        help="Ticket landing mode: direct merge to main (default) or push the branch and open a GitHub PR",
    )
    # Ticket 017: script-mode watchdog configuration.
    parser.add_argument(
        "--watchdog-mode",
        choices=["script", "agent"],
        dest="watchdog_mode",
        help="Watchdog mode: script (default) = the dashboard server schedules watchdog-check.sh and writes job/watchdog-report.json; agent = legacy mode: the router invokes the one-shot watchdog analyst every watchdog.intervalMinutes (nothing loops in the background)",
    )
    parser.add_argument(
        "--watchdog-interval",
        type=int,
        dest="watchdog_interval",
        metavar="SECONDS",
        help="Script-mode scheduler cadence in seconds: the dashboard server runs watchdog-check.sh --json on startup and every N seconds (default: 60)",
    )
    # Ticket 005: default per-ticket budget caps (enforced by the router).
    parser.add_argument(
        "--budget-usd",
        type=float,
        dest="budget_usd",
        metavar="FLOAT",
        help="Default per-ticket estimated-cost budget cap in USD (default: 10.0)",
    )
    parser.add_argument(
        "--budget-turns",
        type=int,
        dest="budget_turns",
        metavar="INT",
        help="Default per-ticket worker turn budget cap (default: 300)",
    )
    # Ticket 023: optional worker implementation delegation (opt-in).
    parser.add_argument(
        "--worker-delegate",
        choices=["none", "codex", "opencode"],
        dest="worker_delegate",
        metavar="CLI",
        help="Worker implementation delegation CLI (none|codex|opencode): route rd-listed mechanical subtasks through delegate-task.sh exec ('none' = off, the default)",
    )
    # Ticket 012: notification layer (notify.sh) convenience flag.
    parser.add_argument(
        "--notify-ntfy",
        dest="notify_ntfy",
        metavar="TOPIC",
        help="Add/update the ntfy provider in notifications.providers (target TOPIC or full URL, subscribed to all events)",
    )
    parser.add_argument("--regenerate-token", action="store_true", help="Force regenerate dashboard auth token")
    parser.add_argument(
        "--show-token",
        action="store_true",
        dest="show_token",
        help="Print the full dashboard auth token in the end-of-run summary (default: masked to its last 4 characters)",
    )

    args = parser.parse_args()

    # Budget caps must be positive and finite: zero would trip instantly and
    # negative/NaN/inf values are meaningless. Reject before anything is written.
    if args.budget_usd is not None and not (0 < args.budget_usd < float("inf")):
        parser.error("--budget-usd must be a positive number (got %r)" % args.budget_usd)
    if args.budget_turns is not None and args.budget_turns <= 0:
        parser.error("--budget-turns must be a positive integer (got %r)" % args.budget_turns)
    for port_flag, port_value in (
        ("--main-port", args.main_port),
        ("--reproducer-port", args.reproducer_port),
        ("--worker-base-port", args.worker_base_port),
    ):
        if port_value is not None and not (1024 <= port_value <= 65535):
            parser.error("%s must be between 1024 and 65535 (got %d)" % (port_flag, port_value))

    script_dir = Path(__file__).parent.resolve()
    repo_root = find_repo_root(script_dir)

    if args.config:
        config_path = Path(args.config).resolve()
    else:
        config_path = repo_root / CONFIG_REL
        move_legacy_config(repo_root)

    config = {}
    if config_path.is_file():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        except Exception as e:
            print(f"Warning: Failed to parse {config_path}: {e}", file=sys.stderr)

    if not config:
        config = {
            "version": "2.0.0",
            "harness": "both",
            "preset": "hybrid-bridge",
            "concurrency": {
                "maxParallelWorkers": 4,
                "mainPort": 3000,
                "reproducerPort": 3090,
                "workerBasePort": 3101,
                "dashboardPort": 3080,
            },
            "watchdog": {
                "intervalMinutes": 10,
                "stallThresholdMinutes": 15,
                "autoCompactWindow": 150000,
            },
            "regression": {
                "everyNMerges": 1,
            },
            "models": PRESETS["hybrid-bridge"]["models"],
            "dashboard": {
                "enabled": True,
                "autoStartWithRouter": True,
                "port": 3080,
                "allowRemoteActions": True,
                "tunnel": {
                    "provider": "cloudflared",
                    "namedTunnel": "",
                },
            },
        }

    # --- Config migrations (always run BEFORE preset/flag application) ---
    # `config.version` is authoritative; a config without a `version` field is
    # treated as 2.0.0. A config from a NEWER worker-fleet aborts here, before
    # anything is written or modified on disk (exit code 3 — reserved).
    original_version = str(config.get("version") or "2.0.0")
    if _version_tuple(original_version) > _version_tuple(CURRENT_CONFIG_VERSION):
        print("config is from a newer worker-fleet - upgrade worker-fleet first", file=sys.stderr)
        sys.exit(3)

    run_migrations(config)

    # Ticket 089: the old secret variables are never read. List them once so the
    # user can rename them (names only, sorted; values are never printed).
    legacy_vars = sorted(name for name in os.environ if name.startswith(LEGACY_ENV_PREFIX))
    if legacy_vars:
        renames = ", ".join(f"{name} -> {ENV_PREFIX}{name[len(LEGACY_ENV_PREFIX):]}" for name in legacy_vars)
        print(f"WARNING: {LEGACY_ENV_PREFIX}* variables are no longer read; rename them: {renames}")

    # --- Notifications (ticket 012) -------------------------------------------
    # Every saved config carries `notifications.providers` (default []).
    # Entries are validated BEFORE anything is written: an invalid provider is
    # a hard error naming the offending index (exit 1, config untouched).
    notif_conf = config.get("notifications")
    if notif_conf is None:
        notif_conf = config["notifications"] = {}
    if not isinstance(notif_conf, dict):
        print("ERROR: notifications must be an object", file=sys.stderr)
        sys.exit(1)
    providers_conf = notif_conf.setdefault("providers", [])
    if not isinstance(providers_conf, list):
        print("ERROR: notifications.providers must be a list", file=sys.stderr)
        sys.exit(1)
    if args.notify_ntfy is not None:
        ntfy_provider = {"type": "ntfy", "target": args.notify_ntfy.strip(), "events": "all"}
        ntfy_error = validate_notification_provider(ntfy_provider)
        if ntfy_error:
            print(f"ERROR: --notify-ntfy: {ntfy_error}", file=sys.stderr)
            sys.exit(1)
        for idx, existing in enumerate(providers_conf):
            if isinstance(existing, dict) and existing.get("type") == "ntfy":
                providers_conf[idx] = ntfy_provider
                break
        else:
            providers_conf.append(ntfy_provider)
    for idx, provider in enumerate(providers_conf):
        provider_error = validate_notification_provider(provider)
        if provider_error:
            print(f"ERROR: notifications.providers[{idx}]: {provider_error}", file=sys.stderr)
            sys.exit(1)

    # Ticket 048: inline notification secrets move into the gitignored
    # job/notify-secrets.json (written later, right before the config save);
    # the tracked config keeps {"secretRef": "<id>"} references. Values are never printed.
    notify_secrets_path = repo_root / "job" / "notify-secrets.json"
    notify_secrets_doc = None
    notify_moved = []
    if has_inline_notify_secrets(providers_conf):
        try:
            notify_secrets_doc = load_notify_secrets_doc(notify_secrets_path)
        except ValueError:
            print(
                f'ERROR: {notify_secrets_path} is not a valid notify secrets file ({{"version": 1, "secrets": {{...}}}}): '
                "fix or move it, then re-run; the config was not changed",
                file=sys.stderr,
            )
            sys.exit(1)
        notify_moved = migrate_inline_notify_secrets(providers_conf, notify_secrets_doc["secrets"])
    # ---------------------------------------------------------------------------

    if args.preset and args.preset in PRESETS:
        config["preset"] = args.preset
        preset_data = PRESETS[args.preset]
        config["harness"] = preset_data["harness"]
        config["models"] = preset_data["models"]

    if args.harness:
        config["harness"] = args.harness
    if args.max_workers:
        config.setdefault("concurrency", {})["maxParallelWorkers"] = args.max_workers
    if args.dashboard:
        config.setdefault("dashboard", {})["enabled"] = (args.dashboard == "on")
    if args.port:
        config.setdefault("dashboard", {})["port"] = args.port
        config.setdefault("concurrency", {})["dashboardPort"] = args.port
    if args.tunnel:
        config.setdefault("dashboard", {}).setdefault("tunnel", {})["provider"] = args.tunnel
    if args.remote_actions:
        config.setdefault("dashboard", {})["allowRemoteActions"] = (args.remote_actions == "on")
    if args.auto_dispatch_on_approve:
        config.setdefault("dispatch", {})["autoOnApprove"] = (args.auto_dispatch_on_approve == "on")
    # Ticket 068: only an explicit flag changes a port; a missing key stays missing.
    if args.main_port is not None:
        config.setdefault("concurrency", {})["mainPort"] = args.main_port
    if args.reproducer_port is not None:
        config.setdefault("concurrency", {})["reproducerPort"] = args.reproducer_port
    if args.worker_base_port is not None:
        config.setdefault("concurrency", {})["workerBasePort"] = args.worker_base_port

    # Ticket 068 FR-4: refuse bad ports before anything is written (every run, flags or not).
    port_values = project_ports_config(config)
    if port_values["base"] + port_values["workers"] - 1 > 65535:
        parser.error(
            "the worker ports %d-%d go past 65535: lower --worker-base-port or --max-workers"
            % (port_values["base"], port_values["base"] + port_values["workers"] - 1)
        )
    port_clash = find_port_clash(config)
    if port_clash:
        print(
            "ERROR: port clash in this project: %s and %s both use %d. Nothing was changed."
            % (port_clash[1], port_clash[2], port_clash[0]),
            file=sys.stderr,
        )
        sys.exit(1)

    # Worker implementation delegation (ticket 023): "none" (default, off),
    # "codex" or "opencode" (opt-in). An explicit flag overrides; a missing
    # key is normalized to the off default. Presets are unchanged.
    if args.worker_delegate:
        config.setdefault("models", {}).setdefault("worker", {})["delegateCli"] = args.worker_delegate
    else:
        config.setdefault("models", {}).setdefault("worker", {}).setdefault("delegateCli", "none")

    # Regression sweep cadence: checker full mode after every N merges
    # (default 1 = every merge; 0 disables). Only an explicit flag overrides
    # an existing value; a missing key is normalized to the default of 1.
    if args.regression_every_n_merges is not None:
        if args.regression_every_n_merges < 0:
            parser.error("--regression-every-n-merges must be >= 0")
        config.setdefault("regression", {})["everyNMerges"] = args.regression_every_n_merges
    else:
        config.setdefault("regression", {}).setdefault("everyNMerges", 1)

    # Per-ticket budget caps (ticket 005): every saved config carries
    # `budget.defaults` (the same block the 2->3 migration writes, applied here
    # idempotently so older configs gain it on the next run). Missing keys are
    # normalized to the defaults; user-set values are only overwritten by an
    # explicit --budget-usd / --budget-turns flag.
    budget_defaults = config.setdefault("budget", {}).setdefault("defaults", {})
    budget_defaults.setdefault("usd", 10.0)
    budget_defaults.setdefault("turns", 300)
    if args.budget_usd is not None:
        budget_defaults["usd"] = float(args.budget_usd)
    if args.budget_turns is not None:
        budget_defaults["turns"] = int(args.budget_turns)

    # Telemetry price table (ticket 014): every saved config carries the
    # preset `telemetry.rates` (USD per 1M tokens). Added idempotently - an
    # existing table, including user edits, is never overwritten. Ticket 018:
    # default keys missing from an existing table (e.g. the new `gpt-4.1`
    # rate used by the budget preset) are added so the summary and telemetry
    # never price a preset model as `rate: unknown`; present keys are untouched.
    rates_conf = config.setdefault("telemetry", {}).setdefault(
        "rates", json.loads(json.dumps(DEFAULT_TELEMETRY_RATES))
    )
    if isinstance(rates_conf, dict):
        for rate_key, rate_val in DEFAULT_TELEMETRY_RATES.items():
            rates_conf.setdefault(rate_key, dict(rate_val))

    # Landing mode (ticket 022): "direct" (merge straight to main, the
    # default) or "pr" (push the branch and open a GitHub PR). Same pattern
    # as the regression cadence — an explicit flag overrides, a missing key
    # is normalized to the default of "direct".
    if args.landing:
        config["landing"] = args.landing
    else:
        config.setdefault("landing", "direct")

    # PR landing preflight (non-fatal warning): PR mode needs the gh CLI on
    # PATH and an origin remote to push to. A missing piece only warns —
    # setup still exits 0; the merger aborts PR creation cleanly at runtime.
    if config.get("landing") == "pr":
        gh_path = shutil.which("gh")
        if gh_path:
            print(f"✔ PR landing mode: gh CLI found at {gh_path}")
        else:
            print(
                "⚠ Warning: landing=pr but the GitHub CLI (gh) is not on PATH — "
                "the merger cannot create PRs until it is installed. Non-fatal: "
                "setup completed, but the merger will abort PR landing cleanly."
            )
        try:
            remotes = subprocess.run(
                ["git", "remote"], cwd=str(repo_root), capture_output=True, text=True, check=False
            ).stdout.split()
        except Exception:
            remotes = []
        if "origin" in remotes:
            print("✔ PR landing mode: origin remote configured")
        else:
            print(
                "⚠ Warning: landing=pr but no origin git remote is configured — "
                "the merger cannot push branches until a remote is added. Non-fatal: "
                "setup completed, but the merger will abort PR landing cleanly."
            )

    # --- Watchdog mode & scheduler cadence (ticket 017) -------------------------
    # watchdog.mode "script" (new default): the dashboard server schedules
    # watchdog-check.sh --json every watchdog.intervalSeconds and writes
    # job/watchdog-report.json; the router reads the report each cycle and
    # the LLM watchdog is only invoked on demand for unclassifiable
    # anomalies. watchdog.mode "agent": legacy mode: the router invokes the
    # one-shot watchdog analyst every watchdog.intervalMinutes (nothing loops
    # in the background).
    # The legacy intervalMinutes / stallThresholdMinutes / autoCompactWindow
    # keys are RETAINED (agent-mode cadence; the stall threshold is shared
    # by both modes) — this block is purely additive and never removes them.
    wd_conf = config.setdefault("watchdog", {})
    wd_conf.setdefault("intervalMinutes", 10)
    wd_conf.setdefault("stallThresholdMinutes", 15)
    wd_conf.setdefault("autoCompactWindow", 150000)
    if args.watchdog_mode:
        wd_conf["mode"] = args.watchdog_mode
    else:
        wd_conf.setdefault("mode", "script")
    if args.watchdog_interval is not None:
        if args.watchdog_interval < 1:
            parser.error("--watchdog-interval must be >= 1 second")
        wd_conf["intervalSeconds"] = args.watchdog_interval
    else:
        wd_conf.setdefault("intervalSeconds", 60)
    # ---------------------------------------------------------------------------

    dash_port = config.get("dashboard", {}).get("port", 3080)
    config.setdefault("concurrency", {})["dashboardPort"] = dash_port

    # Token hygiene: the dashboard auth token lives ONLY in the gitignored
    # job/dashboard-auth.json. Strip any token from the tracked config; if a
    # non-empty value was committed there it is considered burned — a NEW
    # token is generated for job/dashboard-auth.json and the old value is
    # never reused.
    tunnel_conf = config.setdefault("dashboard", {}).setdefault("tunnel", {})
    committed_token = str(tunnel_conf.pop("authToken", "") or "")

    job_dir = repo_root / "job"
    job_dir.mkdir(parents=True, exist_ok=True)
    auth_file = job_dir / "dashboard-auth.json"

    existing_job_token = ""
    if auth_file.is_file():
        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                existing_job_token = str(json.load(f).get("authToken", "") or "")
        except Exception:
            existing_job_token = ""

    auth_token = existing_job_token
    rotate = False
    if committed_token:
        rotate = True
    elif args.regenerate_token or not auth_token:
        rotate = True

    if rotate:
        auth_token = secrets.token_hex(16)
    if committed_token:
        print("Token rotated - the previously committed value is considered burned.")

    config_path.parent.mkdir(parents=True, exist_ok=True)
    # Ticket 048: the secrets file is written BEFORE the config, so an interrupted
    # run leaves the inline value in the config and the next run reuses the stored id.
    if notify_moved:
        try:
            write_notify_secrets_file(notify_secrets_path, notify_secrets_doc)
        except OSError as exc:
            print(f"ERROR: cannot write {notify_secrets_path}: {exc.strerror}; the config was not changed", file=sys.stderr)
            sys.exit(1)
        print(
            f"✔ Moved {len(notify_moved)} notification secret(s) into {notify_secrets_path} (mode 0600); "
            "the config keeps references:"
        )
        for moved_line in notify_moved:
            print(f"   - {moved_line}")
        print(
            "   If a commit ever contained these values, they are in git history: rotate them "
            '(TROUBLESHOOTING.md, "Rotating a leaked notification secret").'
        )
    elif notify_secrets_path.is_file() and stat.S_IMODE(os.stat(notify_secrets_path).st_mode) != 0o600:
        try:
            os.chmod(notify_secrets_path, 0o600)
            print(f"✔ Set {notify_secrets_path} permissions to 0600")
        except OSError as exc:
            print(f"WARNING: cannot set {notify_secrets_path} permissions to 0600: {exc.strerror}")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"✔ Configuration saved to {config_path}")

    # Ticket 048: warnings never stop the run and never print a value.
    if notify_secrets_path.exists():
        try:
            ignored = subprocess.run(
                ["git", "-C", str(repo_root), "check-ignore", "-q", "--", "job/notify-secrets.json"],
                capture_output=True,
                check=False,
            )
            if ignored.returncode == 1:
                print(
                    "WARNING: job/notify-secrets.json is not gitignored in this repository: "
                    "add job/ to .gitignore so notification secrets are never committed."
                )
        except OSError:
            pass
    for shaped_path in find_secret_shaped_values(config):
        print(
            f"WARNING: {shaped_path} looks like a notification secret but is not a notifications.providers[] "
            "secret field, so it was not moved: put it in a provider entry (README \"Notifications\") "
            "and re-run apply-setup.py."
        )

    # Ticket 068: record this project's main checkout and warn about port overlaps.
    update_port_registry(repo_root, config)

    # 1. Update .claude/agents/*.md
    claude_agents_dir = repo_root / ".claude" / "agents"
    models_conf = config.get("models", {})
    updated_claude_agents = []

    if claude_agents_dir.is_dir():
        for agent_file in sorted(claude_agents_dir.glob("*.md")):
            agent_name = agent_file.stem
            agent_model_conf = models_conf.get(agent_name, {}).get("claude", {})

            with open(agent_file, "r", encoding="utf-8") as f:
                content = f.read()

            fm, body = parse_frontmatter(content)
            if not fm:
                continue

            if "model" in agent_model_conf:
                fm["model"] = agent_model_conf["model"]
            if "effort" in agent_model_conf:
                fm["effort"] = agent_model_conf["effort"]

            # Ticket 017: the watchdog agent is now an on-demand analyst, not
            # a self-looping background agent, so its frontmatter no longer
            # carries autoCompactWindow tuning (the key stays in the config
            # for agent-mode compatibility).

            new_content = serialize_frontmatter(fm, body)
            with open(agent_file, "w", encoding="utf-8") as f:
                f.write(new_content)
            updated_claude_agents.append(agent_name)

    print(f"✔ Updated {len(updated_claude_agents)} Claude Code agents in {claude_agents_dir}")

    # 2. Generate OpenCode support (.opencode/agents/*.md + opencode.json)
    opencode_agents_dir = repo_root / ".opencode" / "agents"
    opencode_agents_dir.mkdir(parents=True, exist_ok=True)

    opencode_json_agents = {}
    generated_opencode_agents = []

    if claude_agents_dir.is_dir():
        for agent_file in sorted(claude_agents_dir.glob("*.md")):
            agent_name = agent_file.stem
            with open(agent_file, "r", encoding="utf-8") as f:
                content = f.read()
            fm, body = parse_frontmatter(content)

            agent_cfg = models_conf.get(agent_name, {})
            opencode_model_cfg = agent_cfg.get("opencode", {})
            target_model = opencode_model_cfg.get("model", "anthropic/claude-sonnet-4-5")

            mode = "primary" if agent_name == "router" else "subagent"
            steps = int(fm.get("maxTurns", 200))

            opencode_fm = {
                "name": agent_name,
                "description": fm.get("description", f"worker-fleet {agent_name}"),
                "mode": mode,
                "model": target_model,
                "steps": str(steps),
            }
            if "reasoningEffort" in opencode_model_cfg:
                opencode_fm["reasoning_effort"] = opencode_model_cfg["reasoningEffort"]

            target_file = opencode_agents_dir / f"{agent_name}.md"
            with open(target_file, "w", encoding="utf-8") as f:
                f.write(serialize_frontmatter(opencode_fm, body))

            opencode_json_agents[agent_name] = {
                "mode": mode,
                "model": target_model,
                "prompt": f"{{file:.opencode/agents/{agent_name}.md}}",
            }
            generated_opencode_agents.append(agent_name)

    opencode_config = {
        "$schema": "https://opencode.ai/config.json",
        "default_agent": "router",
        "agent": opencode_json_agents,
    }
    opencode_json_path = repo_root / "opencode.json"
    with open(opencode_json_path, "w", encoding="utf-8") as f:
        json.dump(opencode_config, f, indent=2)

    print(f"✔ Generated {len(generated_opencode_agents)} OpenCode agents in {opencode_agents_dir}")
    print(f"✔ Generated OpenCode configuration at {opencode_json_path}")

    # 3. Write dashboard auth file for runtime scripts (single token source)
    with open(auth_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "authToken": auth_token,
                "dashboardPort": dash_port,
                "allowRemoteActions": config.get("dashboard", {}).get("allowRemoteActions", True),
            },
            f,
            indent=2,
        )
    print(f"✔ Synced dashboard credentials to {auth_file}")

    # 4. Make all scripts executable
    scripts_dir = repo_root / ".claude" / "scripts"
    if scripts_dir.is_dir():
        for sfile in scripts_dir.glob("*"):
            if sfile.is_file() and sfile.suffix in [".sh", ".py"]:
                try:
                    st = os.stat(sfile)
                    os.chmod(sfile, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
                except Exception:
                    pass

    print("\n==================================================")
    print(" worker-fleet v3 Multi-Harness Setup Completed!       ")
    print("==================================================")
    print(f" • Target Harness:     {config.get('harness')}")
    print(f" • Model Preset:       {config.get('preset')}")
    print(f" • Max Parallel:       {config.get('concurrency', {}).get('maxParallelWorkers')} workers")
    print(
        f" • Dev Server Ports:   Worker base {config.get('concurrency', {}).get('workerBasePort')}, "
        f"Reproducer {config.get('concurrency', {}).get('reproducerPort')}, "
        f"Main {config.get('concurrency', {}).get('mainPort')}"
    )
    print(f" • Fleet Control:      Port :{dash_port} (Tunnel: {tunnel_conf.get('provider', 'local')})")
    print(
        " • Remote Actions:     "
        f"{'Enabled (PIN-protected)' if config.get('dashboard', {}).get('allowRemoteActions') else 'Read-Only'}"
    )
    print(
        f" • Regression Sweep:   every {config.get('regression', {}).get('everyNMerges', 1)} merge(s) "
        f"({'0 = disabled' if config.get('regression', {}).get('everyNMerges', 1) == 0 else 'auto full mode'})"
    )
    budget_conf = config.get("budget", {}).get("defaults", {})
    print(
        f" • Budget Caps:        ${float(budget_conf.get('usd', 10.0)):.2f} est. cost / "
        f"{int(budget_conf.get('turns', 300))} turns per ticket (enforced)"
    )
    if config.get("harness") == "both":
        print(f" • Cost Rates:         Claude: {cost_per_role_line(config, 'claude')}")
        print(f"                       OpenCode: {cost_per_role_line(config, 'opencode')}")
    else:
        print(f" • Cost Rates:         {cost_per_role_line(config)}")
    print(
        "                       ~ est. only (never an invoice); USD per 1M tokens in/out, "
        "from telemetry.rates in specs/worker-fleet.config.json"
    )
    landing_mode = config.get("landing", "direct")
    print(
        f" • Landing Mode:       {landing_mode} "
        f"({'merge verified tickets straight to main' if landing_mode == 'direct' else 'push branches and open GitHub PRs (tickets wait in in-review)'})"
    )
    wd_summary = config.get("watchdog", {})
    print(
        f" • Watchdog:           {wd_summary.get('mode', 'script')} mode"
        + (
            f" (scheduler every {wd_summary.get('intervalSeconds', 60)}s)"
            if wd_summary.get("mode", "script") == "script"
            else f" (router invokes the analyst every {wd_summary.get('intervalMinutes', 10)} min)"
        )
    )
    notif_types = [p.get("type") for p in config.get("notifications", {}).get("providers", [])]
    print(
        " • Notifications:      "
        + (", ".join(notif_types) + " (secrets in job/notify-secrets.json or env vars, never printed)" if notif_types else "none (add one with --notify-ntfy <topic>)")
    )
    if args.show_token:
        print(f" • Auth Token:         {auth_token} (stored only in job/dashboard-auth.json)")
    else:
        print(f" • Auth Token:         {mask_token(auth_token)} (stored in job/dashboard-auth.json; re-run with --show-token to print it)")
    if not token_looks_generated(auth_token):
        print(" • Token warning:      " + WEAK_TOKEN_WARNING)
    print("==================================================")


if __name__ == "__main__":
    main()

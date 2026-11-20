"""Tests of the Claude runtime (patches/claude-runtime.cjs and the scripts it drives): python -m unittest tests.test_claude_runtime
No network, no model, no real project: `claude` and `opencode` are stubs on PATH, every folder is a temporary one."""
import copy
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
BIN = KIT / "wv-bin"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, BIN / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


STAGE = load("wv_stage_rt", "wv-stage.py")
DISPATCH = load("wv_dispatch_rt", "wv-dispatch.py")

CFG = {
    "models": {
        "router": {"claude": {"model": "sonnet", "effort": "medium"}, "opencode": {"model": "p/router"}},
        "worker": {"claude": {"model": "sonnet", "effort": "high"}, "opencode": {"model": "p/worker"}, "delegateCli": "none"},
        "reviewer": {"claude": {"model": "sonnet"}, "opencode": {"model": "p/rev"}},
        "tester": {"claude": {"model": "sonnet"}, "opencode": {"model": "p/tester"}},
        "planner": {"opencode": {"model": "p/plan"}, "runtime": "claude", "claude": {"model": "sonnet"}},
        "designer": {"runtime": "claude", "claude": {"model": "sonnet"}},
    },
    "concurrency": {},
}
AGENT = "---\nname: %s\ndescription: d\nmodel: %s\neffort: high\n---\n\nbody\nmodel: stays\n"


def server_namespace(root):
    """The server part of the patch (patches/claude-runtime.server.py.txt) executed against a temporary fleet folder."""
    ns = {"re": re, "json": json, "time": time, "Path": Path, "REPO_ROOT": root, "_WV_BASE_ROOT": root,
          "wv_config_path": lambda: root / "specs" / "worker-fleet.config.json", "utc_now_iso": lambda: "2026-01-01T00:00:00Z",
          "wv_claude_account": lambda: {"loggedIn": True, "plan": "max", "method": "claude.ai"}}

    def atomic(path, text):
        Path(path).write_text(text, encoding="utf-8")
    ns["wv_atomic_write"] = atomic
    exec((KIT / "patches" / "claude-runtime.server.py.txt").read_text(encoding="utf-8"), ns)
    return ns


def make_fleet(tmp):
    root = Path(tmp)
    (root / "specs").mkdir(parents=True)
    (root / "job").mkdir()
    (root / "specs" / "worker-fleet.config.json").write_text(json.dumps(CFG, indent=2), encoding="utf-8")
    d = root / ".claude" / "agents"
    d.mkdir(parents=True)
    for n in ("router", "worker", "reviewer", "tester", "wv-planner", "wv-designer", "wv-reviewer"):
        (d / (n + ".md")).write_text(AGENT % (n, "haiku" if n == "tester" else "sonnet"), encoding="utf-8")
    return root


def cfg_of(root):
    return json.loads((root / "specs" / "worker-fleet.config.json").read_text(encoding="utf-8"))


def model_line(root, name):
    return re.search(r"^model:\s*(\S+)", (root / ".claude" / "agents" / (name + ".md")).read_text(encoding="utf-8"), re.M).group(1)


class ConfigMapping(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = make_fleet(self.tmp.name)
        self.ns = server_namespace(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_runtime_defaults(self):
        rt = self.ns["wv_role_runtime"]
        self.assertEqual(rt(CFG, "worker"), "opencode")
        self.assertEqual(rt(CFG, "planner"), "claude")
        self.assertEqual(rt({"models": {"designer": {}}}, "designer"), "claude")
        self.assertEqual(rt({"models": {"worker": {"runtime": "claude"}}}, "worker"), "claude")
        self.assertEqual(rt({"models": {"worker": {"runtime": "bogus"}}}, "worker"), "opencode")

    def test_set_claude_maps_config_and_agent_file(self):
        code, res = self.ns["wv_set_claude"]("tester", "opus")
        self.assertEqual(code, 200)
        t = cfg_of(self.root)["models"]["tester"]
        self.assertEqual((t["runtime"], t["claude"]["model"], t["opencode"]["model"]), ("claude", "opus", "p/tester"))
        self.assertEqual(model_line(self.root, "tester"), "opus")
        self.assertIn("model: stays", (self.root / ".claude" / "agents" / "tester.md").read_text(encoding="utf-8"))  # only the front matter
        self.assertIn(".claude/agents/tester.md", res["changed"])

    def test_reviewer_updates_both_claude_agent_files(self):
        self.ns["wv_set_claude"]("reviewer", "claude-opus-5-5")
        self.assertEqual((model_line(self.root, "reviewer"), model_line(self.root, "wv-reviewer")), ("claude-opus-5-5",) * 2)

    def test_planner_and_designer_use_their_own_agent_files(self):
        self.ns["wv_set_claude"]("designer", "haiku")
        self.assertEqual(model_line(self.root, "wv-designer"), "haiku")
        self.assertEqual(cfg_of(self.root)["models"]["designer"]["claude"]["model"], "haiku")

    def test_bad_input_and_unknown_role(self):
        self.assertEqual(self.ns["wv_set_claude"]("tester", "so net; rm")[0], 400)
        self.assertEqual(self.ns["wv_set_claude"]("Tester", "opus")[0], 400)
        self.assertEqual(self.ns["wv_set_claude"]("nosuchrole", "opus")[0], 404)

    def test_providers_extra_reports_runtime_per_role(self):
        self.ns["wv_set_claude"]("worker", "opus")
        cfg = cfg_of(self.root)
        roles = [{"role": r, "model": "x", "claude": ""} for r in ("worker", "router", "implementer")]
        extra = self.ns["wv_claude_extra"](cfg, roles)
        self.assertEqual({r["role"]: r["runtime"] for r in roles}, {"worker": "claude", "router": "opencode", "implementer": "opencode"})
        self.assertFalse(extra["claudeAll"])
        self.assertIn("sonnet", extra["claudeModels"])
        self.assertEqual(extra["claudeInfo"]["plan"], "max")
        self.assertFalse(extra["claudeBackup"])

    def test_fleet_switch_on_then_exact_restore(self):
        before_cfg = (self.root / "specs" / "worker-fleet.config.json").read_text(encoding="utf-8")
        before_md = {n: model_line(self.root, n) for n in ("router", "worker", "reviewer", "tester", "wv-planner", "wv-designer", "wv-reviewer")}
        code, res = self.ns["wv_claude_fleet"](True, "haiku")
        self.assertEqual(code, 200)
        cfg = cfg_of(self.root)
        for role, v in cfg["models"].items():
            self.assertEqual((v["runtime"], v["claude"]["model"]), ("claude", "haiku"), role)
        self.assertEqual({model_line(self.root, n) for n in before_md}, {"haiku"})
        self.assertTrue((self.root / "job" / "claude-fleet-backup.json").exists())
        self.assertFalse((self.root / "job" / "models-backup.json").exists())  # the free-preset backup is a different file
        extra = self.ns["wv_claude_extra"](cfg, [])
        self.assertTrue(extra["claudeAll"] and extra["claudeBackup"])
        # switching the model again keeps the FIRST backup
        self.ns["wv_claude_fleet"](True, "opus")
        self.assertEqual(model_line(self.root, "router"), "opus")
        code, _ = self.ns["wv_claude_fleet"](False)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads((self.root / "specs" / "worker-fleet.config.json").read_text(encoding="utf-8")), json.loads(before_cfg))
        self.assertEqual({n: model_line(self.root, n) for n in before_md}, before_md)
        self.assertFalse((self.root / "job" / "claude-fleet-backup.json").exists())
        self.assertEqual(self.ns["wv_claude_fleet"](False)[0], 409)  # nothing left to restore

    def test_fleet_switch_rejects_bad_model(self):
        self.assertEqual(self.ns["wv_claude_fleet"](True, "bad model")[0], 400)
        self.assertFalse((self.root / "job" / "claude-fleet-backup.json").exists())


class PatchMechanics(unittest.TestCase):
    """patches/claude-runtime.cjs run on a tiny fixture of the dashboard files: applied once, then idempotent; missing anchors are skipped."""
    SERVER = '''rel.startswith(".opencode/agents/") and rel.endswith(".md")
def wv_set_model(role, model, reload=True):
    if True:
        entry.setdefault("opencode", {})["model"] = model
        wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\\n")
        changed.append("specs/worker-fleet.config.json")
    return {"roles": roles, "backup": (_WV_BASE_ROOT / "job" / "models-backup.json").exists()}
    if action == "wv_set_model":
        return wv_set_model(req.get("role"), req.get("model"))
WV_ACTIONS = ("a", "wv_set_model", "wv_set_implementer", "wv_pause_all")
WV_CLEARS_ISSUE = ("wv_router_restart", "wv_set_model", "x")
def wv_test_claude(model):
    if model not in ("sonnet", "opus", "haiku"):
        return 400, {"error": "Choose sonnet, opus or haiku."}
'''
    HTML = '''<script>
      /* Agents tab: pick the provider, then the model, of every agent (worker first), and the implementer CLI. */
      (function () {
          var usable = connected.filter(function (p) {
            return byProv[p];
          });
              var p = provOf(r.model);
              cnt[p] = (cnt[p] || 0) + 1;
          body.append(intro);
            if (ROLE[r.role]) nm.append(el('small', '', ROLE[r.role][1]));
            var cur = r.model,
              curProv = provOf(cur);
              var o = el('option', '', p + (connected.indexOf(p) < 0 ? '  (not connected)' : ''));
              ms.textContent = '';
              var list = (byProv[ps.value] || []).slice();
              var x = await wvPost({ action: 'wv_set_model', role: r.role, model: ms.value });
              if (x.ok) {
                cur = ms.value;
                curProv = ps.value;
              }
              var x = await wvPost({ action: 'wv_test_model', model: ms.value });
        window.wvAgentsLoad = load;
        add(sel, 'claude', cl.enabled ? 'Review with Claude' : 'Review with Claude (not available)');
</script>'''

    def apply(self, d):
        r = subprocess.run(["node", str(KIT / "patches" / "claude-runtime.cjs")], cwd=d, capture_output=True, text=True)
        return r.stdout

    def test_apply_idempotent_and_skip(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / ".claude" / "scripts").mkdir(parents=True)
            (Path(d) / ".claude" / "dashboard").mkdir(parents=True)
            sp, hp = Path(d) / ".claude" / "scripts" / "dashboard-server.py", Path(d) / ".claude" / "dashboard" / "index.html"
            sp.write_text(self.SERVER, encoding="utf-8")
            hp.write_text(self.HTML, encoding="utf-8")
            out = self.apply(d)
            self.assertIn("server patched", out)
            self.assertIn("page patched", out)
            s, h = sp.read_text(encoding="utf-8"), hp.read_text(encoding="utf-8")
            self.assertIn('entry["runtime"] = "opencode"', s)
            self.assertIn("wv_claude_fleet", s)
            self.assertIn("**wv_claude_extra(cfg, roles)", s)
            self.assertIn("Run everything on Claude", h)
            self.assertIn("wv_test_claude", h)
            self.assertIn("(cl.suggested", h)
            out2 = self.apply(d)
            self.assertIn("already applied", out2)
            self.assertEqual((s, h), (sp.read_text(encoding="utf-8"), hp.read_text(encoding="utf-8")))
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / ".claude" / "scripts").mkdir(parents=True)
            (Path(d) / ".claude" / "scripts" / "dashboard-server.py").write_text("print('nothing to anchor')\n", encoding="utf-8")
            self.assertIn("anchors not found, skipped", self.apply(d))
            self.assertEqual((Path(d) / ".claude" / "scripts" / "dashboard-server.py").read_text(encoding="utf-8"), "print('nothing to anchor')\n")


class DispatcherRuntime(unittest.TestCase):
    def ticket(self, base, header=""):
        d = Path(base) / "specs" / "tickets" / "001-x"
        d.mkdir(parents=True)
        (d / "rd.md").write_text("# T\n\n**Status:** ready\n%s\n\n## Body\n" % header, encoding="utf-8")

    def cfg(self, runtime=None, model=None):
        w = {"opencode": {"model": "p/w"}}
        if runtime:
            w["runtime"] = runtime
        if model:
            w["claude"] = {"model": model}
        return {"models": {"worker": w}}

    def test_config_runtime_claude_uses_claude_path_and_model(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "opus")), ("claude", "opus"))
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude")), ("claude", "sonnet"))

    def test_default_and_opencode_stay_on_opencode(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg()), ("opencode", None))
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("opencode", "opus")), ("opencode", None))
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", {}), ("opencode", None))

    def layer(self, base, settings):
        d = Path(base) / "job" / "stage"
        d.mkdir(parents=True)
        (d / "001.json").write_text(json.dumps({"settings": settings}), encoding="utf-8")

    def test_ticket_layer_wins_both_ways(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.layer(d, {"models": {"worker": {"runtime": "opencode"}}})
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "opus")), ("opencode", None))
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.layer(d, {"models": {"worker": {"runtime": "claude"}}})
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg(None, "opus")), ("claude", "opus"))

    def test_ticket_layer_model_and_disabled_layer(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.layer(d, {"models": {"worker": {"runtime": "claude", "claude": {"model": "haiku"}}}})
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "opus")), ("claude", "haiku"))
        with tempfile.TemporaryDirectory() as d:  # a disabled layer changes nothing
            self.ticket(d)
            self.layer(d, {"enabled": False, "models": {"worker": {"runtime": "claude", "claude": {"model": "haiku"}}}})
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "opus")), ("claude", "opus"))

    def test_rd_headers_no_longer_override_the_settings(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d, "**Worker harness:** claude\n**Worker model:** haiku")
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg()), ("opencode", None))
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d, "**Worker harness:** opencode\n**Worker model:** nvidia/some-model")
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "opus")), ("claude", "opus"))

    def test_only_a_ticket_layer_pins_the_opencode_model(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.assertIsNone(DISPATCH.pinned_model(DISPATCH.settings_for(d, "001-x", self.cfg())))
            self.layer(d, {"models": {"worker": {"opencode": {"model": "nvidia/big"}}}})
            self.assertEqual(DISPATCH.pinned_model(DISPATCH.settings_for(d, "001-x", self.cfg())), "nvidia/big")

    def test_bad_model_value_falls_back(self):
        with tempfile.TemporaryDirectory() as d:
            self.ticket(d)
            self.assertEqual(DISPATCH.worker_runtime(d, "001-x", self.cfg("claude", "x y; z")), ("claude", "sonnet"))


class ReviewOptions(unittest.TestCase):
    def test_claude_runtime_marks_claude_suggested(self):
        cfg = copy.deepcopy(CFG)
        cfg["models"]["reviewer"].update({"runtime": "claude", "claude": {"model": "opus"}})
        o = STAGE.review_options(cfg, True, None, [])
        self.assertTrue(o["claude"]["suggested"])
        self.assertEqual((o["claude"]["model"], o["suggestedBy"]), ("opus", "claude"))
        self.assertFalse(any(m["suggested"] for m in o["models"]))

    def test_opencode_runtime_unchanged(self):
        o = STAGE.review_options(copy.deepcopy(CFG), True, None, [])
        self.assertFalse(o["claude"]["suggested"])
        self.assertEqual(o["suggestedBy"], "model")
        self.assertEqual([m["suggested"] for m in o["models"]].count(True), 1)

    def test_claude_not_signed_in_is_never_suggested(self):
        cfg = copy.deepcopy(CFG)
        cfg["models"]["reviewer"]["runtime"] = "claude"
        self.assertFalse(STAGE.review_options(cfg, False, None, [])["claude"]["suggested"])


def git_bash():
    for p in (os.environ.get("WV_GIT_BASH"), r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
        if p and Path(p).exists():
            return p
    if os.name != "nt":
        return shutil.which("bash")
    return None


@unittest.skipUnless(git_bash() and shutil.which("python3"), "needs bash and python3")
class RouterLoop(unittest.TestCase):
    """router-loop.sh in a scratch HOME and hub with stub `claude`/`opencode` on PATH and stub wv-bin scripts: which one runs, with which flags."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.home, self.hub, self.stubs, self.neutral = t / "home", t / "hub", t / "stubs", t / "neutral"
        for p in (self.home / ".workov", self.home / ".wv-bin", self.hub / "specs", self.hub / "job", self.hub / ".claude" / "scripts",
                  self.hub / ".claude" / "agents", self.hub / ".opencode" / "agents", self.hub / ".opencode" / "plugins", self.stubs, self.neutral):
            p.mkdir(parents=True)
        shutil.copy(KIT / "overlay" / ".claude" / "scripts" / "router-loop.sh", self.hub / ".claude" / "scripts" / "router-loop.sh")
        (self.hub / ".claude" / "agents" / "router.md").write_text(AGENT % ("router", "sonnet"), encoding="utf-8")
        (self.hub / "opencode.json").write_text("{}", encoding="utf-8")
        (self.home / ".workov" / "hub.json").write_text(json.dumps({"root": str(self.hub).replace("\\", "/")}), encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.hub)], check=True)
        for n in ("wv-sessions", "wv-gate", "wv-plan", "wv-settle", "wv-busy", "wv-stop", "wv-dispatch", "wv-adopt"):
            (self.home / ".wv-bin" / (n + ".py")).write_text("", encoding="utf-8")
        # wv-turn: the first `cycles` calls pick a project, then stop
        (self.home / ".wv-bin" / "wv-turn.py").write_text(
            "import os, sys\nf = os.path.join(os.path.dirname(__file__), 'turns')\nn = int(open(f).read()) if os.path.exists(f) else 0\nopen(f, 'w').write(str(n + 1))\n"
            "print('run\\tproj\\t%s' % os.environ['PROJ_ROOT'] if n < int(os.environ['CYCLES']) else 'idle')\n", encoding="utf-8")
        self.calls = t / "calls.txt"
        (self.stubs / "opencode").write_text('#!/usr/bin/env bash\necho "opencode $*" >> "$CALLS"\n', encoding="utf-8")
        (self.stubs / "claude").write_text(
            '#!/usr/bin/env bash\necho "claude $*" >> "$CALLS"\n'
            'if [ "${CLAUDE_FAIL:-0}" = 1 ]; then echo "usage limit reached" >&2; exit 1; fi\n'
            'echo \'{"type":"system","subtype":"init","session_id":"sess-1"}\'\n'
            'echo \'{"type":"assistant","session_id":"sess-1","message":{"content":[{"type":"text","text":"reconciled one project"},{"type":"tool_use","name":"Read","input":{"file_path":"job/router-state.json"}}]}}\'\n'
            'echo \'{"type":"result","subtype":"success","is_error":false,"result":"cycle ok","num_turns":2,"session_id":"sess-1"}\'\n', encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def run_loop(self, runtime, cycles=2, fail=False):
        cfg = copy.deepcopy(CFG)
        cfg["models"]["router"]["runtime"] = runtime
        cfg["models"]["router"]["claude"]["model"] = "opus"
        (self.hub / "specs" / "worker-fleet.config.json").write_text(json.dumps(cfg), encoding="utf-8")
        env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home), WV_ROUTER_HOME=str(self.neutral), WV_ROUTER_INTERVAL="1",
                   CALLS=str(self.calls), CYCLES=str(cycles), PROJ_ROOT=str(self.hub).replace("\\", "/"), CLAUDE_FAIL="1" if fail else "0",
                   PATH=str(self.stubs) + os.pathsep + os.environ.get("PATH", ""))
        r = subprocess.run([git_bash(), ".claude/scripts/router-loop.sh"], cwd=str(self.hub), env=env, capture_output=True, text=True, timeout=120)
        calls = self.calls.read_text(encoding="utf-8").splitlines() if self.calls.exists() else []
        return r.stdout + r.stderr, calls

    def test_claude_runtime_runs_claude_not_opencode(self):
        out, calls = self.run_loop("claude")
        self.assertEqual([c.split()[0] for c in calls], ["claude", "claude"], out)
        self.assertIn("--agent router --model opus", calls[0])
        self.assertIn("--permission-mode auto", calls[0])
        self.assertIn("--strict-mcp-config", calls[0])
        self.assertNotIn("--resume", calls[0])
        self.assertIn("--resume sess-1", calls[1])  # the second cycle continues the session
        self.assertIn("router on Claude (opus)", out)
        self.assertIn("router: reconciled one project", out)
        self.assertIn("claude cycle done: cycle ok", out)
        self.assertEqual((self.neutral / "job" / "router-claude-session").read_text(encoding="utf-8"), "sess-1")
        self.assertTrue((self.neutral / ".claude" / "agents" / "router.md").exists())

    def test_opencode_runtime_is_untouched(self):
        out, calls = self.run_loop("opencode", cycles=1)
        self.assertEqual([c.split()[0] for c in calls], ["opencode"], out)
        self.assertIn("run --auto --agent router", calls[0])
        self.assertNotIn("router on Claude", out)

    def test_claude_failure_fails_soft(self):
        started = time.time()
        out, calls = self.run_loop("claude", cycles=2, fail=True)
        self.assertEqual(len(calls), 2, out)
        self.assertIn("claude cycle failed", out.replace("Claude router cycle failed", "claude cycle failed"))
        self.assertIn("usage limit reached", out)
        self.assertFalse((self.neutral / "job" / "router-claude-session").exists())
        self.assertGreaterEqual(time.time() - started, 2)  # it waited between the retries, it did not loop hot


if __name__ == "__main__":
    unittest.main()

"""Unit tests of the settings resolver (wv-bin/wv-settings.py): python -m unittest tests.test_settings_layers  (no network, no real project)."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "wv-bin"
_s = importlib.util.spec_from_file_location("wv_settings", BIN / "wv-settings.py")
W = importlib.util.module_from_spec(_s)
_s.loader.exec_module(W)

GLOBAL = {"harness": "opencode", "dashboard": {"port": 3080},
          "models": {"worker": {"claude": {"model": "sonnet", "effort": "high"},
                                "opencode": {"model": "nvidia/ultra", "fallbacks": ["a", "b"]}},
                     "reviewer": {"opencode": {"model": "nvidia/ultra"}}}}


class Resolve(unittest.TestCase):
    def r(self, project=None, ticket=None, kit=None):
        return W.resolve(GLOBAL, project, ticket, kit={} if kit is None else kit)

    def test_global_only(self):
        res = self.r()
        self.assertEqual(W.get(res, "models.worker.opencode.model"), "nvidia/ultra")
        self.assertEqual(res["sources"]["models.worker.opencode.model"], "global")

    def test_precedence_ticket_over_project_over_global(self):
        res = self.r({"models": {"worker": {"opencode": {"model": "project/m"}}}}, {"models": {"worker": {"opencode": {"model": "ticket/m"}}}})
        self.assertEqual(W.get(res, "models.worker.opencode.model"), "ticket/m")
        self.assertEqual(res["sources"]["models.worker.opencode.model"], "ticket")
        res = self.r({"models": {"worker": {"opencode": {"model": "project/m"}}}})
        self.assertEqual(res["sources"]["models.worker.opencode.model"], "project")

    def test_partial_override_keeps_the_rest_and_its_source(self):
        res = self.r({"models": {"worker": {"claude": {"model": "opus"}}}})
        self.assertEqual(W.get(res, "models.worker.claude.model"), "opus")
        self.assertEqual(W.get(res, "models.worker.claude.effort"), "high")
        self.assertEqual(res["sources"]["models.worker.claude.effort"], "global")
        self.assertEqual(W.get(res, "models.reviewer.opencode.model"), "nvidia/ultra")

    def test_lists_replace_whole(self):
        res = self.r({"models": {"worker": {"opencode": {"fallbacks": ["c"]}}}})
        self.assertEqual(W.get(res, "models.worker.opencode.fallbacks"), ["c"])

    def test_disabled_and_missing_layers_are_skipped(self):
        off = {"enabled": False, "models": {"worker": {"opencode": {"model": "x/y"}}}}
        for layer in (off, None, "junk", []):
            self.assertEqual(W.get(self.r(layer, layer), "models.worker.opencode.model"), "nvidia/ultra")

    def test_enabled_flag_is_not_a_setting(self):
        res = self.r({"enabled": True, "harness": "claude"})
        self.assertEqual(W.get(res, "harness"), "claude")
        self.assertNotIn("enabled", res["effective"])
        self.assertNotIn("project.enabled", res["sources"])

    def test_process_wide_keys_cannot_be_layered(self):
        res = self.r({"dashboard": {"port": 9999}, "harness": "claude"}, {"keystore": {"x": 1}})
        self.assertEqual(res["effective"]["dashboard"]["port"], 3080)
        self.assertEqual(res["ignored"], ["project: dashboard", "ticket: keystore"])
        self.assertEqual(W.get(res, "harness"), "claude")

    def test_kit_defaults_sit_under_global(self):
        kit = {"approvals": {"mode": "auto"}, "models": {"worker": {"opencode": {"model": "kit/m"}}}}
        res = self.r(kit=kit)
        self.assertEqual(W.get(res, "approvals.mode"), "auto")
        self.assertEqual(res["sources"]["approvals.mode"], "kit")
        self.assertEqual(W.get(res, "models.worker.opencode.model"), "nvidia/ultra")

    def test_inputs_are_not_changed(self):
        before = json.dumps(GLOBAL, sort_keys=True)
        layer = {"models": {"worker": {"opencode": {"fallbacks": ["z"]}}}}
        self.r(layer)
        self.assertEqual(json.dumps(GLOBAL, sort_keys=True), before)
        self.assertEqual(layer, {"models": {"worker": {"opencode": {"fallbacks": ["z"]}}}})

    def test_get_default(self):
        self.assertEqual(W.get(self.r(), "models.nobody.model", "dflt"), "dflt")


class Load(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.hub, self.base = self.root / "hub", self.root / "proj"
        (self.hub / "specs").mkdir(parents=True)
        (self.base / "job" / "stage").mkdir(parents=True)
        (self.hub / "specs" / "worker-fleet.config.json").write_text(json.dumps(GLOBAL), encoding="utf-8")
        (self.hub / "specs" / "projects.json").write_text(json.dumps({"projects": [
            {"name": "admin-panel", "root": str(self.base), "fleet": {"settings": {"enabled": True, "models": {"worker": {"runtime": "claude"}}}}},
            {"name": "other", "fleet": {"settings": {"harness": "claude"}}}]}), encoding="utf-8")
        (self.base / "job" / "stage" / "012.json").write_text(json.dumps({"settings": {"models": {"worker": {"claude": {"model": "opus"}}}}}), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_all_three_layers_from_disk(self):
        res = W.load(self.hub, "admin-panel", self.base, "012")
        self.assertEqual(res["sources"]["models.worker.runtime"], "project")
        self.assertEqual(W.get(res, "models.worker.claude.model"), "opus")
        self.assertEqual(res["sources"]["models.worker.claude.model"], "ticket")
        self.assertEqual(W.get(res, "models.worker.opencode.model"), "nvidia/ultra")

    def test_ticket_slug_and_unknown_project_and_missing_files(self):
        self.assertEqual(W.get(W.load(self.hub, "admin-panel", self.base, "012-build-session"), "models.worker.claude.model"), "opus")
        unknown = W.load(self.hub, "nope", self.base, "999")
        self.assertEqual((W.get(unknown, "models.worker.runtime"), unknown["sources"]["models.worker.runtime"]), ("opencode", "kit"))
        self.assertEqual(W.load(self.root / "missing")["sources"]["models.worker.runtime"], "kit")

    def test_project_found_by_root_too(self):
        self.assertEqual(W.get(W.load(self.hub, str(self.base)), "models.worker.runtime"), "claude")

    def test_project_root_matches_despite_slash_style(self):
        self.assertEqual(W.get(W.load(self.hub, str(self.base).replace("\\", "/")), "models.worker.runtime"), "claude")

    def test_cli_key(self):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = W.main(["resolve", "--hub", str(self.hub), "--project", "admin-panel", "--base", str(self.base), "--ticket", "012", "--key", "models.worker.claude.model"])
        self.assertEqual((code, out.getvalue().strip()), (0, "opus"))


if __name__ == "__main__":
    unittest.main()

"""Unit tests of the settings migration (wv-bin/wv-migrate-settings.py): python -m unittest tests.test_migrate_settings"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "wv-bin"
_s = importlib.util.spec_from_file_location("wv_migrate_settings", BIN / "wv-migrate-settings.py")
M = importlib.util.module_from_spec(_s)
_s.loader.exec_module(M)
M.HOME = Path(tempfile.mkdtemp())  # backups go to a scratch folder, never to the real home

HUB_CFG = {"models": {"worker": {"opencode": {"model": "nvidia/ultra"}, "claude": {"model": "sonnet"}}}, "dashboard": {"port": 3080}}
RD = "# T\n\n**Status:** ready\n**Branch:** off main · **Date:** 2026-11-19 · **Worker harness:** claude\n**Worker model:** haiku\n\n## Body\ntext\n"


class Migrate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = Path(self.tmp.name)
        self.hub, self.proj, self.reg = r / "hub", r / "proj", r / "fleets.json"
        (self.hub / "specs").mkdir(parents=True)
        (self.hub / "specs" / "worker-fleet.config.json").write_text(json.dumps(HUB_CFG), encoding="utf-8")
        (self.proj / "specs" / "tickets" / "001-a").mkdir(parents=True)
        (self.proj / "specs" / "tickets" / "002-b").mkdir(parents=True)
        (self.proj / "specs" / "tickets" / "001-a" / "rd.md").write_text(RD, encoding="utf-8")
        (self.proj / "specs" / "tickets" / "002-b" / "rd.md").write_text(RD, encoding="utf-8")
        (self.proj / "specs" / "tickets" / "BOARD.md").write_text("| # | Title | Status | Mode | Runs |\n| --- | --- | --- | --- | --- |\n| 001 | a | todo | solo | alongside |\n| 002 | b | done | solo | alongside |\n", encoding="utf-8")
        (self.proj / "specs" / "worker-fleet.config.json").write_text(json.dumps(HUB_CFG), encoding="utf-8")
        self.reg.write_text(json.dumps([{"name": "p", "root": str(self.proj)}]), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_changes_nothing(self):
        before = (self.proj / "specs" / "tickets" / "001-a" / "rd.md").read_text(encoding="utf-8")
        lines = M.run(self.hub, self.reg, False)
        self.assertTrue(any("ticket p/001" in l for l in lines))
        self.assertEqual((self.proj / "specs" / "tickets" / "001-a" / "rd.md").read_text(encoding="utf-8"), before)
        self.assertFalse((self.proj / "job").exists())

    def test_header_moves_into_the_ticket_layer_and_is_removed(self):
        M.run(self.hub, self.reg, True)
        layer = json.loads((self.proj / "job" / "stage" / "001.json").read_text(encoding="utf-8"))["settings"]
        self.assertEqual(layer, {"enabled": True, "models": {"worker": {"runtime": "claude", "claude": {"model": "haiku"}}}})
        text = (self.proj / "specs" / "tickets" / "001-a" / "rd.md").read_text(encoding="utf-8")
        self.assertNotIn("Worker harness", text)
        self.assertNotIn("Worker model", text)
        self.assertIn("**Branch:** off main · **Date:** 2026-11-19", text)
        self.assertIn("## Body\ntext", text)

    def test_done_tickets_keep_their_history(self):
        M.run(self.hub, self.reg, True)
        self.assertIn("Worker harness", (self.proj / "specs" / "tickets" / "002-b" / "rd.md").read_text(encoding="utf-8"))
        self.assertFalse((self.proj / "job" / "stage" / "002.json").exists())

    def test_second_run_is_a_no_op(self):
        M.run(self.hub, self.reg, True)
        self.assertEqual(M.run(self.hub, self.reg, True), [])

    def test_identical_project_config_adds_no_layer(self):
        M.run(self.hub, self.reg, True)
        self.assertFalse((self.hub / "specs" / "projects.json").exists())

    def test_differing_project_config_becomes_a_disabled_layer(self):
        cfg = json.loads(json.dumps(HUB_CFG))
        cfg["models"]["worker"]["opencode"]["model"] = "other/model"
        cfg["dashboard"]["port"] = 9999  # not layerable: ignored
        (self.proj / "specs" / "worker-fleet.config.json").write_text(json.dumps(cfg), encoding="utf-8")
        M.run(self.hub, self.reg, True)
        row = json.loads((self.hub / "specs" / "projects.json").read_text(encoding="utf-8"))["projects"][0]
        self.assertEqual(row["fleet"]["settings"], {"enabled": False, "models": {"worker": {"opencode": {"model": "other/model"}}}})


if __name__ == "__main__":
    unittest.main()

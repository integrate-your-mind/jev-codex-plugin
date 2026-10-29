"""Synthetic rendering checks; never a benchmark result."""

import json
import tempfile
import unittest
from pathlib import Path

from plot import render


def synthetic_report():
    arms = {}
    for arm, fixes in (("plugin-off", 1), ("cheap", None), ("plugin-on", 2)):
        arms[arm] = {
            "assigned": 2,
            "completed": 1,
            "sourceValidCompleted": 1,
            "verifiedFixes": fixes,
            "elapsedMs": 42000,
            "fullTimePerFixMs": None,
            "fixBounds": {"lower": 1 if fixes is not None else 0, "upper": 2},
            "codingUsd": None,
            "jevUsd": None,
            "costComplete": False,
            "approvals": 1,
            "consultations": 0,
            "deliveries": 0,
            "uptake": {"observed": 0, "ignored": 0, "unknown": 1},
            "curve": None,
        }
    arms["plugin-off"]["curve"] = [{"elapsedMs": 10000, "fixes": 0}, {"elapsedMs": 42000, "fixes": 1}]
    arms["plugin-on"]["curve"] = [{"elapsedMs": 42000, "fixes": 2}]
    return {
        "schemaVersion": "whole-plugin-report-v1",
        "studyId": "SYNTHETIC-DO-NOT-REPORT",
        "phase": "interim",
        "attempted": 3,
        "completed": 2,
        "sourceValidCompleted": 2,
        "pending": 1,
        "byArm": arms,
        "paired": [{
            "taskId": "SYNTHETIC-task",
            "arms": {
                "plugin-off": {"status": "graded", "verdict": "verified-fix"},
                "cheap": {"status": "pending", "verdict": None},
                "plugin-on": {"status": "graded", "verdict": "not-fixed"},
            },
        }],
        "limitations": ["Synthetic fixture only"],
    }


class PlotRenderingTest(unittest.TestCase):
    def test_renders_four_svg_png_pairs_with_unknown_and_pending_context(self):
        with tempfile.TemporaryDirectory(prefix="whole-plugin-plot-test-") as temp:
            root = Path(temp)
            report_path = root / "synthetic-report.json"
            report_path.write_text(json.dumps(synthetic_report()), encoding="utf-8")
            output = root / "plots"
            files = render(report_path, output)
            self.assertEqual(len(files), 8)
            for path in files:
                self.assertTrue(path.is_file())
                self.assertGreater(path.stat().st_size, 500)
            for path in output.glob("*.png"):
                self.assertEqual(path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            fixes_svg = (output / "verified-fixes.svg").read_text(encoding="utf-8")
            self.assertIn("1 pending/invalid", fixes_svg)
            self.assertIn("unknown/1", fixes_svg)
            curves_svg = (output / "cumulative-fixes.svg").read_text(encoding="utf-8")
            self.assertIn("Pending elapsed is unknown", curves_svg)
            cost_svg = (output / "cost-approvals-uptake.svg").read_text(encoding="utf-8")
            self.assertIn("unknown stays unknown", cost_svg)
            self.assertIn("Subscription capacity is not dollars", cost_svg)

    def test_rejects_wrong_report_schema(self):
        with tempfile.TemporaryDirectory(prefix="whole-plugin-plot-test-") as temp:
            root = Path(temp)
            report_path = root / "bad.json"
            report_path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "schemaVersion"):
                render(report_path, root / "plots")

    def test_no_scored_curve_is_reported_without_inventing_a_plateau(self):
        report = synthetic_report()
        for data in report["byArm"].values():
            data["curve"] = None
        with tempfile.TemporaryDirectory(prefix="whole-plugin-plot-test-") as temp:
            root = Path(temp)
            report_path = root / "synthetic-report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            output = root / "plots"
            render(report_path, output)
            svg = (output / "cumulative-fixes.svg").read_text(encoding="utf-8")
            self.assertIn("No scored observations; no performance curve", svg)


if __name__ == "__main__":
    unittest.main()

"""Synthetic rendering checks; never a benchmark result."""

import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from plot import render

WORK = Path(__file__).resolve().parents[3] / ".agent-work" / "whole-plugin-plot-tests"
WORK.mkdir(parents=True, exist_ok=True)


def synthetic_report():
    arms = []
    for arm, fixes in (("plugin-off", 1), ("cheap", 0), ("plugin-on", 1)):
        arms.append({
            "id": arm, "assigned": 1, "completed": 1, "pending": 5,
            "invalid": 0, "verifiedFixes": fixes, "fixRate": fixes,
            "elapsedMs": 42000, "timePerVerifiedFixMs": 42000 if fixes else None,
            "codingUsd": None, "jevUsd": 0.02 if arm == "plugin-on" else 0,
            "billingComplete": False, "approvals": 0, "failedPublicCycles": 1,
            "consultations": 1 if arm == "plugin-on" else 0,
            "providerRequests": 1 if arm == "plugin-on" else 0,
            "providerRequestUnknown": 0, "adviceDelivered": 1 if arm == "plugin-on" else 0,
            "uptakeObserved": 0, "uptakeIgnored": 0, "uptakeUnknown": 1 if arm == "plugin-on" else 0,
        })
    return {
        "schemaVersion": "whole-plugin-report-v1", "studyId": "SYNTHETIC-DO-NOT-REPORT",
        "asOf": "2026-10-28T00:00:00Z", "plannedAttempts": 18,
        "completedAttempts": 3, "pendingAttempts": 15, "invalidAttempts": 0,
        "halted": False, "arms": arms,
        "curves": {arm: [{"elapsedMs": 42000, "verifiedFixes": 1 if arm != "cheap" else 0}] for arm in ("plugin-off", "cheap", "plugin-on")},
        "paired": [{"taskId": "SYNTHETIC-task", "conditions": {"plugin-off": "verified-fix", "cheap": "not-fixed", "plugin-on": "pending"}}],
        "interpretation": {"verdict": "inconclusive", "reason": "Synthetic fixture only"},
    }


class PlotRenderingTest(unittest.TestCase):
    def test_renders_four_svg_png_pairs_with_percentages_and_unknown_billing(self):
        with tempfile.TemporaryDirectory(prefix="render-", dir=WORK) as temp:
            root = Path(temp)
            path = root / "synthetic.json"
            path.write_text(json.dumps(synthetic_report()), encoding="utf-8")
            files = render(path, root / "plots")
            self.assertEqual(len(files), 8)
            for file in files:
                self.assertTrue(file.is_file())
                self.assertGreater(file.stat().st_size, 500)
                if file.suffix == ".png":
                    self.assertEqual(file.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
                else:
                    self.assertTrue(ET.parse(file).getroot().tag.endswith("}svg"))
                    self.assertFalse(any(line.endswith((b" ", b"\t")) for line in file.read_bytes().splitlines()))
            fixes = (root / "plots" / "verified-fixes.svg").read_text()
            self.assertIn("1/1 (100%)", fixes)
            self.assertIn("5 pending; 0 invalid", fixes)
            self.assertIn("3/18 completed; 15 pending; 0 invalid", fixes)
            paired = (root / "plots" / "paired-outcomes.svg").read_text()
            self.assertIn("Pending", paired)
            cost = (root / "plots" / "cost-approvals-uptake.svg").read_text()
            self.assertIn("Coding unknown", cost)
            self.assertIn("Subscription usage is not cash savings", cost)
            self.assertIn("Repeated failed checks", cost)

    def test_rejects_wrong_schema_and_missing_arms(self):
        with tempfile.TemporaryDirectory(prefix="invalid-", dir=WORK) as temp:
            path = Path(temp) / "bad.json"
            for report, error in (({}, "schemaVersion"), ({"schemaVersion": "whole-plugin-report-v1", "arms": []}, "arms")):
                path.write_text(json.dumps(report))
                with self.assertRaisesRegex(ValueError, error):
                    render(path, Path(temp) / "plots")

    def test_lower_bound_timing_is_explicit_on_every_chart_and_invalid_only_has_no_curve(self):
        report = synthetic_report()
        report["halted"] = True
        report["arms"][1].update({"elapsedTimeCoverage": "lower-bound", "completed": 0, "invalid": 1})
        report["curves"] = {"cheap": [{"elapsedMs": 100, "verifiedFixes": 0}]}
        with tempfile.TemporaryDirectory(prefix="lower-bound-", dir=WORK) as temp:
            path = Path(temp) / "synthetic.json"
            path.write_text(json.dumps(report))
            render(path, Path(temp) / "plots")
            for name in ("verified-fixes", "cumulative-fixes", "paired-outcomes", "cost-approvals-uptake"):
                svg = (Path(temp) / "plots" / f"{name}.svg").read_text()
                self.assertIn("Elapsed time is a measured lower bound; pre-launch timing is unknown", svg)
                self.assertIn("HALTED / integrity failure", svg)
            curve = (Path(temp) / "plots" / "cumulative-fixes.svg").read_text()
            self.assertIn("No scored observations; no performance curve", curve)
            self.assertNotIn("Cheap retrieval", curve)

    def test_linked_continuation_caption_is_explicit_without_claiming_child_halted(self):
        report = synthetic_report()
        report["continuation"] = {"schemaVersion": "whole-plugin-continuation-report-v1", "importedAttempts": 2, "continuationAttemptLimit": 16, "parentHalted": True, "independentStudy": False}
        report["arms"][0]["elapsedTimeCoverage"] = "lower-bound"
        with tempfile.TemporaryDirectory(prefix="continuation-", dir=WORK) as temp:
            path = Path(temp) / "synthetic.json"
            path.write_text(json.dumps(report))
            render(path, Path(temp) / "plots")
            for name in ("verified-fixes", "cumulative-fixes", "paired-outcomes", "cost-approvals-uptake"):
                svg = (Path(temp) / "plots" / f"{name}.svg").read_text()
                self.assertIn("Linked continuation: 2 imported attempts; 16 new attempts maximum; parent halted. Not an independent full comparison.", svg)
                self.assertIn("Elapsed time is a measured lower bound; pre-launch timing is unknown", svg)
                self.assertNotIn("HALTED / integrity failure", svg)

    def test_no_scored_curve_or_completed_result_is_invented(self):
        report = synthetic_report()
        report["curves"] = {}
        for arm in report["arms"]:
            arm["completed"] = 0
            arm["verifiedFixes"] = 0
        with tempfile.TemporaryDirectory(prefix="unscored-", dir=WORK) as temp:
            path = Path(temp) / "synthetic.json"
            path.write_text(json.dumps(report))
            render(path, Path(temp) / "plots")
            curve = (Path(temp) / "plots" / "cumulative-fixes.svg").read_text()
            self.assertIn("No scored observations; no performance curve", curve)
            fixes = (Path(temp) / "plots" / "verified-fixes.svg").read_text()
            self.assertIn("No completed result", fixes)
            self.assertNotIn("0/0", fixes)


if __name__ == "__main__":
    unittest.main()

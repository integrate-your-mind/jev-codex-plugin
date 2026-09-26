from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from runtime import (
    PINNED_CODEX_VERSION,
    PINNED_EFFORT,
    PINNED_MODEL,
    PluginValueCodex,
)


class PluginValueCodexTests(unittest.TestCase):
    def make_agent(self, **overrides):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        values = {
            "logs_dir": Path(temp.name),
            "model_name": PINNED_MODEL,
            "arm": "baseline",
            "version": PINNED_CODEX_VERSION,
            "reasoning_effort": PINNED_EFFORT,
        }
        values.update(overrides)
        return PluginValueCodex(**values)

    def test_task_network_allowlist_is_empty(self):
        self.assertEqual(self.make_agent().network_allowlist().domains, [])

    def test_fixed_model_and_version_are_enforced(self):
        with self.assertRaisesRegex(ValueError, "model_name"):
            self.make_agent(model_name="other")
        with self.assertRaisesRegex(ValueError, "Codex version"):
            self.make_agent(version="0.154.0")
        with self.assertRaisesRegex(ValueError, "reasoning_effort"):
            self.make_agent(reasoning_effort="high")

    def test_preflight_boolean_is_strict(self):
        self.assertTrue(self.make_agent(preflight_only="true").preflight_only)
        with self.assertRaisesRegex(ValueError, "preflight_only"):
            self.make_agent(preflight_only="sometimes")


if __name__ == "__main__":
    unittest.main()

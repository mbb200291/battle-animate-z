import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "battle-of-waterloo.json"
SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"


class BattleAnimationMvpContractTest(unittest.TestCase):
    def test_waterloo_example_validates_with_cli(self):
        result = subprocess.run(
            [sys.executable, "-m", "battle_animation.validator", str(EXAMPLE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("valid", result.stdout)

    def test_schema_contains_required_event_types(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        event_type = schema["$defs"]["EventType"]["enum"]

        self.assertEqual(
            event_type,
            [
                "advance",
                "retreat",
                "attack",
                "defend",
                "capture",
                "surrender",
                "reinforcement",
                "bombardment",
                "landing",
                "other",
            ],
        )

    def test_example_separates_history_from_animation_hints(self):
        battle = json.loads(EXAMPLE.read_text(encoding="utf-8"))

        self.assertIn("historical_events", battle)
        self.assertIn("animation_hints", battle)
        self.assertNotIn("camera", battle["historical_events"][0])
        self.assertNotIn("confidence", battle["animation_hints"]["style"])

    def test_static_app_has_expected_entrypoints(self):
        index = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")

        self.assertIn("Battle Animator", index)
        self.assertIn("examples/battle-of-waterloo.json", index)
        self.assertIn("renderBattle", animate)
        self.assertIn("playTimeline", animate)


if __name__ == "__main__":
    unittest.main()

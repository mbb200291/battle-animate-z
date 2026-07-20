import json
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path

from battle_animation.validator import validate_document


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "battle-of-waterloo.json"
YALU_EXAMPLE = ROOT / "examples" / "battle-of-甲午海戰.json"
SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"


class BattleAnimationMvpContractTest(unittest.TestCase):
    def _valid_v030_document(self):
        document = deepcopy(json.loads(EXAMPLE.read_text(encoding="utf-8")))
        document["schema_version"] = "0.3.0"
        movement = document["movements"][0]
        movement["path"]["coordinates"] = movement["path"]["coordinates"][:2]
        movement["time"] = {
            "label": "18 June 1815, noon",
            "start": "1815-06-18T12:00:00Z",
            "precision": "hour",
            "confidence": 0.8,
        }
        movement["waypoint_times"] = ["1815-06-18T12:00:00Z", "1815-06-18T12:10:00Z"]
        timeline = document["animation_hints"]["timeline"]
        timeline["historical_seconds_per_playback_second"] = 60
        timeline["idle_compression_threshold_seconds"] = 0
        timeline["idle_compressed_duration_ms"] = 0
        return document

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

    def test_schema_declares_v030_movement_timing(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertIn("0.3.0", schema["properties"]["schema_version"]["enum"])
        movement = schema["$defs"]["Movement"]["properties"]
        self.assertEqual(movement["time"], {"$ref": "#/$defs/DateValue"})
        self.assertEqual(movement["waypoint_times"]["minItems"], 2)
        self.assertEqual(movement["waypoint_times"]["items"]["type"], "string")
        timeline = schema["$defs"]["AnimationHints"]["properties"]["timeline"]["properties"]
        self.assertEqual(timeline["historical_seconds_per_playback_second"]["type"], "number")
        self.assertEqual(timeline["historical_seconds_per_playback_second"]["exclusiveMinimum"], 0)
        self.assertEqual(timeline["idle_compression_threshold_seconds"]["type"], "number")
        self.assertEqual(timeline["idle_compression_threshold_seconds"]["minimum"], 0)
        self.assertEqual(timeline["idle_compressed_duration_ms"]["type"], "number")
        self.assertEqual(timeline["idle_compressed_duration_ms"]["minimum"], 0)

    def test_python_types_declare_v030_fields(self):
        source = (ROOT / "battle_animation" / "types.py").read_text(encoding="utf-8")
        self.assertIn('Literal["0.1.0", "0.2.0", "0.3.0"]', source)
        self.assertIn("time: NotRequired[DateValue]", source)
        self.assertIn("waypoint_times: NotRequired[list[str]]", source)
        self.assertIn("historical_seconds_per_playback_second: float", source)
        self.assertIn("idle_compression_threshold_seconds: float", source)
        self.assertIn("idle_compressed_duration_ms: float", source)

    def test_validator_accepts_v030_movement_and_timeline_timing(self):
        self.assertEqual(validate_document(self._valid_v030_document()), [])

    def test_validator_rejects_zero_historical_seconds_per_playback_second(self):
        document = self._valid_v030_document()
        document["animation_hints"]["timeline"]["historical_seconds_per_playback_second"] = 0

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.animation_hints.timeline.historical_seconds_per_playback_second"
                and error.message == "expected value > 0"
                for error in errors
            )
        )

    def test_validator_rejects_negative_idle_timing_fields(self):
        for field in ("idle_compression_threshold_seconds", "idle_compressed_duration_ms"):
            with self.subTest(field=field):
                document = self._valid_v030_document()
                document["animation_hints"]["timeline"][field] = -1

                errors = validate_document(document)

                self.assertTrue(
                    any(
                        error.path == f"$.animation_hints.timeline.{field}"
                        and error.message == "expected value >= 0"
                        for error in errors
                    )
                )

    def test_validator_rejects_too_few_waypoint_times(self):
        document = self._valid_v030_document()
        document["movements"][0]["waypoint_times"] = ["1815-06-18T12:00:00Z"]

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.movements[0].waypoint_times"
                and error.message == "expected at least 2 items"
                for error in errors
            )
        )

    def test_validator_rejects_non_string_waypoint_time(self):
        document = self._valid_v030_document()
        document["movements"][0]["waypoint_times"][1] = 1815

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.movements[0].waypoint_times[1]"
                and error.message == "expected string, got int"
                for error in errors
            )
        )

    def test_validator_rejects_malformed_movement_time(self):
        document = self._valid_v030_document()
        del document["movements"][0]["time"]["label"]

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.movements[0].time"
                and error.message == "missing required property 'label'"
                for error in errors
            )
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

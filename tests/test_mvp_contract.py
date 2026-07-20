import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from battle_animation.validator import validate_document, validate_document_with_warnings


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "battle-of-waterloo.json"
YALU_EXAMPLE = ROOT / "examples" / "battle-of-甲午海戰.json"
SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"


class BattleAnimationMvpContractTest(unittest.TestCase):
    def _minimal_timed_document(self):
        document = deepcopy(json.loads(EXAMPLE.read_text(encoding="utf-8")))
        document["schema_version"] = "0.3.0"
        movement = document["movements"][0]
        movement["path"]["coordinates"] = movement["path"]["coordinates"][:2]
        movement["time"] = {
            "label": "10:00–10:10",
            "start": "1815-06-18T10:00:00Z",
            "end": "1815-06-18T10:10:00Z",
            "precision": "range",
            "confidence": 0.5,
        }
        movement["waypoint_times"] = ["1815-06-18T10:00:00Z", "1815-06-18T10:10:00Z"]
        movement["precision"] = "inferred"
        return document

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

    def test_waypoint_times_count_must_match_path_coordinates(self):
        document = self._minimal_timed_document()
        document["movements"][0]["path"]["coordinates"].append([4.405, 50.685])

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(any("count must match path coordinate count" in error.message for error in errors))

    def test_waypoint_times_must_be_strictly_increasing(self):
        document = self._minimal_timed_document()
        document["movements"][0]["waypoint_times"][1] = "1815-06-18T10:00:00Z"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(any("strictly increasing" in error.message for error in errors))

    def test_movement_time_must_be_valid_and_ordered(self):
        for field, value in (("start", "not-a-date"), ("end", "1815-06-18T09:59:00Z")):
            with self.subTest(field=field):
                document = self._minimal_timed_document()
                document["movements"][0]["time"][field] = value

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(errors)

    def test_waypoint_times_must_fall_within_movement_range(self):
        for index, value in ((0, "1815-06-18T09:59:00Z"), (1, "1815-06-18T10:11:00Z")):
            with self.subTest(index=index):
                document = self._minimal_timed_document()
                document["movements"][0]["waypoint_times"][index] = value

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(errors)

    def test_engagement_time_must_be_valid_and_ordered(self):
        for start, end in (("not-a-date", "1815-06-18T10:05:00Z"), ("1815-06-18T10:10:00Z", "1815-06-18T10:05:00Z")):
            with self.subTest(start=start, end=end):
                document = self._minimal_timed_document()
                document["engagements"] = [{
                    "id": "engagement_test",
                    "event_id": document["historical_events"][0]["id"],
                    "attacker_actor_id": document["actors"][0]["id"],
                    "target_actor_id": document["actors"][1]["id"],
                    "type": "fire",
                    "time": {
                        "label": "test engagement",
                        "start": start,
                        "end": end,
                        "precision": "range",
                        "confidence": 0.5,
                    },
                    "confidence": 0.5,
                }]

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(errors)

    def test_historical_event_time_must_be_valid_and_ordered(self):
        document = self._minimal_timed_document()
        document["historical_events"][0]["time"]["start"] = "not-a-date"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(errors)

    def test_reduced_iso_month_is_valid_battle_time(self):
        document = self._minimal_timed_document()
        document["historical_events"][0]["time"]["start"] = "1815-06"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertFalse(any(error.path == "$.historical_events[0].time.start" for error in errors))

    def test_unknown_v030_actor_icon_token_is_warning_only(self):
        document = self._minimal_timed_document()
        document["animation_hints"]["style"]["actor_icons"] = {document["actors"][0]["id"]: "🚢"}

        errors, warnings = validate_document_with_warnings(document)

        self.assertEqual(errors, [])
        self.assertTrue(any("unknown actor icon token" in warning.message for warning in warnings))

    def test_inferred_movement_high_time_confidence_is_warning_only(self):
        document = self._minimal_timed_document()
        document["movements"][0]["time"]["confidence"] = 0.9

        errors, warnings = validate_document_with_warnings(document)

        self.assertEqual(errors, [])
        self.assertTrue(any("inferred time confidence must be <= 0.6" in warning.message for warning in warnings))

    def test_disconnected_overlapping_movements_are_fatal(self):
        document = self._minimal_timed_document()
        later = deepcopy(document["movements"][0])
        later["id"] = "move_french_overlap"
        later["time"]["start"] = "1815-06-18T10:05:00Z"
        later["time"]["end"] = "1815-06-18T10:15:00Z"
        later["waypoint_times"] = ["1815-06-18T10:05:00Z", "1815-06-18T10:15:00Z"]
        later["path"]["coordinates"] = [[4.500, 50.700], [4.510, 50.710]]
        document["movements"].append(later)

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(any("conflicting overlapping movements for actor" in error.message for error in errors))

    def test_connected_overlapping_movements_warn_and_later_wins(self):
        document = self._minimal_timed_document()
        previous_last = document["movements"][0]["path"]["coordinates"][-1]
        later = deepcopy(document["movements"][0])
        later["id"] = "move_french_overlap"
        later["time"]["start"] = "1815-06-18T10:05:00Z"
        later["time"]["end"] = "1815-06-18T10:15:00Z"
        later["waypoint_times"] = ["1815-06-18T10:05:00Z", "1815-06-18T10:15:00Z"]
        later["path"]["coordinates"] = [previous_last, [4.400, 50.690]]
        document["movements"].append(later)

        errors, warnings = validate_document_with_warnings(document)

        self.assertEqual(errors, [])
        self.assertTrue(any("overlap resolved in favor of later movement" in warning.message for warning in warnings))

    def test_nested_overlap_checks_all_active_previous_movements(self):
        document = self._minimal_timed_document()
        first = document["movements"][0]
        first["time"]["end"] = "1815-06-18T10:20:00Z"
        first["waypoint_times"][-1] = "1815-06-18T10:20:00Z"

        middle = deepcopy(first)
        middle["id"] = "move_french_middle"
        middle["time"]["start"] = "1815-06-18T10:01:00Z"
        middle["time"]["end"] = "1815-06-18T10:02:00Z"
        middle["waypoint_times"] = ["1815-06-18T10:01:00Z", "1815-06-18T10:02:00Z"]
        middle["path"]["coordinates"] = [first["path"]["coordinates"][-1], [4.400, 50.690]]

        later = deepcopy(middle)
        later["id"] = "move_french_later"
        later["time"]["start"] = "1815-06-18T10:03:00Z"
        later["time"]["end"] = "1815-06-18T10:04:00Z"
        later["waypoint_times"] = ["1815-06-18T10:03:00Z", "1815-06-18T10:04:00Z"]
        later["path"]["coordinates"] = [middle["path"]["coordinates"][-1], [4.390, 50.695]]
        document["movements"].extend([middle, later])

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(any("conflicting overlapping movements for actor" in error.message for error in errors))

    def test_validate_document_remains_errors_only(self):
        document = self._minimal_timed_document()
        document["movements"][0]["time"]["confidence"] = 0.9

        self.assertEqual(validate_document(document), [])

    def test_cli_prints_warning_but_accepts_warning_only_document(self):
        document = self._minimal_timed_document()
        document["movements"][0]["time"]["confidence"] = 0.9
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "warning-only.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-m", "battle_animation.validator", str(path)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("warning:", result.stderr)
        self.assertIn("valid:", result.stdout)

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

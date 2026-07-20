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

    def test_yalu_is_a_timed_v030_ship_demo(self):
        battle = json.loads(YALU_EXAMPLE.read_text(encoding="utf-8"))
        naval_icons = {
            "warship_generic",
            "warship_ironclad",
            "warship_battleship",
            "warship_armored_cruiser",
            "warship_protected_cruiser",
            "warship_destroyer",
            "warship_torpedo_boat",
        }

        ships = [actor for actor in battle["actors"] if actor["kind"] == "ship"]
        timed_ship_movements = [
            movement
            for movement in battle["movements"]
            if "time" in movement
            and any(actor["id"] == movement["actor_id"] for actor in ships)
        ]
        actor_icons = battle["animation_hints"]["style"]["actor_icons"]

        self.assertEqual(battle["schema_version"], "0.3.0")
        self.assertGreaterEqual(len(ships), 10)
        self.assertGreaterEqual(len(timed_ship_movements), 10)
        self.assertTrue(any("waypoint_times" in movement for movement in timed_ship_movements))
        self.assertTrue(set(actor_icons.values()) <= naval_icons)
        self.assertTrue(all(ord(character) <= 0xFFFF for icon in actor_icons.values() for character in icon))
        self.assertTrue(all("time" in engagement for engagement in battle["engagements"]))

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

        waypoint_errors = [
            error for error in errors if error.path == "$.movements[0].waypoint_times[1]"
        ]
        self.assertEqual(
            [(error.path, error.message) for error in waypoint_errors],
            [("$.movements[0].waypoint_times[1]", "expected string, got int")],
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
        cases = (
            ("start", "not-a-date", "$.movements[0].time.start", "invalid ISO battle time"),
            ("end", "1815-06-18T09:59:00Z", "$.movements[0].time", "end must not be before start"),
        )
        for field, value, expected_path, expected_message in cases:
            with self.subTest(field=field):
                document = self._minimal_timed_document()
                document["movements"][0]["time"][field] = value

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(
                    any(
                        error.path == expected_path and error.message == expected_message
                        for error in errors
                    )
                )

    def test_waypoint_times_must_fall_within_movement_range(self):
        cases = (
            (0, "1815-06-18T09:59:00Z", "value is before movement start"),
            (1, "1815-06-18T10:11:00Z", "value is after movement end"),
        )
        for index, value, expected_message in cases:
            with self.subTest(index=index):
                document = self._minimal_timed_document()
                document["movements"][0]["waypoint_times"][index] = value

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(
                    any(
                        error.path == f"$.movements[0].waypoint_times[{index}]"
                        and error.message == expected_message
                        for error in errors
                    )
                )

    def test_engagement_time_must_be_valid_and_ordered(self):
        cases = (
            ("not-a-date", "1815-06-18T10:05:00Z", "$.engagements[0].time.start", "invalid ISO battle time"),
            ("1815-06-18T10:10:00Z", "1815-06-18T10:05:00Z", "$.engagements[0].time", "end must not be before start"),
        )
        for start, end, expected_path, expected_message in cases:
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

                self.assertTrue(
                    any(
                        error.path == expected_path and error.message == expected_message
                        for error in errors
                    )
                )

    def test_historical_event_time_must_be_valid_and_ordered(self):
        document = self._minimal_timed_document()
        document["historical_events"][0]["time"]["start"] = "not-a-date"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(
            any(
                error.path == "$.historical_events[0].time.start"
                and error.message == "invalid ISO battle time"
                for error in errors
            )
        )

    def test_battle_time_rejects_non_iso_datetime_separators(self):
        for value in ("1815-06-18X10:00:00Z", "1815-06-18🕙10:00:00Z"):
            with self.subTest(value=value):
                document = self._minimal_timed_document()
                document["movements"][0]["time"]["start"] = value

                errors, _warnings = validate_document_with_warnings(document)

                self.assertTrue(
                    any(
                        error.path == "$.movements[0].time.start"
                        and error.message == "invalid ISO battle time"
                        for error in errors
                    )
                )

    def test_battle_time_accepts_documented_lexical_forms(self):
        values = (
            "1815",
            "1815-06",
            "1815-06-18",
            "1815-06-18T10:00",
            "1815-06-18T10:00:30",
            "1815-06-18T10:00:30.125",
            "1815-06-18T10:00Z",
            "1815-06-18T10:00:30+02:00",
        )
        for value in values:
            with self.subTest(value=value):
                document = self._minimal_timed_document()
                document["historical_events"][0]["time"] = {
                    "label": value,
                    "start": value,
                    "precision": "unknown",
                    "confidence": 0.5,
                }

                errors, _warnings = validate_document_with_warnings(document)

                self.assertFalse(
                    any(error.path == "$.historical_events[0].time.start" for error in errors)
                )

    def test_offset_bearing_and_battle_local_datetimes_cannot_mix_across_collections(self):
        document = self._minimal_timed_document()
        document["historical_events"][0]["time"]["start"] = "1815-06-18T09:00"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(
            any(
                error.path == "$.movements[0].time.start"
                and error.message == "mixed offset-bearing and battle-local date-times are not allowed"
                for error in errors
            )
        )

    def test_offset_bearing_and_battle_local_datetimes_cannot_mix_within_range(self):
        document = self._minimal_timed_document()
        document["movements"][0]["time"]["start"] = "1815-06-18T10:00:00"

        errors, _warnings = validate_document_with_warnings(document)

        self.assertTrue(
            any(
                error.path == "$.movements[0].time.end"
                and error.message == "mixed offset-bearing and battle-local date-times are not allowed"
                for error in errors
            )
        )

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

    def test_static_app_exposes_continuous_playback_controls(self):
        index = (ROOT / "app" / "index.html").read_text(encoding="utf-8")

        for element_id in (
            "historical-time",
            "compression-notice",
            "speed-controls",
            "follow-button",
            "event-card-stack",
            "validation-warnings",
        ):
            self.assertIn(f'id="{element_id}"', index)
        self.assertRegex(
            index,
            r'id="event-scrubber"[^>]*step="any"',
        )
        self.assertRegex(
            index,
            r'</div>\s*</div>\s*<section id="event-card-stack"[^>]*></section>\s*<aside class="inspector"',
        )

    def test_renderer_uses_timeline_and_symbol_modules(self):
        animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")

        self.assertIn('from "./timeline.js"', animate)
        self.assertIn('from "./symbols.js"', animate)
        self.assertIn("compileTimeline", animate)
        self.assertIn("sampleTimeline", animate)
        self.assertIn("resolveSymbol", animate)
        self.assertIn("requestAnimationFrame", animate)
        self.assertIn("cancelAnimationFrame", animate)
        self.assertNotIn("setInterval", animate)
        self.assertNotIn("buildSnapshots", animate)
        self.assertNotIn("DEFAULT_ACTOR_ICONS", animate)
        self.assertNotIn("NAMED_ACTOR_ICONS", animate)
        self.assertNotIn("resolveActorIcon", animate)

    def test_browser_validator_exposes_v030_structured_validation_contract(self):
        animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")
        index = (ROOT / "app" / "index.html").read_text(encoding="utf-8")

        for contract in (
            '"0.3.0"',
            "waypoint_times",
            "warnings",
            "ACTOR_ICON_TOKENS",
            "parseBattleTime",
            "return { errors, warnings }",
        ):
            self.assertIn(contract, animate)
        self.assertIn("setBattleDocument", index)
        self.assertIn("previousController: controller", index)

    def test_renderer_exposes_continuous_controller_and_split_svg_transforms(self):
        animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")
        styles = (ROOT / "app" / "styles.css").read_text(encoding="utf-8")

        for contract in (
            "compiled = compileTimeline(battle)",
            "renderAt(presentationMs)",
            "seek(presentationMs)",
            "setSpeed(rate)",
            "playbackRate",
            "_lastFrameTime",
            'class: "unit-heading"',
            "unit-symbol token-",
            "redrawStaticGeometry",
            "updateActorPositions",
            "redrawEngagementEndpoints",
        ):
            self.assertIn(contract, animate)
        self.assertIn("flyToBounds", animate)
        self.assertNotIn("transform 700ms", styles)
        self.assertIn(".unit-symbol path", styles)


if __name__ == "__main__":
    unittest.main()

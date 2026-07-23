import json
import math
import re
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from battle_animation.validator import (
    ACTOR_ICON_TOKENS,
    validate_document,
    validate_document_with_warnings,
)


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "battle-of-waterloo.json"
YALU_EXAMPLE = ROOT / "examples" / "battle-of-甲午海戰.json"
SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"
MAX_INFERRED_WITHDRAWAL_SPEED_KMH = 18


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
        expected_icons = {
            "ship_dingyuan": "warship_ironclad",
            "ship_zhenyuan": "warship_ironclad",
            "ship_jingyuan": "warship_armored_cruiser",
            "ship_zhiyuan": "warship_protected_cruiser",
            "ship_chaoyong": "warship_generic",
            "ship_yangwei": "warship_generic",
            "ship_matsushima": "warship_protected_cruiser",
            "ship_yoshino": "warship_protected_cruiser",
            "ship_naniwa": "warship_protected_cruiser",
            "ship_hiei": "warship_generic",
        }
        expected_ship_ids = {
            "ship_dingyuan",
            "ship_zhenyuan",
            "ship_jingyuan",
            "ship_zhiyuan",
            "ship_chaoyong",
            "ship_yangwei",
            "ship_matsushima",
            "ship_yoshino",
            "ship_naniwa",
            "ship_hiei",
        }

        ships = [actor for actor in battle["actors"] if actor["kind"] == "ship"]
        ship_ids = {actor["id"] for actor in ships}
        ship_movements = [
            movement
            for movement in battle["movements"]
            if movement["actor_id"] in ship_ids
        ]
        actor_icons = battle["animation_hints"]["style"]["actor_icons"]
        timeline = battle["animation_hints"]["timeline"]
        events_by_id = {event["id"]: event for event in battle["historical_events"]}

        self.assertEqual(battle["schema_version"], "0.3.0")
        self.assertEqual(battle["metadata"]["updated_at"], "2026-07-20")
        self.assertGreaterEqual(len(ships), 10)
        self.assertGreaterEqual(len(ship_movements), 10)
        self.assertEqual(ship_ids, expected_ship_ids)
        self.assertEqual({movement["actor_id"] for movement in ship_movements}, expected_ship_ids)
        self.assertEqual(actor_icons, expected_icons)
        self.assertEqual(
            {
                key: timeline[key]
                for key in (
                    "historical_seconds_per_playback_second",
                    "idle_compression_threshold_seconds",
                    "idle_compressed_duration_ms",
                )
            },
            {
                "historical_seconds_per_playback_second": 120,
                "idle_compression_threshold_seconds": 900,
                "idle_compressed_duration_ms": 1200,
            },
        )

        for movement in ship_movements:
            with self.subTest(movement=movement["id"]):
                event_time = events_by_id[movement["event_id"]]["time"]
                movement_time = movement["time"]
                waypoint_times = movement["waypoint_times"]
                coordinates = movement["path"]["coordinates"]

                self.assertEqual(movement["precision"], "inferred")
                self.assertEqual(movement_time["precision"], "range")
                self.assertLessEqual(movement_time["confidence"], 0.6)
                self.assertEqual(len(waypoint_times), len(coordinates))
                parsed_waypoints = [datetime.fromisoformat(value) for value in waypoint_times]
                event_start = datetime.fromisoformat(event_time["start"])
                event_end = datetime.fromisoformat(event_time["end"])
                movement_start = datetime.fromisoformat(movement_time["start"])
                movement_end = datetime.fromisoformat(movement_time["end"])
                self.assertTrue(
                    all(
                        earlier < later
                        for earlier, later in zip(parsed_waypoints, parsed_waypoints[1:])
                    )
                )
                self.assertLessEqual(movement_start, parsed_waypoints[0])
                self.assertLessEqual(parsed_waypoints[-1], movement_end)
                self.assertLessEqual(event_start, movement_start)
                self.assertLessEqual(movement_end, event_end)

        for engagement in battle["engagements"]:
            with self.subTest(engagement=engagement["id"]):
                event_time = events_by_id[engagement["event_id"]]["time"]
                engagement_time = engagement["time"]
                event_start = datetime.fromisoformat(event_time["start"])
                event_end = datetime.fromisoformat(event_time["end"])
                engagement_start = datetime.fromisoformat(engagement_time["start"])
                engagement_end = datetime.fromisoformat(engagement_time["end"])
                self.assertLessEqual(event_start, engagement_start)
                self.assertLessEqual(engagement_start, engagement_end)
                self.assertLessEqual(engagement_end, event_end)

    def test_yalu_chronology_results_and_withdrawal_speeds_are_plausible(self):
        battle = json.loads(YALU_EXAMPLE.read_text(encoding="utf-8"))
        events = {event["id"]: event for event in battle["historical_events"]}
        engagements = {engagement["id"]: engagement for engagement in battle["engagements"]}
        movements = {movement["id"]: movement for movement in battle["movements"]}

        self.assertEqual(events["evt_zhiyuan_charge"]["time"]["end"], "1894-09-17T15:20")
        self.assertNotIn("ship_jingyuan", events["evt_zhiyuan_charge"]["actor_ids"])
        self.assertEqual(events["evt_jingyuan_sinking"]["time"]["end"], "1894-09-17T17:30")
        self.assertIn("ship_jingyuan", events["evt_jingyuan_sinking"]["actor_ids"])
        self.assertEqual(events["evt_chaoyong_sinking"]["time"]["end"], "1894-09-17T14:20")

        self.assertEqual(engagements["eng_dingyuan_open"]["result"], "none")
        self.assertNotIn("result_actor_id", engagements["eng_dingyuan_open"])
        self.assertEqual(
            engagements["eng_flying_squadron_yangwei"]["result"],
            "damaged",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_yangwei"]["attacker_actor_id"],
            "ship_yoshino",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_chaoyong"]["attacker_actor_id"],
            "ship_yoshino",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_chaoyong"]["result"],
            "damaged",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_zhiyuan"]["time"]["end"],
            "1894-09-17T15:20",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_jingyuan"]["event_id"],
            "evt_jingyuan_sinking",
        )
        self.assertEqual(
            engagements["eng_flying_squadron_jingyuan"]["time"]["end"],
            "1894-09-17T17:29",
        )
        self.assertEqual(engagements["eng_chaoyong_sinking"]["result"], "sunk")

        actors = {actor["id"]: actor for actor in battle["actors"]}
        self.assertNotIn("fleet_japan_first_flying", actors)
        self.assertTrue(all(actor["kind"] == "ship" for actor in actors.values()))
        self.assertTrue(
            all(movement["actor_id"] in actors for movement in battle["movements"])
        )
        self.assertTrue(
            all(
                engagement[role] in actors and actors[engagement[role]]["kind"] == "ship"
                for engagement in battle["engagements"]
                for role in ("attacker_actor_id", "target_actor_id")
            )
        )
        self.assertFalse(
            any(
                engagement.get("result") == "sunk"
                and engagement.get("result_actor_id") == "ship_yangwei"
                for engagement in battle["engagements"]
            )
        )
        representative_engagement_ids = {
            "eng_flying_squadron_chaoyong",
            "eng_flying_squadron_yangwei",
            "eng_flying_squadron_zhiyuan",
            "eng_flying_squadron_jingyuan",
            "eng_chaoyong_sinking",
        }
        for engagement_id in representative_engagement_ids:
            with self.subTest(representative_engagement=engagement_id):
                engagement = engagements[engagement_id]
                self.assertEqual(engagement["attacker_actor_id"], "ship_yoshino")
                self.assertLessEqual(engagement["confidence"], 0.5)
        for event_id in (
            "evt_flying_flank",
            "evt_chaoyong_sinking",
            "evt_zhiyuan_charge",
            "evt_jingyuan_sinking",
        ):
            with self.subTest(representative_event=event_id):
                self.assertIn("視覺代表", events[event_id]["description"])
                self.assertIn("不表示單艦歸功", events[event_id]["description"])

        yoshino_flank = movements["mov_yoshino_flank"]
        yoshino_pursuit = movements["mov_yoshino_jingyuan_pursuit"]
        jingyuan_last_stand = movements["mov_jingyuan_last_stand"]
        pursuit_coordinates = yoshino_pursuit["path"]["coordinates"]
        jingyuan_endpoint = jingyuan_last_stand["path"]["coordinates"][-1]
        self.assertEqual(yoshino_pursuit["event_id"], "evt_jingyuan_sinking")
        self.assertEqual(
            pursuit_coordinates[0],
            yoshino_flank["path"]["coordinates"][-1],
        )
        self.assertEqual(yoshino_pursuit["time"]["start"], "1894-09-17T17:00")
        self.assertEqual(yoshino_pursuit["time"]["end"], "1894-09-17T17:29")
        self.assertLessEqual(yoshino_pursuit["time"]["confidence"], 0.6)
        self.assertGreater(
            self._haversine_km(pursuit_coordinates[0], jingyuan_endpoint),
            self._haversine_km(pursuit_coordinates[-1], jingyuan_endpoint),
        )

        for movement_id in ("mov_qing_retreat", "mov_japan_withdraw"):
            with self.subTest(movement=movement_id):
                movement = movements[movement_id]
                coordinates = movement["path"]["coordinates"]
                distance_km = sum(
                    self._haversine_km(start, end)
                    for start, end in zip(coordinates, coordinates[1:])
                )
                start = datetime.fromisoformat(movement["time"]["start"])
                end = datetime.fromisoformat(movement["time"]["end"])
                hours = (end - start).total_seconds() / 3600
                self.assertLessEqual(distance_km / hours, MAX_INFERRED_WITHDRAWAL_SPEED_KMH)

    @staticmethod
    def _haversine_km(start, end):
        start_lon, start_lat = map(math.radians, start)
        end_lon, end_lat = map(math.radians, end)
        delta_lon = end_lon - start_lon
        delta_lat = end_lat - start_lat
        value = (
            math.sin(delta_lat / 2) ** 2
            + math.cos(start_lat) * math.cos(end_lat) * math.sin(delta_lon / 2) ** 2
        )
        return 6371 * 2 * math.asin(math.sqrt(value))

    def test_yalu_preserves_source_and_geographic_confidence_baseline(self):
        battle = json.loads(YALU_EXAMPLE.read_text(encoding="utf-8"))

        self.assertEqual(
            {
                place["id"]: {
                    "coordinates": place["geometry"]["coordinates"],
                    "precision": place["precision"],
                    "confidence": place["confidence"],
                }
                for place in battle["places"]
            },
            {
                "place_dadonggou": {
                    "coordinates": [123.62, 39.35],
                    "precision": "approximate",
                    "confidence": 0.7,
                },
                "place_right_wing": {
                    "coordinates": [123.56, 39.333],
                    "precision": "inferred",
                    "confidence": 0.5,
                },
                "place_melee": {
                    "coordinates": [123.6, 39.33],
                    "precision": "inferred",
                    "confidence": 0.5,
                },
                "place_weihaiwei": {
                    "coordinates": [122.1, 37.5],
                    "precision": "approximate",
                    "confidence": 0.8,
                },
            },
        )
        self.assertEqual(
            battle["sources"],
            [
                {
                    "id": "src_zhwiki_yalu",
                    "title": "黃海海戰 - 維基百科",
                    "url": "https://zh.wikipedia.org/wiki/黃海海戰_(1894年)",
                    "retrieved_at": "2026-06-22",
                    "license": "CC BY-SA 4.0",
                }
            ],
        )

    def test_yalu_has_zero_python_and_browser_validation_diagnostics(self):
        battle = json.loads(YALU_EXAMPLE.read_text(encoding="utf-8"))

        errors, warnings = validate_document_with_warnings(battle)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

        script = """
            import fs from "node:fs";
            import { validateBattle } from "./app/animate.js";
            const battle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            console.log(JSON.stringify(validateBattle(battle)));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(YALU_EXAMPLE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"errors": [], "warnings": []})

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

    def test_readme_prompt_teaches_v030_timing_and_tokens(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        for required in (
            'schema_version：使用精細時間軌時請用字串 "0.3.0"',
            "waypoint_times 的數量必須與 path.coordinates 完全相同，且時間嚴格遞增",
            "不要輸出 Emoji、SVG、data URL 或詞彙表以外的名稱",
            'precision:"inferred"',
            "confidence <= 0.6",
            '"schema_version": "0.3.0"',
            '"historical_seconds_per_playback_second": 120',
            '"idle_compression_threshold_seconds": 900',
            '"idle_compressed_duration_ms": 1200',
            "代表位置，不是該單位的精確空間範圍",
            "船艦級",
            "師／旅級",
            "連續歷史時間播放",
            "閒置時間壓縮",
            "推估僅限於代表性幾何與時間",
            "來源已確認事件確實發生及先後順序",
            "沒有來源支持的 actor、engagement、result 或艦種／兵種分類必須省略",
        ):
            self.assertIn(required, readme)
        token_paragraph = re.search(
            r"actor_icons 只能使用以下 21 個受控名稱：\n(?P<tokens>.*?unit_generic。)",
            readme,
            re.DOTALL,
        )
        self.assertIsNotNone(token_paragraph)
        documented_token_list = re.findall(
            r"\b[a-z][a-z0-9_]*\b", token_paragraph.group("tokens")
        )
        self.assertEqual(len(documented_token_list), len(ACTOR_ICON_TOKENS))
        self.assertEqual(set(documented_token_list), ACTOR_ICON_TOKENS)
        self.assertNotIn("寧可多給細節", readme)
        self.assertNotIn("強烈建議提供", readme)
        for stale_emoji in ("🚢", "⛵", "🪖", "🐎", "💥", "🛡️", "✈️", "🏰", "🚩"):
            self.assertNotIn(stale_emoji, readme)

    def test_readme_embedded_v030_sample_validates_in_python_and_browser(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        sample_match = re.search(
            r"===== 輸出格式範本.*?=====\n(?P<json>\{.*?\n\})\n\n===== 資料來源 =====",
            readme,
            re.DOTALL,
        )
        self.assertIsNotNone(sample_match)
        sample = json.loads(sample_match.group("json"))

        errors, warnings = validate_document_with_warnings(sample)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

        script = """
            import { validateBattle } from "./app/animate.js";
            let input = "";
            process.stdin.setEncoding("utf8");
            for await (const chunk of process.stdin) input += chunk;
            console.log(JSON.stringify(validateBattle(JSON.parse(input))));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=ROOT,
            input=json.dumps(sample),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"errors": [], "warnings": []})

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
            "trails-button",
            "event-card-stack",
            "validation-warnings",
        ):
            self.assertIn(f'id="{element_id}"', index)
        self.assertIn('id="trails-button" type="button" class="ghost" aria-pressed="false">Trails: off</button>', index)
        self.assertRegex(
            index,
            r'id="event-scrubber"[^>]*step="any"',
        )
        self.assertRegex(
            index,
            r'</div>\s*</div>\s*<section id="event-card-stack"[^>]*></section>\s*<aside class="inspector"',
        )

    def test_readme_documents_transient_map_overlays(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        for phrase in (
            "航跡預設關閉",
            "關閉時不顯示 movement 路徑",
            "開啟後只顯示當前 movement",
            "只顯示當前 movement",
            "active-only 脈衝信標",
            "相近事件會合併顯示數量",
        ):
            self.assertIn(phrase, readme)

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
            "renderAt(presentationMs, { mode = \"seek\" } = {})",
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

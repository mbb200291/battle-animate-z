import hashlib
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
from typing import Literal, NotRequired, get_type_hints

from battle_animation.types import (
    BattleAnimationDocument,
    ControlArea,
    DateValue,
    FrontLine,
    FrontlineSnapshot,
    LineString,
    Polygon,
    Precision,
)
from battle_animation.validator import (
    ACTOR_ICON_TOKENS,
    validate_document,
    validate_document_with_warnings,
)


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "battle-of-waterloo.json"
YALU_EXAMPLE = ROOT / "examples" / "battle-of-甲午海戰.json"
STALINGRAD_EXAMPLE = ROOT / "examples" / "battle-of-stalingrad-frontlines.json"
BULGE_EXAMPLE = ROOT / "examples" / "battle-of-the-bulge-frontlines.json"
SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"
MAX_INFERRED_WITHDRAWAL_SPEED_KMH = 18


def valid_v030_document():
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


def frontline_document():
    document = valid_v030_document()
    document["schema_version"] = "0.4.0"
    document["frontline_snapshots"] = [{
        "id": "front_day_1",
        "time": {
            "label": "1942-11-19T08:00:00Z",
            "start": "1942-11-19T08:00:00Z",
            "precision": "hour",
            "confidence": 0.9,
        },
        "event_id": document["historical_events"][0]["id"],
        "front_lines": [{
            "id": "front_main",
            "geometry": {
                "type": "LineString",
                "coordinates": [[43.1, 49.2], [44.0, 48.9]],
            },
        }],
        "control_areas": [{
            "id": "area_a",
            "side_id": document["sides"][0]["id"],
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [42.5, 49.8],
                    [44.0, 49.5],
                    [44.0, 48.9],
                    [42.5, 49.0],
                    [42.5, 49.8],
                ]],
            },
        }],
        "precision": "approximate",
        "confidence": 0.8,
        "source_ids": [document["sources"][0]["id"]],
    }]
    return document


class BattleAnimationMvpContractTest(unittest.TestCase):
    def _readme_prompt_sample(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        prompt_match = re.search(
            r"## Generate JSON With AI — Battle JSON Prompt 1\.3\.2.*?"
            r"````text\n(?P<prompt>.*?)\n````",
            readme,
            re.DOTALL,
        )
        if prompt_match is None:
            prompt = (ROOT / "docs/battle-json-prompt.md").read_text(encoding="utf-8")
            return readme, prompt, json.loads(EXAMPLE.read_text(encoding="utf-8"))
        prompt = prompt_match.group("prompt")
        sample_match = re.search(
            r"===== 輸出格式範本.*?=====\n(?P<json>\{.*?\n\})\n\n===== 資料來源 =====",
            prompt,
            re.DOTALL,
        )
        self.assertIsNotNone(sample_match)
        return readme, prompt, json.loads(sample_match.group("json"))

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
        return valid_v030_document()

    def _assert_bulge_reference_provenance(self, battle):
        self.assertEqual(
            {actor["id"]: (actor["name"], actor["side_id"], actor["kind"])
             for actor in battle["actors"]},
            {
                "actor_us_30_infantry": ("U.S. 30th Infantry Division", "side_allied", "division"),
                "actor_us_7_armored": ("U.S. 7th Armored Division", "side_allied", "division"),
                "actor_german_1_ss_panzer_corps": ("German I SS Panzer Corps", "side_german", "corps"),
                "actor_german_66_corps": ("German LXVI Corps", "side_german", "corps"),
                "actor_german_58_panzer_corps": ("German LVIII Panzer Corps", "side_german", "corps"),
                "actor_german_47_panzer_corps": ("German XLVII Panzer Corps", "side_german", "corps"),
            },
        )
        self.assertEqual(
            {source["id"]: source for source in battle["sources"]},
            {
                "source_us_army_ardennes": {
                    "id": "source_us_army_ardennes",
                    "title": "The Ardennes: Battle of the Bulge",
                    "url": "https://history.army.mil/Publications/Publications-Catalog/The-Ardennes-Battle-Of-The-Bulge/",
                    "retrieved_at": "2026-08-11",
                    "license": "Public domain as a U.S. Army Center of Military History publication",
                    "note": "Hugh M. Cole, U.S. Army Center of Military History, CMH Pub 7-8. Supports the campaign chronology, participating formations, German corps axes, Allied responses, and outcome. It is not used as a claim of exact geospatial coordinates.",
                },
                "source_wacht_am_rhein_map": {
                    "id": "source_wacht_am_rhein_map",
                    "title": "File:Wacht am Rhein map (original).svg",
                    "url": "https://commons.wikimedia.org/wiki/File:Wacht_am_Rhein_map_(original).svg",
                    "retrieved_at": "2026-08-11",
                    "license": "CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/)",
                    "note": "Grandiose derivative map based on the public-domain U.S. military File:P23(map).jpg. The legend directly distinguishes front lines dated 16, 20, and 25 December 1944, labels Allied divisions and German corps, and depicts movement arrows. JSON frontline_snapshots are coarse source-map traces, while movement coordinates are low-confidence representative traces of depicted axes; the SVG is not treated as georeferenced and does not state a map projection. App runtime-derived lines are analytical renderings from actor positions and are not serialized in this JSON. The fixture retains only formations with explicit movement placement, favoring evidence over unit density. No control-area polygons are asserted.",
                },
                "source_us_army_ardennes_alsace": {
                    "id": "source_us_army_ardennes_alsace",
                    "title": "Ardennes-Alsace",
                    "url": "https://history.army.mil/portals/143/Images/Publications/catalog/72-26.pdf",
                    "retrieved_at": "2026-08-11",
                    "license": "Public domain as a U.S. Army Center of Military History publication",
                    "note": "Official U.S. Army campaign brochure. Supports the 30th Infantry Division move south toward Malmedy, the 7th Armored Division withdrawal from St. Vith, and the westward operations of I SS and LVIII Panzer Corps. It supports only broad movement axes, not the example's exact representative coordinates.",
                },
            },
        )

        reviewed_sources = [
            "source_us_army_ardennes",
            "source_us_army_ardennes_alsace",
            "source_wacht_am_rhein_map",
        ]
        events = {event["id"]: event for event in battle["historical_events"]}
        self.assertEqual(
            {event_id: event["source_ids"] for event_id, event in events.items()},
            {event_id: reviewed_sources for event_id in (
                "event_front_1944_12_16", "event_front_1944_12_20", "event_front_1944_12_25"
            )},
        )
        self.assertNotIn("target_actor_ids", events["event_front_1944_12_16"])
        self.assertEqual(battle["outcome"]["source_ids"], ["source_us_army_ardennes"])

        snapshots = battle["frontline_snapshots"]
        self.assertEqual(
            [(snapshot["id"], snapshot["time"]["start"], snapshot["event_id"], snapshot["source_ids"])
             for snapshot in snapshots],
            [
                ("snapshot_front_1944_12_16", "1944-12-16", "event_front_1944_12_16", ["source_wacht_am_rhein_map"]),
                ("snapshot_front_1944_12_20", "1944-12-20", "event_front_1944_12_20", ["source_wacht_am_rhein_map"]),
                ("snapshot_front_1944_12_25", "1944-12-25", "event_front_1944_12_25", ["source_wacht_am_rhein_map"]),
            ],
        )
        self.assertEqual(
            {
                snapshot["time"]["start"]: hashlib.sha256(json.dumps(
                    [line["geometry"]["coordinates"] for line in snapshot["front_lines"]],
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")).hexdigest()
                for snapshot in snapshots
            },
            {
                "1944-12-16": "48ed0317a1e871f6e0e8af04258e5b65e23878220fd2fdc80fbf44c222b9252e",
                "1944-12-20": "60a0fc336210828f66634bfaf83fa4e5484e89449b6840f32d7df5d02db7a05f",
                "1944-12-25": "a49f31959ce928099daa9f3cc2f44b6af25ec468235381af8d262629670b36e5",
            },
        )
        western_edges = []
        for snapshot in snapshots:
            self.assertNotIn("end", snapshot["time"])
            self.assertEqual(snapshot["time"]["precision"], "day")
            self.assertEqual([line["id"] for line in snapshot["front_lines"]], ["front_main"])
            self.assertEqual(snapshot["precision"], "inferred")
            self.assertLessEqual(snapshot["confidence"], 0.5)
            coordinates = snapshot["front_lines"][0]["geometry"]["coordinates"]
            self.assertTrue(all(4.8 <= lon <= 6.7 and 49.8 <= lat <= 50.9
                                for lon, lat in coordinates))
            western_edges.append(min(lon for lon, _ in coordinates))
        self.assertTrue(all(left > right for left, right in zip(western_edges, western_edges[1:])))

        movement_bindings = {
            "movement_1_ss_panzer_16_20": ("event_front_1944_12_20", "actor_german_1_ss_panzer_corps"),
            "movement_66_corps_16_20": ("event_front_1944_12_20", "actor_german_66_corps"),
            "movement_66_corps_20_25": ("event_front_1944_12_25", "actor_german_66_corps"),
            "movement_58_panzer_16_20": ("event_front_1944_12_20", "actor_german_58_panzer_corps"),
            "movement_58_panzer_20_25": ("event_front_1944_12_25", "actor_german_58_panzer_corps"),
            "movement_47_panzer_16_20": ("event_front_1944_12_20", "actor_german_47_panzer_corps"),
            "movement_47_panzer_20_25": ("event_front_1944_12_25", "actor_german_47_panzer_corps"),
            "movement_us_30_16_20": ("event_front_1944_12_20", "actor_us_30_infantry"),
            "movement_us_7_armored_16_20": ("event_front_1944_12_20", "actor_us_7_armored"),
            "movement_us_7_armored_20_25": ("event_front_1944_12_25", "actor_us_7_armored"),
        }
        movements = {movement["id"]: movement for movement in battle["movements"]}
        self.assertEqual(
            {movement_id: (movement["event_id"], movement["actor_id"])
             for movement_id, movement in movements.items()},
            movement_bindings,
        )
        for movement in movements.values():
            coordinates = movement["path"]["coordinates"]
            waypoint_times = movement["waypoint_times"]
            self.assertEqual(len(coordinates), len(waypoint_times))
            self.assertEqual(waypoint_times[0], movement["time"]["start"])
            self.assertEqual(waypoint_times[-1], movement["time"]["end"])
            parsed = [datetime.fromisoformat(value) for value in waypoint_times]
            self.assertTrue(all(left < right for left, right in zip(parsed, parsed[1:])))
            self.assertEqual(movement["precision"], "inferred")
            self.assertLessEqual(movement["confidence"], 0.5)
            self.assertTrue(all(4.8 <= lon <= 6.7 and 49.8 <= lat <= 50.9
                                for lon, lat in coordinates))
        for movement_id, movement in movements.items():
            start, end = movement["path"]["coordinates"][0], movement["path"]["coordinates"][-1]
            if movement_id == "movement_us_30_16_20":
                self.assertLess(end[1], start[1])
                self.assertAlmostEqual(end[0], 6.03, delta=0.15)
            elif movement_id == "movement_us_7_armored_16_20":
                self.assertGreater(end[0], start[0])
                self.assertLess(end[1], start[1])
            else:
                self.assertLess(end[0], start[0])

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

    def test_stalingrad_v040_frontline_example(self):
        battle = json.loads(STALINGRAD_EXAMPLE.read_text(encoding="utf-8"))
        snapshots = battle["frontline_snapshots"]

        self.assertEqual(battle["schema_version"], "0.4.0")
        self.assertEqual(
            battle["metadata"]["source_system"],
            "battle_json_prompt_1.1.0",
        )
        events = {
            event["id"]: event
            for event in battle["historical_events"]
        }
        self.assertEqual(
            events["event_encirclement_established"]["time"]["start"],
            "1942-11-23",
        )
        self.assertGreaterEqual(len(snapshots), 3)
        starts = [
            datetime.fromisoformat(snapshot["time"]["start"])
            for snapshot in snapshots
        ]
        self.assertTrue(
            all(earlier < later for earlier, later in zip(starts, starts[1:]))
        )

        first_line_ids = {
            line["id"] for line in snapshots[0].get("front_lines", [])
        }
        second_line_ids = {
            line["id"] for line in snapshots[1].get("front_lines", [])
        }
        final_line_ids = {
            line["id"] for line in snapshots[-1].get("front_lines", [])
        }
        self.assertIn("front_main", first_line_ids & second_line_ids)
        self.assertEqual(final_line_ids, {"front_main"})
        final_front = snapshots[-1]["front_lines"][0]["geometry"]["coordinates"]
        self.assertGreaterEqual(len(final_front), 4)
        self.assertEqual(final_front[0], final_front[-1])

        self.assertTrue(all("control_areas" not in snapshot for snapshot in snapshots))
        self.assertNotIn(
            "movement_axis_contraction",
            {movement["id"] for movement in battle["movements"]},
        )
        axis_event = events["event_pocket_isolated"]
        self.assertEqual(axis_event["actor_ids"], ["actor_axis_stalingrad"])
        self.assertEqual(axis_event["place_ids"][0], "place_stalingrad")

        sources = {source["id"]: source for source in battle["sources"]}
        preparation_map = sources["source_map_uranus_preparations"]
        self.assertIn("Josullivan.59", preparation_map["note"])
        self.assertIn(
            "https://creativecommons.org/licenses/by-sa/3.0/",
            preparation_map["license"],
        )
        self.assertRegex(
            preparation_map["note"],
            r"(?i)(adapted|coarsened)",
        )
        front_map = sources["source_map_stalingrad_three_dates"]
        self.assertRegex(front_map["note"], r"(?i)does not support control-area polygons")
        self.assertEqual(
            battle["metadata"]["license"],
            "CC BY-SA 4.0; includes public-domain source material",
        )
        self.assertTrue(
            all(
                any(source_id.startswith("source_map_") for source_id in snapshot["source_ids"])
                for snapshot in snapshots
            )
        )
        self.assertTrue(
            all(
                snapshot["precision"] in {"approximate", "inferred"}
                and snapshot["confidence"] <= 0.5
                for snapshot in snapshots
            )
        )
        errors, warnings = validate_document_with_warnings(battle)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

        script = """
            import fs from "node:fs";
            import { validateBattle } from "./app/animate.js";
            import { compileTimeline, sampleTimeline } from "./app/timeline.js";
            const battle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const timeline = compileTimeline(battle);
            const finalPair = timeline.frontlineKeyframes.slice(-2);
            const midpoint = timeline.toPresentationTime(
                (finalPair[0].historicalMs + finalPair[1].historicalMs) / 2,
            );
            const frontline = sampleTimeline(timeline, midpoint).frontline;
            console.log(JSON.stringify({
                diagnostics: validateBattle(battle),
                axisStart: timeline.startingPositions.get("actor_axis_stalingrad"),
                finalTransition: frontline.transition,
                enclosureLineIds: frontline.enclosureLineIds,
            }));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(STALINGRAD_EXAMPLE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "diagnostics": {"errors": [], "warnings": []},
                "axisStart": [44.516, 48.709],
                "finalTransition": "enclosure",
                "enclosureLineIds": ["front_main"],
            },
        )

    def test_battle_of_the_bulge_hybrid_frontline_example(self):
        self.assertTrue(BULGE_EXAMPLE.is_file())
        battle = json.loads(BULGE_EXAMPLE.read_text(encoding="utf-8"))
        self._assert_bulge_reference_provenance(battle)

        self.assertEqual(battle["schema_version"], "0.4.0")
        self.assertEqual(
            battle["metadata"]["source_system"],
            "battle_json_prompt_1.2.0",
        )
        snapshots = battle["frontline_snapshots"]
        self.assertEqual(
            [snapshot["time"]["start"] for snapshot in snapshots],
            ["1944-12-16", "1944-12-20", "1944-12-25"],
        )
        self.assertTrue(all(snapshot["source_ids"] for snapshot in snapshots))
        self.assertTrue(all(
            snapshot["precision"] == "inferred" and snapshot["confidence"] <= 0.5
            for snapshot in snapshots
        ))
        self.assertTrue(all("control_areas" not in snapshot for snapshot in snapshots))
        self.assertEqual(
            [{line["id"] for line in snapshot["front_lines"]} for snapshot in snapshots],
            [{"front_main"}, {"front_main"}, {"front_main"}],
        )

        eligible_kinds = {"army", "corps", "division", "brigade", "regiment"}
        eligible = [actor for actor in battle["actors"] if actor["kind"] in eligible_kinds]
        self.assertEqual(len(eligible), 6)
        self.assertEqual(
            {actor["kind"] for actor in eligible},
            {"division", "corps"},
            "The fixture favors six source-positioned formations over unsupported density.",
        )
        side_counts = {
            side["id"]: sum(actor["side_id"] == side["id"] for actor in eligible)
            for side in battle["sides"]
        }
        self.assertTrue(all(count >= 2 for count in side_counts.values()))

        movements = battle["movements"]
        events_by_id = {event["id"]: event for event in battle["historical_events"]}
        movement_actor_ids = {movement["actor_id"] for movement in movements}
        self.assertGreaterEqual(len(movement_actor_ids), 4)
        self.assertTrue(all(
            movement["precision"] == "inferred" and movement["confidence"] <= 0.5
            for movement in movements
        ))
        movements_by_actor = {}
        for movement in movements:
            movements_by_actor.setdefault(movement["actor_id"], []).append(movement)
            self.assertTrue(
                {"source_wacht_am_rhein_map", "source_us_army_ardennes_alsace"}
                <= set(events_by_id[movement["event_id"]]["source_ids"]),
            )
            coordinates = movement["path"]["coordinates"]
            waypoint_times = movement["waypoint_times"]
            self.assertEqual(len(coordinates), len(waypoint_times))
            parsed = [datetime.fromisoformat(value) for value in waypoint_times]
            self.assertTrue(all(left < right for left, right in zip(parsed, parsed[1:])))
        recurring = [items for items in movements_by_actor.values() if len(items) >= 2]
        self.assertGreaterEqual(len(recurring), 2)
        for items in recurring:
            ordered = sorted(items, key=lambda item: item["time"]["start"])
            self.assertLessEqual(
                datetime.fromisoformat(ordered[0]["time"]["end"]),
                datetime.fromisoformat(ordered[1]["time"]["start"]),
            )

        sources = {source["id"]: source for source in battle["sources"]}
        map_source = sources["source_wacht_am_rhein_map"]
        self.assertIn("source-map traces", map_source["note"])
        self.assertIn("runtime-derived", map_source["note"])
        self.assertIn("not serialized", map_source["note"])
        self.assertIn("CC BY-SA 3.0", map_source["license"])
        self.assertTrue(all(
            "source_wacht_am_rhein_map" in snapshot["source_ids"]
            for snapshot in snapshots
        ))

        errors, warnings = validate_document_with_warnings(battle)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

        script = """
            import fs from "node:fs";
            import { validateBattle } from "./app/animate.js";
            import { deriveFrontlineFallback } from "./app/frontlines.js";
            import { compileTimeline, sampleTimeline } from "./app/timeline.js";
            const battle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const diagnostics = validateBattle(battle);
            const compiled = compileTimeline(battle);
            const deriveAt = (iso) => {
              const sampled = sampleTimeline(compiled, compiled.toPresentationTime(Date.parse(iso)));
              const positions = new Map([...sampled.actorPositions].filter(([actorId]) =>
                compiled.explicitStartingPositionActorIds.has(actorId)));
              return { sampled, positions, derived: deriveFrontlineFallback({
                actors: battle.actors,
                positions,
                bounds: [[4.8, 49.8], [6.7, 50.9]],
                gridSize: 40,
              }) };
            };
            const snapshotSamples = battle.frontline_snapshots.map((snapshot) => {
              const result = deriveAt(`${snapshot.time.start}T00:00:00Z`);
              const sourceCoordinates = snapshot.front_lines.map((line) => line.geometry.coordinates);
              return {
                date: snapshot.time.start,
                positions: Object.fromEntries(result.positions),
                available: result.derived.available,
                reason: result.derived.reason,
                sideIds: [...new Set(result.derived.influences.map(({ sideId }) => sideId))].sort(),
                contactLineCount: result.derived.contactLines.length,
                sourceDiffersFromDerived: sourceCoordinates.every((sourceLine) =>
                  result.derived.contactLines.every((derivedLine) =>
                    JSON.stringify(sourceLine) !== JSON.stringify(derivedLine))),
              };
            });
            const midpoint = deriveAt("1944-12-22T00:00:00Z");
            const crossTime = deriveAt("1944-12-23T12:00:00Z");
            console.log(JSON.stringify({
              diagnostics,
              keyframeCount: compiled.frontlineKeyframes.length,
              explicitActorIds: [...compiled.explicitStartingPositionActorIds].sort(),
              snapshotSamples,
              labelPositions: Object.fromEntries(midpoint.positions),
              midpoint: {
                available: midpoint.derived.available,
                reason: midpoint.derived.reason,
                sideIds: [...new Set(midpoint.derived.influences.map(({ sideId }) => sideId))].sort(),
                contactLineCount: midpoint.derived.contactLines.length,
              },
              crossTimeDerivedLines: crossTime.derived.contactLines,
            }));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(BULGE_EXAMPLE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        browser = json.loads(result.stdout)
        self.assertEqual(browser["diagnostics"], {"errors": [], "warnings": []})
        self.assertEqual(browser["keyframeCount"], 3)
        self.assertFalse(browser["midpoint"]["available"])
        self.assertEqual(browser["midpoint"]["reason"], "interleaved-sides")
        self.assertEqual(browser["midpoint"]["sideIds"], ["side_allied", "side_german"])
        self.assertEqual(browser["midpoint"]["contactLineCount"], 0)
        actor_ids = sorted(actor["id"] for actor in battle["actors"])
        actor_sides = {actor["id"]: actor["side_id"] for actor in battle["actors"]}
        self.assertEqual(browser["explicitActorIds"], actor_ids)
        for sample in browser["snapshotSamples"]:
            self.assertEqual(sorted(sample["positions"]), actor_ids)
            self.assertTrue(all(
                sum(actor_sides[actor_id] == side["id"] for actor_id in sample["positions"]) >= 2
                for side in battle["sides"]
            ))
            self.assertEqual(len({tuple(position) for position in sample["positions"].values()}), 6)
            self.assertTrue(all(4.8 <= lon <= 6.7 and 49.8 <= lat <= 50.9
                                for lon, lat in sample["positions"].values()))
            self.assertEqual(sample["sideIds"], ["side_allied", "side_german"])
            if sample["date"] == "1944-12-25":
                self.assertFalse(sample["available"])
                self.assertEqual(sample["reason"], "interleaved-sides")
                self.assertEqual(sample["contactLineCount"], 0)
            else:
                self.assertTrue(sample["available"])
                self.assertIsNone(sample["reason"])
                self.assertEqual(sample["contactLineCount"], 1)
            self.assertTrue(sample["sourceDiffersFromDerived"])
        self.assertEqual(sorted(browser["labelPositions"]), actor_ids)
        self.assertTrue(all(4.8 <= lon <= 6.7 and 49.8 <= lat <= 50.9
                            for lon, lat in browser["labelPositions"].values()))
        self.assertEqual(
            len({tuple(position) for position in browser["labelPositions"].values()}),
            6,
            "Renderer labels need distinct positions at 22 December.",
        )
        out_of_region = deepcopy(battle)
        movement = out_of_region["movements"][0]
        movement["path"]["coordinates"] = [[0, 0], [1, 1], [2, 2]]
        with self.assertRaises(AssertionError):
            self._assert_bulge_reference_provenance(out_of_region)

        self.assertEqual(browser["crossTimeDerivedLines"], [])

    def test_modern_border_asset_is_geometry_only_natural_earth(self):
        path = ROOT / "app" / "data" / "modern-borders-50m.geojson"
        serialized = path.read_text(encoding="utf-8")
        borders = json.loads(serialized)

        self.assertEqual(borders["type"], "FeatureCollection")
        self.assertGreater(len(borders["features"]), 200)
        self.assertNotIn("crs", borders)
        for feature in borders["features"]:
            self.assertEqual(feature["properties"], {})
            self.assertTrue(feature["geometry"])
            self.assertNotIn("bbox", feature)
        for key in ("NAME", "ADMIN", "POP_EST", "SOVEREIGNT"):
            self.assertNotIn(f'"{key}"', serialized)

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

    def test_current_json_prompt_uses_schema_version_only(self):
        prompt = (ROOT / "docs/battle-json-prompt.md").read_text(encoding="utf-8")
        self.assertIn("# Battle JSON Generation Prompt", prompt)
        self.assertIn('`schema_version` must be the string `"0.4.0"`', prompt)
        self.assertIn("metadata.source_system` identifies the actual source collection", prompt)
        self.assertNotIn("Prompt version", prompt)
        self.assertNotIn("prompt_version", prompt)
        return
        readme, prompt, sample = self._readme_prompt_sample()

        for required in (
            "New documents use the current JSON schema version only",
            'schema_version 固定使用字串 "0.4.0"',
            "metadata.source_system 應標示實際來源系統，不得使用 prompt 版本",
            "只輸出一個標記為 json 的 Markdown 程式碼區塊",
            "程式碼區塊內只能放最終 JSON 物件",
            "唯一例外",
            "無法實際讀取 URL",
            "請使用者貼上頁面文字",
            "retrieved_at 必須填寫實際取得資料的日期",
            "缺少必要的 title、url 或 license",
            "不得生成 JSON",
            "required 欄位不能省略",
            "省略整筆 movement",
            "也不符合下方 inferred 代表性路徑規則",
            "engagement 只有 attacker_actor_id、target_actor_id 與 type 都有來源直接支持時才建立",
            "result 只有在來源直接支持結果時才填寫",
            "來源未記載結果時省略 result，仍可保留有來源支持的 engagement",
            "historical_events[].source_ids 必須是非空陣列",
            "outcome.source_ids 必須是非空陣列",
            "每筆 engagement.source_ids 必須是非空陣列",
            "movements 沒有 source_ids；每筆 movement 必須由其 event_id 所連結 historical_event 的 source_ids 支持",
            "waypoint_times 的數量必須與 path.coordinates 完全相同，且時間嚴格遞增",
            "不要輸出 Emoji、SVG、data URL 或詞彙表以外的名稱",
            'precision:"inferred"',
            '"schema_version": "0.4.0"',
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
            "沒有來源支持的 actor、engagement 或艦種／兵種分類必須省略",
            "只有 result 缺少來源支持時只省略 result",
            "frontline_snapshots[]（選填）",
            "*id *time *precision *confidence *source_ids, event_id, front_lines, control_areas",
            "front_lines[]: *id *geometry",
            "control_areas[]: *id *side_id *geometry",
            "直接支持該時刻戰線或控制區的來源",
            "不得從戰果敘述推導出精確包圍圈",
            "不得從 casualties、strength 或 outcome 推算 control_areas",
            "0.1.0、0.2.0 與 0.3.0 只供 app 讀取舊文件",
            "本提示詞只輸出 0.4.0",
            "不得從單位點位生成 frontline_snapshots",
            "同一單位跨階段保持相同 actor id",
            "AI 只整理有來源支持的事實與明確由證據支持的推估",
            "低 confidence 不是虛構資料的許可",
            "不得為了動畫平滑而編造單位、事件、時間、轉折點或路徑",
            "只有直接支持特定日期／時刻戰線的來源地圖才可建立",
            "來源同時支持細緻單位／movements 與來源戰線快照時，兩者都要保留",
            "同一條戰線只有在來源支持連續性時，才跨 snapshot 沿用相同 id",
            "無法確認連續性時必須使用不同 id",
            "優先蒐集多個有明確日期的來源地圖作為時間錨點",
            "不要把同一張地圖自行變形成多個快照",
            "不要為了延長動畫虛構中間快照",
            "不得從單位位置推導突出部、包圍圈或控制區",
            "只有文字記載而沒有地圖輪廓時，只建立事件，不建立戰線幾何",
            "推導戰線不得寫入 frontline_snapshots",
            "來源錨點之間只做來源幾何的時間插值",
            "每個來源錨點保留原始幾何",
            "source_ids、precision 與 confidence",
        ):
            self.assertIn(required, prompt)
        self.assertEqual(sample["schema_version"], "0.4.0")
        self.assertEqual(sample["metadata"]["source_system"], "wikipedia")
        for obsolete in (
            "battle-animation-schema v0.1.0／v0.2.0／v0.3.0",
            '基本資料使用 "0.1.0"',
            "confidence <= 0.6",
            '"retrieved_at": "2026-06-22"',
        ):
            self.assertNotIn(obsolete, prompt)
        self.assertNotIn('"prompt_version"', prompt)
        self.assertNotIn("battle_json_prompt_1.3.2", prompt)
        self.assertNotIn("attacker、target、action", prompt)
        self.assertNotIn("不要程式碼框", prompt)
        self.assertNotIn("attacker、target、type 與 result 任一缺少來源支持", prompt)
        self.assertNotIn("Battle JSON Prompt 1.1.0", prompt)
        self.assertNotIn("battle_json_prompt_1.1.0", prompt)
        self.assertEqual(set(re.findall(r"confidence <= (0\.\d+)", prompt)), {"0.5"})
        self.assertRegex(
            prompt,
            r"frontline_snapshots.*選填.*沒有直接支持.*省略",
        )
        token_paragraph = re.search(
            r"actor_icons 只能使用以下 21 個受控名稱：\n(?P<tokens>.*?unit_generic。)",
            prompt,
            re.DOTALL,
        )
        self.assertIsNotNone(token_paragraph)
        documented_token_list = re.findall(
            r"\b[a-z][a-z0-9_]*\b", token_paragraph.group("tokens")
        )
        self.assertEqual(len(documented_token_list), len(ACTOR_ICON_TOKENS))
        self.assertEqual(set(documented_token_list), ACTOR_ICON_TOKENS)
        self.assertNotIn("寧可多給細節", prompt)
        self.assertNotIn("強烈建議提供", prompt)
        self.assertRegex(
            prompt,
            r"師／旅級.*?代表位置.*?movements",
        )
        for stale_emoji in ("🚢", "⛵", "🪖", "🐎", "💥", "🛡️", "✈️", "🏰", "🚩"):
            self.assertNotIn(stale_emoji, prompt)

        script = """
            import { deriveFrontlineFallback } from "./app/frontlines.js";
            import { compileTimeline, sampleTimeline } from "./app/timeline.js";
            let input = "";
            process.stdin.setEncoding("utf8");
            for await (const chunk of process.stdin) input += chunk;
            const battle = JSON.parse(input);
            const deriveAt = (document) => {
              const timeline = compileTimeline(document);
              const presentationMs = timeline.toPresentationTime(Date.parse("1900-01-01T10:30:00Z"));
              const sampled = sampleTimeline(timeline, presentationMs);
              const derived = deriveFrontlineFallback({
                actors: document.actors,
                positions: sampled.actorPositions,
              });
              return {
                available: derived.available,
                influences: derived.influences.map(({ actorId, sideId }) => ({ actorId, sideId })),
                contactLineCount: derived.contactLines.length,
              };
            };
            const mutated = JSON.parse(JSON.stringify(battle));
            mutated.actors.forEach((actor, index) => {
              actor.kind = index % 2 === 0 ? "unit" : "ship";
            });
            console.log(JSON.stringify({ eligible: deriveAt(battle), mutated: deriveAt(mutated) }));
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
        production_frontlines = json.loads(result.stdout)
        eligible = production_frontlines["eligible"]
        self.assertTrue(eligible["available"])
        self.assertEqual(len(eligible["influences"]), 4)
        self.assertEqual({item["sideId"] for item in eligible["influences"]}, {"side_a", "side_b"})
        self.assertGreater(eligible["contactLineCount"], 0)
        self.assertEqual(
            production_frontlines["mutated"],
            {"available": False, "influences": [], "contactLineCount": 0},
        )

        sides = {side["id"] for side in sample["sides"]}
        eligible_actor_ids = {item["actorId"] for item in eligible["influences"]}
        for side_id in sides:
            self.assertGreaterEqual(
                sum(
                    item["sideId"] == side_id
                    for item in eligible["influences"]
                ),
                2,
            )

        movements_by_actor = {}
        events_by_id = {event["id"]: event for event in sample["historical_events"]}
        self.assertTrue(all(event["source_ids"] for event in events_by_id.values()))
        self.assertTrue(sample["outcome"]["source_ids"])
        self.assertTrue(all(engagement["source_ids"] for engagement in sample.get("engagements", [])))
        for movement in sample["movements"]:
            self.assertTrue(events_by_id[movement["event_id"]]["source_ids"])
            self.assertEqual(
                len(movement["path"]["coordinates"]),
                len(movement["waypoint_times"]),
            )
            movements_by_actor.setdefault(movement["actor_id"], []).append(movement)
        recurring_actor_ids = []
        for actor_id, movements in movements_by_actor.items():
            if actor_id not in eligible_actor_ids:
                continue
            ordered = sorted(movements, key=lambda movement: movement["time"]["start"])
            if len(ordered) < 2 or len({movement["event_id"] for movement in ordered}) < 2:
                continue
            if all(
                datetime.fromisoformat(previous["time"]["end"]) <=
                datetime.fromisoformat(current["time"]["start"])
                for previous, current in zip(ordered, ordered[1:])
            ):
                recurring_actor_ids.append(actor_id)
        self.assertGreaterEqual(len(recurring_actor_ids), 2)

        def inferred_confidences(value):
            if isinstance(value, dict):
                if value.get("precision") == "inferred":
                    yield value["confidence"]
                for child in value.values():
                    yield from inferred_confidences(child)
            elif isinstance(value, list):
                for child in value:
                    yield from inferred_confidences(child)

        self.assertTrue(all(value <= 0.5 for value in inferred_confidences(sample)))
        source_notes = {source["id"]: source.get("note", "") for source in sample["sources"]}
        self.assertTrue(sample["frontline_snapshots"])
        for snapshot in sample["frontline_snapshots"]:
            for source_id in snapshot["source_ids"]:
                self.assertIn("直接支持", source_notes[source_id])
                self.assertIn("不是由單位點位推導", source_notes[source_id])

        for required in (
            "`hybrid→source→derived→off`",
            "`hybrid` is the default",
            "source-only interpolation between anchors",
            "unit positions never alter those intervals",
            "Before the first source snapshot",
            "holds the final known source geometry",
            "exist only in the renderer",
            "An inferred line traced from a dated source map remains source-backed evidence",
            "An app-derived line is different",
        ):
            self.assertIn(required, readme)

    def test_readme_embedded_v040_sample_validates_in_python_and_browser(self):
        _readme, _prompt, sample = self._readme_prompt_sample()

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
        self.assertIn('Literal["0.1.0", "0.2.0", "0.3.0", "0.4.0"]', source)
        self.assertIn("time: NotRequired[DateValue]", source)
        self.assertIn("waypoint_times: NotRequired[list[str]]", source)
        self.assertIn("historical_seconds_per_playback_second: float", source)
        self.assertIn("idle_compression_threshold_seconds: float", source)
        self.assertIn("idle_compressed_duration_ms: float", source)

    def test_schema_declares_v040_frontline_snapshots(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))

        self.assertIn("0.4.0", schema["properties"]["schema_version"]["enum"])
        snapshots = schema["properties"]["frontline_snapshots"]
        self.assertEqual(snapshots["items"]["$ref"], "#/$defs/FrontlineSnapshot")
        self.assertIn(
            {
                "if": {"required": ["frontline_snapshots"]},
                "then": {
                    "properties": {
                        "schema_version": {"const": "0.4.0"},
                    },
                },
            },
            schema["allOf"],
        )

        front_line = schema["$defs"]["FrontLine"]
        self.assertFalse(front_line["additionalProperties"])
        self.assertEqual(set(front_line["required"]), {"id", "geometry"})
        self.assertEqual(set(front_line["properties"]), {"id", "geometry"})
        self.assertEqual(front_line["properties"]["geometry"], {"$ref": "#/$defs/LineString"})

        control_area = schema["$defs"]["ControlArea"]
        self.assertFalse(control_area["additionalProperties"])
        self.assertEqual(set(control_area["required"]), {"id", "side_id", "geometry"})
        self.assertEqual(set(control_area["properties"]), {"id", "side_id", "geometry"})
        self.assertEqual(control_area["properties"]["geometry"], {"$ref": "#/$defs/Polygon"})

        snapshot = schema["$defs"]["FrontlineSnapshot"]
        self.assertFalse(snapshot["additionalProperties"])
        self.assertEqual(
            set(snapshot["required"]),
            {"id", "time", "precision", "confidence", "source_ids"},
        )
        self.assertEqual(
            set(snapshot["properties"]),
            {
                "id",
                "time",
                "event_id",
                "front_lines",
                "control_areas",
                "precision",
                "confidence",
                "source_ids",
            },
        )
        self.assertEqual(snapshot["properties"]["time"], {"$ref": "#/$defs/DateValue"})
        self.assertEqual(snapshot["properties"]["front_lines"]["minItems"], 1)
        self.assertEqual(snapshot["properties"]["control_areas"]["minItems"], 1)
        self.assertEqual(snapshot["properties"]["source_ids"]["minItems"], 1)
        self.assertEqual(
            snapshot["anyOf"],
            [{"required": ["front_lines"]}, {"required": ["control_areas"]}],
        )
        self.assertEqual(validate_document(frontline_document()), [])

    def test_frontline_snapshot_requires_lines_or_control_areas(self):
        document = frontline_document()
        snapshot = document["frontline_snapshots"][0]
        del snapshot["front_lines"]
        del snapshot["control_areas"]

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.frontline_snapshots[0]"
                and error.message == "must include front_lines or control_areas"
                for error in errors
            )
        )

    def test_frontline_snapshot_references_must_resolve(self):
        cases = (
            (
                lambda snapshot: snapshot.__setitem__("event_id", "missing-event"),
                "$.frontline_snapshots[0].event_id",
                "unknown id 'missing-event'",
            ),
            (
                lambda snapshot: snapshot["control_areas"][0].__setitem__(
                    "side_id", "missing-side"
                ),
                "$.frontline_snapshots[0].control_areas[0].side_id",
                "unknown id 'missing-side'",
            ),
            (
                lambda snapshot: snapshot.__setitem__("source_ids", ["missing-source"]),
                "$.frontline_snapshots[0].source_ids[0]",
                "unknown source id 'missing-source'",
            ),
        )
        for mutate, expected_path, expected_message in cases:
            with self.subTest(path=expected_path):
                document = frontline_document()
                mutate(document["frontline_snapshots"][0])

                errors = validate_document(document)

                self.assertTrue(
                    any(
                        error.path == expected_path and error.message == expected_message
                        for error in errors
                    )
                )

    def test_structurally_invalid_frontline_references_do_not_raise(self):
        document = frontline_document()
        snapshot = document["frontline_snapshots"][0]
        snapshot["event_id"] = []
        snapshot["control_areas"][0]["side_id"] = {}
        snapshot["source_ids"] = [[]]

        try:
            errors = validate_document(document)
        except (TypeError, ValueError) as error:
            self.fail(f"validation raised for structurally invalid references: {error}")

        self.assertEqual(
            [
                (error.path, error.message)
                for error in errors
                if error.path.startswith("$.frontline_snapshots")
            ],
            [
                (
                    "$.frontline_snapshots[0].event_id",
                    "expected string, got list",
                ),
                (
                    "$.frontline_snapshots[0].control_areas[0].side_id",
                    "expected string, got dict",
                ),
                (
                    "$.frontline_snapshots[0].source_ids[0]",
                    "expected string, got list",
                ),
            ],
        )

    def test_frontline_snapshot_ids_must_be_unique(self):
        document = frontline_document()
        duplicate = deepcopy(document["frontline_snapshots"][0])
        duplicate["time"]["start"] = "1942-11-19T09:00:00Z"
        document["frontline_snapshots"].append(duplicate)

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.frontline_snapshots[1].id"
                and error.message == "duplicate id 'front_day_1'"
                for error in errors
            )
        )

    def test_frontline_shape_ids_must_be_unique_within_snapshot(self):
        cases = (
            (
                "front_lines",
                "$.frontline_snapshots[0].front_lines[1].id",
                "front_main",
            ),
            (
                "control_areas",
                "$.frontline_snapshots[0].control_areas[1].id",
                "area_a",
            ),
        )
        for collection, expected_path, duplicate_id in cases:
            with self.subTest(collection=collection):
                document = frontline_document()
                shapes = document["frontline_snapshots"][0][collection]
                shapes.append(deepcopy(shapes[0]))

                errors = validate_document(document)

                self.assertTrue(
                    any(
                        error.path == expected_path
                        and error.message == f"duplicate id {duplicate_id!r}"
                        for error in errors
                    )
                )

    def test_frontline_snapshot_starts_must_be_strictly_increasing(self):
        for start in ("1942-11-19T08:00:00Z", "1942-11-19T07:59:00Z"):
            with self.subTest(start=start):
                document = frontline_document()
                later = deepcopy(document["frontline_snapshots"][0])
                later["id"] = "front_day_2"
                later["front_lines"][0]["id"] = "front_second"
                later["control_areas"][0]["id"] = "area_second"
                later["time"]["start"] = start
                document["frontline_snapshots"].append(later)

                errors = validate_document(document)

                self.assertTrue(
                    any(
                        error.path == "$.frontline_snapshots[1].time.start"
                        and error.message == "values must be strictly increasing"
                        for error in errors
                    )
                )

    def test_missing_frontline_start_does_not_reset_ordering_baseline(self):
        for final_start in ("1942-11-19T08:00:00Z", "1942-11-19T07:59:00Z"):
            with self.subTest(final_start=final_start):
                document = frontline_document()
                first = document["frontline_snapshots"][0]
                missing = deepcopy(first)
                missing["id"] = "front_day_2"
                del missing["time"]["start"]
                final = deepcopy(first)
                final["id"] = "front_day_3"
                final["time"]["start"] = final_start
                document["frontline_snapshots"].extend([missing, final])

                errors, warnings = validate_document_with_warnings(document)

                self.assertTrue(
                    any(
                        error.path == "$.frontline_snapshots[2].time.start"
                        and error.message == "values must be strictly increasing"
                        for error in errors
                    )
                )
                self.assertTrue(
                    any(
                        warning.path == "$.frontline_snapshots[1].time"
                        and warning.message
                        == "snapshot without time.start is excluded from animation"
                        for warning in warnings
                    )
                )

    def test_frontline_snapshot_without_start_warns_but_remains_valid(self):
        document = frontline_document()
        del document["frontline_snapshots"][0]["time"]["start"]

        errors, warnings = validate_document_with_warnings(document)

        self.assertEqual(errors, [])
        self.assertEqual(
            [
                (warning.path, warning.message)
                for warning in warnings
                if "snapshot without time.start" in warning.message
            ],
            [(
                "$.frontline_snapshots[0].time",
                "snapshot without time.start is excluded from animation",
            )],
        )

    def test_malformed_frontline_snapshot_start_is_an_error_not_a_warning(self):
        document = frontline_document()
        document["frontline_snapshots"][0]["time"]["start"] = "not-a-date"

        errors, warnings = validate_document_with_warnings(document)

        self.assertTrue(
            any(
                error.path == "$.frontline_snapshots[0].time.start"
                and error.message == "invalid ISO battle time"
                for error in errors
            )
        )
        self.assertFalse(
            any("snapshot without time.start" in warning.message for warning in warnings)
        )

    def test_python_types_declare_v040_frontlines(self):
        self.assertEqual(FrontLine.__required_keys__, frozenset({"id", "geometry"}))
        self.assertEqual(FrontLine.__optional_keys__, frozenset())
        self.assertEqual(
            get_type_hints(FrontLine, include_extras=True),
            {"id": str, "geometry": LineString},
        )

        self.assertEqual(
            ControlArea.__required_keys__,
            frozenset({"id", "side_id", "geometry"}),
        )
        self.assertEqual(ControlArea.__optional_keys__, frozenset())
        self.assertEqual(
            get_type_hints(ControlArea, include_extras=True),
            {"id": str, "side_id": str, "geometry": Polygon},
        )

        self.assertEqual(
            FrontlineSnapshot.__required_keys__,
            frozenset({"id", "time", "precision", "confidence", "source_ids"}),
        )
        self.assertEqual(
            FrontlineSnapshot.__optional_keys__,
            frozenset({"event_id", "front_lines", "control_areas"}),
        )
        snapshot_hints = get_type_hints(FrontlineSnapshot, include_extras=True)
        self.assertEqual(
            snapshot_hints,
            {
                "id": str,
                "time": DateValue,
                "precision": Precision,
                "confidence": float,
                "source_ids": list[str],
                "event_id": NotRequired[str],
                "front_lines": NotRequired[list[FrontLine]],
                "control_areas": NotRequired[list[ControlArea]],
            },
        )

        self.assertEqual(
            BattleAnimationDocument.__required_keys__,
            frozenset({
                "schema_version",
                "metadata",
                "battle",
                "sides",
                "commanders",
                "actors",
                "places",
                "historical_events",
                "movements",
                "outcome",
                "sources",
                "animation_hints",
            }),
        )
        self.assertEqual(
            BattleAnimationDocument.__optional_keys__,
            frozenset({"engagements", "frontline_snapshots"}),
        )
        document_hints = get_type_hints(BattleAnimationDocument, include_extras=True)
        self.assertEqual(
            document_hints["schema_version"],
            Literal["0.1.0", "0.2.0", "0.3.0", "0.4.0"],
        )
        self.assertEqual(
            document_hints["frontline_snapshots"],
            NotRequired[list[FrontlineSnapshot]],
        )

    def test_validator_accepts_v030_movement_and_timeline_timing(self):
        self.assertEqual(validate_document(self._valid_v030_document()), [])

    def test_python_validator_rejects_unknown_camera_event_reference(self):
        document = self._valid_v030_document()
        document["animation_hints"]["camera"][0]["event_id"] = "missing-event"

        errors = validate_document(document)

        self.assertTrue(
            any(
                error.path == "$.animation_hints.camera[0].event_id"
                and error.message == "unknown id 'missing-event'"
                for error in errors
            )
        )

    def test_python_validator_rejects_nonfinite_camera_numbers(self):
        cases = (
            ("center longitude NaN", ("center", 0), math.nan, "$.animation_hints.camera[0].center[0]"),
            ("center latitude infinity", ("center", 1), math.inf, "$.animation_hints.camera[0].center[1]"),
            ("zoom NaN", ("zoom", None), math.nan, "$.animation_hints.camera[0].zoom"),
            ("zoom infinity", ("zoom", None), math.inf, "$.animation_hints.camera[0].zoom"),
        )
        for label, (field, index), value, expected_path in cases:
            with self.subTest(label=label):
                document = self._valid_v030_document()
                camera = document["animation_hints"]["camera"][0]
                if index is None:
                    camera[field] = value
                else:
                    camera[field][index] = value

                errors = validate_document(document)

                self.assertTrue(
                    any(
                        error.path == expected_path
                        and error.message == "expected finite number"
                        for error in errors
                    )
                )

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

    def test_frontline_snapshots_require_v040(self):
        for version in ("0.1.0", "0.2.0", "0.3.0"):
            with self.subTest(version=version):
                document = frontline_document()
                document["schema_version"] = version
                errors = validate_document(document)
                self.assertTrue(any(
                    error.path == "$.frontline_snapshots"
                    and error.message == "requires schema_version '0.4.0'"
                    for error in errors
                ))
        self.assertFalse(any(
            error.path == "$.frontline_snapshots"
            for error in validate_document(frontline_document())
        ))

    def test_unknown_v040_actor_icon_token_is_warning_only(self):
        document = frontline_document()
        document["animation_hints"]["style"]["actor_icons"] = {
            document["actors"][0]["id"]: "army"
        }

        errors, warnings = validate_document_with_warnings(document)

        self.assertEqual(errors, [])
        self.assertTrue(any("unknown actor icon token 'army'" in warning.message for warning in warnings))

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

    def test_static_app_uses_road_free_hillshade_basemap(self):
        animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")
        styles = (ROOT / "app" / "styles.css").read_text(encoding="utf-8")

        self.assertNotIn("tile.openstreetmap.org", animate)
        self.assertIn(
            "https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
            animate,
        )
        self.assertIn(
            "Sources: Maxar, Airbus, USGS, NGA, NASA, CGIAR, NLS, OS, NMA, "
            "Geodatastyrelsen, GSA, GSI, Intermap, and the GIS User Community",
            animate,
        )
        self.assertIn('Powered by <a href="https://www.esri.com/">Esri</a>', animate)
        self.assertIn("Made with Natural Earth.", animate)
        self.assertNotIn("World_Shaded_Relief", animate)
        self.assertIn('loadBattle("./data/modern-borders-50m.geojson")', animate)
        self.assertEqual(animate.count("fetch("), 1)
        self.assertRegex(
            styles,
            r"(?s)#battle-map\s*\{[^}]*background:\s*#b7d4dc;",
        )

    def test_static_app_exposes_continuous_playback_controls(self):
        index = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "app" / "styles.css").read_text(encoding="utf-8")

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
        self.assertIn('<button id="focus-event-button" type="button" class="ghost" disabled>Focus event</button>', index)
        self.assertIn('<button id="modern-borders-button" type="button" class="ghost" aria-pressed="false">Modern borders: off</button>', index)
        fronts = '<button id="fronts-button" type="button" class="ghost" aria-pressed="false" disabled>Fronts: hybrid</button>'
        self.assertIn(fronts, index)
        self.assertGreater(index.index(fronts), index.index("Modern borders: off"))
        for selector in (
            ".front-control-area",
            ".front-control-area.is-inferred",
            ".front-line.is-source-backed",
            ".front-line.is-inferred",
            ".frontline-confidence-label",
            ".frontline-layer[hidden]",
        ):
            self.assertIn(selector, styles)
        self.assertRegex(
            index,
            r'id="event-scrubber"[^>]*step="any"',
        )
        self.assertRegex(
            index,
            r'</div>\s*</div>\s*<section id="event-card-stack"[^>]*></section>\s*<aside class="inspector"',
        )
        self.assertRegex(
            styles.split("@media", 1)[0],
            r"(?s)\.playback-options\s*\{[^}]*\bflex-wrap:\s*wrap;",
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

    def test_readme_explains_source_enclosure_interpolation_is_display_only(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        for phrase in (
            "沿目標輪廓延伸",
            "不表示來源提供了中間合圍路徑",
            "只在後一個錨點完全閉合",
            "不播放額外揭示效果",
        ):
            self.assertIn(phrase, readme)

    def test_readme_documents_map_controls_and_sources(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        for phrase in (
            "Focus event",
            "When a single event has usable geography",
            "camera hint with both `center` and `zoom` takes priority",
            "Modern borders",
            "off by default",
            "not historical borders",
            "World Hillshade",
            "Natural Earth",
            "ca96624a56bd078437bca8184e78163e5039ad19",
        ):
            self.assertIn(phrase, readme)

        self.assertIn(
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            "ca96624a56bd078437bca8184e78163e5039ad19/"
            "geojson/ne_50m_admin_0_countries.geojson",
            readme,
        )
        self.assertNotIn("Leaflet + OpenStreetMap basemap", readme)

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

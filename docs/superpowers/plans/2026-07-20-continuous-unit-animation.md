# Continuous Unit-Level Battle Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backward-compatible `0.3.0` battle format and browser player that moves ship- and formation-level actors continuously along historically scaled trajectories with controlled SVG symbols, readable timing, and smooth camera behavior.

**Architecture:** Keep historical data in the schema and compile it into a pure, deterministic presentation timeline before rendering. Split the current large renderer into focused timeline and symbol modules; `animate.js` remains the Leaflet/SVG adapter and controller. Preserve `0.1.0`/`0.2.0` through explicit timing and symbol fallbacks.

**Tech Stack:** JSON Schema draft 2020-12, Python 3.10+ standard library and `unittest`, vanilla ES modules, Node's built-in `node:test`, SVG, Leaflet 1.9.4, CSS.

---

## File Structure

- Modify `schemas/battle-animation-schema.json` — declare schema `0.3.0`, movement timing, and playback hints.
- Modify `battle_animation/types.py` — mirror every schema addition in `TypedDict` types.
- Modify `battle_animation/validator.py` — add semantic timing checks, recoverable warnings, and CLI warning output.
- Create `app/timeline.js` — parse battle-local timestamps, compile time warps and actor tracks, and sample deterministic state.
- Create `app/symbols.js` — own the controlled token catalog, fallback rules, SVG geometry, and heading behavior.
- Modify `app/animate.js` — render normalized timeline state using `requestAnimationFrame`; retain Leaflet and battle drawing responsibilities.
- Modify `app/index.html` — expose continuous scrub, speed, follow, warnings, and event-card stack controls.
- Modify `app/styles.css` — style SVG symbols, playback controls, warnings, event cards, and zoom-dependent labels.
- Modify `examples/battle-of-甲午海戰.json` — provide the complete `0.3.0` individual-ship demonstration.
- Modify `README.md` — document `0.3.0` and update the LLM prompt contract and example.
- Modify `tests/test_mvp_contract.py` — cover the Python/schema/docs/example contract and backward compatibility.
- Create `tests/test_timeline.mjs` — test the pure JavaScript timeline compiler.
- Create `tests/test_symbols.mjs` — test controlled tokens and fallbacks without a DOM.

## Task 1: Extend the Schema and Python Types

**Files:**
- Modify: `schemas/battle-animation-schema.json`
- Modify: `battle_animation/types.py`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing contract tests for `0.3.0`**

Add these constants and tests to `tests/test_mvp_contract.py`:

```python
YALU_EXAMPLE = ROOT / "examples" / "battle-of-甲午海戰.json"


def test_schema_declares_v030_movement_timing(self):
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    self.assertIn("0.3.0", schema["properties"]["schema_version"]["enum"])
    movement = schema["$defs"]["Movement"]["properties"]
    self.assertEqual(movement["time"], {"$ref": "#/$defs/DateValue"})
    self.assertEqual(movement["waypoint_times"]["items"]["type"], "string")
    timeline = schema["$defs"]["AnimationHints"]["properties"]["timeline"]["properties"]
    self.assertEqual(timeline["historical_seconds_per_playback_second"]["exclusiveMinimum"], 0)
    self.assertEqual(timeline["idle_compression_threshold_seconds"]["minimum"], 0)
    self.assertEqual(timeline["idle_compressed_duration_ms"]["minimum"], 0)


def test_python_types_declare_v030_fields(self):
    source = (ROOT / "battle_animation" / "types.py").read_text(encoding="utf-8")
    self.assertIn('Literal["0.1.0", "0.2.0", "0.3.0"]', source)
    self.assertIn("time: NotRequired[DateValue]", source)
    self.assertIn("waypoint_times: NotRequired[list[str]]", source)
    self.assertIn("historical_seconds_per_playback_second: float", source)
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_schema_declares_v030_movement_timing \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_python_types_declare_v030_fields -v
```

Expected: two failures because `0.3.0`, movement timing, and timeline hint fields do not exist.

- [ ] **Step 3: Add the schema fields**

In `schemas/battle-animation-schema.json`:

```json
"schema_version": {
  "type": "string",
  "enum": ["0.1.0", "0.2.0", "0.3.0"]
}
```

Add to `$defs.Movement.properties`:

```json
"time": {
  "$ref": "#/$defs/DateValue"
},
"waypoint_times": {
  "type": "array",
  "minItems": 2,
  "items": {
    "type": "string"
  }
}
```

Add to `$defs.AnimationHints.properties.timeline.properties`:

```json
"historical_seconds_per_playback_second": {
  "type": "number",
  "exclusiveMinimum": 0
},
"idle_compression_threshold_seconds": {
  "type": "number",
  "minimum": 0
},
"idle_compressed_duration_ms": {
  "type": "number",
  "minimum": 0
}
```

The hand-written validator does not yet implement `exclusiveMinimum`; add support beside `_validate_number`'s existing minimum check:

```python
exclusive_minimum = schema.get("exclusiveMinimum")
if exclusive_minimum is not None and value <= exclusive_minimum:
    errors.append(ValidationError(path, f"expected value > {exclusive_minimum}"))
```

- [ ] **Step 4: Mirror the fields in `types.py`**

Change `Movement`, `AnimationTimelineHints`, and the document version literal to:

```python
class Movement(TypedDict):
    id: Identifier
    event_id: Identifier
    actor_id: Identifier
    path: LineString
    precision: Precision
    confidence: Confidence
    from_place_id: NotRequired[Identifier]
    to_place_id: NotRequired[Identifier]
    time: NotRequired[DateValue]
    waypoint_times: NotRequired[list[str]]


class AnimationTimelineHints(TypedDict, total=False):
    default_event_duration_ms: float
    ordered_event_ids: list[Identifier]
    historical_seconds_per_playback_second: float
    idle_compression_threshold_seconds: float
    idle_compressed_duration_ms: float


class BattleAnimationDocument(TypedDict):
    schema_version: Literal["0.1.0", "0.2.0", "0.3.0"]
    metadata: Metadata
    battle: Battle
    sides: list[Side]
    commanders: list[Commander]
    actors: list[Actor]
    places: list[Place]
    historical_events: list[HistoricalEvent]
    movements: list[Movement]
    outcome: Outcome
    sources: list[Source]
    animation_hints: AnimationHints
    engagements: NotRequired[list[Engagement]]
```

- [ ] **Step 5: Run contract tests**

Run: `python3 -m unittest tests/test_mvp_contract.py -v`

Expected: all existing and new contract tests pass.

- [ ] **Step 6: Commit the contract change**

```bash
git add schemas/battle-animation-schema.json battle_animation/types.py battle_animation/validator.py tests/test_mvp_contract.py
git commit -m "feat: add schema v0.3 movement timing"
```

## Task 2: Add Semantic Validation and Warnings

**Files:**
- Modify: `battle_animation/validator.py`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing tests for fatal timing errors and warnings**

Add imports and helpers to `tests/test_mvp_contract.py`:

```python
from copy import deepcopy

from battle_animation.validator import validate_document_with_warnings


def _minimal_timed_document(self):
    document = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["schema_version"] = "0.3.0"
    movement = document["movements"][0]
    movement["time"] = {
        "label": "10:00–10:10",
        "start": "1815-06-18T10:00:00",
        "end": "1815-06-18T10:10:00",
        "precision": "range",
        "confidence": 0.5,
    }
    movement["waypoint_times"] = [
        "1815-06-18T10:00:00",
        "1815-06-18T10:10:00",
    ]
    movement["precision"] = "inferred"
    return document
```

Add these test methods:

```python
def test_waypoint_count_mismatch_is_fatal(self):
    document = self._minimal_timed_document()
    document["movements"][0]["waypoint_times"] = ["1815-06-18T10:00:00"]
    errors, warnings = validate_document_with_warnings(document)
    self.assertTrue(any("must match path coordinate count" in str(e) for e in errors))
    self.assertEqual(warnings, [])


def test_non_monotonic_waypoint_times_are_fatal(self):
    document = self._minimal_timed_document()
    document["movements"][0]["waypoint_times"] = [
        "1815-06-18T10:10:00",
        "1815-06-18T10:00:00",
    ]
    errors, _ = validate_document_with_warnings(document)
    self.assertTrue(any("strictly increasing" in str(e) for e in errors))


def test_unknown_v030_icon_and_high_inferred_confidence_warn(self):
    document = self._minimal_timed_document()
    actor_id = document["actors"][0]["id"]
    document["animation_hints"]["style"]["actor_icons"] = {actor_id: "🚢"}
    document["movements"][0]["time"]["confidence"] = 0.9
    errors, warnings = validate_document_with_warnings(document)
    self.assertEqual(errors, [])
    messages = [str(w) for w in warnings]
    self.assertTrue(any("unknown v0.3 actor icon token" in m for m in messages))
    self.assertTrue(any("inferred time confidence must be <= 0.6" in m for m in messages))


def test_conflicting_actor_movement_overlap_is_fatal(self):
    document = self._minimal_timed_document()
    second = deepcopy(document["movements"][0])
    second["id"] = "overlap"
    second["path"]["coordinates"] = [[9, 9], [10, 10]]
    second["time"]["start"] = "1815-06-18T10:05:00"
    second["time"]["end"] = "1815-06-18T10:15:00"
    second["waypoint_times"] = ["1815-06-18T10:05:00", "1815-06-18T10:15:00"]
    document["movements"].append(second)
    errors, _ = validate_document_with_warnings(document)
    self.assertTrue(any("conflicting overlapping movements" in str(e) for e in errors))
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
python3 -m unittest \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_waypoint_count_mismatch_is_fatal \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_non_monotonic_waypoint_times_are_fatal \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_unknown_v030_icon_and_high_inferred_confidence_warn \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_conflicting_actor_movement_overlap_is_fatal -v
```

Expected: import failure because `validate_document_with_warnings` does not exist.

- [ ] **Step 3: Implement warnings and battle-local time parsing**

Add beside `ValidationError` in `battle_animation/validator.py`:

```python
from datetime import datetime, timezone


class ValidationWarning(ValueError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


ACTOR_ICON_TOKENS = {
    "warship_generic", "warship_ironclad", "warship_battleship",
    "warship_armored_cruiser", "warship_protected_cruiser",
    "warship_destroyer", "warship_torpedo_boat", "naval_transport",
    "fleet_generic", "infantry", "cavalry", "artillery", "armor",
    "engineer", "logistics", "headquarters", "fortress", "aircraft",
    "aircraft_fighter", "aircraft_bomber", "unit_generic",
}


def _parse_battle_time(value: str) -> float:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000
```

Replace `validate_document` with a compatibility wrapper and add semantic validation:

```python
def validate_document(document: Any, schema: dict[str, Any] | None = None) -> list[ValidationError]:
    errors, _ = validate_document_with_warnings(document, schema)
    return errors


def validate_document_with_warnings(
    document: Any, schema: dict[str, Any] | None = None
) -> tuple[list[ValidationError], list[ValidationWarning]]:
    schema = schema or load_json(DEFAULT_SCHEMA)
    errors: list[ValidationError] = []
    warnings: list[ValidationWarning] = []
    _validate(document, schema, schema, "$", errors)
    _validate_references(document, errors)
    _validate_timing(document, errors, warnings)
    _validate_movement_overlaps(document, errors, warnings)
    _validate_icon_tokens(document, warnings)
    return errors, warnings


def _validate_timing(document: Any, errors: list[ValidationError], warnings: list[ValidationWarning]) -> None:
    if not isinstance(document, dict):
        return
    for index, movement in enumerate(document.get("movements", [])):
        path = f"$.movements[{index}]"
        time = movement.get("time")
        parsed_start = parsed_end = None
        if isinstance(time, dict):
            try:
                parsed_start = _parse_battle_time(time["start"]) if time.get("start") else None
                parsed_end = _parse_battle_time(time["end"]) if time.get("end") else None
            except (TypeError, ValueError):
                errors.append(ValidationError(f"{path}.time", "invalid ISO date-time"))
            if parsed_start and parsed_end and parsed_end < parsed_start:
                errors.append(ValidationError(f"{path}.time", "end must not precede start"))
            if movement.get("precision") == "inferred" and time.get("confidence", 0) > 0.6:
                warnings.append(ValidationWarning(f"{path}.time", "inferred time confidence must be <= 0.6"))
        waypoint_times = movement.get("waypoint_times")
        if waypoint_times is None:
            continue
        coordinates = movement.get("path", {}).get("coordinates", [])
        if len(waypoint_times) != len(coordinates):
            errors.append(ValidationError(f"{path}.waypoint_times", "count must match path coordinate count"))
            continue
        try:
            parsed = [_parse_battle_time(value) for value in waypoint_times]
        except (TypeError, ValueError):
            errors.append(ValidationError(f"{path}.waypoint_times", "contains invalid ISO date-time"))
            continue
        if any(right <= left for left, right in zip(parsed, parsed[1:])):
            errors.append(ValidationError(f"{path}.waypoint_times", "values must be strictly increasing"))
        if parsed_start and parsed and parsed[0] < parsed_start:
            errors.append(ValidationError(f"{path}.waypoint_times", "first value precedes movement start"))
        if parsed_end and parsed and parsed[-1] > parsed_end:
            errors.append(ValidationError(f"{path}.waypoint_times", "last value follows movement end"))

    for collection in ("historical_events", "engagements"):
        for index, item in enumerate(document.get(collection, [])):
            time = item.get("time")
            if not isinstance(time, dict):
                continue
            path = f"$.{collection}[{index}].time"
            try:
                start = _parse_battle_time(time["start"]) if time.get("start") else None
                end = _parse_battle_time(time["end"]) if time.get("end") else None
            except (TypeError, ValueError):
                errors.append(ValidationError(path, "invalid ISO date-time"))
                continue
            if start is not None and end is not None and end < start:
                errors.append(ValidationError(path, "end must not precede start"))


def _validate_icon_tokens(document: Any, warnings: list[ValidationWarning]) -> None:
    if not isinstance(document, dict) or document.get("schema_version") != "0.3.0":
        return
    icons = document.get("animation_hints", {}).get("style", {}).get("actor_icons", {})
    for actor_id, token in icons.items():
        if token not in ACTOR_ICON_TOKENS:
            warnings.append(ValidationWarning(
                f"$.animation_hints.style.actor_icons.{actor_id}",
                f"unknown v0.3 actor icon token {token!r}",
            ))


def _validate_movement_overlaps(
    document: Any, errors: list[ValidationError], warnings: list[ValidationWarning]
) -> None:
    if not isinstance(document, dict):
        return
    by_actor: dict[str, list[tuple[float, float, int, list[Any]]]] = {}
    for index, movement in enumerate(document.get("movements", [])):
        time = movement.get("time", {})
        if not time.get("start") or not time.get("end"):
            continue
        try:
            start = _parse_battle_time(time["start"])
            end = _parse_battle_time(time["end"])
        except (TypeError, ValueError):
            continue
        points = movement.get("path", {}).get("coordinates", [])
        by_actor.setdefault(movement.get("actor_id", ""), []).append((start, end, index, points))
    for tracks in by_actor.values():
        tracks.sort(key=lambda item: (item[0], item[1]))
        for previous, current in zip(tracks, tracks[1:]):
            if current[0] >= previous[1]:
                continue
            same_boundary = bool(previous[3] and current[3] and previous[3][-1] == current[3][0])
            path = f"$.movements[{current[2]}].time"
            if same_boundary:
                warnings.append(ValidationWarning(path, "overlap resolved in favor of later movement"))
            else:
                errors.append(ValidationError(path, "conflicting overlapping movements for actor"))
```

- [ ] **Step 4: Print warnings without failing the CLI**

In `main`, replace the validation call and success block with:

```python
errors, warnings = validate_document_with_warnings(document, schema)
for warning in warnings:
    print(f"warning: {warning}", file=sys.stderr)
if errors:
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    return 1

print(f"valid: {args.document}")
return 0
```

- [ ] **Step 5: Run validator tests and the legacy CLI test**

Run: `python3 -m unittest tests/test_mvp_contract.py -v`

Expected: all tests pass; the Waterloo CLI still exits `0` and prints `valid:`.

- [ ] **Step 6: Commit semantic validation**

```bash
git add battle_animation/validator.py tests/test_mvp_contract.py
git commit -m "feat: validate movement timing semantics"
```

## Task 3: Build the Pure Timeline Compiler

**Files:**
- Create: `app/timeline.js`
- Create: `tests/test_timeline.mjs`

- [ ] **Step 1: Write failing time parsing and interpolation tests**

Create `tests/test_timeline.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  compileTimeline,
  parseBattleTime,
  sampleTimeline,
} from "../app/timeline.js";

const document = {
  actors: [{ id: "ship_a", kind: "ship" }],
  places: [{ id: "p", geometry: { type: "Point", coordinates: [120, 30] } }],
  historical_events: [{
    id: "e1",
    actor_ids: ["ship_a"],
    place_ids: ["p"],
    time: { label: "10:00–10:10", start: "1894-09-17T10:00:00", end: "1894-09-17T10:10:00" },
  }],
  movements: [{
    id: "m1",
    event_id: "e1",
    actor_id: "ship_a",
    path: { type: "LineString", coordinates: [[120, 30], [121, 30], [123, 30]] },
    time: { label: "10:00–10:10", start: "1894-09-17T10:00:00", end: "1894-09-17T10:10:00" },
  }],
  engagements: [],
  animation_hints: { timeline: { historical_seconds_per_playback_second: 60 } },
};

test("offset-free battle time is timezone-independent", () => {
  assert.equal(parseBattleTime("1894-09-17T10:00:00"), Date.UTC(1894, 8, 17, 10, 0, 0));
});

test("samples a polyline by cumulative distance", () => {
  const timeline = compileTimeline(document);
  const state = sampleTimeline(timeline, timeline.presentationDurationMs / 2);
  assert.deepEqual(state.actorPositions.get("ship_a").map((n) => Number(n.toFixed(3))), [121.5, 30]);
});
```

- [ ] **Step 2: Run the tests and verify module failure**

Run: `node --test tests/test_timeline.mjs`

Expected: failure with `ERR_MODULE_NOT_FOUND` for `app/timeline.js`.

- [ ] **Step 3: Implement parsing, effective movement ranges, and distance sampling**

Create `app/timeline.js` with these public functions and helpers:

```javascript
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

export function parseBattleTime(value) {
  if (typeof value !== "string") return null;
  const match = ISO_LOCAL.exec(value);
  if (match) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = match;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms.padEnd(3, "0"));
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cumulativeLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    const meanLat = ((points[i - 1][1] + points[i][1]) / 2) * Math.PI / 180;
    const dx = (points[i][0] - points[i - 1][0]) * Math.cos(meanLat);
    const dy = points[i][1] - points[i - 1][1];
    lengths.push(lengths[i - 1] + Math.hypot(dx, dy));
  }
  return lengths;
}

function pointAlong(points, lengths, ratio) {
  const target = lengths[lengths.length - 1] * Math.max(0, Math.min(1, ratio));
  let index = 1;
  while (index < lengths.length && lengths[index] < target) index += 1;
  if (index >= points.length) return [...points[points.length - 1]];
  const span = lengths[index] - lengths[index - 1] || 1;
  const local = (target - lengths[index - 1]) / span;
  return [
    points[index - 1][0] + (points[index][0] - points[index - 1][0]) * local,
    points[index - 1][1] + (points[index][1] - points[index - 1][1]) * local,
  ];
}

function effectiveRange(movement, event, previousEnd, legacyDurationMs) {
  const movementStart = parseBattleTime(movement.time?.start);
  const movementEnd = parseBattleTime(movement.time?.end);
  const eventStart = parseBattleTime(event?.time?.start);
  const eventEnd = parseBattleTime(event?.time?.end);
  const start = movementStart ?? eventStart ?? previousEnd;
  const end = movementEnd ?? eventEnd ?? start + legacyDurationMs;
  return { start, end: Math.max(start, end), synthetic: movementStart === null && eventStart === null };
}

export function compileTimeline(battle) {
  const events = new Map((battle.historical_events || []).map((event) => [event.id, event]));
  const legacyDurationMs = battle.animation_hints?.timeline?.default_event_duration_ms || 1800;
  const scale = battle.animation_hints?.timeline?.historical_seconds_per_playback_second || 60;
  const ordered = battle.animation_hints?.timeline?.ordered_event_ids || [...events.keys()];
  let previousEnd = 0;
  const tracks = [];
  for (const eventId of ordered) {
    for (const movement of (battle.movements || []).filter((item) => item.event_id === eventId)) {
      const range = effectiveRange(movement, events.get(eventId), previousEnd, legacyDurationMs);
      previousEnd = Math.max(previousEnd, range.end);
      const points = movement.path.coordinates;
      tracks.push({ ...range, actorId: movement.actor_id, eventId, points, lengths: cumulativeLengths(points) });
    }
  }
  const starts = tracks.map((track) => track.start);
  const ends = tracks.map((track) => track.end);
  const historicalStartMs = starts.length ? Math.min(...starts) : 0;
  const historicalEndMs = ends.length ? Math.max(...ends) : historicalStartMs + legacyDurationMs;
  return {
    battle,
    tracks,
    historicalStartMs,
    historicalEndMs,
    presentationDurationMs: (historicalEndMs - historicalStartMs) / scale,
    scale,
  };
}

export function sampleTimeline(timeline, presentationMs) {
  const historicalMs = timeline.historicalStartMs + presentationMs * timeline.scale;
  const actorPositions = new Map();
  for (const track of timeline.tracks) {
    if (historicalMs < track.start) {
      if (!actorPositions.has(track.actorId)) actorPositions.set(track.actorId, [...track.points[0]]);
      continue;
    }
    const ratio = track.end === track.start ? 1 : (historicalMs - track.start) / (track.end - track.start);
    actorPositions.set(track.actorId, pointAlong(track.points, track.lengths, ratio));
  }
  return { historicalMs, actorPositions };
}
```

Add a heading assertion to the same test file so map-axis orientation cannot regress:

```javascript
test("northbound heading rotates toward the top of the map", () => {
  const battle = structuredClone(document);
  battle.movements[0].path.coordinates = [[120, 30], [120, 31]];
  const timeline = compileTimeline(battle);
  const state = sampleTimeline(timeline, timeline.presentationDurationMs / 2);
  assert.equal(Number(state.headings.get("ship_a").toFixed(3)), Number((-Math.PI / 2).toFixed(3)));
});
```

- [ ] **Step 4: Add failing tests for waypoint timing, gap compression, legacy fallback, and persistent outcomes**

Append tests that clone `document` with `structuredClone`:

```javascript
test("compresses a long inactive historical gap", () => {
  const battle = structuredClone(document);
  battle.historical_events.push({
    id: "e2", actor_ids: ["ship_a"], place_ids: ["p"],
    time: { label: "12:00–12:10", start: "1894-09-17T12:00:00", end: "1894-09-17T12:10:00" },
  });
  battle.movements.push({
    id: "m2", event_id: "e2", actor_id: "ship_a",
    path: { type: "LineString", coordinates: [[123, 30], [124, 30]] },
    time: battle.historical_events[1].time,
  });
  battle.animation_hints.timeline.ordered_event_ids = ["e1", "e2"];
  battle.animation_hints.timeline.idle_compression_threshold_seconds = 900;
  battle.animation_hints.timeline.idle_compressed_duration_ms = 1200;
  const timeline = compileTimeline(battle);
  assert.equal(timeline.compressedGaps.length, 1);
  assert.equal(timeline.compressedGaps[0].presentationDurationMs, 1200);
});

test("uses waypoint timestamps instead of uniform path speed", () => {
  const battle = structuredClone(document);
  battle.movements[0].waypoint_times = [
    "1894-09-17T10:00:00", "1894-09-17T10:08:00", "1894-09-17T10:10:00",
  ];
  const timeline = compileTimeline(battle);
  const atEightMinutes = timeline.toPresentationTime(parseBattleTime("1894-09-17T10:08:00"));
  assert.deepEqual(sampleTimeline(timeline, atEightMinutes).actorPositions.get("ship_a"), [121, 30]);
});

test("legacy timing is marked synthetic", () => {
  const battle = structuredClone(document);
  delete battle.movements[0].time;
  delete battle.historical_events[0].time.start;
  delete battle.historical_events[0].time.end;
  const timeline = compileTimeline(battle);
  assert.equal(timeline.tracks[0].synthetic, true);
});
```

- [ ] **Step 5: Extend the compiler to pass the new tests**

Add a piecewise `timeWarp` array whose entries contain historical and presentation start/end values. Build active intervals from movement, engagement, and event boundaries; replace inactive gaps longer than the configured threshold with the configured presentation duration. Expose these exact functions:

```javascript
export function toPresentationTime(timeline, historicalMs) {
  const segment = timeline.timeWarp.find((item) => historicalMs <= item.historicalEnd) || timeline.timeWarp.at(-1);
  const ratio = segment.historicalEnd === segment.historicalStart
    ? 1
    : (historicalMs - segment.historicalStart) / (segment.historicalEnd - segment.historicalStart);
  return segment.presentationStart + ratio * (segment.presentationEnd - segment.presentationStart);
}

export function toHistoricalTime(timeline, presentationMs) {
  const segment = timeline.timeWarp.find((item) => presentationMs <= item.presentationEnd) || timeline.timeWarp.at(-1);
  const ratio = segment.presentationEnd === segment.presentationStart
    ? 1
    : (presentationMs - segment.presentationStart) / (segment.presentationEnd - segment.presentationStart);
  return segment.historicalStart + ratio * (segment.historicalEnd - segment.historicalStart);
}
```

Set `timeline.toPresentationTime = (value) => toPresentationTime(timeline, value)`, sample waypoint segments by their parsed timestamps, and return `activeEventIds`, `activeEngagementIds`, `persistentOutcomeActorIds`, `headings`, and `compressedGap` from `sampleTimeline`. Heading is `Math.atan2(-deltaLat, deltaLon)` in radians because north is negative screen Y. For destructive engagement results, add the victim when historical time reaches its effective end.

- [ ] **Step 6: Run timeline tests**

Run: `node --test tests/test_timeline.mjs`

Expected: all timeline tests pass with zero failures.

- [ ] **Step 7: Commit the timeline compiler**

```bash
git add app/timeline.js tests/test_timeline.mjs
git commit -m "feat: compile continuous battle timelines"
```

## Task 4: Build the Controlled SVG Symbol Catalog

**Files:**
- Create: `app/symbols.js`
- Create: `tests/test_symbols.mjs`

- [ ] **Step 1: Write failing catalog and fallback tests**

Create `tests/test_symbols.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { ACTOR_ICON_TOKENS, resolveSymbol } from "../app/symbols.js";

const expected = [
  "warship_generic", "warship_ironclad", "warship_battleship",
  "warship_armored_cruiser", "warship_protected_cruiser",
  "warship_destroyer", "warship_torpedo_boat", "naval_transport",
  "fleet_generic", "infantry", "cavalry", "artillery", "armor",
  "engineer", "logistics", "headquarters", "fortress", "aircraft",
  "aircraft_fighter", "aircraft_bomber", "unit_generic",
];

test("catalog exactly matches the prompt vocabulary", () => {
  assert.deepEqual([...ACTOR_ICON_TOKENS].sort(), expected.sort());
});

test("unknown ship token falls back to generic warship", () => {
  const symbol = resolveSymbol({ id: "s", kind: "ship" }, "🚢");
  assert.equal(symbol.token, "warship_generic");
  assert.equal(symbol.rotatesWithHeading, true);
});

test("land formations remain upright and retain echelon", () => {
  const symbol = resolveSymbol({ id: "d", kind: "division" }, "infantry");
  assert.equal(symbol.token, "infantry");
  assert.equal(symbol.rotatesWithHeading, false);
  assert.equal(symbol.echelon, "XX");
});
```

- [ ] **Step 2: Run symbol tests and verify module failure**

Run: `node --test tests/test_symbols.mjs`

Expected: failure with `ERR_MODULE_NOT_FOUND` for `app/symbols.js`.

- [ ] **Step 3: Implement token metadata and fallback**

Create `app/symbols.js` with a frozen registry. Each definition has `viewBox`, `paths`, and `rotatesWithHeading`; land definitions also use an inner branch glyph:

```javascript
const naval = (path) => ({ viewBox: "-50 -30 100 60", paths: [path], rotatesWithHeading: true });
const land = (glyph) => ({ viewBox: "-42 -30 84 60", paths: ["M-38-22H38V22H-38Z", glyph], rotatesWithHeading: false });

export const SYMBOL_DEFS = Object.freeze({
  warship_generic: naval("M-44 0Q-33-14 24-11L48 0L24 11Q-33 14-44 0Z"),
  warship_ironclad: naval("M-46 0Q-34-16 22-13L49 0L22 13Q-34 16-46 0ZM-16-8H12V8H-16ZM20-6A6 6 0 1 0 20 6A6 6 0 1 0 20-6"),
  warship_battleship: naval("M-48 0L-35-15H28L50 0L28 15H-35ZM-20-8A8 8 0 1 0-20 8A8 8 0 1 0-20-8ZM20-8A8 8 0 1 0 20 8A8 8 0 1 0 20-8"),
  warship_armored_cruiser: naval("M-46 0L-32-13H27L49 0L27 13H-32ZM-15-7H14V7H-15Z"),
  warship_protected_cruiser: naval("M-46 0L-30-11H29L49 0L29 11H-30ZM-10-6H16V6H-10Z"),
  warship_destroyer: naval("M-48 0L-29-8H31L50 0L31 8H-29Z"),
  warship_torpedo_boat: naval("M-45 0L-25-6H30L48 0L30 6H-25Z"),
  naval_transport: naval("M-45 0L-32-12H30L48 0L30 12H-32ZM-18-7H18V7H-18Z"),
  fleet_generic: naval("M-44-10L-30-20H20L43-10L20 0H-30ZM-44 12L-30 2H20L43 12L20 22H-30Z"),
  infantry: land("M-27-14L27 14M27-14L-27 14"),
  cavalry: land("M-27 14L0-14L27 14"),
  artillery: land("M0-15A15 15 0 1 0 0 15A15 15 0 1 0 0-15"),
  armor: land("M-25 0L-13-14H13L25 0L13 14H-13Z"),
  engineer: land("M-28 12L0-14L28 12M-22 12H22"),
  logistics: land("M-26-12H26V12H-26ZM-18 0H18"),
  headquarters: land("M-25 14V-14H20L8-5L20 4H-25"),
  fortress: land("M-27 14V-8L-18-15L-9-8L0-15L9-8L18-15L27-8V14Z"),
  aircraft: { viewBox: "-42 -42 84 84", paths: ["M0-36L9-8L38 7L34 16L8 8L7 30L0 38L-7 30L-8 8L-34 16L-38 7L-9-8Z"], rotatesWithHeading: true },
  aircraft_fighter: { viewBox: "-42 -42 84 84", paths: ["M0-38L8-7L35 10L30 18L7 8L6 31L0 38L-6 31L-7 8L-30 18L-35 10L-8-7Z"], rotatesWithHeading: true },
  aircraft_bomber: { viewBox: "-46 -40 92 80", paths: ["M0-36L10-8L43 4L39 17L9 9L8 29L0 37L-8 29L-9 9L-39 17L-43 4L-10-8Z"], rotatesWithHeading: true },
  unit_generic: { viewBox: "-30 -30 60 60", paths: ["M0-24L24 0L0 24L-24 0Z"], rotatesWithHeading: false },
});

export const ACTOR_ICON_TOKENS = Object.freeze(Object.keys(SYMBOL_DEFS));

const KIND_FALLBACKS = Object.freeze({
  ship: "warship_generic", fleet: "fleet_generic", army: "infantry",
  corps: "infantry", division: "infantry", brigade: "infantry",
  regiment: "infantry", person: "headquarters", unit: "unit_generic",
  other: "unit_generic",
});

const ECHELONS = Object.freeze({ army: "XXXX", corps: "XXX", division: "XX", brigade: "X", regiment: "III" });

export function resolveSymbol(actor, requestedToken) {
  const token = SYMBOL_DEFS[requestedToken] ? requestedToken : (KIND_FALLBACKS[actor.kind] || "unit_generic");
  return { token, ...SYMBOL_DEFS[token], echelon: ECHELONS[actor.kind] || "" };
}
```

- [ ] **Step 4: Run symbol tests**

Run: `node --test tests/test_symbols.mjs`

Expected: three tests pass with zero failures.

- [ ] **Step 5: Commit the symbol catalog**

```bash
git add app/symbols.js tests/test_symbols.mjs
git commit -m "feat: add controlled svg unit symbols"
```

## Task 5: Replace Event Jumps with a Continuous Animation Controller

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write a failing source contract for the new engine boundary**

Add to `tests/test_mvp_contract.py`:

```python
def test_renderer_uses_timeline_and_symbol_modules(self):
    animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")
    self.assertIn('from "./timeline.js"', animate)
    self.assertIn('from "./symbols.js"', animate)
    self.assertIn("requestAnimationFrame", animate)
    self.assertNotIn("setInterval", animate)
    self.assertNotIn("buildSnapshots", animate)
```

- [ ] **Step 2: Run the new contract test and verify it fails**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_renderer_uses_timeline_and_symbol_modules -v`

Expected: failure because `animate.js` still uses snapshots and `setInterval`.

- [ ] **Step 3: Import the compiler and symbol catalog and render SVG paths**

At the top of `app/animate.js`, add:

```javascript
import { compileTimeline, sampleTimeline } from "./timeline.js";
import { resolveSymbol } from "./symbols.js";
```

Replace emoji construction in the actor loop with:

```javascript
const symbol = resolveSymbol(actor, actorIcons[actor.id]);
const unit = svgEl(documentRef, "g", { class: "unit", "data-actor-id": actor.id });
const heading = svgEl(documentRef, "g", { class: "unit-heading" });
const body = svgEl(documentRef, "g", { class: `unit-symbol token-${symbol.token}` });
for (const d of symbol.paths) body.append(svgEl(documentRef, "path", { d, fill: colorOf(actor.side_id) }));
heading.append(body);
unit.append(
  heading,
  svgEl(documentRef, "text", { class: "unit-echelon", "text-anchor": "middle", y: -31 }, symbol.echelon),
  svgEl(documentRef, "text", { class: "unit-label", x: 54, y: 0 }, actor.name),
  svgEl(documentRef, "text", { class: "unit-sub-label", x: 54, y: 16 }, symbol.token.replaceAll("_", " ")),
);
svg.append(unit);
unitEls.set(actor.id, { g: unit, heading, symbol });
```

Set the SVG path coordinate system by applying `transform="scale(0.55)"` on `body`; keep the outer `unit` transform exclusively for map position and `heading` exclusively for rotation.

- [ ] **Step 4: Replace snapshots with timeline sampling**

Delete `buildSnapshots`, `firstActorCoord`, the CSS-transition placement logic, and event-index position updates. Initialize:

```javascript
const compiled = compileTimeline(battle);
let presentationMs = 0;
let sampled = sampleTimeline(compiled, presentationMs);
let actorPositions = sampled.actorPositions;

function renderAt(nextPresentationMs) {
  presentationMs = Math.max(0, Math.min(nextPresentationMs, compiled.presentationDurationMs));
  sampled = sampleTimeline(compiled, presentationMs);
  actorPositions = sampled.actorPositions;
  for (const [actorId, { g, heading, symbol }] of unitEls) {
    const coord = actorPositions.get(actorId);
    if (!coord) {
      g.hidden = true;
      continue;
    }
    g.hidden = false;
    const point = project(coord);
    g.setAttribute("transform", `translate(${point.x} ${point.y})`);
    const radians = sampled.headings.get(actorId) || 0;
    heading.setAttribute("transform", symbol.rotatesWithHeading ? `rotate(${radians * 180 / Math.PI})` : "");
    g.classList.toggle("is-sunk", sampled.persistentOutcomeActorIds.has(actorId));
  }
  for (const { eng, line } of engagementEls.values()) {
    line.classList.toggle("is-active", sampled.activeEngagementIds.has(eng.id));
  }
  redrawStaticGeometry();
}
```

Rename the old `redraw` map-projection function to `redrawStaticGeometry`; it reprojects places, paths, markers, engagement endpoints, and then calls `renderAt(presentationMs)` only from Leaflet events. Prevent recursion by having `renderAt` call a small `redrawEngagementEndpoints()` helper instead of `redrawStaticGeometry`.

- [ ] **Step 5: Implement a `requestAnimationFrame` controller**

Replace timer fields and methods with:

```javascript
_frame: null,
_lastFrameTime: null,
playbackRate: 1,

seek(nextPresentationMs) {
  renderAt(nextPresentationMs);
  updatePlaybackUi(documentRef, compiled, sampled, presentationMs);
},
setSpeed(rate) {
  this.playbackRate = rate;
  updateSpeedButtons(documentRef, rate);
},
play() {
  if (this._frame) return;
  if (presentationMs >= compiled.presentationDurationMs) this.seek(0);
  const tick = (now) => {
    if (this._lastFrameTime === null) this._lastFrameTime = now;
    const elapsed = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this.seek(presentationMs + elapsed * this.playbackRate);
    if (presentationMs >= compiled.presentationDurationMs) return this.pause();
    this._frame = requestAnimationFrame(tick);
  };
  this._frame = requestAnimationFrame(tick);
  this._setPlaying(true);
},
pause() {
  if (this._frame) cancelAnimationFrame(this._frame);
  this._frame = null;
  this._lastFrameTime = null;
  this._setPlaying(false);
},
```

For this commit, define a minimal `updatePlaybackUi` beside the controller so seeking is functional before the richer controls arrive in Task 6:

```javascript
function updatePlaybackUi(documentRef, compiled, sampled, currentMs) {
  const scrubber = documentRef.getElementById("event-scrubber");
  if (scrubber) {
    scrubber.max = String(compiled.presentationDurationMs);
    scrubber.step = "any";
    scrubber.value = String(currentMs);
  }
  const progress = documentRef.getElementById("event-progress");
  if (progress) progress.textContent = `${Math.round(currentMs / 1000)}s / ${Math.round(compiled.presentationDurationMs / 1000)}s`;
}

function updateSpeedButtons(documentRef, rate) {
  documentRef.querySelectorAll("[data-speed]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === rate));
  });
}
```

Keep `showEvent(index)` as a compatibility navigation method that seeks to the selected event's presentation start. Make `next()` and `prev()` choose adjacent compiled events rather than move actors directly.

- [ ] **Step 6: Remove movement CSS interpolation and add SVG symbol styling**

In `app/styles.css`, remove `.unit { transition: transform 700ms ... }` and add:

```css
.unit-symbol path {
  stroke: #fffaf0;
  stroke-width: 4;
  vector-effect: non-scaling-stroke;
  paint-order: stroke fill;
}

.unit-heading {
  transform-box: fill-box;
  transform-origin: center;
}

.unit-echelon {
  fill: currentColor;
  font-size: 12px;
  font-weight: 850;
  paint-order: stroke;
  stroke: var(--panel);
  stroke-width: 4px;
}

.unit-sub-label {
  fill: var(--muted);
  font-size: 11px;
  paint-order: stroke;
  stroke: var(--panel);
  stroke-width: 4px;
}
```

- [ ] **Step 7: Run unit and contract tests**

Run:

```bash
node --test tests/test_timeline.mjs tests/test_symbols.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all JavaScript and Python tests pass; no `setInterval` or `buildSnapshots` remains.

- [ ] **Step 8: Commit the continuous renderer**

```bash
git add app/animate.js app/styles.css tests/test_mvp_contract.py
git commit -m "feat: animate units on continuous trajectories"
```

## Task 6: Add Continuous Playback UI, Event Cards, and Camera Follow

**Files:**
- Modify: `app/index.html`
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write a failing UI contract test**

Add to `tests/test_mvp_contract.py`:

```python
def test_static_app_exposes_continuous_playback_controls(self):
    index = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "historical-time", "compression-notice", "speed-controls",
        "follow-button", "event-card-stack", "validation-warnings",
    ):
        self.assertIn(f'id="{element_id}"', index)
    self.assertIn('step="any"', index)
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_static_app_exposes_continuous_playback_controls -v`

Expected: failure on the first missing UI element.

- [ ] **Step 3: Replace event-index controls in `index.html`**

Inside `.controls`, keep play and reset, retain previous/next as event navigation, and use:

```html
<div id="speed-controls" class="speed-controls" aria-label="Playback speed">
  <button type="button" data-speed="0.5">½×</button>
  <button type="button" data-speed="1" aria-pressed="true">1×</button>
  <button type="button" data-speed="2">2×</button>
  <button type="button" data-speed="4">4×</button>
</div>
<button id="follow-button" type="button" class="ghost" aria-pressed="true">Follow: on</button>
<label class="scrubber">
  <span class="scrubber-row">
    <span id="historical-time">動畫時間 00:00</span>
    <span id="event-progress">0 / 0</span>
  </span>
  <input id="event-scrubber" type="range" min="0" max="0" value="0" step="any" />
</label>
<p id="compression-notice" class="compression-notice" hidden></p>
```

Add below `error-banner`:

```html
<div id="validation-warnings" class="warning-banner" role="status" hidden></div>
```

Move the event display into `.map-stage` immediately after `.map-caption`, and remove the old single `.current-event` live region from the inspector:

```html
<section id="event-card-stack" class="event-card-stack" aria-live="polite"></section>
```

- [ ] **Step 4: Wire speed, seek, and follow controls**

In the module script in `index.html`, keep the existing error-array validation contract for this commit, initialize the warning banner as hidden, and wire:

```javascript
document.querySelectorAll("[data-speed]").forEach((button) => {
  button.onclick = () => controller.setSpeed(Number(button.dataset.speed));
});
$("follow-button").onclick = () => controller.setFollowEnabled(!controller.followEnabled);
$("event-scrubber").oninput = (event) => {
  controller.pause();
  controller.seek(Number(event.target.value));
};
```

Set the scrubber maximum to `compiled.presentationDurationMs`; display historical time with a formatter exported from `timeline.js`. When `sampled.compressedGap` is non-null, show `已壓縮 ${formatDuration(compressedGap.historicalDurationMs)} 無動作時段`; otherwise hide the notice. Synthetic periods display `動畫時間` plus elapsed presentation time rather than a fabricated date.

- [ ] **Step 5: Implement readable event card stacking**

Add an `eventCards` map in `animate.js`. When a sampled event becomes active, append a card once with a removal deadline of `performance.now() + 3000`. Cards show title, time label, precision, confidence percentage, and description. On each frame remove expired non-current cards. Bind `pointerenter` and `click` to `controller.pause()`.

Use this markup per card:

```javascript
const card = documentRef.createElement("article");
card.className = "event-card";
card.dataset.eventId = event.id;
card.innerHTML = `
  <p class="event-card-meta">${escapeHtml(event.time.label)} · ${escapeHtml(event.type)}</p>
  <h2>${escapeHtml(event.title)}</h2>
  <p>${escapeHtml(event.description || "")}</p>
  <small>${escapeHtml(event.precision || "unknown")} · ${Math.round((event.confidence || 0) * 100)}%</small>`;
```

- [ ] **Step 6: Implement safe-viewport camera following**

Add controller fields `followEnabled: true` and `_programmaticMove: false`. Compute a safe rectangle inset by 22% on each side. At most once every 500 ms, if an active actor or engagement endpoint leaves the rectangle, call `map.flyToBounds(activeBounds.pad(0.35), { duration })`; derive duration from projected center distance and clamp it to `0.8–2.4` seconds.

Map interaction handlers must distinguish programmatic moves:

```javascript
map.on("dragstart zoomstart", () => {
  if (!controller._programmaticMove) controller.setFollowEnabled(false);
});

controller.setFollowEnabled = function setFollowEnabled(enabled) {
  this.followEnabled = enabled;
  const button = $("follow-button");
  button.textContent = `Follow: ${enabled ? "on" : "off"}`;
  button.setAttribute("aria-pressed", String(enabled));
};
```

Set `_programmaticMove = true` immediately before `flyToBounds` and restore it on the matching `moveend`.

- [ ] **Step 7: Add responsive UI styles**

Add styles for `.speed-controls`, `.warning-banner`, `.compression-notice`, `.event-card-stack`, and `.event-card`. The stack is positioned over the map on wide screens, capped at three visible cards, and moves into normal inspector flow below `880px`. Add zoom-state classes `.labels-middle` and `.labels-far` on the SVG: middle hides `.unit-sub-label`; far hides both labels and reduces symbol scale.

- [ ] **Step 8: Run contract and module tests**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/test_timeline.mjs tests/test_symbols.mjs
```

Expected: all tests pass.

- [ ] **Step 9: Commit the playback experience**

```bash
git add app/index.html app/animate.js app/styles.css tests/test_mvp_contract.py
git commit -m "feat: add historical-time playback controls"
```

## Task 7: Synchronize Browser Validation

**Files:**
- Modify: `app/animate.js`
- Modify: `app/index.html`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing browser-validator contract tests**

Add to `tests/test_mvp_contract.py`:

```python
def test_browser_validator_supports_v030_warnings(self):
    animate = (ROOT / "app" / "animate.js").read_text(encoding="utf-8")
    self.assertIn('"0.3.0"', animate)
    self.assertIn("waypoint_times", animate)
    self.assertIn("warnings", animate)
    self.assertIn("ACTOR_ICON_TOKENS", animate)
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_browser_validator_supports_v030_warnings -v`

Expected: failure because browser validation returns only an error array and knows only `0.1.0`/`0.2.0`.

- [ ] **Step 3: Return structured browser validation results**

Import `ACTOR_ICON_TOKENS` from `symbols.js`. Change `validateBattle` to return `{ errors, warnings }`. Preserve existing reference checks, accept `0.3.0`, and add movement semantic checks matching Python:

```javascript
const iconTokens = new Set(ACTOR_ICON_TOKENS);
for (const [index, movement] of (battle.movements || []).entries()) {
  const path = `movements[${index}]`;
  const points = movement.path?.coordinates || [];
  const times = movement.waypoint_times;
  if (times && times.length !== points.length) errors.push(`${path}.waypoint_times: count must match path coordinate count`);
  const parsed = (times || []).map(parseBattleTime);
  if (parsed.some((value) => value === null)) errors.push(`${path}.waypoint_times: contains invalid ISO date-time`);
  if (parsed.some((value, i) => i > 0 && value <= parsed[i - 1])) errors.push(`${path}.waypoint_times: values must be strictly increasing`);
  if (movement.precision === "inferred" && movement.time?.confidence > 0.6) {
    warnings.push(`${path}.time: inferred time confidence must be <= 0.6`);
  }
}
if (battle.schema_version === "0.3.0") {
  for (const [actorId, token] of Object.entries(battle.animation_hints?.style?.actor_icons || {})) {
    if (!iconTokens.has(token)) warnings.push(`actor_icons.${actorId}: unknown v0.3 token ${JSON.stringify(token)}`);
  }
}
return { errors, warnings };
```

Import `parseBattleTime` from `timeline.js`; check movement start/end and waypoint bounds with the same messages as the Python validator.

- [ ] **Step 4: Adapt `index.html` and validate warning behavior**

In `setBattle`, use:

```javascript
const { errors, warnings } = validateBattle(battle);
showErrors(errors);
showWarnings(warnings);
if (errors.length) return;
controller = renderBattle(battle, document);
wireControls();
```

`showWarnings` escapes messages and renders at most twelve list items in `validation-warnings`; warnings never stop rendering.

- [ ] **Step 5: Run all automated tests**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/test_timeline.mjs tests/test_symbols.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit browser validation**

```bash
git add app/animate.js app/index.html tests/test_mvp_contract.py
git commit -m "feat: validate v0.3 timelines in browser"
```

## Task 8: Upgrade the Yalu Individual-Ship Demonstration

**Files:**
- Modify: `examples/battle-of-甲午海戰.json`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write a failing Yalu detail contract**

Add to `tests/test_mvp_contract.py`:

```python
def test_yalu_is_a_timed_v030_ship_demo(self):
    battle = json.loads(YALU_EXAMPLE.read_text(encoding="utf-8"))
    self.assertEqual(battle["schema_version"], "0.3.0")
    ships = [actor for actor in battle["actors"] if actor["kind"] == "ship"]
    self.assertGreaterEqual(len(ships), 10)
    ship_ids = {ship["id"] for ship in ships}
    timed_ship_movements = [
        movement for movement in battle["movements"]
        if movement["actor_id"] in ship_ids and "time" in movement
    ]
    self.assertGreaterEqual(len(timed_ship_movements), 10)
    self.assertTrue(any("waypoint_times" in movement for movement in timed_ship_movements))
    allowed = {
        "warship_generic", "warship_ironclad", "warship_battleship",
        "warship_armored_cruiser", "warship_protected_cruiser",
        "warship_destroyer", "warship_torpedo_boat", "naval_transport", "fleet_generic",
    }
    icons = battle["animation_hints"]["style"]["actor_icons"]
    self.assertTrue(set(icons.values()) <= allowed)
    self.assertFalse(any(any(ord(char) > 0xFFFF for char in value) for value in icons.values()))
    self.assertTrue(all("time" in engagement for engagement in battle["engagements"]))
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_yalu_is_a_timed_v030_ship_demo -v`

Expected: failure because the example is `0.2.0`, uses emoji, and movements lack time.

- [ ] **Step 3: Upgrade actors and icon hints**

Change `schema_version` to `0.3.0` and `metadata.updated_at` to `2026-07-20`. Assign historically appropriate controlled tokens without claiming unsupported specificity:

```json
"actor_icons": {
  "ship_dingyuan": "warship_ironclad",
  "ship_zhenyuan": "warship_ironclad",
  "ship_jingyuan": "warship_armored_cruiser",
  "ship_zhiyuan": "warship_protected_cruiser",
  "ship_chaoyong": "warship_protected_cruiser",
  "ship_yangwei": "warship_protected_cruiser",
  "ship_matsushima": "warship_protected_cruiser",
  "ship_yoshino": "warship_protected_cruiser",
  "ship_naniwa": "warship_protected_cruiser",
  "ship_hiei": "warship_generic"
}
```

- [ ] **Step 4: Add movement and engagement timing**

For every ship movement, add `time` spanning its linked event. Use exact or approximate source-backed times where present. For constructed intermediate phases, set the movement's `precision` to `"inferred"`, keep the time `confidence <= 0.6`, use `time.precision: "range"`, and provide waypoint timestamps matching the coordinate count. Example:

```json
"time": {
  "label": "約 13:00–13:20",
  "start": "1894-09-17T13:00:00",
  "end": "1894-09-17T13:20:00",
  "precision": "range",
  "confidence": 0.5
},
"waypoint_times": [
  "1894-09-17T13:00:00",
  "1894-09-17T13:09:00",
  "1894-09-17T13:20:00"
]
```

Give each engagement a time range contained by its linked event. Destructive results end when the outcome should become persistent. Do not raise geographic confidence merely because more intermediate coordinates were added.

Add timeline hints:

```json
"historical_seconds_per_playback_second": 120,
"idle_compression_threshold_seconds": 900,
"idle_compressed_duration_ms": 1200
```

- [ ] **Step 5: Validate the upgraded example**

Run:

```bash
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_yalu_is_a_timed_v030_ship_demo -v
```

Expected: CLI prints `valid: examples/battle-of-甲午海戰.json`; the detail test passes. Any warnings must be reviewed and corrected rather than ignored for the canonical demo.

- [ ] **Step 6: Commit the demonstration**

```bash
git add examples/battle-of-甲午海戰.json tests/test_mvp_contract.py
git commit -m "feat: add timed ship-level Yalu demo"
```

## Task 9: Update the LLM Prompt, Documentation, and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write a failing README prompt contract**

Add to `tests/test_mvp_contract.py`:

```python
def test_readme_prompt_teaches_v030_timing_and_tokens(self):
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for required in (
        'schema_version：使用精細時間軌時請用字串 "0.3.0"',
        "waypoint_times",
        "warship_ironclad",
        "warship_protected_cruiser",
        "不要輸出 Emoji",
        'precision:"inferred"',
        "confidence <= 0.6",
    ):
        self.assertIn(required, readme)
```

- [ ] **Step 2: Run the prompt test and verify it fails**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_teaches_v030_timing_and_tokens -v`

Expected: failure because the current prompt recommends emoji and omits `0.3.0` timing.

- [ ] **Step 3: Rewrite the prompt's version, movement, icon, and precision sections**

Update the existing prompt in place rather than adding a second prompt. It must state:

```text
schema_version：基本資料使用 "0.1.0"；engagements／ship／parent_id 使用 "0.2.0"；
使用 movement.time、waypoint_times 或歷史比例時間軌時請用字串 "0.3.0"。

movements[] 可選欄位：time, waypoint_times
- time 使用與 historical_events.time 相同結構。
- waypoint_times 的數量必須與 path.coordinates 完全相同，且時間嚴格遞增。
- 缺少可靠時間時可以合理推估，但 movement 必須標 precision:"inferred"，time.precision 使用 hour／range 等時間粒度，且 time.confidence <= 0.6。

actor_icons 只能使用受控名稱：
warship_generic, warship_ironclad, warship_battleship,
warship_armored_cruiser, warship_protected_cruiser, warship_destroyer,
warship_torpedo_boat, naval_transport, fleet_generic, infantry, cavalry,
artillery, armor, engineer, logistics, headquarters, fortress, aircraft,
aircraft_fighter, aircraft_bomber, unit_generic。
不要輸出 Emoji、SVG、data URL 或詞彙表以外的名稱；不確定時使用同類 generic token。
```

Update the JSON template to `0.3.0`, use controlled tokens, include one timed movement with matching waypoint times, and show all three new timeline hint fields. Explain that a land unit coordinate is a representative position rather than its exact footprint.

- [ ] **Step 4: Update user-facing project documentation**

Update the file list and app sections to describe schema `0.3.0`, continuous historical-time playback, idle compression, speed controls, SVG tokens, and legacy fallback. Replace the stale MVP boundary statement that actors are coarse units with the confirmed ship and division/brigade granularity policy.

- [ ] **Step 5: Run the complete automated verification suite**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/test_timeline.mjs tests/test_symbols.mjs
python3 -m battle_animation.validator examples/battle-of-waterloo.json
python3 -m battle_animation.validator examples/battle-of-甲午.json
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
```

Expected: all Python and JavaScript tests pass; all three validators print `valid:`. The canonical Yalu document prints no warnings.

- [ ] **Step 6: Run browser verification**

Start the app:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/app/` with the browser automation skill and verify:

1. Load `examples/battle-of-甲午海戰.json`.
2. Confirm ships use top-down warship silhouettes, not passenger-ship emoji.
3. Press Play and confirm positions change continuously between animation frames.
4. Switch through `0.5×`, `1×`, `2×`, and `4×`; confirm the historical clock stays continuous.
5. Drag the scrubber backward and forward; confirm ship positions and sunk state reconstruct correctly.
6. Confirm a long inactive gap shows the compression notice.
7. Confirm inferred timing and confidence appear on event cards.
8. Drag the map; confirm Follow changes to off and the camera stops recentering.
9. Re-enable Follow; confirm the camera moves only when active units leave the safe viewport.
10. Load `examples/battle-of-waterloo.json`; confirm legacy fallback says `動畫時間` and still moves smoothly.

Expected: no console errors, no instant actor jumps, no passenger-ship emoji, readable labels at near/middle/far zoom, and every interaction above behaves as specified.

- [ ] **Step 7: Commit documentation and final integration**

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: teach continuous unit animation prompt"
```

- [ ] **Step 8: Record final branch status**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: no tracked modifications remain; only intentionally ignored local visual-companion files may exist. The log contains the nine feature commits from this plan plus the design and plan commits.

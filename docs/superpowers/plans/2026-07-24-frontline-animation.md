# Frontline Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-backed frontline and control-area snapshots to schema `0.4.0`, animate compatible snapshots, and provide an explicitly low-confidence land-unit fallback.

**Architecture:** Extend the existing additive schema contract, validators, types, prompt, and timeline without changing old-version behavior. Put resampling, interpolation, and fallback inference in a pure `app/frontlines.js` module; keep SVG lifecycle, controls, crossfades, and inspector integration inside the existing renderer. Source snapshots always outrank renderer-derived fallback.

**Tech Stack:** JSON Schema draft 2020-12, Python standard library and `TypedDict`, vanilla ES modules, Leaflet 1.9, SVG/CSS, Node built-in test runner, Python `unittest`.

---

## File map

- Modify `schemas/battle-animation-schema.json`: declare `0.4.0` and frontline snapshot definitions.
- Modify `battle_animation/types.py`: mirror the new schema types.
- Modify `battle_animation/validator.py`: add frontline references, unique IDs, chronological rules, and warnings.
- Modify `app/animate.js`: browser validation, controls, SVG rendering, transitions, inspector, and teardown.
- Modify `app/timeline.js`: compile and sample frontline keyframes.
- Create `app/frontlines.js`: pure snapshot geometry and renderer fallback functions.
- Modify `app/index.html`: add the Fronts control and inspector fields.
- Modify `app/styles.css`: layer order, source/inferred/fallback styles, crossfade, and reduced motion.
- Modify `README.md`: publish Prompt 1.1.0 and describe schema/rendering behavior.
- Create `examples/battle-of-stalingrad-frontlines.json`: tracked `0.4.0` example with interpolation and topology change.
- Modify `tests/test_mvp_contract.py`: schema, Python validation, prompt, example, and static app contracts.
- Modify `tests/test_browser_validation.mjs`: browser-side `0.4.0` validation.
- Create `tests/test_frontlines.mjs`: pure geometry and fallback tests.
- Modify `tests/test_timeline.mjs`: frontline keyframe compilation and sampling.
- Modify `tests/test_renderer.mjs`: controls, rendering, transitions, fallback, inspector, and teardown.

### Task 1: Schema 0.4.0 and Python types

**Files:**
- Modify: `schemas/battle-animation-schema.json`
- Modify: `battle_animation/types.py`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing schema and type contract tests**

Add a `frontline_document()` fixture helper that clones the existing valid `0.3.0` fixture, changes `schema_version` to `0.4.0`, and adds:

```python
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
        "geometry": {"type": "LineString", "coordinates": [[43.1, 49.2], [44.0, 48.9]]},
    }],
    "control_areas": [{
        "id": "area_a",
        "side_id": document["sides"][0]["id"],
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[42.5, 49.8], [44.0, 49.5], [44.0, 48.9], [42.5, 49.0], [42.5, 49.8]]],
        },
    }],
    "precision": "approximate",
    "confidence": 0.8,
    "source_ids": [document["sources"][0]["id"]],
}]
```

Add tests that assert:

```python
schema = json.loads((ROOT / "schemas/battle-animation-schema.json").read_text())
self.assertIn("0.4.0", schema["properties"]["schema_version"]["enum"])
self.assertEqual(
    schema["properties"]["frontline_snapshots"]["items"]["$ref"],
    "#/$defs/FrontlineSnapshot",
)
self.assertEqual(validate_document(frontline_document()), [])
```

Assert `battle_animation/types.py` contains `FrontLine`, `ControlArea`, `FrontlineSnapshot`, `frontline_snapshots`, and `Literal["0.1.0", "0.2.0", "0.3.0", "0.4.0"]`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
python3 -m unittest \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_schema_declares_v040_frontline_snapshots \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_python_types_declare_v040_frontlines -v
```

Expected: FAIL because `0.4.0` and frontline definitions are absent.

- [ ] **Step 3: Add the minimal schema definitions**

Add optional top-level:

```json
"frontline_snapshots": {
  "type": "array",
  "items": { "$ref": "#/$defs/FrontlineSnapshot" }
}
```

Add `$defs.FrontLine`, `$defs.ControlArea`, and `$defs.FrontlineSnapshot`. Use `additionalProperties: false`; `FrontLine` requires `id` and a `LineString`; `ControlArea` requires `id`, `side_id`, and a `Polygon`. `FrontlineSnapshot` requires `id`, `time`, `precision`, `confidence`, and a nonempty `source_ids`; `event_id`, `front_lines`, and `control_areas` are optional. Encode “at least one collection exists” with:

```json
"anyOf": [
  { "required": ["front_lines"] },
  { "required": ["control_areas"] }
]
```

Add `"0.4.0"` to the version enum. The hand-rolled validator does not yet implement `anyOf`, so Task 2 must add the equivalent semantic check; do not add unsupported schema machinery to `_validate()` in this task.

- [ ] **Step 4: Mirror the exact fields in `TypedDict`**

Add:

```python
class FrontLine(TypedDict):
    id: Identifier
    geometry: LineString


class ControlArea(TypedDict):
    id: Identifier
    side_id: Identifier
    geometry: Polygon


class FrontlineSnapshot(TypedDict):
    id: Identifier
    time: BattleTime
    precision: Precision
    confidence: Confidence
    source_ids: list[Identifier]
    event_id: NotRequired[Identifier]
    front_lines: NotRequired[list[FrontLine]]
    control_areas: NotRequired[list[ControlArea]]
```

Extend `BattleAnimationDocument` with `frontline_snapshots: NotRequired[list[FrontlineSnapshot]]` and the version literal with `0.4.0`.

- [ ] **Step 5: Run the focused and full Python contracts**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add schemas/battle-animation-schema.json battle_animation/types.py tests/test_mvp_contract.py
git commit -m "feat: define schema v0.4 frontline snapshots"
```

### Task 2: Python frontline validation semantics

**Files:**
- Modify: `battle_animation/validator.py`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add failing semantic and reference tests**

Add table-driven tests that mutate `frontline_document()` and expect path-specific errors for:

```python
cases = [
    ("neither lines nor areas", lambda d: (
        d["frontline_snapshots"][0].pop("front_lines"),
        d["frontline_snapshots"][0].pop("control_areas"),
    ), "must include front_lines or control_areas"),
    ("unknown event", lambda d: d["frontline_snapshots"][0].update(event_id="missing"), "unknown id"),
    ("unknown side", lambda d: d["frontline_snapshots"][0]["control_areas"][0].update(side_id="missing"), "unknown id"),
    ("unknown source", lambda d: d["frontline_snapshots"][0].update(source_ids=["missing"]), "unknown id"),
]
```

Add explicit tests for duplicate snapshot IDs, duplicate line IDs within one snapshot, duplicate area IDs within one snapshot, and non-increasing `time.start`.

Add a warning-only test for a structurally valid snapshot whose BattleTime contains only `label`, `precision`, and `confidence`, with no `start`.

- [ ] **Step 2: Run the new tests and verify failures**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_v040_frontline_semantics_and_references -v
```

Expected: FAIL because frontline-specific semantic checks are absent.

- [ ] **Step 3: Add references and uniqueness checks**

Inside `_validate_references`, resolve:

```python
for index, snapshot in enumerate(_objects(document.get("frontline_snapshots"))):
    prefix = f"$.frontline_snapshots[{index}]"
    if "event_id" in snapshot:
        check(snapshot["event_id"], event_ids, f"{prefix}.event_id")
    for source_index, source_id in enumerate(snapshot.get("source_ids", [])):
        check(source_id, source_ids, f"{prefix}.source_ids[{source_index}]")
    for area_index, area in enumerate(_objects(snapshot.get("control_areas"))):
        check(area.get("side_id"), side_ids, f"{prefix}.control_areas[{area_index}].side_id")
```

Add one small `_validate_unique_ids(items, path, errors)` helper and reuse it for snapshot IDs plus each snapshot’s line and area IDs.

- [ ] **Step 4: Add chronological and missing-start rules**

Add `_validate_frontline_timing(document, errors, warnings)`:

```python
previous_start = None
for index, snapshot in enumerate(_objects(document.get("frontline_snapshots"))):
    prefix = f"$.frontline_snapshots[{index}]"
    if not snapshot.get("front_lines") and not snapshot.get("control_areas"):
        errors.append(ValidationError(prefix, "must include front_lines or control_areas"))
    start = snapshot.get("time", {}).get("start")
    if start is None:
        warnings.append(ValidationWarning(f"{prefix}.time", "snapshot without time.start is excluded from animation"))
        continue
    try:
        current = _parse_battle_time(start)
    except (TypeError, ValueError):
        continue
    if previous_start is not None and current <= previous_start:
        errors.append(ValidationError(f"{prefix}.time.start", "snapshot times must be strictly increasing"))
    previous_start = current
```

Call it from `validate_document_with_warnings()` after structural validation.

- [ ] **Step 5: Run the Python suite**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all tests pass, including old versions.

- [ ] **Step 6: Commit**

```bash
git add battle_animation/validator.py tests/test_mvp_contract.py
git commit -m "feat: validate frontline snapshot semantics"
```

### Task 3: Browser-side 0.4 validation

**Files:**
- Modify: `app/animate.js`
- Modify: `tests/test_browser_validation.mjs`

- [ ] **Step 1: Add failing browser validation cases**

Extend the valid browser fixture to optionally include the same `frontline_snapshots` fixture. Add tests for:

```js
test("accepts a valid v0.4 frontline document", () => {
  assert.deepEqual(validateBattle(frontlineBattle()).errors, []);
});

test("rejects malformed and unresolved frontline snapshots before render", () => {
  const mutations = [
    (battle) => { battle.frontline_snapshots = {}; },
    (battle) => { battle.frontline_snapshots[0].front_lines[0].geometry.coordinates = [[1, 2]]; },
    (battle) => { battle.frontline_snapshots[0].control_areas[0].side_id = "missing"; },
    (battle) => { battle.frontline_snapshots[0].event_id = "missing"; },
    (battle) => { battle.frontline_snapshots[0].source_ids = ["missing"]; },
    (battle) => { battle.frontline_snapshots[0].extra = true; },
  ];
  for (const mutate of mutations) {
    const battle = frontlineBattle();
    mutate(battle);
    assert.ok(validateBattle(battle).errors.length);
  }
});
```

Add cases for duplicate IDs, missing both geometry collections, missing `time.start` warning, and non-increasing times.

- [ ] **Step 2: Run and verify failures**

Run:

```bash
node --test tests/test_browser_validation.mjs
```

Expected: FAIL because the browser currently rejects version `0.4.0` or ignores frontline shapes.

- [ ] **Step 3: Extend browser structural validation**

Add `"0.4.0"` to the supported versions. In `validateRendererShapes`, validate exact allowed keys and shapes for snapshots, lines, areas, BattleTime, LineString, and Polygon using existing shape helpers. Keep old documents unaffected when `frontline_snapshots` is absent.

- [ ] **Step 4: Extend browser semantic validation**

After the existing ID sets are created:

```js
const seenSnapshots = new Set();
let previousFrontlineStart = null;
objects(battle.frontline_snapshots).forEach((snapshot, index) => {
  const path = `frontline_snapshots[${index}]`;
  checkUnique(snapshot.id, seenSnapshots, `${path}.id`);
  if (snapshot.event_id) check(snapshot.event_id, eventIds, `${path}.event_id`);
  array(snapshot.source_ids).forEach((id, i) => check(id, sourceIds, `${path}.source_ids[${i}]`));
  const seenLines = new Set();
  objects(snapshot.front_lines).forEach((line, i) => checkUnique(line.id, seenLines, `${path}.front_lines[${i}].id`));
  const seenAreas = new Set();
  objects(snapshot.control_areas).forEach((area, i) => {
    checkUnique(area.id, seenAreas, `${path}.control_areas[${i}].id`);
    check(area.side_id, sideIds, `${path}.control_areas[${i}].side_id`);
  });
  if (!array(snapshot.front_lines).length && !array(snapshot.control_areas).length) {
    errors.push(`${path}: must include front_lines or control_areas`);
  }
});
```

Use `parseBattleTime` for strict chronological starts. Missing start adds a warning; malformed time remains an error.

- [ ] **Step 5: Run browser and Python validation suites**

Run:

```bash
node --test tests/test_browser_validation.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all pass with matching error/warning semantics.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js tests/test_browser_validation.mjs
git commit -m "feat: validate v0.4 frontlines in browser"
```

### Task 4: Pure frontline geometry and fallback module

**Files:**
- Create: `app/frontlines.js`
- Create: `tests/test_frontlines.mjs`

- [ ] **Step 1: Write failing resampling and interpolation tests**

Declare the public API in tests:

```js
import {
  interpolateFrontlineSnapshots,
  resampleLine,
  resampleRing,
  deriveFrontlineFallback,
} from "../app/frontlines.js";
```

Cover:

```js
assert.deepEqual(resampleLine([[0, 0], [10, 0]], 3), [[0, 0], [5, 0], [10, 0]]);
assert.deepEqual(resampleRing([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], 4).at(-1),
                 resampleRing([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], 4)[0]);
```

Add dateline input `[[179, 0], [-179, 0]]` and assert the midpoint remains at ±180 rather than 0.

Add snapshots with matching IDs and assert progress `0.5` returns interpolated lines/areas. Add unmatched IDs and polygons with different ring counts and assert they appear in `exiting`/`entering`, not `interpolated`.

- [ ] **Step 2: Write failing fallback tests**

Use actors and sampled positions:

```js
const actors = [
  { id: "a1", side_id: "a", kind: "division" },
  { id: "a2", side_id: "a", kind: "brigade" },
  { id: "b1", side_id: "b", kind: "corps" },
  { id: "ship", side_id: "b", kind: "ship" },
];
const positions = new Map([
  ["a1", [0, 0]], ["a2", [0, 2]], ["b1", [4, 1]], ["ship", [1, 1]],
]);
const derived = deriveFrontlineFallback({ actors, positions, maxPairDistance: 10 });
assert.equal(derived.confidence, 0.35);
assert.equal(derived.label, "DERIVED FROM UNIT POSITIONS");
assert.equal(derived.influences.some(({ actorId }) => actorId === "ship"), false);
```

Cover mutual-nearest pairs, two midpoint ordering, one midpoint perpendicular short segment, one-side-only influences without a line, distance cutoff, excluded fleet/ship/person/other/generic unit, and no reads of `strength`, `casualties`, or `outcome`.

- [ ] **Step 3: Run and verify the missing module**

Run:

```bash
node --test tests/test_frontlines.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement deterministic resampling**

Use cumulative Euclidean distance in locally unwrapped longitude coordinates. Public functions return fresh arrays and never mutate input. `resampleLine(points, count = 48)` includes both endpoints. `resampleRing(points, count = 64)` samples `count` unique positions and appends the first point to close the ring.

- [ ] **Step 5: Implement snapshot interpolation**

Return:

```js
{
  interpolatedLines: [{ id, geometry, precision, confidence }],
  interpolatedAreas: [{ id, sideId, geometry, precision, confidence }],
  enteringLines,
  exitingLines,
  enteringAreas,
  exitingAreas,
}
```

Only same IDs and compatible types/ring counts interpolate. Carry the lower confidence and the less-certain precision (`inferred` outranks `approximate`, which outranks `exact`) across a transition.

- [ ] **Step 6: Implement conservative fallback**

Use only `army`, `corps`, `division`, `brigade`, and `regiment`. Return one influence circle descriptor per valid actor. Find mutual nearest enemies, apply `maxPairDistance`, compute midpoints, and order two-or-more midpoints along their widest coordinate axis. For one pair, return a short perpendicular two-point line. Do not union circles or import a geometry library.

- [ ] **Step 7: Run the pure module tests**

Run:

```bash
node --test tests/test_frontlines.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "feat: add frontline geometry and fallback helpers"
```

### Task 5: Timeline frontline keyframes

**Files:**
- Modify: `app/timeline.js`
- Modify: `tests/test_timeline.mjs`

- [ ] **Step 1: Add failing keyframe sampling tests**

Create three snapshots at minute 0, 10, and 20. Assert:

```js
const timeline = compileTimeline(frontlineBattle());
assert.equal(timeline.frontlineKeyframes.length, 3);
const sample = sampleTimeline(timeline, toPresentationTime(timeline, parseBattleTime(iso(5))));
assert.equal(sample.frontline.before.id, "front_0");
assert.equal(sample.frontline.after.id, "front_10");
assert.equal(sample.frontline.progress, 0.5);
assert.equal(sample.frontline.transition, "interpolate");
```

Assert one snapshot persists to the end, missing-start snapshots are excluded, and a changed stable-ID set produces `transition: "crossfade"`. Verify idle compression maps to the same historical progress and backward seek is deterministic.

- [ ] **Step 2: Run and verify failures**

Run:

```bash
node --test tests/test_timeline.mjs
```

Expected: FAIL because `frontlineKeyframes` and sampled frontline state are absent.

- [ ] **Step 3: Compile keyframes**

Add:

```js
function compileFrontlineKeyframes(battle) {
  return array(battle?.frontline_snapshots)
    .map((snapshot, sourceIndex) => ({
      id: snapshot.id,
      snapshot,
      sourceIndex,
      historicalMs: parseBattleTime(snapshot?.time?.start),
    }))
    .filter(({ historicalMs }) => Number.isFinite(historicalMs))
    .sort((a, b) => a.historicalMs - b.historicalMs || a.sourceIndex - b.sourceIndex);
}
```

Include keyframe instants in `allWindows` or historical bounds without treating them as active event ranges.

- [ ] **Step 4: Sample before/after state**

Add `sampleFrontline(timeline, historicalMs)` returning `null` when no keyframes, otherwise:

```js
{
  before: before.snapshot,
  after: after.snapshot,
  progress,
  transition: compatibleStableIds(before.snapshot, after.snapshot) ? "interpolate" : "crossfade",
}
```

Before the first keyframe, use the first snapshot with progress 0; after the last, persist the last snapshot. Keep `sampleFrontline` private and test it through `sampleTimeline()`.

- [ ] **Step 5: Run timeline and full Node tests**

Run:

```bash
node --test tests/test_timeline.mjs tests/test_frontlines.mjs
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/timeline.js tests/test_timeline.mjs
git commit -m "feat: sample frontline timeline keyframes"
```

### Task 6: Fronts control and source-backed SVG layer

**Files:**
- Modify: `app/index.html`
- Modify: `app/styles.css`
- Modify: `app/animate.js`
- Modify: `tests/test_renderer.mjs`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add failing markup and control contracts**

Assert exact markup:

```html
<button id="fronts-button" type="button" class="ghost" aria-pressed="false" disabled>Fronts: off</button>
```

Add it after Modern borders. Extend renderer fakes with `fronts-button`.

Add a wiring test proving one click calls `setFrontsEnabled`, rewiring removes the old handler, and the click does not pause or change time.

- [ ] **Step 2: Add failing source-front rendering tests**

Use a `0.4.0` fixture with two compatible snapshots. Assert the first render creates:

- one `.frontline-layer`;
- `.front-control-area` below `.front-line`;
- source-backed line class `.is-source-backed`;
- fill color derived from `side.color`;
- button enabled and `Fronts: on` by default.

Assert `setFrontsEnabled(false)` hides the layer without changing playback, Follow, Focus, Trails, borders, actor positions, or historical time.

- [ ] **Step 3: Run and verify failures**

Run:

```bash
node --test tests/test_renderer.mjs
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_static_app_exposes_continuous_playback_controls -v
```

Expected: FAIL because the control and SVG layer do not exist.

- [ ] **Step 4: Add control lifecycle**

Wire:

```js
const fronts = $("fronts-button");
own(fronts, "onclick", () => controller.setFrontsEnabled(!controller.frontsEnabled));
```

The controller starts `frontsEnabled` based on whether the initial sampled state has a source snapshot or a valid land fallback. `resetBattleUI` restores disabled/off. Document replacement recomputes availability; preference is not persisted.

- [ ] **Step 5: Create SVG groups in fixed order**

Immediately before movement/event/unit groups:

```js
const frontlineLayer = svgEl(documentRef, "g", { class: "frontline-layer" });
const controlAreaLayer = svgEl(documentRef, "g", { class: "front-control-area-layer" });
const frontLineLayer = svgEl(documentRef, "g", { class: "front-line-layer" });
frontlineLayer.append(controlAreaLayer, frontLineLayer);
svg.append(frontlineLayer);
```

Render sampled source snapshot geometry through `interpolateFrontlineSnapshots()` and existing projection helpers. Key DOM nodes by `area:${id}` and `line:${id}` so map reprojection updates rather than replaces them.

- [ ] **Step 6: Add source and inferred styling**

Add CSS:

```css
.front-control-area { pointer-events:none; opacity:.16; }
.front-line { pointer-events:none; fill:none; stroke-width:3; vector-effect:non-scaling-stroke; }
.front-line.is-source-backed { stroke-dasharray:none; }
.front-line.is-inferred { stroke-dasharray:10 7; }
.frontline-confidence-label { font-size:11px; paint-order:stroke; stroke:var(--paper); stroke-width:4px; }
.frontline-layer[hidden] { display:none; }
```

Use lower fill opacity for `precision === "inferred"` and render `推定 · NN%` near the line midpoint.

- [ ] **Step 7: Run renderer and static tests**

Run:

```bash
node --test tests/test_renderer.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/index.html app/styles.css app/animate.js tests/test_renderer.mjs tests/test_mvp_contract.py
git commit -m "feat: render source-backed frontlines"
```

### Task 7: Crossfade, seek, and reduced motion

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`

- [ ] **Step 1: Add failing transition tests**

Test normal playback across:

- compatible IDs: one keyed DOM node changes geometry continuously without replacement;
- incompatible IDs: old node receives `.is-front-exiting`, new node `.is-front-entering`, both removed/settled after 500ms;
- scrub/seek: no entering/exiting class or timeout;
- backward seek: deterministic target geometry;
- reduced motion: immediate target state and no timeout;
- destroy/replacement: all front transition timers cleared.

- [ ] **Step 2: Run and verify failures**

Run:

```bash
node --test --test-name-pattern="frontline|front line|front control" tests/test_renderer.mjs
```

Expected: transition tests fail.

- [ ] **Step 3: Implement mode-aware transitions**

Keep `renderAt(presentationMs, { mode })` as the single transition owner. When `mode === "playback"` and the timeline says `crossfade`, retain old keyed nodes for `FRONT_CROSSFADE_MS = 500`. For `seek`, reset, previous/next, reduced motion, and initial render, replace immediately.

Track timers in `controller._frontTransitionTimers`; clear them in `setFrontsEnabled(false)`, document replacement, and `destroy()`.

- [ ] **Step 4: Add reduced-motion CSS**

```css
.front-line.is-front-entering,
.front-control-area.is-front-entering { animation:front-fade-in 500ms ease-out both; }
.front-line.is-front-exiting,
.front-control-area.is-front-exiting { animation:front-fade-out 500ms ease-in both; }

@media (prefers-reduced-motion: reduce) {
  .front-line,
  .front-control-area { animation:none !important; transition:none !important; }
}
```

- [ ] **Step 5: Run renderer tests**

Run:

```bash
node --test tests/test_renderer.mjs
```

Expected: all pass with no leaked timeouts.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js app/styles.css tests/test_renderer.mjs
git commit -m "feat: animate frontline topology changes"
```

### Task 8: Renderer-derived land fallback

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`

- [ ] **Step 1: Add failing fallback integration tests**

Create a `0.4.0` land fixture with no snapshots and opposing division/brigade actors. Assert:

- Fronts defaults on;
- one `.front-influence` per eligible actor;
- no ship/fleet/person influence;
- `.front-line.is-derived` is dashed;
- label is `DERIVED FROM UNIT POSITIONS · ≤35%`;
- source snapshot added at current time suppresses fallback;
- one-side-only shows influences but no line;
- all-naval document disables Fronts.

Assert fallback ignores `strength`, `casualties`, and `outcome` by mutating them while expecting identical descriptors.

- [ ] **Step 2: Run and verify failures**

Run:

```bash
node --test --test-name-pattern="fallback|derived front|naval front" tests/test_renderer.mjs
```

Expected: FAIL because renderer fallback is absent.

- [ ] **Step 3: Render fallback only when source state is absent**

In the render path:

```js
const sourceFront = sampled.frontline;
const fallback = sourceFront ? null : deriveFrontlineFallback({
  actors: battle.actors,
  positions: sampled.actorPositions,
  maxPairDistance: fallbackPairDistance(map.getZoom()),
});
```

Represent influences as SVG circles with fixed screen radius; reproject centers on map movement without changing radius. Project the derived contact line like other frontline paths.

- [ ] **Step 4: Add derived styles**

```css
.front-influence { pointer-events:none; opacity:.10; }
.front-line.is-derived { stroke-dasharray:7 7; opacity:.68; }
.frontline-confidence-label.is-derived { letter-spacing:.04em; }
```

Do not use blur filters or polygon union.

- [ ] **Step 5: Run renderer and pure fallback tests**

Run:

```bash
node --test tests/test_frontlines.mjs tests/test_renderer.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js app/styles.css tests/test_renderer.mjs
git commit -m "feat: derive low-confidence land frontlines"
```

### Task 9: Inspector and Prompt 1.1.0

**Files:**
- Modify: `app/index.html`
- Modify: `app/animate.js`
- Modify: `README.md`
- Modify: `tests/test_renderer.mjs`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add failing inspector tests**

Add semantic fields under the current event inspector:

```html
<section id="frontline-status" aria-label="Frontline status" hidden>
  <h3>Frontline</h3>
  <p id="frontline-summary"></p>
  <ul id="frontline-sources"></ul>
</section>
```

Test exact/inferred/source/fallback states:

- source: time, precision, confidence, source links, linked event, `Interpolated` or `Crossfade`;
- fallback: warning text `Not a source-backed frontline` and no fake source link;
- Fronts off/no data: section hidden.

- [ ] **Step 2: Add failing prompt contracts**

Change expected strings to:

```python
"Generate JSON With AI — Battle JSON Prompt 1.1.0"
'schema_version 固定使用字串 "0.4.0"'
'metadata.source_system 固定使用字串 "battle_json_prompt_1.1.0"'
"frontline_snapshots"
"confidence <= 0.5"
```

Assert the fenced prompt says snapshots are optional, requires direct supporting sources, forbids deriving precise encirclements from outcome prose, and tells the model to preserve stable line/area IDs.

- [ ] **Step 3: Run and verify failures**

Run:

```bash
node --test --test-name-pattern="frontline inspector" tests/test_renderer.mjs
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v11_teaches_v040_frontlines -v
```

Expected: FAIL because inspector and Prompt 1.1.0 are absent.

- [ ] **Step 4: Implement the inspector**

Update existing inspector rendering, not a new floating map card. Build source anchors with DOM APIs and `textContent`; never interpolate source text into `innerHTML`. Hide the section when Fronts is off.

- [ ] **Step 5: Upgrade the README prompt**

Update schema/prompt provenance strings, top-level optional key list, legal fields, evidence rules, final quality checklist, and embedded sample. Keep all pre-existing movement, engagement, icon, uncertainty, and source-boundary guidance unless directly superseded by `0.4.0`.

Add the exact frontline legal fields:

```text
frontline_snapshots[]（選填）:
  *id *time *precision *confidence *source_ids, event_id, front_lines, control_areas
  front_lines[]: *id *geometry
  control_areas[]: *id *side_id *geometry
```

- [ ] **Step 6: Run prompt, renderer, and full contracts**

Run:

```bash
node --test tests/test_renderer.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/index.html app/animate.js README.md tests/test_renderer.mjs tests/test_mvp_contract.py
git commit -m "docs: publish prompt 1.1 and frontline inspector"
```

### Task 10: Tracked 0.4 example and complete acceptance

**Files:**
- Create: `examples/battle-of-stalingrad-frontlines.json`
- Modify: `README.md`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add a failing example contract**

Assert the new file:

- has `schema_version: "0.4.0"`;
- has `metadata.source_system: "battle_json_prompt_1.1.0"`;
- has at least three strictly increasing snapshots;
- contains matching stable IDs between snapshots for interpolation;
- contains a later split/merge with new IDs for crossfade;
- includes at least two side-owned control areas;
- includes direct source IDs for every snapshot;
- validates with Python and browser validators.

- [ ] **Step 2: Run and verify the missing example**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_stalingrad_v040_frontline_example -v
```

Expected: ERROR with `FileNotFoundError`.

- [ ] **Step 3: Audit direct frontline sources**

Inspect the Battle of Stalingrad Wikipedia article and the individual Wikimedia Commons file pages for operational maps covering the three selected dates. Record each direct page URL, title, retrieval date, and the license stated on that file page in `sources[]`. A general battle article may support names and chronology, but every snapshot must cite at least one map or spatial source that visibly supports that snapshot. If three directly supported dates cannot be found, stop this task and report the evidence gap instead of inventing geometry.

- [ ] **Step 4: Create the source-backed example**

Build `examples/battle-of-stalingrad-frontlines.json` only from the audited sources. Keep geometry coarse enough to match the visible map; mark representative geometry `approximate` or `inferred`, with inferred confidence `<= 0.5`. Do not reuse either untracked Stalingrad file unless every reused claim and source passes the same audit.

The three snapshots must demonstrate:

1. matching `front_main` and matching area IDs;
2. a second compatible `front_main` position;
3. new `front_north` and `front_south` IDs representing a split or encirclement state.

- [ ] **Step 5: Update README file list and app instructions**

Document the new example, Fronts control, source-vs-derived styles, and the fact that fallback is not written to JSON.

- [ ] **Step 6: Run every automated check**

Run:

```bash
node --test tests/*.mjs
python3 -m unittest tests/test_mvp_contract.py -v
git ls-files -z 'examples/*.json' |
  while IFS= read -r -d '' file; do python3 -m battle_animation.validator "$file" || exit 1; done
git diff --check
```

Expected: all Node and Python tests pass; every tracked example is valid; no whitespace errors.

- [ ] **Step 7: Perform real-browser acceptance**

Serve:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/app/` and verify:

1. The Stalingrad example shows control fills beneath units and source-backed solid lines.
2. Compatible snapshots move continuously with historical time.
3. Split/merge state crossfades instead of warping.
4. Scrubbing and previous/next do not replay crossfade.
5. Reduced motion switches immediately.
6. Fronts toggling does not alter playback, Follow, Focus, Trails, borders, or unit positions.
7. Fallback is dashed and visibly labeled; naval example keeps Fronts disabled.
8. Inspector source links and warnings are correct.
9. Mobile viewport keeps Fronts reachable and the scrubber unobstructed.
10. Replacing a document and destroying the controller leave no stale front nodes or timers.

- [ ] **Step 8: Commit**

```bash
git add examples/battle-of-stalingrad-frontlines.json README.md tests/test_mvp_contract.py
git commit -m "feat: add v0.4 frontline demonstration"
```

## Final self-review checklist

- Tasks 1–3 keep JSON Schema, Python types/validator, and browser validator synchronized.
- Tasks 4–5 keep geometry and time sampling pure and testable.
- Tasks 6–9 own renderer/UI behavior without moving historical facts into animation hints.
- Task 10 proves interpolation, topology crossfade, fallback labeling, prompt provenance, and old-version compatibility.
- No task adds a geometry dependency, military simulation fields, MultiPolygon, MultiLineString, or a patch language.
- Source snapshots always outrank renderer fallback.
- Fallback never writes JSON and never reads strength, casualties, outcome, or engagement results.
- Existing untracked `.codex/`, `AGENTS.md`, and Stalingrad JSON files remain untouched.

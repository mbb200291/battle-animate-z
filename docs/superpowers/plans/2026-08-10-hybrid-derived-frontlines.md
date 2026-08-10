# Hybrid Derived Frontlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate deterministic low-confidence land frontlines from moving unit positions, blend them into source-backed frontline anchors, expose four display modes, and update the AI prompt and reference data without mixing derived geometry into historical JSON.

**Architecture:** Keep historical snapshots in the existing timeline and add pure geometry helpers in `app/frontlines.js` for leaf-unit selection, a two-side distance field, deterministic contour extraction, and source convergence. `app/animate.js` owns only display-mode state and SVG rendering. Schema 0.4.0 remains unchanged; README Prompt 1.2.0 asks the AI for source-backed unit positions and source-backed snapshots, while all point-derived frontlines remain runtime-only.

**Tech Stack:** Vanilla JavaScript ES modules, SVG, Leaflet, Node `node:test`, Python 3.10+ `unittest`, existing dependency-free validator.

---

## File map

- Modify `app/frontlines.js`: pure unit-selection, influence-field contour, smoothing, and hybrid-convergence helpers.
- Modify `app/animate.js`: mode state, hybrid/source/derived selection, multi-line rendering, fallback and provenance.
- Modify `app/index.html`: initial four-state Fronts button label.
- Modify `tests/test_frontlines.mjs`: geometry and determinism contracts.
- Modify `tests/test_renderer.mjs`: mode cycling, fallback, provenance, seek and reduced-motion contracts.
- Modify `README.md`: Battle JSON Prompt 1.2.0 and user-facing Fronts documentation.
- Modify `tests/test_mvp_contract.py`: prompt/version and reference-example contracts.
- Create `examples/battle-of-the-bulge-frontlines.json`: source anchors plus source-supported division movements.

## Execution prerequisite

The current worktree already contains the separately completed Stalingrad correction in `examples/battle-of-stalingrad-frontlines.json` and `tests/test_mvp_contract.py`. Before creating an implementation worktree, verify and commit those two files alone; do not stash, overwrite, or mix them into this feature's commits.

Run:

```bash
python3 -m battle_animation.validator examples/battle-of-stalingrad-frontlines.json
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_stalingrad_v040_frontline_example -v
node --test tests/*.mjs
git diff --check
```

Expected: validator reports `valid`, Python test passes, all Node tests pass, and `git diff --check` is silent. Commit only those two paths with `fix: align Stalingrad enclosure with source map`, then create a worktree using `superpowers:using-git-worktrees`.

### Task 1: Select non-duplicated land influences

**Files:**
- Modify: `app/frontlines.js:1-10,260-350`
- Test: `tests/test_frontlines.mjs:200-365`

- [ ] **Step 1: Write failing selection tests**

Replace mutual-nearest-specific expectations with contracts for leaf selection and availability:

```js
test("derived influences use positioned leaf land units without counting their parents", () => {
  const actors = [
    { id: "corps", side_id: "a", kind: "corps" },
    { id: "division", parent_id: "corps", side_id: "a", kind: "division" },
    { id: "enemy", side_id: "b", kind: "division" },
  ];
  const result = deriveFrontlineFallback({
    actors,
    positions: new Map([["corps", [0, 0]], ["division", [0, 1]], ["enemy", [4, 1]]]),
    bounds: [[-1, -1], [5, 2]],
  });
  assert.deepEqual(result.influences.map(({ actorId }) => actorId), ["division", "enemy"]);
});

test("derived front is unavailable unless exactly two land sides remain", () => {
  const actor = (id, sideId, x) => ({ id, side_id: sideId, kind: "division", x });
  const actors = [actor("a", "a"), actor("b", "b"), actor("c", "c")];
  const positions = new Map([["a", [0, 0]], ["b", [2, 0]], ["c", [4, 0]]]);
  assert.equal(deriveFrontlineFallback({ actors: actors.slice(0, 1), positions }).reason, "requires-two-sides");
  assert.equal(deriveFrontlineFallback({ actors, positions }).reason, "requires-two-sides");
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `node --test tests/test_frontlines.mjs`

Expected: failures because a positioned parent is still included and `reason` is absent.

- [ ] **Step 3: Implement the minimum leaf selector**

Add a pure helper and make fallback call it:

```js
export function selectFrontlineInfluences(actors = [], positions = new Map()) {
  const positioned = actors.filter(({ kind, id, side_id: sideId }) =>
    LAND_KINDS.has(kind) && typeof sideId === "string" && isPoint(positions.get(id)));
  const positionedParentIds = new Set(positioned.map(({ parent_id: parentId }) => parentId).filter(Boolean));
  return positioned
    .filter(({ id }) => !positionedParentIds.has(id))
    .map(({ id: actorId, side_id: sideId }) => ({ actorId, sideId, position: [...positions.get(actorId)] }))
    .sort((left, right) => left.actorId.localeCompare(right.actorId));
}
```

Return a stable unavailable shape when the selected influence set contains other than two unique sides:

```js
{
  available: false,
  reason: "requires-two-sides",
  influences,
  contactLines: [],
  precision: "inferred",
  confidence: 0.35,
  label: "DERIVED FROM UNIT POSITIONS",
}
```

- [ ] **Step 4: Run selection tests and the full frontend suite**

Run: `node --test tests/test_frontlines.mjs && node --test tests/*.mjs`

Expected: all tests pass after obsolete pair-order assertions are removed only where they describe the replaced algorithm.

- [ ] **Step 5: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "refactor: select leaf units for derived fronts"
```

### Task 2: Replace midpoint pairing with a deterministic influence field

**Files:**
- Modify: `app/frontlines.js:250-380`
- Test: `tests/test_frontlines.mjs:200-390`

- [ ] **Step 1: Write failing contour tests**

Add contracts using explicit bounds and a small deterministic grid:

```js
test("influence field forms a vertical front between two unit rows", () => {
  const result = deriveFrontlineFallback({
    actors: [
      { id: "a1", side_id: "a", kind: "division" },
      { id: "a2", side_id: "a", kind: "division" },
      { id: "b1", side_id: "b", kind: "division" },
      { id: "b2", side_id: "b", kind: "division" },
    ],
    positions: new Map([["a1", [0, 0]], ["a2", [0, 4]], ["b1", [4, 0]], ["b2", [4, 4]]]),
    bounds: [[-1, -1], [5, 5]],
    gridSize: 24,
    maxPairDistance: 6,
  });
  assert.equal(result.available, true);
  assert.ok(result.contactLines.length >= 1);
  assert.ok(result.contactLines.flat().every(([x]) => Math.abs(x - 2) < 0.4));
});

test("a local advance bends only the nearby derived front", () => {
  const input = new Map([["a1", [0, 0]], ["a2", [0, 4]], ["b1", [4, 0]], ["b2", [4, 4]]]);
  const before = deriveFrontlineFallback({ actors: fieldActors, positions: input, bounds: fieldBounds, gridSize: 32 });
  input.set("a2", [2, 4]);
  const after = deriveFrontlineFallback({ actors: fieldActors, positions: input, bounds: fieldBounds, gridSize: 32 });
  assert.deepEqual(after.contactLines[0].at(0), before.contactLines[0].at(0));
  assert.notDeepEqual(after.contactLines[0].at(-1), before.contactLines[0].at(-1));
});

test("derived contours are deterministic and can close around an isolated side", () => {
  const options = { actors: enclosureActors, positions: enclosurePositions, bounds: [[-5, -5], [5, 5]], gridSize: 40 };
  const first = deriveFrontlineFallback(options);
  const second = deriveFrontlineFallback(options);
  assert.deepEqual(first, second);
  assert.ok(first.contactLines.some((line) => isClosedFrontline(line)));
});
```

Define `fieldActors`, `fieldBounds`, `enclosureActors`, and `enclosurePositions` immediately above these tests with two side-A units inside a ring of at least four side-B units.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test tests/test_frontlines.mjs`

Expected: failures because `contactLines`, grid contours, and closed derived boundaries do not exist.

- [ ] **Step 3: Implement scalar samples and marching squares**

Add focused private helpers:

```js
const nearestDistance = (point, influences) => Math.min(...influences.map(({ position }) => distance(point, position)));
const lerpPoint = (a, b, amount) => [
  wrapLongitude(a[0] + deltaLongitude(a[0], b[0]) * amount),
  a[1] + (b[1] - a[1]) * amount,
];

function zeroCrossing(a, b, aValue, bValue) {
  const span = Math.abs(aValue) + Math.abs(bValue);
  return lerpPoint(a, b, span ? Math.abs(aValue) / span : 0.5);
}
```

Build a `gridSize × gridSize` field over normalized, dateline-unwrapped `bounds`; each sample value is `nearestDistance(point, sideA) - nearestDistance(point, sideB)`. For each cell, inspect its four signed corners, create edge crossings, and emit one segment for two crossings or two deterministic segments for four crossings. Stitch segment endpoints using grid-coordinate keys rather than floating-point string equality, choose the continuation with the smallest turn, close a line when it returns to its first key, wrap output longitudes, and sort lines by their first coordinate.

Discard a segment when both its endpoints are farther than `maxPairDistance / 2` from either side. Apply one Chaikin pass only to lines with at least four points; preserve the first/last points of open lines and re-close closed lines. Return all surviving lines as `contactLines`, set `available` to `contactLines.length > 0`, and temporarily return `contactLine: contactLines[0] ?? null` so the existing renderer stays green until Task 4 consumes all lines.

- [ ] **Step 4: Run geometry tests and check determinism**

Run: `node --test tests/test_frontlines.mjs`

Expected: all frontline tests pass, including dateline and input-nonmutation tests.

- [ ] **Step 5: Run all Node tests**

Run: `node --test tests/*.mjs`

Expected: all tests pass through the temporary singular compatibility field; Task 4 switches rendering to all `contactLines`.

- [ ] **Step 6: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "feat: derive natural fronts from unit influence"
```

### Task 3: Add pure hybrid convergence

**Files:**
- Modify: `app/frontlines.js`
- Test: `tests/test_frontlines.mjs`

- [ ] **Step 1: Write failing convergence tests**

```js
test("hybrid convergence equals derived at zero and source at one", () => {
  const derived = [[[0, 0], [0, 2]]];
  const source = { precision: "approximate", confidence: 0.8, front_lines: [line("main", [[2, 0], [2, 2]])] };
  assert.deepEqual(convergeDerivedFrontlines(derived, source, 0).front_lines[0].geometry.coordinates, derived[0]);
  assert.deepEqual(convergeDerivedFrontlines(derived, source, 1).front_lines, source.front_lines);
});

test("hybrid convergence reports crossfade for incompatible topology", () => {
  const derived = [[[0, 0], [0, 2]]];
  const closed = { front_lines: [line("ring", [[0, 0], [2, 0], [1, 1], [0, 0]])] };
  assert.equal(convergeDerivedFrontlines(derived, closed, 0.5).transition, "crossfade");
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `node --test tests/test_frontlines.mjs`

Expected: import/export failure for `convergeDerivedFrontlines`.

- [ ] **Step 3: Implement convergence using existing resampling/alignment**

Export:

```js
export function convergeDerivedFrontlines(derivedLines, sourceSnapshot, sourceWeight) {
  const weight = Math.max(0, Math.min(1, sourceWeight));
  const sourceLines = sourceSnapshot?.front_lines ?? [];
  if (weight === 1) return { front_lines: sourceLines, transition: "source", sourceWeight: 1 };
  if (!derivedLines.length || derivedLines.length !== sourceLines.length) {
    return { derivedLines, front_lines: sourceLines, transition: "crossfade", sourceWeight: weight };
  }
  if (weight === 0) {
    return {
      front_lines: derivedLines.map((coordinates, index) => ({
        id: `hybrid:${sourceLines[index].id}`,
        geometry: { type: "LineString", coordinates: coordinates.map((point) => [...point]) },
      })),
      transition: "hybrid",
      sourceWeight: 0,
    };
  }
  const incompatible = derivedLines.some((coordinates, index) =>
    isClosedFrontline(coordinates) !== isClosedFrontline(sourceLines[index]?.geometry?.coordinates));
  if (incompatible) {
    return { derivedLines, front_lines: sourceLines, transition: "crossfade", sourceWeight: weight };
  }
  const front_lines = derivedLines.map((coordinates, index) => {
    const source = sourceLines[index];
    const closed = isClosedFrontline(coordinates);
    const from = closed ? resampleRing(coordinates) : resampleLine(coordinates);
    const sampledSource = closed
      ? alignRing(from, resampleRing(source.geometry.coordinates))
      : alignLine(from, resampleLine(source.geometry.coordinates));
    return {
      id: `hybrid:${source.id}`,
      geometry: {
        type: "LineString",
        coordinates: from.map((point, pointIndex) =>
          interpolatePoint(point, sampledSource[pointIndex], weight)),
      },
    };
  });
  return { front_lines, transition: "hybrid", sourceWeight: weight };
}
```

Derived contours and source lines are already deterministically ordered; pair equal-count lines by index. At weight zero preserve derived coordinates exactly. At weight one return the source objects exactly. Between endpoints, use the existing 48-point open and 64-point closed defaults. Any count or topology mismatch returns `crossfade`.

- [ ] **Step 4: Run frontline tests**

Run: `node --test tests/test_frontlines.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "feat: converge derived fronts to source anchors"
```

### Task 4: Render source, derived, hybrid, and off modes

**Files:**
- Modify: `app/animate.js:130-155,990-1010,1330-1540,1530-1565,2035-2180,2390-2405`
- Modify: `app/index.html:70`
- Test: `tests/test_renderer.mjs`

- [ ] **Step 1: Write failing mode-cycle tests**

Update the fake document button to `Fronts: hybrid`, then add:

```js
test("front control cycles hybrid source derived and off", () => {
  const { controller, document } = renderFrontlineFixture({ source: true, derived: true });
  const button = document.getElementById("fronts-button");
  assert.equal(controller.frontlineMode, "hybrid");
  assert.equal(button.textContent, "Fronts: hybrid");
  button.dispatch("click");
  assert.equal(controller.frontlineMode, "source");
  button.dispatch("click");
  assert.equal(controller.frontlineMode, "derived");
  button.dispatch("click");
  assert.equal(controller.frontlineMode, "off");
  button.dispatch("click");
  assert.equal(controller.frontlineMode, "hybrid");
});
```

Add renderer assertions that source mode emits `.is-source-backed`, derived mode emits every returned `contactLines` path with `.is-derived`, hybrid at a keyframe uses the exact source `d`, and hybrid with unavailable derived data reports the source-interpolation fallback text.

- [ ] **Step 2: Run and confirm RED**

Run: `node --test tests/test_renderer.mjs`

Expected: failures because only boolean `frontsEnabled` and singular fallback line rendering exist.

- [ ] **Step 3: Add four-state controller API**

Replace boolean toggling with:

```js
const FRONTLINE_MODES = ["hybrid", "source", "derived", "off"];

function nextFrontlineMode(mode) {
  return FRONTLINE_MODES[(FRONTLINE_MODES.indexOf(mode) + 1) % FRONTLINE_MODES.length];
}
```

The click handler calls `controller.setFrontlineMode(nextFrontlineMode(controller.frontlineMode))`. Implement `setFrontlineMode(mode)` to validate the token, clear transitions, set `frontsEnabled = mode !== "off"`, update `aria-pressed`, update `Fronts: ${mode}`, and redraw at the current presentation time. Keep `setFrontsEnabled(boolean)` as a backward-compatible controller alias mapping true to `hybrid` and false to `off` until all callers and tests migrate.

- [ ] **Step 4: Route rendering by mode**

Always compute source state and derived state when their inputs are available. Route them as follows:

```js
if (mode === "source") renderSource(sourceState);
if (mode === "derived") renderDerived(derivedState);
if (mode === "hybrid") {
  if (!sourceState) renderDerived(derivedState);
  else if (!derivedState.available) renderSource(sourceState, { fallback: true });
  else {
    const distanceFromMiddle = Math.abs(sourceState.progress - 0.5) * 2;
    const sourceWeight = distanceFromMiddle ** 2;
    renderHybrid(derivedState, sourceState, sourceWeight);
  }
}
```

The U-shaped weight is `1` at both historical anchors and `0` at the interval midpoint, so hybrid is exact at each anchor and moves away from/toward source continuously. Use a stable battle-data bounds value computed once at render startup. Render each derived `contactLines` member with key `derived:line:${index}`. In hybrid mode, keep source-backed `control_areas` on their existing interpolation path because unit points do not support deriving control polygons. Do not render influence circles in source mode; retain them in derived/hybrid only if they do not obscure source lines.

- [ ] **Step 5: Update provenance and transitions**

Set `_frontlineStatus.kind` to `source`, `derived`, `hybrid`, or `source-fallback`. For hybrid status include `sourceWeight`. Update inspector text to the four strings in the design. Mode changes, seek, and reduced motion clear enclosure/crossfade timers before immediate redraw.

- [ ] **Step 6: Run renderer and full Node tests**

Run: `node --test tests/test_renderer.mjs && node --test tests/*.mjs`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/animate.js app/index.html tests/test_renderer.mjs
git commit -m "feat: add hybrid frontline display modes"
```

### Task 5: Upgrade the AI prompt to 1.2.0

**Files:**
- Modify: `README.md:51-225,290-305`
- Modify: `tests/test_mvp_contract.py:575-625,1540-1560`

- [ ] **Step 1: Write failing Prompt 1.2.0 contracts**

Rename the existing v1.1 test and assert these exact requirements:

```python
self.assertIn("Battle JSON Prompt 1.2.0", readme)
self.assertIn('metadata.source_system 固定使用字串 "battle_json_prompt_1.2.0"', readme)
self.assertIn("不得從單位點位生成 frontline_snapshots", readme)
self.assertIn("推導戰線只由 app 執行時計算，不得寫回 JSON", readme)
self.assertIn("同一單位跨階段保持相同 actor id", readme)
self.assertRegex(readme, r"師／旅級.*代表位置.*movements")
```

Assert the embedded JSON parses, validates in both validators, contains at least two land actors per side, and contains at least two movements whose actor IDs recur across distinct historical stages.

- [ ] **Step 2: Run and confirm RED**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v12_teaches_hybrid_frontline_evidence -v`

Expected: failure on the old 1.1.0 strings and single-land-actor example.

- [ ] **Step 3: Edit the prompt and embedded sample**

Replace every prompt-version occurrence with 1.2.0 while keeping `schema_version: "0.4.0"`. Add an explicit evidence-boundary subsection containing the exact tested sentences. Expand the sample with two actors on each side and two dated advance/retreat stages; every movement must have a source-supported event, stable actor ID, inferred geometry, confidence at most 0.5, and matching waypoint count.

Keep the source-backed `frontline_snapshots` sample and state that its source must directly depict that dated line. Do not add a schema field for derived geometry or display mode.

- [ ] **Step 4: Update Fronts user documentation**

Document the four modes, default hybrid convergence, source fallback, runtime-only derivation, and the exact distinction between an inferred source trace and an app-derived line.

- [ ] **Step 5: Validate README contracts**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v12_teaches_hybrid_frontline_evidence -v`

Expected: pass with zero Python/browser diagnostics for the embedded JSON.

- [ ] **Step 6: Commit**

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: upgrade battle JSON prompt to 1.2.0"
```

### Task 6: Add the Battle of the Bulge comparison example

**Files:**
- Create: `examples/battle-of-the-bulge-frontlines.json`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write the failing example contract**

Add `BULGE_EXAMPLE` and a test requiring:

```python
self.assertEqual(battle["schema_version"], "0.4.0")
self.assertEqual(battle["metadata"]["source_system"], "battle_json_prompt_1.2.0")
self.assertEqual(
    [snapshot["time"]["start"] for snapshot in battle["frontline_snapshots"]],
    ["1944-12-16", "1944-12-20", "1944-12-25"],
)
self.assertTrue(all(snapshot["source_ids"] for snapshot in battle["frontline_snapshots"]))
self.assertGreaterEqual(sum(actor["kind"] == "division" for actor in battle["actors"]), 8)
self.assertGreaterEqual(len({movement["actor_id"] for movement in battle["movements"]}), 4)
```

Run both validators and a Node script that samples between 20 and 25 December, asserting source keyframes exist and the derived helper returns `available: true` from sampled actor positions.

- [ ] **Step 2: Run and confirm RED**

Run: `python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_bulge_v040_hybrid_reference_example -v`

Expected: failure because the file does not exist.

- [ ] **Step 3: Research and construct only source-supported data**

Use the U.S. Army Center of Military History volume `The Ardennes: Battle of the Bulge` and the dated 16/20/25 December map derived from U.S. military map `P23(map).jpg`. Record both exact URLs, retrieval date, and licenses in `sources[]`.

Create division actors only when the source identifies them. Create movements only where the source supports both the stage and representative endpoints; trace source lines coarsely into three stable-ID snapshots, mark traced geometry `precision: "inferred"`, `confidence <= 0.5`, and explain the map projection/trace limitation in each source note. Do not derive snapshot geometry from actor points.

- [ ] **Step 4: Validate the example**

Run:

```bash
python3 -m battle_animation.validator examples/battle-of-the-bulge-frontlines.json
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_bulge_v040_hybrid_reference_example -v
```

Expected: `valid` and test pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add examples/battle-of-the-bulge-frontlines.json tests/test_mvp_contract.py
git commit -m "test: add Battle of the Bulge hybrid example"
```

### Task 7: Full verification and focused review

**Files:**
- Review all files changed by Tasks 1-6.

- [ ] **Step 1: Validate every tracked example**

Run:

```bash
for file in examples/*.json; do
  git ls-files --error-unmatch "$file" >/dev/null 2>&1 || continue
  python3 -m battle_animation.validator "$file" || exit 1
done
```

Expected: every tracked example reports `valid`; no warnings.

- [ ] **Step 2: Run complete automated verification**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/*.mjs
git diff --check
```

Expected: all Python and Node tests pass; diff check is silent.

- [ ] **Step 3: Perform browser smoke checks**

Serve with `python3 -m http.server 8000`, load `http://localhost:8000/app/`, and verify the Bulge example at 16, 20, and 25 December in all four modes. Confirm hybrid equals source at anchors, derived bends with units, unavailable fallback text is readable, mode cycling has correct `aria-pressed`, seek leaves no transition residue, and reduced-motion removes animated crossfades.

- [ ] **Step 4: Review provenance boundaries**

Search:

```bash
rg -n "derived|hybrid|frontline_snapshots|source_system" README.md app examples/battle-of-the-bulge-frontlines.json
```

Expected: no derived coordinates are serialized, no app-generated line carries source IDs, Prompt 1.2.0 is consistent, and source snapshots retain direct citations.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review` on the complete diff. Address correctness findings, rerun Step 2, and only then use `superpowers:finishing-a-development-branch` to merge or retain the branch according to the user's choice.

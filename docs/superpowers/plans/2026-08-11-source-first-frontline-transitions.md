# Source-First Frontline Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hybrid frontlines use source-backed temporal geometry wherever it exists, reject ambiguous unit-derived fronts, and animate a verified stable open line into a closed source ring without inventing historical geometry.

**Architecture:** Keep source sampling in `app/timeline.js`, pure geometry and safety decisions in `app/frontlines.js`, and display-mode/provenance behavior in `app/animate.js`. Reuse stable `front_lines[].id`; do not change schema 0.4.0. Derived geometry remains runtime-only and is selected only before the first source snapshot or when the document contains no source snapshots.

**Tech Stack:** Vanilla JavaScript ES modules, SVG, Leaflet, Node `node:test`, Python 3.10+ `unittest`, dependency-free JSON validator.

---

## File Map

- Modify `app/frontlines.js`: conservative two-side separation gate and deterministic open-to-closed source interpolation.
- Modify `app/timeline.js`: distinguish time before the first source snapshot from exact/covered/final source states.
- Modify `app/animate.js`: source-first Hybrid routing and exact provenance text; remove dead source/derived convergence rendering.
- Modify `tests/test_frontlines.mjs`: pure safety-gate and endpoint-closure geometry contracts.
- Modify `tests/test_timeline.mjs`: source coverage boundary contracts.
- Modify `tests/test_renderer.mjs`: Hybrid routing, provenance, scrubbing, reduced-motion, and lifecycle integration.
- Modify `README.md`: Prompt 1.2 guidance for stable IDs and source-only historical geometry.
- Modify `tests/test_mvp_contract.py`: lock the prompt rules and preserve example/schema compatibility.

### Task 1: Preserve the Current Work and Create the Feature Branch

**Files:**
- Existing dirty prerequisite: `app/animate.js`
- Existing dirty prerequisite: `tests/test_renderer.mjs`
- Existing dirty prerequisite: `tests/test_mvp_contract.py`
- Create: `docs/superpowers/specs/2026-08-11-source-first-frontline-transitions-design.md`
- Create: `docs/superpowers/plans/2026-08-11-source-first-frontline-transitions.md`

- [ ] **Step 1: Confirm the exact starting state**

Run:

```bash
git status --short --branch
git diff --check
git diff --stat
```

Expected: branch `feature/hybrid-derived-frontlines`; only the three known prerequisite files plus these two design documents differ; diff check exits 0.

- [ ] **Step 2: Create the isolated implementation branch without discarding changes**

Run:

```bash
git switch -c feature/source-first-frontlines
```

Expected: branch changes to `feature/source-first-frontlines`; all five working-tree changes remain.

- [ ] **Step 3: Verify prerequisite behavior before committing**

Run:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/*.mjs
```

Expected: Python 62 tests and Node 320 tests pass at the current baseline.

- [ ] **Step 4: Commit the prerequisite fixes and approved design documents**

```bash
git add app/animate.js tests/test_renderer.mjs tests/test_mvp_contract.py \
  docs/superpowers/specs/2026-08-11-source-first-frontline-transitions-design.md \
  docs/superpowers/plans/2026-08-11-source-first-frontline-transitions.md
git commit -m "docs: define source-first frontline transitions"
```

If Git write access is rejected by the platform usage limit, stop retrying, report the exact blocker, and continue only with explicitly preserved working-tree changes.

### Task 2: Reject Ambiguous Unit-Derived Fronts

**Files:**
- Modify: `app/frontlines.js:720-770`
- Modify: `tests/test_frontlines.mjs:760-940`

- [ ] **Step 1: Write failing safety-gate tests**

Add focused tests using `deriveFrontlineFallback`:

```js
test("derived fallback requires two positioned actors per side", () => {
  const result = deriveFrontlineFallback({
    actors: [
      { id: "a1", kind: "division", side_id: "a" },
      { id: "b1", kind: "division", side_id: "b" },
      { id: "b2", kind: "division", side_id: "b" },
    ],
    positions: new Map([["a1", [0, 0]], ["b1", [2, 0]], ["b2", [2, 2]]]),
    bounds: [[-1, -1], [3, 3]],
    maxPairDistance: 6,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "requires-two-per-side");
});

test("derived fallback rejects interleaved side projections", () => {
  const result = deriveFrontlineFallback({
    actors: fieldActors,
    positions: new Map([
      ["a1", [0, 0]], ["a2", [3, 2]],
      ["b1", [1, 0]], ["b2", [2, 2]],
    ]),
    bounds: [[-1, -1], [4, 3]],
    maxPairDistance: 6,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "interleaved-sides");
});

test("derived fallback rejects closed or multiple candidate contours", () => {
  const result = deriveFrontlineFallback({
    actors: enclosureActors,
    positions: enclosurePositions,
    bounds: [[-5, -5], [5, 5]],
    gridSize: 40,
    maxPairDistance: 10,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "ambiguous-contact-topology");
  assert.deepEqual(result.contactLines, []);
});
```

Retain one separated two-row fixture that produces exactly one open line and remains available.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --test --test-name-pattern="derived fallback requires|derived fallback rejects|influence field forms" tests/test_frontlines.mjs
```

Expected: the three new rejection contracts fail because the current implementation accepts sparse/interleaved/multi-contour inputs.

- [ ] **Step 3: Implement the minimum data-space safety gate**

Add private helpers beside `deriveFrontlineFallback`:

```js
function separatedSideRanges(influences) {
  const groups = new Map();
  influences.forEach((influence) => {
    if (!groups.has(influence.sideId)) groups.set(influence.sideId, []);
    groups.get(influence.sideId).push(influence);
  });
  const sides = [...groups.values()];
  if (sides.length !== 2 || sides.some((items) => items.length < 2)) return null;
  const longitudeAnchor = influences[0].position[0];
  const centroid = (items) => items.reduce(
    ([x, y], { position }) => [
      x + (longitudeAnchor + normalizeLongitudeDelta(position[0] - longitudeAnchor)) / items.length,
      y + position[1] / items.length,
    ],
    [0, 0],
  );
  const [leftCenter, rightCenter] = sides.map(centroid);
  const axis = [
    normalizeLongitudeDelta(rightCenter[0] - leftCenter[0]),
    rightCenter[1] - leftCenter[1],
  ];
  const length = Math.hypot(...axis);
  if (!(length > 0)) return false;
  const project = ({ position }) =>
    (normalizeLongitudeDelta(position[0] - leftCenter[0]) * axis[0]
      + (position[1] - leftCenter[1]) * axis[1]) / length;
  const ranges = sides.map((items) => {
    const values = items.map(project);
    return [Math.min(...values), Math.max(...values)];
  });
  return ranges[0][1] < ranges[1][0] || ranges[1][1] < ranges[0][0];
}
```

In `deriveFrontlineFallback`, return `requires-two-per-side` before contour extraction when a side has fewer than two actors; return `interleaved-sides` when the ranges overlap. After extraction, accept only one non-closed contact line:

```js
if (contactLines.length !== 1 || isClosedFrontline(contactLines[0])) {
  return unavailable("ambiguous-contact-topology", influences);
}
```

Use one small local `unavailable(reason, influences)` factory to avoid repeating the existing return object; do not expose a new configuration API.

- [ ] **Step 4: Run focused and full geometry tests**

Run:

```bash
node --test tests/test_frontlines.mjs
```

Expected: all frontline tests pass, including dateline and input-nonmutation contracts.

- [ ] **Step 5: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "fix: reject ambiguous derived frontlines"
```

### Task 3: Represent Source Coverage Boundaries in the Timeline

**Files:**
- Modify: `app/timeline.js:418-455`
- Modify: `tests/test_timeline.mjs:900-1030`

- [ ] **Step 1: Write failing boundary tests**

Add a fixture with snapshots at presentation-equivalent times 100 and 200, then assert:

```js
test("frontline sampling has no source state before its first snapshot", () => {
  const compiled = compileTimeline(sourceCoverageBattle());
  assert.equal(sampleTimeline(compiled, 50).frontline, null);
  assert.equal(sampleTimeline(compiled, 100).frontline.before.id, "front_100");
});

test("frontline sampling interpolates between anchors and holds the final source", () => {
  const compiled = compileTimeline(sourceCoverageBattle());
  const middle = sampleTimeline(compiled, 150).frontline;
  assert.equal(middle.before.id, "front_100");
  assert.equal(middle.after.id, "front_200");
  assert.equal(middle.progress, 0.5);
  const final = sampleTimeline(compiled, 250).frontline;
  assert.equal(final.before.id, "front_200");
  assert.equal(final.after, final.before);
});
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --test --test-name-pattern="frontline sampling has no source|frontline sampling interpolates" tests/test_timeline.mjs
```

Expected: the pre-first assertion fails because current sampling clamps to the first future snapshot.

- [ ] **Step 3: Make pre-first sampling unavailable**

Change only the boundary in `sampleFrontline`:

```js
if (historicalMs < keyframes[0].historicalMs) return null;
if (historicalMs === keyframes[0].historicalMs) {
  return settled(keyframes[0].snapshot);
}
```

Keep exact anchors, between-anchor progress, topology classification, and final clamping unchanged.

- [ ] **Step 4: Run timeline and full Node tests**

```bash
node --test tests/test_timeline.mjs
node --test tests/*.mjs
```

Expected: all tests pass; update only tests that previously required a future source snapshot before its historical time.

- [ ] **Step 5: Commit**

```bash
git add app/timeline.js tests/test_timeline.mjs
git commit -m "fix: respect frontline source coverage start"
```

### Task 4: Make Hybrid Source-First

**Files:**
- Modify: `app/animate.js:1270-1875`
- Modify: `app/frontlines.js:250-405`
- Modify: `tests/test_renderer.mjs:1280-1750`
- Modify: `tests/test_frontlines.mjs:210-570`

- [ ] **Step 1: Write failing renderer contracts**

Add tests that mutate actor positions while keeping the same source snapshots:

```js
test("source-covered hybrid ignores derived actor geometry", () => {
  const first = renderHybridAtMidpoint(hybridFrontlineBattleFixture());
  const moved = hybridFrontlineBattleFixture();
  moved.movements.forEach((movement) => {
    movement.path.coordinates = movement.path.coordinates.map(([x, y]) => [x + 20, y + 20]);
  });
  const second = renderHybridAtMidpoint(moved);
  assert.equal(first.status.kind, "source-interpolation");
  assert.equal(second.status.kind, "source-interpolation");
  assert.deepEqual(second.geographicLines, first.geographicLines);
});

test("hybrid uses derived fallback before the first source anchor only", () => {
  const { before, middle, after } = renderSourceCoverageStates();
  assert.equal(before.kind, "derived");
  assert.equal(middle.kind, "source-interpolation");
  assert.equal(after.kind, "source-snapshot");
});
```

Assert exact inspector summaries:

```js
assert.equal(summaryAtAnchor, "SOURCE SNAPSHOT");
assert.equal(summaryBetween, "SOURCE INTERPOLATION · animation between historical anchors");
assert.equal(summaryDerived, "DERIVED FROM UNIT POSITIONS · ≤35% confidence");
assert.equal(summaryUnavailable, "INSUFFICIENT EVIDENCE · frontline unavailable");
```

- [ ] **Step 2: Run and confirm RED**

```bash
node --test --test-name-pattern="source-covered hybrid|hybrid uses derived fallback|SOURCE INTERPOLATION" tests/test_renderer.mjs
```

Expected: midpoint geometry/status tests fail because current Hybrid assigns derived geometry 100% weight at the interval midpoint.

- [ ] **Step 3: Replace convergence routing with source-first routing**

Reduce `renderHybridFrontlines` to the two actual cases:

```js
function renderHybridFrontlines(sampled, mode, previousSampled) {
  if (sampled.frontline) {
    renderSourceFrontlines(sampled, mode, previousSampled);
    controller._frontlineStatus.kind = sampled.frontline.before === sampled.frontline.after
      ? "source-snapshot"
      : "source-interpolation";
    return;
  }
  renderDerivedFrontlines(sampled);
}
```

Set equivalent `source-snapshot`/`source-interpolation` status kinds in Source mode. Map derived failure reasons to `derived-unavailable` without changing historical state.

Delete renderer-only hybrid convergence helpers, per-line hybrid timer selections, obsolete `sourceWeight` inspector text, and the `convergeDerivedFrontlines` import. If `convergeDerivedFrontlines` then has no production caller, delete it and its private matching helpers from `app/frontlines.js`, together with tests that only lock the removed source/derived mixing algorithm.

- [ ] **Step 4: Update inspector provenance**

Use exact summaries:

```js
const FRONTLINE_SUMMARIES = {
  "source-snapshot": "SOURCE SNAPSHOT",
  "source-interpolation": "SOURCE INTERPOLATION · animation between historical anchors",
  derived: "DERIVED FROM UNIT POSITIONS · ≤35% confidence",
  "derived-unavailable": "INSUFFICIENT EVIDENCE · frontline unavailable",
};
```

Keep source titles, time labels, precision, confidence, and linked events in the detail/source list.

- [ ] **Step 5: Run renderer and full Node tests**

```bash
node --test tests/test_renderer.mjs
node --test tests/*.mjs
```

Expected: source-covered Hybrid remains source-derived regardless of actor movement; mode, seek, timer, dateline, and label tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js app/frontlines.js tests/test_renderer.mjs tests/test_frontlines.mjs
git commit -m "feat: make hybrid frontlines source-first"
```

### Task 5: Morph a Stable Open Source Line into a Closed Ring

**Files:**
- Modify: `app/frontlines.js:120-250`
- Modify: `app/animate.js:1270-1530`
- Modify: `tests/test_frontlines.mjs:120-220`
- Modify: `tests/test_renderer.mjs:2200-2605`

- [ ] **Step 1: Write failing pure geometry tests**

Use one stable ID with an open three-sided shape and a closed target ring:

```js
test("stable open line extends along its target ring and closes only at the anchor", () => {
  const before = { front_lines: [line("pocket", [[0, 0], [2, 0], [2, 2]])] };
  const after = { front_lines: [line("pocket", [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])] };
  const middle = interpolateFrontlineSnapshots(before, after, 0.5).interpolatedLines[0];
  const end = interpolateFrontlineSnapshots(before, after, 1).interpolatedLines[0];
  assert.equal(isClosedFrontline(middle.geometry.coordinates), false);
  assert.equal(isClosedFrontline(end.geometry.coordinates), true);
  assert.deepEqual(end.geometry.coordinates, resampleRing(after.front_lines[0].geometry.coordinates));
});

test("unsupported open-closed collections crossfade", () => {
  const result = interpolateFrontlineSnapshots(twoOpenLines, twoClosedLines, 0.5);
  assert.equal(result.interpolatedLines.length, 0);
  assert.equal(result.exitingLines.length, 2);
  assert.equal(result.enteringLines.length, 2);
});
```

Also assert determinism, dateline safety, no mutation, invalid geometry fallback, and endpoint movement at progress 0.25/0.5/0.75.

- [ ] **Step 2: Run and confirm RED**

```bash
node --test --test-name-pattern="extends along its target ring|unsupported open-closed" tests/test_frontlines.mjs
```

Expected: current generic line resampling treats the closed target as an open line and either closes too early or produces incompatible interpolation.

- [ ] **Step 3: Implement one-open-to-one-closed interpolation**

Add a private helper called only when the snapshot collections each contain exactly one matching line:

```js
function interpolateOpenToClosed(openCoordinates, ringCoordinates, progress) {
  if (progress >= 1) return resampleRing(ringCoordinates);
  const open = resampleLine(openCoordinates, 48);
  const ring = resampleRing(ringCoordinates, 64);
  if (!open.length || !ring.length) return null;
  const target = alignOpenLineToRing(open, ring);
  const body = open.map((point, index) =>
    interpolatePoint(point, target.body[index], progress));
  const revealCount = Math.floor(target.closureArc.length * progress);
  return target.closureArc.slice(0, revealCount).reverse()
    .concat(body, target.closureArc.slice(target.closureArc.length - revealCount));
}
```

`alignOpenLineToRing` must deterministically test both ring directions, choose the pair of ring cut positions with minimum endpoint-plus-body correspondence cost, and return a target body plus the remaining closure arc. At equal cost, retain source order. Do not use viewport coordinates.

In `interpolateLines`, invoke this helper only for the single matching open-to-closed collection. If it returns invalid or closed-before-anchor output, place the old/new lines in exiting/entering collections for crossfade.

- [ ] **Step 4: Render sampled enclosure geometry instead of holding the old line**

Delete the enclosure hold branch from `frontlineGeometry`:

```js
// Remove: interpolateFrontlineSnapshots(state.before, state.before, 0)
return interpolateFrontlineSnapshots(state.before, state.after, state.progress);
```

Keep playback-only emphasis optional, but it must not replace the sampled morph with a sudden final-ring reveal. Scrubbing and reduced motion render the same deterministic sampled geometry without transient timers.

- [ ] **Step 5: Update renderer lifecycle tests**

Replace tests that require the old line to remain frozen until crossing with assertions that:

- sampled paths change continuously at 25%, 50%, and 75%;
- the path is open before 100% and exactly closed at 100%;
- backward seek returns the identical earlier path;
- playback, reduced motion, mode changes, replacement, and destroy leave no mask, clone, or stale enclosure timer;
- unsupported split/merge still uses the existing topology crossfade timer.

- [ ] **Step 6: Run focused and full tests**

```bash
node --test tests/test_frontlines.mjs
node --test tests/test_renderer.mjs
node --test tests/*.mjs
```

Expected: geometry, renderer, and complete Node suites pass.

- [ ] **Step 7: Commit**

```bash
git add app/frontlines.js app/animate.js tests/test_frontlines.mjs tests/test_renderer.mjs
git commit -m "feat: grow source frontlines into enclosures"
```

### Task 6: Tighten the AI Prompt and Verify the Whole Branch

**Files:**
- Modify: `README.md` under `Generate JSON With AI`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing prompt contracts**

Extend `test_readme_prompt_v12_teaches_hybrid_frontline_evidence` with exact requirements:

```python
self.assertIn("同一條戰線只有在來源支持連續性時，才跨 snapshot 沿用相同 id", prompt)
self.assertIn("不得從單位位置推導突出部、包圍圈或控制區", prompt)
self.assertIn("只有文字記載而沒有地圖輪廓時，只建立事件，不建立戰線幾何", prompt)
self.assertIn("推導戰線不得寫入 frontline_snapshots", prompt)
```

Add a contract confirming the schema version remains `0.4.0` and the prompt version is upgraded from `1.2.0` to `1.3.0`. Prompt guidance changed, but the JSON format did not.

- [ ] **Step 2: Run and confirm RED**

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v12_teaches_hybrid_frontline_evidence -v
```

Expected: the new exact guidance strings and Prompt `1.3.0` marker are absent.

- [ ] **Step 3: Add concise prompt guidance**

Insert the four rules next to the existing frontline evidence rules. Do not add a second prompt template, change schema fields, or ask the LLM to classify reserves, penetrations, or encirclements without mapped evidence.

- [ ] **Step 4: Run complete verification**

```bash
python3 -m unittest tests/test_mvp_contract.py -v
node --test tests/*.mjs
for battle_file in examples/*.json; do
  python3 -m battle_animation.validator "$battle_file" || exit 1
done
node --check app/frontlines.js
node --check app/timeline.js
node --check app/animate.js
git diff --check
```

Expected: all Python and Node tests pass, every tracked example is valid, syntax checks exit 0, and diff check is clean.

- [ ] **Step 5: Perform browser smoke verification**

Serve the feature worktree and verify:

- Source and Hybrid show no future source line before the first snapshot.
- Hybrid uses source interpolation between anchors and preserves the final source afterward.
- Derived mode reports unavailable for interleaved Bulge unit positions rather than drawing a misleading line.
- A stable open-to-closed source track grows and closes continuously.
- Backward scrubbing and reduced motion leave no stale overlay.
- Browser console has no errors.

If no sanctioned browser backend is available, report this check as unverified; do not substitute a fake browser claim.

- [ ] **Step 6: Commit**

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: clarify source-only frontline evidence"
```

- [ ] **Step 7: Request final review and preserve the branch**

Compare the new branch against its merge base, request a correctness/spec review, address every Critical or Important finding, rerun Step 4, and keep `feature/source-first-frontlines` unmerged until the user explicitly requests integration.

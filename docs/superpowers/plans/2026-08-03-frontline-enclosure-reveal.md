# Frontline Enclosure Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep normal frontline morphing, but replace the discontinuous open-line-to-closed-enclosure morph with a source-conservative outline reveal.

**Architecture:** Add a pure open/closed topology classifier to `app/frontlines.js`, expose `transition: "enclosure"` from the timeline, and let `renderAt()` own the playback-only reveal lifecycle. The target line keeps its normal source/inferred styling and is revealed through a temporary animated SVG mask; seeks and reduced motion bypass the mask.

**Tech Stack:** Vanilla JavaScript ES modules, SVG masks and CSS keyframes, Node's built-in test runner, Python `unittest` static contracts.

---

## File responsibilities

- `app/frontlines.js`: pure dateline-safe closed-line detection and matching enclosure IDs.
- `app/timeline.js`: classify compatible snapshot pairs as `interpolate`, `enclosure`, or `crossfade`.
- `app/animate.js`: hold old geometry before an enclosure keyframe and own reveal masks, fade timers, and cleanup.
- `app/styles.css`: old-line fade, mask stroke reveal, delayed control-area fill, and reduced-motion overrides.
- `tests/test_frontlines.mjs`: pure topology detection tests.
- `tests/test_timeline.mjs`: historical sampling semantics for enclosure transitions.
- `tests/test_renderer.mjs`: DOM, timer, seek, frame-jump, cleanup, and reduced-motion behavior.
- `tests/test_mvp_contract.py`: static CSS/renderer contract so production markup and accessibility behavior remain exposed.

No schema, Python type, Python validator, prompt, or JSON example changes are required.

### Task 1: Pure enclosure topology detection

**Files:**
- Modify: `app/frontlines.js`
- Modify: `tests/test_frontlines.mjs`

- [ ] **Step 1: Write failing closed-line tests**

Import the new API and add these cases:

```js
import {
  enclosureLineIds,
  isClosedFrontline,
} from "../app/frontlines.js";

test("closed frontline detection is dateline-safe and rejects degenerate paths", () => {
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [2, 2], [0, 0]]), true);
  assert.equal(isClosedFrontline([[179.9999999, 0], [-179.5, 1], [-179, 0], [-180, 0]]), true);
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [2, 2], [0.001, 0]]), false);
  assert.equal(isClosedFrontline([[0, 0], [1, 0], [0, 0]]), false);
  assert.equal(isClosedFrontline(null), false);
});
```

Use a `1e-6` degree detection tolerance. The dateline fixture's first and last longitudes differ by approximately zero after longitude wrapping.

- [ ] **Step 2: Write failing matching-ID tests**

```js
test("enclosureLineIds returns only stable ids changing from open to closed", () => {
  const before = {
    front_lines: [
      { id: "main", geometry: { type: "LineString", coordinates: [[0, 0], [2, 1], [4, 0]] } },
      { id: "stable", geometry: { type: "LineString", coordinates: [[8, 0], [9, 1], [10, 0]] } },
    ],
  };
  const after = {
    front_lines: [
      { id: "main", geometry: { type: "LineString", coordinates: [[0, 0], [3, 0], [2, 2], [0, 0]] } },
      { id: "stable", geometry: { type: "LineString", coordinates: [[8, 1], [9, 2], [10, 1]] } },
    ],
  };
  assert.deepEqual(enclosureLineIds(before, after), ["main"]);
  assert.deepEqual(enclosureLineIds(after, before), []);
  assert.deepEqual(enclosureLineIds({}, after), []);
});
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
node --test tests/test_frontlines.mjs
```

Expected: FAIL because `isClosedFrontline` and `enclosureLineIds` are not exported.

- [ ] **Step 4: Implement the minimal pure helpers**

Add next to the existing longitude helpers in `app/frontlines.js`:

```js
const CLOSED_LINE_TOLERANCE = 1e-6;

export function isClosedFrontline(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4 || !coordinates.every(isPoint)) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return Math.abs(deltaLongitude(first[0], last[0])) <= CLOSED_LINE_TOLERANCE
    && Math.abs(first[1] - last[1]) <= CLOSED_LINE_TOLERANCE;
}

export function enclosureLineIds(beforeSnapshot, afterSnapshot) {
  const afterById = new Map((afterSnapshot?.front_lines || []).map((line) => [line?.id, line]));
  return (beforeSnapshot?.front_lines || []).flatMap((line) => {
    const next = afterById.get(line?.id);
    if (line?.geometry?.type !== "LineString" || next?.geometry?.type !== "LineString") return [];
    return !isClosedFrontline(line.geometry.coordinates) && isClosedFrontline(next.geometry.coordinates)
      ? [line.id]
      : [];
  });
}
```

Keep both functions pure and do not normalize or mutate source coordinates.

- [ ] **Step 5: Run pure and full Node tests**

Run:

```bash
node --test tests/test_frontlines.mjs
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/frontlines.js tests/test_frontlines.mjs
git commit -m "feat: detect frontline enclosure topology"
```

### Task 2: Timeline enclosure sampling

**Files:**
- Modify: `app/timeline.js`
- Modify: `tests/test_timeline.mjs`

- [ ] **Step 1: Add failing enclosure transition tests**

Extend the existing frontline fixture with a stable `main_front` that is open at minute 0 and closed at minute 10. Test through public APIs only:

```js
test("timeline classifies an open-to-closed stable line as enclosure", () => {
  const battle = frontlineBattle();
  battle.frontline_snapshots[1].front_lines[0].geometry.coordinates = [
    [0, 0], [4, 0], [4, 4], [0, 0],
  ];
  const timeline = compileTimeline(battle);
  const halfway = toPresentationTime(timeline, parseBattleTime(iso(5)));
  const sample = sampleTimeline(timeline, halfway);
  assert.equal(sample.frontline.transition, "enclosure");
  assert.deepEqual(sample.frontline.enclosureLineIds, ["front_main"]);
});

test("closed-to-open and changed ids remain crossfades", () => {
  const battle = frontlineBattle();
  battle.frontline_snapshots[0].front_lines[0].geometry.coordinates = [
    [0, 0], [4, 0], [4, 4], [0, 0],
  ];
  assert.equal(sampleAtMinute(battle, 5).frontline.transition, "crossfade");

  battle.frontline_snapshots[1].front_lines[0].id = "new_front";
  assert.equal(sampleAtMinute(battle, 5).frontline.transition, "crossfade");
});
```

Define `sampleAtMinute` in the test file using the existing `compileTimeline`, `parseBattleTime`, `toPresentationTime`, and `sampleTimeline` helpers; do not export a private sampler.

- [ ] **Step 2: Run timeline tests and confirm RED**

Run:

```bash
node --test tests/test_timeline.mjs
```

Expected: FAIL because the transition is currently `interpolate`.

- [ ] **Step 3: Classify the transition without duplicating closure math**

Add this import at the top of `app/timeline.js`:

```js
import { enclosureLineIds } from "./frontlines.js";
```

Replace the inline transition selection in `sampleFrontline()` with:

```js
const enclosureIds = enclosureLineIds(before.snapshot, after.snapshot);
const compatible = compatibleStableIds(before.snapshot, after.snapshot);
return {
  before: before.snapshot,
  after: after.snapshot,
  progress: (historicalMs - before.historicalMs) / (after.historicalMs - before.historicalMs),
  transition: enclosureIds.length && compatible ? "enclosure" : compatible ? "interpolate" : "crossfade",
  enclosureLineIds: enclosureIds,
};
```

For before-first, exact singleton, and after-last returns, add `enclosureLineIds: []` so the sampled shape is consistent.

Update `compatibleStableIds()` so closed-to-open returns false:

```js
if (enclosureLineIds(afterSnapshot, beforeSnapshot).length) return false;
```

This keeps enclosure teardown on the existing crossfade path.

- [ ] **Step 4: Run timeline and full Node tests**

Run:

```bash
node --test tests/test_timeline.mjs tests/test_frontlines.mjs
node --test tests/*.mjs
```

Expected: all pass, including existing interpolation and crossfade tests.

- [ ] **Step 5: Commit**

```bash
git add app/timeline.js tests/test_timeline.mjs
git commit -m "feat: classify frontline enclosure keyframes"
```

### Task 3: Playback-only enclosure reveal

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`

- [ ] **Step 1: Add an enclosure renderer fixture**

Create `enclosureBattleFixture()` from `frontlineBattleFixture()` and keep the same line ID:

```js
function enclosureBattleFixture() {
  const battle = frontlineBattleFixture();
  battle.frontline_snapshots[1].front_lines[0].geometry.coordinates = [
    [1, 1], [5, 1], [5, 5], [1, 5], [1, 1],
  ];
  return battle;
}
```

Keep its existing target control area so delayed-fill behavior can be asserted.

- [ ] **Step 2: Add failing hold-and-reveal tests**

```js
test("enclosure transition holds the old geometry until the playback boundary", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);
  const line = frontlineElement(document, "line:main_front");
  const initial = line.getAttribute("d");

  controller.renderAt(500, { mode: "playback" });

  assert.equal(line.getAttribute("d"), initial);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("playback reveals a closed target through a temporary SVG mask", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);

  controller.renderAt(1000, { mode: "playback" });

  const target = frontlineElement(document, "line:main_front");
  const masks = descendants(document.getElementById("battle-map"))
    .filter((element) => element.classList.contains("front-enclosure-mask"));
  const oldLines = descendants(document.getElementById("battle-map"))
    .filter((element) => element.classList.contains("is-enclosure-exiting"));
  const area = frontlineElement(document, "area:blue_area");
  assert.equal(masks.length, 1);
  assert.match(target.getAttribute("mask"), /^url\(#front-enclosure-mask-/);
  assert.equal(oldLines.length, 1);
  assert.equal(area.classList.contains("is-enclosure-area-entering"), true);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("enclosure")), 900);

  clock.flushTimeouts();
  assert.equal(target.hasAttribute("mask"), false);
  assert.equal(oldLines[0].parentNode, null);
  assert.equal(area.classList.contains("is-enclosure-area-entering"), false);
});
```

Add a small `frontlineElement(document, key)` test helper that searches the existing SVG descendants by `data-frontline-key`.

- [ ] **Step 3: Add failing bypass and cleanup tests**

Cover each behavior explicitly:

```js
test("enclosure seek and reduced motion show the complete target immediately", () => {
  for (const reducedMotion of [false, true]) {
    const clock = new FrameClock(reducedMotion);
    const document = new FakeDocument(clock.window);
    installLeaflet();
    const controller = renderBattle(enclosureBattleFixture(), document);
    reducedMotion ? controller.renderAt(1000, { mode: "playback" }) : controller.seek(1000);
    assert.equal(frontlineElement(document, "line:main_front").hasAttribute("mask"), false);
    assert.equal(controller._frontTransitionTimers.size, 0);
  }
});
```

Add separate assertions that map `move`, `setFrontsEnabled(false)`, document replacement, and `destroy()` remove the mask, old clone, reveal classes, and timer. Add a frame-jump fixture with open snapshot A, unrelated snapshot B, and final closed snapshot A; one `renderAt(finalTime, { mode: "playback" })` must reveal the final closed line rather than morph or skip it.

- [ ] **Step 4: Run renderer tests and confirm RED**

Run:

```bash
node --test --test-name-pattern="enclosure" tests/test_renderer.mjs
```

Expected: FAIL because open-to-closed currently follows ordinary interpolation.

- [ ] **Step 5: Add transition constants and SVG definitions**

In `app/animate.js` add:

```js
const FRONT_ENCLOSURE_REVEAL_MS = 900;
let nextEnclosureMaskId = 0;
```

Inside `renderBattle`, append one definitions container to the frontline layer:

```js
const frontlineDefs = svgEl(documentRef, "defs", { class: "frontline-transition-defs" });
frontlineLayer.prepend(frontlineDefs);
```

Do not use `getTotalLength()`. Each mask path uses SVG `pathLength="1"`, so tests and browsers share deterministic normalized dash values.

- [ ] **Step 6: Hold historical geometry before the boundary**

At the start of `frontlineGeometry(state)`, handle enclosure sampling:

```js
if (state.transition === "enclosure" && state.progress < 1) {
  return interpolateFrontlineSnapshots(state.before, state.before, 0);
}
```

Keep the existing exact-snapshot fallback that restores valid raw lines which cannot be resampled. This change must not affect ordinary `interpolate` or `crossfade` states.

- [ ] **Step 7: Detect crossed enclosure keyframes**

Add a sibling to `crossedIncompatibleKeyframes()`:

```js
function crossedEnclosureKeyframes(previousSampled, sampled) {
  if (!previousSampled || sampled.historicalMs <= previousSampled.historicalMs) return [];
  const crossed = [];
  for (let index = 1; index < compiled.frontlineKeyframes.length; index += 1) {
    const keyframe = compiled.frontlineKeyframes[index];
    if (keyframe.historicalMs > sampled.historicalMs) break;
    if (keyframe.historicalMs <= previousSampled.historicalMs) continue;
    const before = compiled.frontlineKeyframes[index - 1].snapshot;
    const ids = enclosureLineIds(before, keyframe.snapshot);
    if (ids.length) crossed.push({ before, after: keyframe.snapshot, lineIds: ids });
  }
  return crossed;
}
```

Import `enclosureLineIds` from `app/frontlines.js`. If one frame crosses multiple enclosure boundaries, use the last crossed entry whose target line ID exists in the final sampled snapshot. Existing incompatible-keyframe aggregation remains unchanged for other lines and areas.

- [ ] **Step 8: Create and clean the mask-owned reveal**

Add a helper inside `renderBattle`:

```js
function startEnclosureReveal(owner, oldPath, targetPath, targetAreas) {
  clearFrontTransitions(owner);
  oldPath.removeAttribute("mask");
  oldPath.classList.add("is-enclosure-exiting");
  targetPath.parentNode.append(oldPath);
  transientFrontlineEls.add(oldPath);

  const maskId = `front-enclosure-mask-${++nextEnclosureMaskId}`;
  const mask = svgEl(documentRef, "mask", {
    id: maskId,
    class: "front-enclosure-mask",
    maskUnits: "userSpaceOnUse",
  });
  const maskPath = svgEl(documentRef, "path", {
    class: "front-enclosure-mask-path",
    d: targetPath.getAttribute("d"),
    fill: "none",
    stroke: "white",
    "stroke-width": "12",
    pathLength: "1",
  });
  mask.append(maskPath);
  frontlineDefs.append(mask);
  transientFrontlineEls.add(mask);
  targetPath.setAttribute("mask", `url(#${maskId})`);
  targetAreas.forEach((area) => area.classList.add("is-enclosure-area-entering"));

  const timer = scheduleTimeout(() => {
    if (owner._frontTransitionTimers.get("enclosure") !== timer) return;
    targetPath.removeAttribute("mask");
    targetAreas.forEach((area) => area.classList.remove("is-enclosure-area-entering"));
    clearFrontTransitions(owner);
  }, FRONT_ENCLOSURE_REVEAL_MS);
  owner._frontTransitionTimers.set("enclosure", timer);
}
```

When an enclosure boundary is crossed, clone each matching keyed target path **before** the render loop replaces its `d`:

```js
const oldEnclosurePaths = new Map();
for (const lineId of enclosureCrossing.lineIds) {
  const current = frontlineEls.get(`line:${lineId}`);
  if (current) oldEnclosurePaths.set(lineId, current.cloneNode(true));
}
```

Call `startEnclosureReveal()` only after the final target `d` and control-area paths have been rendered, passing `oldEnclosurePaths.get(line.id)` as `oldPath`. If the old keyed path is missing, skip animation and settle directly on the target. Keep mask IDs process-unique to avoid collisions across document replacement.

Extend `clearFrontTransitions()` to:

```js
for (const element of frontlineEls.values()) {
  element.removeAttribute("mask");
  element.classList.remove("is-enclosure-area-entering", "is-enclosure-entering");
}
```

Transient masks and old clones are already removed through `transientFrontlineEls`.

- [ ] **Step 9: Add minimal CSS**

Add beside existing frontline transition styles:

```css
.front-line.is-enclosure-exiting {
  animation: front-enclosure-old-fade 350ms ease-out both;
}

.front-enclosure-mask-path {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: front-enclosure-reveal 900ms ease-out both;
}

.front-control-area.is-enclosure-area-entering {
  animation: front-fade-in 360ms ease-out 540ms both;
}

@keyframes front-enclosure-old-fade { to { opacity: 0; } }
@keyframes front-enclosure-reveal { to { stroke-dashoffset: 0; } }
```

Inside the existing reduced-motion media query add:

```css
.front-line.is-enclosure-exiting,
.front-enclosure-mask-path,
.front-control-area.is-enclosure-area-entering {
  animation: none !important;
}
```

Reusing `front-fade-in` preserves the area's underlying `.16` source-backed or `.09` inferred opacity. The mask preserves the target line's source-backed or inferred dash style; only the white mask stroke becomes continuous.

- [ ] **Step 10: Run renderer and full Node tests**

Run:

```bash
node --test --test-name-pattern="frontline|front line|front control|enclosure" tests/test_renderer.mjs
node --test tests/*.mjs
```

Expected: all pass with no real-time waits and no leaked fake timers.

- [ ] **Step 11: Commit**

```bash
git add app/animate.js app/styles.css tests/test_renderer.mjs
git commit -m "feat: reveal newly enclosed frontlines"
```

### Task 4: Documentation contract and complete verification

**Files:**
- Modify: `tests/test_mvp_contract.py`
- Modify: `README.md`

- [ ] **Step 1: Add a failing documentation contract**

Add a README contract before changing the README:

```python
def test_readme_explains_enclosure_reveal_is_display_only(self):
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    self.assertIn("開放戰線變為閉合包圍圈", readme)
    self.assertIn("不表示來源提供了中間合圍路徑", readme)
    self.assertIn("減少動態效果", readme)
```

- [ ] **Step 2: Run the contract and confirm RED**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_explains_enclosure_reveal_is_display_only -v
```

Expected: FAIL because README does not yet describe the enclosure reveal evidence boundary.

- [ ] **Step 3: Document the display-only behavior**

Add a concise paragraph to README's Fronts documentation:

```text
同一 stable ID 由開放戰線變為閉合包圍圈時，app 會淡出舊線並逐段揭示新輪廓；這只是顯示過渡，不表示來源提供了中間合圍路徑。拖曳與減少動態效果會直接顯示目標狀態。
```

Do not add schema or prompt instructions because the transition is renderer-derived and does not alter historical JSON.

- [ ] **Step 4: Run all automated checks**

Run:

```bash
node --test tests/*.mjs
python3 -m unittest tests/test_mvp_contract.py -v
git ls-files -z 'examples/*.json' |
  while IFS= read -r -d '' file; do python3 -m battle_animation.validator "$file" || exit 1; done
git diff --check
git status --short
```

Expected: Node and Python suites pass; all tracked examples are valid; only the user's pre-existing untracked files remain.

- [ ] **Step 5: Perform browser acceptance**

Serve the repository and load `examples/battle-of-stalingrad-frontlines.json` plus a small local enclosure fixture:

```bash
python3 -m http.server 8000
```

Verify:

1. Open-to-open stable lines still morph continuously.
2. Open-to-closed stable line holds its old shape until the target keyframe.
3. At the boundary, the old line fades and the new outline draws progressively without a geometric snap.
4. Inferred target lines remain visually inferred through the mask.
5. Target control fill starts after the outline is mostly visible.
6. Scrub, previous/next, reset, and reduced motion show the complete target immediately.
7. Map move/zoom, Fronts off, replacement, and destroy leave no mask, clone, class, or timer.
8. Mobile controls and scrubber remain unobstructed.

- [ ] **Step 6: Commit documentation and contracts**

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: explain frontline enclosure reveal"
```

## Final review checklist

- Normal compatible morphing is unchanged.
- Only open-to-closed stable LineStrings use enclosure reveal.
- No intermediate historical coordinates or schema fields are created.
- Closed-to-open, split, merge, and unsafe geometry still crossfade.
- The target path retains source/inferred styling because the animated dash belongs to its mask.
- All transition-owned masks, clones, classes, and timers clear on every lifecycle exit.
- No dependency, geometry library, combat simulation, or persistent animation hint is introduced.

# Trail and Event Marker Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make movement paths opt-in and ephemeral, and replace persistent circular event markers with active-only clustered pulse beacons.

**Architecture:** Add two pure view helpers: timeline track-progress sampling and projected event clustering. Keep transient trail/beacon lifecycle state inside the existing renderer controller so seeking can reconstruct deterministic state while normal playback may run short CSS/timer exits. Reuse the existing control wiring and teardown ownership model.

**Tech Stack:** Browser-native ES modules, SVG, CSS animations/transitions, Leaflet projection, Node `node:test`, Python `unittest`, static HTML.

---

## File Map

- Create `app/overlay-effects.js` — pure event-beacon clustering and constants shared by renderer/tests.
- Create `tests/test_overlay_effects.mjs` — clustering boundary, transitivity, centroid, and deterministic-key tests.
- Modify `app/timeline.js` — export normalized movement-path progress without duplicating interpolation rules.
- Modify `app/animate.js` — trail toggle/lifecycle, progressive path reveal, clustered beacons, timer cleanup.
- Modify `app/index.html` — add the accessible trail toggle.
- Modify `app/styles.css` — opt-in trail states, 2.5-second fade, diamond beacon/pulse/exit styles, reduced motion.
- Modify `tests/test_timeline.mjs` — movement progress tests.
- Modify `tests/test_renderer.mjs` — renderer/controller/control/lifecycle/style integration tests.
- Modify `tests/test_mvp_contract.py` — static UI and README contract assertions.
- Modify `README.md` — document default-off trails and active event beacons.

## Task 1: Expose Exact Movement-Path Progress

**Files:**
- Modify: `app/timeline.js`
- Modify: `tests/test_timeline.mjs`

- [ ] **Step 1: Write failing uniform and waypoint progress tests**

Add imports and tests in `tests/test_timeline.mjs`:

```javascript
import { trackProgressAt } from "../app/timeline.js";

test("trackProgressAt follows cumulative path distance", () => {
  const timeline = compileTimeline({
    actors: [{ id: "ship", kind: "ship" }],
    historical_events: [], places: [], engagements: [],
    movements: [{
      id: "move", actor_id: "ship",
      time: { start: "2020-01-01T00:00:00Z", end: "2020-01-01T00:00:10Z" },
      path: { type: "LineString", coordinates: [[0, 0], [1, 0], [3, 0]] },
    }],
  });
  const track = timeline.tracks[0];
  assert.equal(trackProgressAt(track, track.startMs), 0);
  assert.equal(trackProgressAt(track, track.startMs + 5_000), 0.5);
  assert.equal(trackProgressAt(track, track.endMs), 1);
});

test("trackProgressAt respects waypoint timing and cumulative length", () => {
  const timeline = compileTimeline({
    actors: [{ id: "ship", kind: "ship" }],
    historical_events: [], places: [], engagements: [],
    movements: [{
      id: "move", actor_id: "ship",
      time: { start: "2020-01-01T00:00:00Z", end: "2020-01-01T00:00:10Z" },
      waypoint_times: [
        "2020-01-01T00:00:00Z", "2020-01-01T00:00:08Z", "2020-01-01T00:00:10Z",
      ],
      path: { type: "LineString", coordinates: [[0, 0], [1, 0], [3, 0]] },
    }],
  });
  const track = timeline.tracks[0];
  assert.equal(Number(trackProgressAt(track, track.startMs + 4_000).toFixed(3)), 0.167);
  assert.equal(Number(trackProgressAt(track, track.startMs + 9_000).toFixed(3)), 0.667);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="trackProgressAt" tests/test_timeline.mjs
```

Expected: FAIL because `trackProgressAt` is not exported.

- [ ] **Step 3: Implement the normalized progress helper**

Add beside `sampleTrack()` in `app/timeline.js`:

```javascript
export function trackProgressAt(track, historicalMs) {
  if (!track || !Number.isFinite(historicalMs)) return 0;
  if (historicalMs <= track.startMs) return 0;
  if (historicalMs >= track.endMs) return 1;
  const lengths = array(track.cumulativeLengths);
  const totalLength = lengths.at(-1) ?? 0;
  if (totalLength <= 0) {
    return Math.min(1, Math.max(0,
      (historicalMs - track.startMs) / (track.endMs - track.startMs || 1)));
  }
  if (track.waypointTimes) {
    let index = 0;
    while (index < track.waypointTimes.length - 2
      && historicalMs >= track.waypointTimes[index + 1]) index += 1;
    const start = track.waypointTimes[index];
    const end = track.waypointTimes[index + 1];
    const local = Math.min(1, Math.max(0, (historicalMs - start) / (end - start)));
    const segmentLength = lengths[index + 1] - lengths[index];
    return (lengths[index] + segmentLength * local) / totalLength;
  }
  return Math.min(1, Math.max(0,
    (historicalMs - track.startMs) / (track.endMs - track.startMs)));
}
```

- [ ] **Step 4: Run timeline tests**

Run: `node --test tests/test_timeline.mjs`

Expected: all timeline tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/timeline.js tests/test_timeline.mjs
git commit -m "feat: expose movement trail progress"
```

## Task 2: Add Pure Event-Beacon Clustering

**Files:**
- Create: `app/overlay-effects.js`
- Create: `tests/test_overlay_effects.mjs`

- [ ] **Step 1: Write failing clustering tests**

Create `tests/test_overlay_effects.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  BEACON_CLUSTER_PX,
  BEACON_EXIT_MS,
  TRAIL_FADE_MS,
  clusterProjectedEvents,
} from "../app/overlay-effects.js";

test("exports the approved effect constants", () => {
  assert.equal(BEACON_CLUSTER_PX, 28);
  assert.equal(BEACON_EXIT_MS, 400);
  assert.equal(TRAIL_FADE_MS, 2500);
});

test("clusters transitively and returns a deterministic centroid and key", () => {
  const clusters = clusterProjectedEvents([
    { id: "c", x: 50, y: 10, type: "attack" },
    { id: "a", x: 0, y: 10, type: "attack" },
    { id: "b", x: 25, y: 10, type: "retreat" },
  ]);
  assert.deepEqual(clusters, [{
    key: "a|b|c", ids: ["a", "b", "c"], x: 25, y: 10,
    type: "cluster", count: 3,
  }]);
});

test("keeps points at or beyond the threshold separate", () => {
  assert.equal(clusterProjectedEvents([
    { id: "a", x: 0, y: 0, type: "attack" },
    { id: "b", x: BEACON_CLUSTER_PX, y: 0, type: "retreat" },
  ]).length, 2);
});
```

- [ ] **Step 2: Run the test and verify module RED**

Run: `node --test tests/test_overlay_effects.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement union-based clustering**

Create `app/overlay-effects.js`:

```javascript
export const TRAIL_FADE_MS = 2500;
export const BEACON_EXIT_MS = 400;
export const BEACON_CLUSTER_PX = 28;

export function clusterProjectedEvents(points, threshold = BEACON_CLUSTER_PX) {
  const items = [...points].sort((a, b) => a.id.localeCompare(b.id));
  const parent = items.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (Math.hypot(items[left].x - items[right].x, items[left].y - items[right].y) < threshold) {
        union(left, right);
      }
    }
  }
  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()].map((group) => ({
    key: group.map(({ id }) => id).join("|"),
    ids: group.map(({ id }) => id),
    x: group.reduce((sum, item) => sum + item.x, 0) / group.length,
    y: group.reduce((sum, item) => sum + item.y, 0) / group.length,
    type: group.length > 1 ? "cluster" : group[0].type,
    count: group.length,
  }));
}
```

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/test_overlay_effects.mjs`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/overlay-effects.js tests/test_overlay_effects.mjs
git commit -m "feat: cluster active event beacons"
```

## Task 3: Add Default-Off Progressive Trails

**Files:**
- Modify: `app/index.html`
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add failing UI/control contract tests**

In `tests/test_mvp_contract.py`, assert that `app/index.html` contains:

```python
self.assertIn('id="trails-button"', html)
self.assertIn('aria-pressed="false"', html)
self.assertIn('Trails: off', html)
```

In `tests/test_renderer.mjs`, extend `FakeDocument` setup with `trails-button`, then add:

```javascript
test("trails default off and control toggling preserves playback position", () => {
  const { controller, document, byClass } = setup();
  wirePlaybackControls(controller, document);
  const before = controller.currentPresentationMs;
  assert.equal(controller.trailsEnabled, false);
  assert.ok(byClass("movement-path").every((path) => !path.classList.contains("is-trail-active")));
  document.getElementById("trails-button").dispatch("click");
  assert.equal(controller.trailsEnabled, true);
  assert.equal(controller.currentPresentationMs, before);
  assert.equal(document.getElementById("trails-button").getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("trails-button").textContent, "Trails: on");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern="trails default" tests/test_renderer.mjs
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_static_app_exposes_continuous_playback_controls -v
```

Expected: FAIL because the button/controller API does not exist.

- [ ] **Step 3: Add the control and controller API**

Add beside Follow in `app/index.html`:

```html
<button id="trails-button" type="button" class="ghost" aria-pressed="false">Trails: off</button>
```

In `wirePlaybackControls()` bind:

```javascript
const trails = $("trails-button");
own(trails, "onclick", () => controller.setTrailsEnabled(!controller.trailsEnabled));
```

Initialize the controller and implement:

```javascript
trailsEnabled: false,
_trailFadeTimers: new Map(),
_lastTrailHistoricalMs: null,

setTrailsEnabled(enabled) {
  if (this._destroyed) return this.trailsEnabled;
  this.trailsEnabled = Boolean(enabled);
  if (!this.trailsEnabled) clearTrailEffects();
  const button = $("trails-button");
  if (button) {
    button.setAttribute("aria-pressed", String(this.trailsEnabled));
    button.textContent = `Trails: ${this.trailsEnabled ? "on" : "off"}`;
  }
  this.renderAt(this.currentPresentationMs, { mode: "seek" });
  return this.trailsEnabled;
},
```

Add `trails-button` to `resetBattleUI()` transport reset/disable lists and reset its text and `aria-pressed` to off.

- [ ] **Step 4: Write failing progressive reveal and fade tests**

Add renderer tests using the fake clock:

```javascript
test("enabled trails reveal active progress and completed playback trails fade once", () => {
  const { controller, clock, byClass } = setup();
  controller.setTrailsEnabled(true);
  controller.seek(500);
  const first = byClass("movement-path")[0];
  const reveal = byClass("movement-reveal-mask")[0];
  assert.equal(reveal.style.strokeDashoffset, "0.5");
  assert.equal(first.classList.contains("is-trail-active"), true);
  controller.play();
  clock.frame(0);
  clock.frame(600);
  assert.equal(first.classList.contains("is-trail-fading"), true);
  clock.flushTimeouts();
  assert.equal(first.classList.contains("is-trail-fading"), false);
  assert.equal(first.classList.contains("is-trail-hidden"), true);
});

test("seeking and disabling trails clear every transient trail", () => {
  const { controller, byClass } = setup();
  controller.setTrailsEnabled(true);
  controller.seek(500);
  controller.seek(1500);
  assert.ok(byClass("movement-path").every((path) => !path.classList.contains("is-trail-fading")));
  controller.setTrailsEnabled(false);
  assert.ok(byClass("movement-path").every((path) => path.classList.contains("is-trail-hidden")));
});
```

- [ ] **Step 5: Run tests and verify trail behavior RED**

Run: `node --test --test-name-pattern="trail" tests/test_renderer.mjs`

Expected: FAIL because progressive/fading classes and timer lifecycle are absent.

- [ ] **Step 6: Add a separate SVG reveal mask for every movement**

Do not use the visible path's `strokeDashoffset` for progress: inferred paths need that property for their repeating dash pattern. Create one mask per source index so solid and inferred paths share the same progressive reveal mechanism:

```javascript
const defs = svgEl(documentRef, "defs");
svg.append(defs);

// Inside the movement loop:
const maskId = `movement-reveal-${sourceIndex}`;
const mask = svgEl(documentRef, "mask", { id: maskId });
const reveal = svgEl(documentRef, "path", {
  class: "movement-reveal-mask",
  pathLength: "1",
  fill: "none",
  stroke: "white",
  "stroke-width": (style.movement_line_width || 4) + 2,
  "stroke-dasharray": "1",
  "stroke-dashoffset": "1",
});
mask.append(reveal);
defs.append(mask);
path.setAttribute("mask", `url(#${maskId})`);
movementEls.set(movement.id, { coords: movement.path.coordinates, path, reveal, track });
```

`redrawStaticGeometry()` must assign the same projected `d` to both `path` and `reveal`. Tests must assert every movement has one unique mask and that an inferred visible path retains `stroke-dasharray: 0.04 0.025` while its mask offset changes.

- [ ] **Step 7: Implement playback-only fade and update reveal progress**

Import `trackProgressAt` plus `TRAIL_FADE_MS`. Replace `is-visible/is-completed` path logic with a `renderTrails(sampled, mode)` helper that:

```javascript
const active = track && sampled.historicalMs >= track.startMs && sampled.historicalMs <= track.endMs;
const crossedEnd = mode === "playback"
  && controller._lastTrailHistoricalMs < track.endMs
  && sampled.historicalMs >= track.endMs;
reveal.style.strokeDashoffset = String(1 - trackProgressAt(track, sampled.historicalMs));
path.classList.toggle("is-trail-active", controller.trailsEnabled && active);
path.classList.toggle("is-trail-hidden", !controller.trailsEnabled || !active);
if (controller.trailsEnabled && crossedEnd) beginTrailFade(movementId, path);
```

`beginTrailFade()` must clear any prior timer for the same movement, set the reveal mask's `strokeDashoffset` to `0`, add `is-trail-fading`, remove `is-trail-hidden`, then schedule one owned `windowRef.setTimeout()` for 2500 ms. `seek()`, Reset/Prev/Next, disabling trails, document replacement and `destroy()` call `clearTrailEffects()` to cancel all timers and hide all paths.

Change `renderAt` to accept `{ mode = "seek" }`; the RAF playback loop passes `{ mode: "playback" }`. Update `_lastTrailHistoricalMs` after trail evaluation.

- [ ] **Step 8: Replace movement-path CSS states**

Use:

```css
.movement-path {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
}
.movement-path.is-trail-active { opacity: 0.9; }
.movement-path.is-trail-fading {
  opacity: 0;
  transition: opacity 2500ms linear;
}
.movement-path.is-trail-hidden { opacity: 0; transition: none; }
.movement-path.is-inferred { stroke-dasharray: 0.04 0.025 !important; }
.movement-reveal-mask {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
}
```

Do not add CSS that overwrites the reveal mask's inline `strokeDashoffset` progress value. The visible inferred path's dash pattern remains independent from reveal progress.

- [ ] **Step 9: Run renderer and contract tests**

Run:

```bash
node --test tests/test_renderer.mjs tests/test_timeline.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add app/index.html app/animate.js app/styles.css tests/test_renderer.mjs tests/test_mvp_contract.py
git commit -m "feat: add opt-in fading movement trails"
```

## Task 4: Replace Circular Markers with Clustered Pulse Beacons

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`

- [ ] **Step 1: Write failing beacon structure and lifecycle tests**

Add tests that assert:

```javascript
test("only active events render diamond beacons and playback exits fade", () => {
  const { controller, clock, byClass } = setup();
  controller.seek(500);
  assert.equal(byClass("event-beacon").length, 1);
  assert.equal(byClass("event-beacon-diamond").length, 1);
  assert.equal(byClass("event-disc").length, 0);
  controller.play();
  clock.frame(0);
  clock.frame(600);
  assert.equal(byClass("event-beacon").some((node) => node.classList.contains("is-exiting")), true);
  clock.flushTimeouts();
  assert.equal(byClass("event-beacon").some((node) => node.classList.contains("is-exiting")), false);
});

test("nearby active events share one beacon with a count", () => {
  const battle = battleFixture();
  battle.historical_events[1].time = battle.historical_events[0].time;
  battle.historical_events[1].place_ids = battle.historical_events[0].place_ids;
  const { controller, byClass } = setup(battle);
  controller.seek(500);
  assert.equal(byClass("event-beacon").length, 1);
  assert.equal(byClass("event-beacon-count")[0].textContent, "2");
});
```

Add a seek test proving an inactive beacon disappears immediately without `is-exiting`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern="beacon" tests/test_renderer.mjs`

Expected: FAIL because the renderer still creates `.event-marker` circles.

- [ ] **Step 3: Build a keyed beacon layer**

In `app/animate.js`:

1. Replace per-event circle construction with one SVG `g.event-beacon-layer`.
2. Project only `sampled.activeEventIds` with valid `eventCoord()` values.
3. Pass `{ id, x, y, type }` records to `clusterProjectedEvents()`.
4. Key live beacon nodes by the cluster `key` (`event IDs` sorted and joined).
5. Reuse a node when its key remains active; update only `transform`.
6. Create a new node with:

```javascript
const beacon = svgEl(documentRef, "g", {
  class: "event-beacon is-entering", "data-event-ids": cluster.ids.join(" "),
});
const pulse = svgEl(documentRef, "circle", { class: "event-beacon-pulse", r: 10 });
const diamond = svgEl(documentRef, "path", {
  class: "event-beacon-diamond", d: "M 0 -8 L 8 0 L 0 8 L -8 0 Z",
});
const label = svgEl(documentRef, "text", {
  class: cluster.count > 1 ? "event-beacon-count" : "event-beacon-icon",
  y: 4, "text-anchor": "middle",
}, cluster.count > 1 ? String(cluster.count) : iconOf(cluster.type));
beacon.append(pulse, diamond, label);
```

7. During normal playback, stale nodes receive `is-exiting` and an owned 400 ms removal timeout. During seek/reset/document replacement, remove stale nodes immediately.
8. On `move zoom zoomend`, recompute projection/clusters but reuse unchanged keys so panning does not restart pulse animation.

- [ ] **Step 4: Add beacon CSS and remove circular marker rules**

Replace `.event-disc`, `.event-marker`, and `.event-marker-inner` rules with:

```css
.event-beacon { opacity: 1; transition: opacity 400ms ease; }
.event-beacon.is-exiting { opacity: 0; }
.event-beacon-diamond {
  fill: var(--accent);
  stroke: var(--paper);
  stroke-width: 2;
}
.event-beacon-icon,
.event-beacon-count {
  fill: var(--paper);
  font-size: 9px;
  font-weight: 800;
  pointer-events: none;
}
.event-beacon-pulse {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  transform-box: fill-box;
  transform-origin: center;
  animation: event-beacon-pulse 600ms ease-out 2;
}
@keyframes event-beacon-pulse {
  from { opacity: 0.75; transform: scale(0.7); }
  to { opacity: 0; transform: scale(2.2); }
}
```

- [ ] **Step 5: Run renderer tests**

Run: `node --test tests/test_renderer.mjs tests/test_overlay_effects.mjs`

Expected: all tests PASS and no `.event-disc` source/test contract remains.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js app/styles.css tests/test_renderer.mjs
git commit -m "feat: replace event circles with pulse beacons"
```

## Task 5: Reduced Motion, Teardown, Documentation, and End-to-End Verification

**Files:**
- Modify: `app/animate.js`
- Modify: `app/styles.css`
- Modify: `tests/test_renderer.mjs`
- Modify: `README.md`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Write failing reduced-motion and teardown tests**

Add tests proving:

```javascript
test("reduced motion hides completed trails and ended beacons immediately", () => {
  const { controller, clock, byClass } = setup(battleFixture(), { reducedMotion: true });
  controller.setTrailsEnabled(true);
  controller.play();
  clock.frame(0);
  clock.frame(1200);
  assert.equal(controller._trailFadeTimers.size, 0);
  assert.equal(controller._beaconExitTimers.size, 0);
  assert.ok(byClass("movement-path").every((path) => !path.classList.contains("is-trail-fading")));
});

test("destroy cancels owned trail and beacon timers", () => {
  const { controller, clock } = setup();
  controller.setTrailsEnabled(true);
  controller.play();
  clock.frame(0);
  clock.frame(1200);
  controller.destroy();
  assert.equal(controller._trailFadeTimers.size, 0);
  assert.equal(controller._beaconExitTimers.size, 0);
  assert.ok(clock.clearedTimeouts.length >= 1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern="reduced motion|owned trail" tests/test_renderer.mjs`

Expected: FAIL until timer bypass/cleanup is complete.

- [ ] **Step 3: Complete reduced-motion and teardown behavior**

- When `reducedMotion` is true, never create trail/beacon exit timers; remove/hide immediately.
- Add every trail and beacon timeout ID to controller-owned maps.
- `destroy()` and document replacement clear all timeout IDs, maps, beacon nodes, fading classes, and the active-set snapshot.
- Add CSS under existing `@media (prefers-reduced-motion: reduce)`:

```css
.event-beacon-pulse { animation: none !important; }
.event-beacon,
.movement-path { transition: none !important; }
```

- [ ] **Step 4: Document the new controls and visual semantics**

Update `README.md` app usage to state:

```text
- 航跡預設關閉；開啟後只顯示當前 movement，完成路徑會短暫淡出。
- 地圖事件使用 active-only 脈衝信標；相近事件會合併顯示數量。
```

Add this focused test to `tests/test_mvp_contract.py`:

```python
def test_readme_documents_transient_map_overlays(self):
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    self.assertIn("航跡預設關閉", readme)
    self.assertIn("只顯示當前 movement", readme)
    self.assertIn("active-only 脈衝信標", readme)
    self.assertIn("相近事件會合併顯示數量", readme)
```

- [ ] **Step 5: Run all automated verification**

Run:

```bash
node --test tests/*.mjs
python3 -m unittest discover -s tests -v
python3 -m battle_animation.validator examples/battle-of-waterloo.json
python3 -m battle_animation.validator examples/battle-of-甲午.json
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
node --check app/animate.js
node --check app/timeline.js
node --check app/overlay-effects.js
git diff --check
```

Expected: all Node/Python tests PASS; all examples print `valid:`; syntax and diff checks are clean.

- [ ] **Step 6: Run browser verification**

Serve the repository and load `examples/battle-of-甲午海戰.json`. Verify:

1. Trails are absent on initial load and after loading a replacement document.
2. `Trails: off` toggles to `Trails: on` without changing time or unit positions.
3. Active paths reveal progressively; inferred paths remain dashed.
4. A completed path fades in about 2.5 seconds and does not remain on the sea.
5. Scrubbing backward/forward shows only paths active at the selected instant.
6. Events show small diamond pulse beacons, never the former white circles.
7. Beacons disappear after events; nearby simultaneous events show one count badge.
8. Pan/zoom updates positions without replaying pulse animation.
9. Mobile controls wrap cleanly and the trail button remains operable.
10. Browser console has no errors.

- [ ] **Step 7: Commit final integration**

```bash
git add app/animate.js app/styles.css README.md tests/test_renderer.mjs tests/test_mvp_contract.py
git commit -m "docs: explain transient map overlays"
```

- [ ] **Step 8: Record branch status**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: no tracked modifications; commits for progress sampling, clustering, trails, beacons, and final integration are present.

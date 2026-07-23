# Event Focus and Modern Borders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click view of every currently active event, replace the road-heavy basemap, and provide a default-off modern-country-border overlay.

**Architecture:** Keep Leaflet and the existing SVG renderer. Put coordinate collection and camera selection in a small pure module, use one road-free raster tile layer as the base, and load a stripped Natural Earth GeoJSON asset lazily into a non-interactive Leaflet layer. Expose focus and border operations through the existing renderer controller and wire them like Follow and Trails.

**Tech Stack:** Vanilla ES modules, Leaflet 1.9, SVG/CSS, Node built-in test runner, Python `unittest`.

---

## File map

- Create `app/map-view.js`: pure active-coordinate collection and focus-plan selection.
- Create `app/data/modern-borders-50m.geojson`: geometry-only Natural Earth Admin 0 data.
- Create `tests/test_map_view.mjs`: unit tests for focus planning.
- Modify `app/animate.js`: road-free tiles, border layer lifecycle, focus controller methods, control wiring.
- Modify `app/index.html`: Focus and Modern borders buttons.
- Modify `app/styles.css`: control and subtle border presentation.
- Modify `tests/test_renderer.mjs`: renderer/controller integration.
- Modify `tests/test_mvp_contract.py`: static HTML, asset, attribution, and no-OSM-road contract.
- Modify `README.md`: document the two map controls and data attribution.

### Task 1: Pure focus planning

**Files:**
- Create: `app/map-view.js`
- Create: `tests/test_map_view.mjs`

- [ ] **Step 1: Write failing focus-plan tests**

Create `tests/test_map_view.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { buildFocusPlan } from "../app/map-view.js";

const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });

test("uses a matching camera hint for one active event", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a"]),
    eventWindows: [{
      id: "event-a",
      event: { id: "event-a", actor_ids: ["unit-a"], place_ids: ["place-a"] },
    }],
    places: new Map([["place-a", { geometry: point(120, 24) }]]),
    actorPositions: new Map([["unit-a", [120.1, 24.1]]]),
    cameras: [{ event_id: "event-a", center: [121, 25], zoom: 9 }],
  });
  assert.deepEqual(plan, { kind: "view", center: [121, 25], zoom: 9 });
});

test("fits all simultaneous active event points instead of choosing one", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a", "event-b"]),
    eventWindows: [
      { id: "event-a", event: { id: "event-a", actor_ids: ["a"], place_ids: ["pa"] } },
      { id: "event-b", event: { id: "event-b", actor_ids: ["b"], place_ids: ["pb"] } },
    ],
    places: new Map([
      ["pa", { geometry: point(120, 24) }],
      ["pb", { geometry: point(123, 26) }],
    ]),
    actorPositions: new Map([["a", [120.2, 24.2]], ["b", [122.8, 25.8]]]),
    cameras: [],
  });
  assert.equal(plan.kind, "bounds");
  assert.deepEqual(plan.points, [[120, 24], [120.2, 24.2], [123, 26], [122.8, 25.8]]);
  assert.equal(plan.maxZoom, 10);
});

test("falls back to the selected event and returns none without coordinates", () => {
  const eventWindows = [{
    id: "selected",
    event: { id: "selected", actor_ids: [], place_ids: ["place"] },
  }];
  assert.deepEqual(buildFocusPlan({
    activeEventIds: new Set(),
    selectedEventId: "selected",
    eventWindows,
    places: new Map([["place", { geometry: point(10, 20) }]]),
    actorPositions: new Map(),
    cameras: [],
  }), { kind: "view", center: [10, 20], zoom: 8 });
  assert.deepEqual(buildFocusPlan({
    activeEventIds: new Set(),
    eventWindows: [],
    places: new Map(),
    actorPositions: new Map(),
    cameras: [],
  }), { kind: "none" });
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
node --test tests/test_map_view.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `app/map-view.js`.

- [ ] **Step 3: Implement the minimal pure planner**

Create `app/map-view.js`:

```js
const validPoint = (value) =>
  Array.isArray(value) && value.length >= 2
  && Number.isFinite(value[0]) && Number.isFinite(value[1]);

function geometryPoints(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "Point") return validPoint(geometry.coordinates) ? [geometry.coordinates] : [];
  if (geometry.type === "LineString") return geometry.coordinates?.filter(validPoint) || [];
  if (geometry.type === "Polygon") return geometry.coordinates?.flat().filter(validPoint) || [];
  return [];
}

export function buildFocusPlan({
  activeEventIds,
  selectedEventId,
  eventWindows,
  places,
  actorPositions,
  cameras = [],
  extraActorIds = [],
}) {
  let windows = eventWindows.filter(({ id }) => activeEventIds.has(id));
  if (!windows.length && selectedEventId) {
    windows = eventWindows.filter(({ id }) => id === selectedEventId);
  }
  const actorIds = new Set(extraActorIds);
  const points = [];
  for (const { event } of windows) {
    for (const id of [...(event.actor_ids || []), ...(event.target_actor_ids || [])]) actorIds.add(id);
    for (const id of event.place_ids || []) points.push(...geometryPoints(places.get(id)?.geometry));
  }
  for (const id of actorIds) {
    const position = actorPositions.get(id);
    if (validPoint(position)) points.push(position);
  }
  const unique = [...new Map(points.map((value) => [value.join("\u0000"), value])).values()];
  if (!unique.length) return { kind: "none" };
  if (windows.length === 1) {
    const camera = cameras.find(({ event_id: id }) => id === windows[0].id);
    if (camera && validPoint(camera.center) && Number.isFinite(camera.zoom)) {
      return { kind: "view", center: camera.center, zoom: camera.zoom };
    }
  }
  if (unique.length === 1) return { kind: "view", center: unique[0], zoom: 8 };
  return { kind: "bounds", points: unique, maxZoom: 10 };
}
```

- [ ] **Step 4: Run pure planner tests**

Run:

```bash
node --test tests/test_map_view.mjs
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/map-view.js tests/test_map_view.mjs
git commit -m "feat: plan active event map views"
```

### Task 2: Add accessible map controls

**Files:**
- Modify: `app/index.html:56-68`
- Modify: `app/styles.css:329-340,680-700`
- Modify: `tests/test_mvp_contract.py:886-905`

- [ ] **Step 1: Add failing static contract assertions**

Extend the existing app markup contract test in `tests/test_mvp_contract.py`:

```python
self.assertIn(
    'id="focus-event-button" type="button" class="ghost" disabled>Focus event</button>',
    index,
)
self.assertIn(
    'id="modern-borders-button" type="button" class="ghost" aria-pressed="false">'
    'Modern borders: off</button>',
    index,
)
```

- [ ] **Step 2: Verify the contract fails**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest -v
```

Expected: FAIL because both button strings are absent.

- [ ] **Step 3: Add the controls**

Add after the Trails button in `app/index.html`:

```html
<button id="focus-event-button" type="button" class="ghost" disabled>Focus event</button>
<button id="modern-borders-button" type="button" class="ghost" aria-pressed="false">Modern borders: off</button>
```

Extend the shared active-toggle selector in `app/styles.css` so Follow, Trails, and Modern borders use the same pressed treatment:

```css
#follow-button[aria-pressed="true"],
#trails-button[aria-pressed="true"],
#modern-borders-button[aria-pressed="true"] {
  border-color: var(--ink);
  color: var(--ink);
}

#focus-event-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
```

Do not add a separate wrapper or component; `.playback-options` already wraps controls on narrow screens.

- [ ] **Step 4: Run the static contract**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/index.html app/styles.css tests/test_mvp_contract.py
git commit -m "feat: add focus and border controls"
```

### Task 3: Bundle geometry-only modern borders

**Files:**
- Create: `app/data/modern-borders-50m.geojson`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Add a failing asset contract**

Add to `tests/test_mvp_contract.py`:

```python
def test_modern_border_asset_is_geometry_only_natural_earth(self):
    path = ROOT / "app" / "data" / "modern-borders-50m.geojson"
    data = json.loads(path.read_text())
    self.assertEqual(data["type"], "FeatureCollection")
    self.assertGreater(len(data["features"]), 200)
    self.assertTrue(all(feature.get("properties") == {} for feature in data["features"]))
    self.assertTrue(all(feature.get("geometry") for feature in data["features"]))
```

- [ ] **Step 2: Verify the missing asset fails**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_modern_border_asset_is_geometry_only_natural_earth -v
```

Expected: ERROR with `FileNotFoundError`.

- [ ] **Step 3: Download and strip the Natural Earth asset**

Run:

```bash
mkdir -p app/data
curl -L https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson -o /tmp/ne_50m_admin_0_countries.geojson
node -e 'const fs=require("node:fs");const source=JSON.parse(fs.readFileSync("/tmp/ne_50m_admin_0_countries.geojson"));const output={type:"FeatureCollection",features:source.features.map(({type,geometry})=>({type,properties:{},geometry}))};fs.writeFileSync("app/data/modern-borders-50m.geojson",JSON.stringify(output));'
```

The committed asset must not contain `NAME`, `ADMIN`, `POP_EST`, `SOVEREIGNT`, `bbox`, or `crs`.

- [ ] **Step 4: Run the asset contract**

Run:

```bash
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_modern_border_asset_is_geometry_only_natural_earth -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/data/modern-borders-50m.geojson tests/test_mvp_contract.py
git commit -m "data: add simplified modern country borders"
```

### Task 4: Replace the basemap and implement the border lifecycle

**Files:**
- Modify: `app/animate.js:1-4,80-125,560-615,680-688,1240-1440`
- Modify: `tests/test_renderer.mjs`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Extend renderer fakes and write failing integration tests**

Add `focus-event-button` and `modern-borders-button` to `FakeDocument`'s ID list. Extend the fake Leaflet map with `addLayer`, `removeLayer`, `hasLayer`, and recordable `flyTo`, `flyToBounds`, `setView`, and `fitBounds`; add fakes for `L.geoJSON` and `L.tileLayer`.

Add:

```js
test("modern borders default off and reuse one non-interactive layer", async () => {
  const { controller, documentRef, leaflet } = renderFixture();
  assert.equal(controller.modernBordersEnabled, false);
  await controller.setModernBordersEnabled(true);
  const firstLayer = leaflet.geoJsonLayers[0];
  assert.equal(leaflet.geoJsonLayers.length, 1);
  assert.deepEqual(firstLayer.options.style, {
    color: "#59636b", weight: 1, opacity: 0.55, fill: false, interactive: false,
  });
  await controller.setModernBordersEnabled(false);
  await controller.setModernBordersEnabled(true);
  assert.equal(leaflet.geoJsonLayers.length, 1);
  assert.equal(documentRef.getElementById("modern-borders-button").getAttribute("aria-pressed"), "true");
  controller.destroy();
  assert.equal(controller.map.hasLayer(firstLayer), false);
});
```

Add a fetch stub returning a small `FeatureCollection`, then verify the border button calls the method once per click and resets to off for a new controller.

In `tests/test_mvp_contract.py`, assert that `animate.js` no longer contains `tile.openstreetmap.org` and does contain `services/Elevation/World_Hillshade/MapServer/tile` plus the Esri source attribution.

- [ ] **Step 2: Run tests and verify failures**

Run:

```bash
node --test tests/test_renderer.mjs
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest -v
```

Expected: FAIL because the new controller state and layer methods do not exist and OSM Standard is still configured.

- [ ] **Step 3: Wire buttons and reset state**

In `wirePlaybackControls`:

```js
const focusEvent = $("focus-event-button");
own(focusEvent, "onclick", () => controller.focusActiveEvents());
const modernBorders = $("modern-borders-button");
own(modernBorders, "onclick", () =>
  controller.setModernBordersEnabled(!controller.modernBordersEnabled));
```

Add both IDs to `setTransportEnabled`. In `resetBattleUI`, restore:

```js
const focus = documentRef.getElementById("focus-event-button");
if (focus) focus.disabled = true;
const borders = documentRef.getElementById("modern-borders-button");
if (borders) {
  borders.textContent = "Modern borders: off";
  borders.setAttribute("aria-pressed", "false");
}
```

- [ ] **Step 4: Replace the road basemap**

Use Esri World Hillshade, which Esri documents as an actively updated terrain backdrop without the separate road/reference layer:

```js
L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
  {
    maxNativeZoom: 16,
    maxZoom: 18,
    attribution: "Sources: Esri, USGS, NGA, NASA, CGIAR, and the GIS User Community",
  },
).addTo(map);
```

Give the map container a neutral ocean background because the hillshade is intentionally only a relief backdrop:

```css
#battle-map {
  background: #b7d4dc;
}
```

Do not add Esri's Terrain Reference layer; that separate reference layer contains roads, boundaries, places, and labels.

- [ ] **Step 5: Implement one lazy reusable border layer**

Add controller state:

```js
modernBordersEnabled: false,
_modernBordersLayer: null,
_modernBordersPromise: null,
```

Implement:

```js
async setModernBordersEnabled(enabled) {
  if (this._destroyed) return this.modernBordersEnabled;
  const next = Boolean(enabled);
  if (next && !this._modernBordersLayer) {
    this._modernBordersPromise ||= loadBattle("./data/modern-borders-50m.geojson")
      .then((geojson) => L.geoJSON(geojson, {
        pane: "modernBordersPane",
        style: {
          color: "#59636b",
          weight: 1,
          opacity: 0.55,
          fill: false,
          interactive: false,
        },
      }));
    try {
      this._modernBordersLayer = await this._modernBordersPromise;
    } catch (error) {
      this._modernBordersPromise = null;
      this.modernBordersEnabled = false;
      showDiagnosticList(documentRef, "validation-warnings", "Map layer warning", [
        `Unable to load modern borders: ${error.message}`,
      ]);
      return false;
    }
  }
  this.modernBordersEnabled = next;
  if (next) this._modernBordersLayer.addTo(map);
  else if (this._modernBordersLayer && map.hasLayer(this._modernBordersLayer)) {
    map.removeLayer(this._modernBordersLayer);
  }
  const button = $("modern-borders-button");
  if (button) {
    button.setAttribute("aria-pressed", String(next));
    button.textContent = `Modern borders: ${next ? "on" : "off"}`;
  }
  return next;
}
```

Create the pane before the SVG overlay:

```js
map.createPane("modernBordersPane");
map.getPane("modernBordersPane").style.zIndex = "350";
map.getPane("modernBordersPane").style.pointerEvents = "none";
```

In `destroy()`, remove `_modernBordersLayer` if present. Do not re-fetch on off/on toggles.

- [ ] **Step 6: Run renderer and contract tests**

Run:

```bash
node --test tests/test_renderer.mjs
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest -v
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/animate.js tests/test_renderer.mjs tests/test_mvp_contract.py
git commit -m "feat: add road-free map and modern borders"
```

### Task 5: Integrate Focus event with the renderer

**Files:**
- Modify: `app/animate.js:1-4,1000-1095,1240-1380`
- Modify: `tests/test_renderer.mjs`

- [ ] **Step 1: Write failing camera integration tests**

Add tests covering:

```js
test("focus uses camera hint without changing playback or follow", () => {
  const { controller, map } = renderFixture({ cameraHint: true });
  const playing = controller.isPlaying;
  const follow = controller.followEnabled;
  controller.focusActiveEvents();
  assert.deepEqual(map.flyToCalls.at(-1).slice(0, 2), [[25, 121], 9]);
  assert.equal(controller.isPlaying, playing);
  assert.equal(controller.followEnabled, follow);
});

test("focus fits simultaneous active events with padding and max zoom", () => {
  const { controller, map } = renderFixture({ overlappingEvents: true });
  controller.focusActiveEvents();
  assert.equal(map.flyToBoundsCalls.at(-1).options.maxZoom, 10);
  assert.equal(map.flyToBoundsCalls.at(-1).bounds.padValue, 0.3);
});

test("reduced motion focuses without fly animation", () => {
  const { controller, map } = renderFixture({ reducedMotion: true });
  controller.focusActiveEvents();
  assert.equal(map.setViewCalls.length + map.fitBoundsCalls.length, 1);
  assert.equal(map.flyToCalls.length + map.flyToBoundsCalls.length, 0);
});
```

Also assert the Focus button is disabled when `buildFocusPlan` returns `none` and enabled after rendering a sample with geographic data.

- [ ] **Step 2: Verify focus tests fail**

Run:

```bash
node --test tests/test_renderer.mjs
```

Expected: FAIL because `focusActiveEvents` and Focus button state are absent.

- [ ] **Step 3: Feed engagement/movement participants into the planner**

Import:

```js
import { buildFocusPlan } from "./map-view.js";
```

Add a helper that gathers active movement actors and active engagement endpoints:

```js
function focusExtraActorIds(sampled) {
  const ids = new Set();
  for (const track of compiled.tracks) {
    if (sampled.historicalMs >= track.startMs && sampled.historicalMs <= track.endMs) ids.add(track.actorId);
  }
  for (const engagement of engagements) {
    if (!sampled.activeEngagementIds.has(engagement.id)) continue;
    ids.add(engagement.attacker_actor_id);
    ids.add(engagement.target_actor_id);
  }
  return [...ids];
}
```

Build the plan from `sampledState`, `compiled.eventWindows`, `places`, current actor positions, `animation_hints.camera`, and the current selected event ID.

- [ ] **Step 4: Implement camera execution and button state**

Add:

```js
focusActiveEvents() {
  if (this._destroyed || !this.sampledState) return false;
  const plan = currentFocusPlan(this);
  if (plan.kind === "none") return false;
  this._programmaticMove = true;
  try {
    if (plan.kind === "view") {
      const [lon, lat] = plan.center;
      if (reducedMotion) map.setView([lat, lon], plan.zoom, { animate: false });
      else map.flyTo([lat, lon], plan.zoom, { duration: 0.9, animate: true });
    } else {
      const bounds = L.latLngBounds(plan.points.map(([lon, lat]) => [lat, lon])).pad(0.3);
      if (reducedMotion) map.fitBounds(bounds, { maxZoom: plan.maxZoom, animate: false });
      else map.flyToBounds(bounds, { maxZoom: plan.maxZoom, duration: 0.9, animate: true });
    }
  } finally {
    this._programmaticMove = false;
  }
  return true;
}
```

After every `renderAt`, set:

```js
const focusButton = $("focus-event-button");
if (focusButton) focusButton.disabled = currentFocusPlan(this).kind === "none";
```

- [ ] **Step 5: Run map and renderer tests**

Run:

```bash
node --test tests/test_map_view.mjs tests/test_renderer.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/animate.js tests/test_renderer.mjs
git commit -m "feat: focus the map on active events"
```

### Task 6: Documentation and complete verification

**Files:**
- Modify: `README.md:12-20`
- Modify: `tests/test_mvp_contract.py`

- [ ] **Step 1: Update README**

Update the animation app file description:

```markdown
- `app/index.html` and `app/animate.js` provide continuous playback, scrubbing,
  speed controls, camera follow, one-click active-event focus, optional modern
  borders, and inline validation diagnostics. The road-free terrain basemap is
  intentionally free of modern transport detail. Modern borders use geometry-only
  Natural Earth 1:50m Admin 0 data and are off by default because they do not
  represent historical borders.
```

Credit the basemap sources using the same Esri attribution shown in the Leaflet control. Credit the border asset as “Made with Natural Earth.”

- [ ] **Step 2: Run every automated test**

Run:

```bash
node --test tests/*.mjs
python3 -m unittest tests/test_mvp_contract.py -v
```

Expected: all Node and Python tests pass with zero failures.

- [ ] **Step 3: Run schema validation on all examples**

Run:

```bash
for file in examples/*.json; do python3 -m battle_animation.validator "$file"; done
```

Expected: every example prints `OK`.

- [ ] **Step 4: Perform browser acceptance checks**

Run:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/app/` and verify:

1. No roads, railway lines, buildings, shops, or modern place labels appear.
2. Modern borders begin off; toggling on draws subtle lines below battle units.
3. Repeated off/on toggles do not flicker, duplicate borders, or reset playback.
4. Focus includes all simultaneous active events and units with comfortable padding.
5. Focus does not alter Follow, Trails, playback state, or historical time.
6. A JSON with no geographic coordinates leaves Focus disabled.
7. With operating-system reduced motion enabled, Focus changes view without a flight animation.
8. Narrow/mobile layout keeps both controls reachable without covering the scrubber.

- [ ] **Step 5: Review the diff and commit documentation**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files are modified. Then:

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: explain focus and modern border controls"
```

## Final review checklist

- Every design requirement is covered by Tasks 1–6.
- No schema or prompt version changes are included.
- The border toggle is explicitly modern and default-off.
- The implementation does not use the mature-support World Shaded Relief service.
- The implementation adds no npm or Python dependency.
- Focus is manual and does not duplicate Follow semantics.
- The existing untracked `.codex/`, `AGENTS.md`, and example JSON are not added or modified.

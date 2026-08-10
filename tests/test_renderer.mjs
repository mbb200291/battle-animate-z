import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FRONTLINE_MODES,
  renderBattle,
  resetBattleUI,
  setBattleDocument,
  wirePlaybackControls,
} from "../app/animate.js";

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.tokens = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.tokens.add(token));
    this.owner.attributes.set("class", [...this.tokens].join(" "));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.tokens.delete(token));
    this.owner.attributes.set("class", [...this.tokens].join(" "));
  }

  toggle(token, force) {
    const enabled = force === undefined ? !this.tokens.has(token) : Boolean(force);
    if (enabled) this.add(token);
    else this.remove(token);
    return enabled;
  }

  contains(token) {
    return this.tokens.has(token);
  }

  replaceFrom(value) {
    this.tokens = new Set(String(value).split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  constructor(tagName, id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.value = "";
    this.max = "";
    this.disabled = false;
    this.clientWidth = id === "battle-map" ? 800 : 0;
    this.clientHeight = id === "battle-map" ? 600 : 0;
    this.removed = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
    this.removed = true;
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    clone.textContent = this.textContent;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === "class") this.classList.replaceFrom(stringValue);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    this.listeners ??= new Map();
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners?.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners?.get(type) || []) listener({ target: this, ...event });
    this[`on${type}`]?.({ target: this, ...event });
  }

  scrollIntoView(options) { this.scrollOptions = options; }
}

function descendants(root) {
  return [root, ...root.children.flatMap(descendants)];
}

class FakeDocument {
  constructor(windowRef) {
    this.defaultView = windowRef;
    this.listeners = new Map();
    this.elements = new Map();
    for (const id of [
      "battle-map", "legend", "battle-name", "battle-date", "battle-summary",
      "timeline", "event-type", "event-title", "event-description", "event-precision",
      "event-confidence", "confidence-bar", "engagements", "event-scrubber",
      "event-progress", "historical-time", "compression-notice", "play-button",
      "follow-button", "trails-button", "event-card-stack", "speed-controls",
      "reset-button", "prev-button", "next-button", "focus-event-button",
      "modern-borders-button", "fronts-button", "validation-warnings", "error-banner",
      "frontline-status", "frontline-summary", "frontline-details", "frontline-sources",
    ]) {
      this.elements.set(id, new FakeElement(id === "battle-map" ? "div" : "span", id));
    }
    this.elements.get("focus-event-button").disabled = true;
    this.elements.get("modern-borders-button").textContent = "Modern borders: off";
    this.elements.get("modern-borders-button").setAttribute("aria-pressed", "false");
    this.elements.get("fronts-button").textContent = "Fronts: hybrid";
    this.elements.get("fronts-button").setAttribute("aria-pressed", "false");
    this.elements.get("fronts-button").disabled = true;
    this.elements.get("frontline-status").hidden = true;
    const speeds = this.elements.get("speed-controls");
    for (const rate of [0.5, 1, 2, 4]) {
      const button = new FakeElement("button");
      button.dataset.speed = String(rate);
      button.setAttribute("aria-pressed", String(rate === 1));
      speeds.append(button);
    }
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector) {
    if (selector === "#timeline button") {
      return descendants(this.getElementById("timeline")).filter((element) => element.tagName === "BUTTON");
    }
    if (selector === "#speed-controls [data-speed]") {
      return descendants(this.getElementById("speed-controls")).filter((element) => element.dataset.speed);
    }
    return [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class FrameClock {
  constructor(reducedMotion = false) {
    this.nextId = 0;
    this.callbacks = new Map();
    this.cancelled = [];
    this.now = 0;
    this.nextTimeoutId = 0;
    this.timeouts = new Map();
    this.timeoutDelays = new Map();
    this.clearedTimeouts = [];
    this.window = {
      performance: { now: () => this.now },
      matchMedia: () => ({ matches: reducedMotion }),
      requestAnimationFrame: (callback) => {
        const id = this.nextId;
        this.nextId += 1;
        this.callbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id) => {
        this.cancelled.push(id);
        this.callbacks.delete(id);
      },
      setTimeout: (callback, delay = 0) => {
        const id = this.nextTimeoutId;
        this.nextTimeoutId += 1;
        this.timeouts.set(id, callback);
        this.timeoutDelays.set(id, delay);
        return id;
      },
      clearTimeout: (id) => {
        this.clearedTimeouts.push(id);
        this.timeouts.delete(id);
        this.timeoutDelays.delete(id);
      },
    };
  }

  frame(timestamp) {
    this.now = timestamp;
    const pending = [...this.callbacks.entries()];
    this.callbacks.clear();
    pending.forEach(([, callback]) => callback(timestamp));
  }

  flushTimeouts() {
    const pending = [...this.timeouts.values()];
    this.timeouts.clear();
    pending.forEach((callback) => callback());
  }
}

class FakeMap {
  constructor(container, mercator = false) {
    this.container = container;
    this.listeners = new Map();
    this.removeCount = 0;
    this.offCount = 0;
    this.zoom = 8;
    this.center = [0, 0];
    this.flyCalls = [];
    this.pointFlyCalls = [];
    this.fitBoundsCalls = [];
    this.setViewCalls = [];
    this.invalidateCount = 0;
    this.projectionOffset = 0;
    this.panes = new Map();
    this.layers = new Set();
    this.mercator = mercator;
  }

  getContainer() { return this.container; }
  createPane(name) {
    const pane = new FakeElement("div");
    this.panes.set(name, pane);
    return pane;
  }
  getPane(name) { return this.panes.get(name); }
  addLayer(layer) { this.layers.add(layer); return this; }
  removeLayer(layer) { this.layers.delete(layer); return this; }
  hasLayer(layer) { return this.layers.has(layer); }
  setView(center, zoom, options) {
    this.center = [...center];
    this.zoom = zoom;
    this.setViewCalls.push({ center, zoom, options });
    return this;
  }
  fitBounds(bounds, options) {
    this.fitBoundsCalls.push({ bounds, options });
    if (bounds.points.length) {
      const latitudes = bounds.points.map(([latitude]) => latitude);
      const longitudes = bounds.points.map(([, longitude]) => longitude);
      this.center = [
        (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
        (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
      ];
    }
    return this;
  }
  invalidateSize() { this.invalidateCount += 1; }
  getZoom() { return this.zoom; }
  getSize() { return { x: this.container.clientWidth, y: this.container.clientHeight }; }
  latLngToContainerPoint([lat, lon]) {
    const projectedLat = this.mercator
      ? Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI
      : lat;
    const projectedCenterLat = this.mercator
      ? Math.log(Math.tan(Math.PI / 4 + this.center[0] * Math.PI / 360)) * 180 / Math.PI
      : this.center[0];
    const scale = 2 ** (this.zoom - 8);
    return {
      x: (lon - this.center[1]) * 100 * scale + 400 + this.projectionOffset,
      y: 300 - (projectedLat - projectedCenterLat) * 100 * scale,
    };
  }
  on(events, listener) {
    events.split(/\s+/).forEach((event) => {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(listener);
    });
    return this;
  }
  fire(event) { for (const listener of this.listeners.get(event) || []) listener(); }
  flyToBounds(bounds, options) { this.flyCalls.push({ bounds, options }); return this; }
  flyTo(point, zoom, options) { this.pointFlyCalls.push({ point, zoom, options }); return this; }
  off() { this.offCount += 1; this.listeners.clear(); return this; }
  remove() { this.removeCount += 1; }
}

function installLeaflet(fetchImpl, { mercator = false } = {}) {
  const maps = [];
  const tileCalls = [];
  const geoJSONCalls = [];
  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    if (fetchImpl) return fetchImpl(...args);
    return { ok: true, json: async () => ({ type: "FeatureCollection", features: [] }) };
  };
  globalThis.L = {
    map(container) {
      const map = new FakeMap(container, mercator);
      maps.push(map);
      return map;
    },
    tileLayer(url, options) {
      tileCalls.push({ url, options });
      return { addTo() {} };
    },
    geoJSON(data, options) {
      const layer = {
        data,
        options,
        addTo(map) { map.addLayer(this); return this; },
      };
      geoJSONCalls.push(layer);
      return layer;
    },
    latLngBounds(points) {
      return {
        points,
        padRatio: null,
        pad(ratio) { this.padRatio = ratio; return this; },
      };
    },
  };
  maps.tileCalls = tileCalls;
  maps.geoJSONCalls = geoJSONCalls;
  maps.fetchCalls = fetchCalls;
  return maps;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function battleFixture() {
  const timed = (label, start, end) => ({ label, start, end, precision: "exact", confidence: 1 });
  return {
    schema_version: "0.3.0",
    metadata: {},
    battle: { name: "Renderer test", date: { label: "test" }, part_of: "tests", summary: "summary" },
    sides: [{ id: "blue", name: "Blue" }, { id: "red", name: "Red" }],
    commanders: [],
    actors: [
      { id: "alpha", name: "Alpha", kind: "ship", side_id: "blue", commander_ids: [] },
      { id: "bravo", name: "Bravo", kind: "division", side_id: "red", commander_ids: [] },
    ],
    places: [
      { id: "west", name: "West", geometry: { type: "Point", coordinates: [0, 0] } },
      { id: "east", name: "East", geometry: { type: "Point", coordinates: [2, 0] } },
    ],
    historical_events: [
      { id: "opening", title: "Opening", type: "attack", time: timed("opening", "2020-01-01T00:00:00Z", "2020-01-01T00:00:01Z"), actor_ids: ["alpha"], target_actor_ids: ["bravo"], place_ids: ["west"], source_ids: [], precision: "exact", confidence: 1 },
      { id: "finish", title: "Finish", type: "advance", time: timed("finish", "2020-01-01T00:00:01Z", "2020-01-01T00:00:02Z"), actor_ids: ["alpha"], target_actor_ids: [], place_ids: ["east"], source_ids: [], precision: "exact", confidence: 1 },
    ],
    movements: [
      { id: "move_one", event_id: "opening", actor_id: "alpha", time: timed("move one", "2020-01-01T00:00:00Z", "2020-01-01T00:00:01Z"), path: { type: "LineString", coordinates: [[0, 0], [1, 0]] }, precision: "exact", confidence: 1 },
      { id: "move_two", event_id: "finish", actor_id: "alpha", time: timed("move two", "2020-01-01T00:00:01Z", "2020-01-01T00:00:02Z"), path: { type: "LineString", coordinates: [[1, 0], [2, 0]] }, precision: "exact", confidence: 1 },
      { id: "bravo_hold", event_id: "opening", actor_id: "bravo", time: timed("hold", "2020-01-01T00:00:00Z", "2020-01-01T00:00:01Z"), path: { type: "LineString", coordinates: [[0, 1], [0, 1]] }, precision: "exact", confidence: 1 },
    ],
    engagements: [{
      id: "strike", event_id: "opening", attacker_actor_id: "alpha", target_actor_id: "bravo",
      result_actor_id: "bravo", type: "fire", result: "sunk", source_ids: [],
      time: timed("strike", "2020-01-01T00:00:00Z", "2020-01-01T00:00:01Z"),
    }],
    outcome: { winner_side_ids: ["blue"], source_ids: [] },
    sources: [],
    animation_hints: {
      map: { initial_center: [1, 0], initial_zoom: 8 },
      timeline: { historical_seconds_per_playback_second: 1, ordered_event_ids: ["opening", "finish"] },
      style: { side_colors: { blue: "#00f", red: "#f00" }, actor_icons: { alpha: "warship_generic", bravo: "infantry" } },
    },
  };
}

function battleFixtureWithWarning() {
  const battle = battleFixture();
  battle.animation_hints.style.actor_icons.alpha = "not_a_real_token";
  return battle;
}

function frontlineBattleFixture() {
  const battle = battleFixture();
  battle.schema_version = "0.4.0";
  battle.sides[0].color = "#2468ac";
  const snapshot = (id, start, shift, precision = "exact", confidence = 0.8) => ({
    id,
    time: { label: id, start, precision, confidence },
    precision,
    confidence,
    event_id: "opening",
    source_ids: ["front-source"],
    front_lines: [{
      id: "main_front",
      geometry: { type: "LineString", coordinates: [[shift, -0.5], [shift, 0.5]] },
    }],
    control_areas: [{
      id: "blue_area",
      side_id: "blue",
      geometry: {
        type: "Polygon",
        coordinates: [[[shift - 1, -1], [shift, -1], [shift, 1], [shift - 1, -1]]],
      },
    }],
  });
  battle.frontline_snapshots = [
    snapshot("front_0", "2020-01-01T00:00:00Z", 0),
    snapshot("front_1", "2020-01-01T00:00:01Z", 1, "inferred", 0.6),
  ];
  battle.sources = [{
    id: "front-source",
    title: "<Front source>",
    url: "https://example.test/front",
    retrieved_at: "2026-07-25",
    license: "CC BY 4.0",
  }];
  return battle;
}

function enclosureBattleFixture({ inferred = false } = {}) {
  const battle = frontlineBattleFixture();
  battle.frontline_snapshots[0].front_lines[0].geometry.coordinates = [[0, -1], [0, 1]];
  battle.frontline_snapshots[1].front_lines[0].geometry.coordinates = [
    [1, -1], [2, 0], [1, 1], [1, -1],
  ];
  battle.frontline_snapshots[1].precision = inferred ? "inferred" : "exact";
  battle.frontline_snapshots[1].confidence = inferred ? 0.6 : 0.8;
  return battle;
}

function frontlineFallbackBattleFixture() {
  const battle = battleFixture();
  battle.schema_version = "0.4.0";
  battle.actors[0].kind = "division";
  battle.actors[1].kind = "brigade";
  battle.actors.push(
    { id: "fleet", name: "Fleet", kind: "fleet", side_id: "blue", commander_ids: [] },
    { id: "observer", name: "Observer", kind: "person", side_id: "red", commander_ids: [] },
  );
  battle.movements.push(
    {
      ...structuredClone(battle.movements[0]),
      id: "fleet_hold",
      actor_id: "fleet",
      path: { type: "LineString", coordinates: [[0.2, 0.2], [0.2, 0.2]] },
    },
    {
      ...structuredClone(battle.movements[0]),
      id: "observer_hold",
      actor_id: "observer",
      path: { type: "LineString", coordinates: [[0.3, 0.3], [0.3, 0.3]] },
    },
  );
  battle.actors[0].strength = 10000;
  battle.outcome = { winner_side_ids: ["blue"], source_ids: [], summary: "Blue wins" };
  return battle;
}

function antimeridianFrontlineBattleFixture() {
  const battle = frontlineFallbackBattleFixture();
  battle.actors = battle.actors.filter(({ id }) => id === "alpha" || id === "bravo");
  battle.movements = battle.movements.filter(({ actor_id: actorId }) =>
    actorId === "alpha" || actorId === "bravo");
  for (const movement of battle.movements) {
    const longitude = movement.actor_id === "alpha" ? 179.8 : -179.8;
    movement.path.coordinates = [[longitude, 0], [longitude, 0]];
  }
  battle.places[0].geometry.coordinates = [179.8, 0];
  battle.places[1].geometry.coordinates = [-179.8, 0];
  return battle;
}

function hybridFrontlineBattleFixture() {
  const battle = frontlineFallbackBattleFixture();
  const source = frontlineBattleFixture();
  battle.frontline_snapshots = source.frontline_snapshots;
  battle.sources = source.sources;
  return battle;
}

function multiContourBattleFixture({ source = false, mixed = false } = {}) {
  const battle = frontlineFallbackBattleFixture();
  battle.actors.push(
    { id: "alpha_east", name: "Alpha east", kind: "division", side_id: "blue", commander_ids: [] },
    { id: "bravo_east", name: "Bravo east", kind: "brigade", side_id: "red", commander_ids: [] },
  );
  for (const [id, actorId, point] of [
    ["alpha_east_hold", "alpha_east", [10, 0]],
    ["bravo_east_hold", "bravo_east", [10, 1]],
  ]) {
    battle.movements.push({
      ...structuredClone(battle.movements[0]),
      id,
      actor_id: actorId,
      path: { type: "LineString", coordinates: [point, point] },
    });
  }
  if (source) {
    const sourceBattle = frontlineBattleFixture();
    battle.frontline_snapshots = sourceBattle.frontline_snapshots;
    battle.sources = sourceBattle.sources;
    for (const snapshot of battle.frontline_snapshots) {
      snapshot.front_lines = [
        { id: "west_front", geometry: { type: "LineString", coordinates: [[-1, 0.5], [1, 0.5]] } },
        {
          id: "east_front",
          geometry: {
            type: "LineString",
            coordinates: mixed
              ? [[9, 0.2], [10, 0.5], [9, 0.8], [9, 0.2]]
              : [[9, 0.5], [11, 0.5]],
          },
        },
      ];
    }
  }
  return battle;
}

function topologyChangeBattleFixture() {
  const battle = frontlineBattleFixture();
  battle.frontline_snapshots[1].front_lines[0].id = "split_front";
  battle.frontline_snapshots[1].control_areas[0].id = "split_area";
  return battle;
}

function partialTopologyChangeBattleFixture() {
  const battle = topologyChangeBattleFixture();
  for (const [index, snapshot] of battle.frontline_snapshots.entries()) {
    snapshot.front_lines.push({
      id: "stable_front",
      geometry: { type: "LineString", coordinates: [[index, 2], [index, 3]] },
    });
    snapshot.control_areas.push({
      id: "stable_area",
      side_id: "blue",
      geometry: {
        type: "Polygon",
        coordinates: [[[index, 2], [index + 0.5, 2], [index, 2.5], [index, 2]]],
      },
    });
  }
  return battle;
}

function incompatibleStableAreaFixture() {
  const battle = frontlineBattleFixture();
  battle.frontline_snapshots[1].control_areas[0].geometry.coordinates.push([
    [0.2, -0.2], [0.4, -0.2], [0.2, 0], [0.2, -0.2],
  ]);
  return battle;
}

function incompatibleStableLineFixture() {
  const battle = frontlineBattleFixture();
  battle.frontline_snapshots[0].front_lines[0].geometry.coordinates = [[0, 0], [0, 0]];
  return battle;
}

function repeatedTopologyCrossingFixture() {
  const battle = topologyChangeBattleFixture();
  const final = structuredClone(battle.frontline_snapshots[0]);
  final.id = "front_2";
  final.time = {
    ...final.time,
    label: "front_2",
    start: "2020-01-01T00:00:02Z",
  };
  final.front_lines[0].geometry.coordinates = [[2, -0.5], [2, 0.5]];
  final.control_areas[0].geometry.coordinates = [[[1, -1], [2, -1], [2, 1], [1, -1]]];
  battle.frontline_snapshots.push(final);
  return battle;
}

function setup() {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = () => descendants(svg);
  const unit = (id) => all().find((element) => element.getAttribute("data-actor-id") === id);
  const byClass = (className) => all().filter((element) => element.classList.contains(className));
  return { clock, document, maps, controller, svg, all, unit, byClass };
}

test("renderBattle samples immediately and separates position, heading, and symbol transforms", () => {
  const { controller, unit } = setup();
  const alpha = unit("alpha");
  const heading = alpha.children.find((child) => child.classList.contains("unit-heading"));
  const symbol = heading.children.find((child) => child.classList.contains("unit-symbol"));

  assert.equal(controller.currentPresentationMs, 0);
  assert.match(alpha.getAttribute("transform"), /^translate\(/);
  assert.match(heading.getAttribute("transform"), /^rotate\(/);
  assert.equal(symbol.getAttribute("transform"), "scale(0.55)");
  assert.ok(symbol.children.length >= 1);
  assert.ok(symbol.children.every((child) => child.tagName === "PATH"));
});

test("active events render as pulse beacons without legacy discs", () => {
  const { byClass } = setup();

  const beacon = byClass("event-beacon")[0];
  assert.equal(byClass("event-beacon").length, 1);
  assert.equal(beacon.getAttribute("data-event-ids"), "opening");
  assert.deepEqual(beacon.children.map((child) => child.getAttribute("class")), [
    "event-beacon-pulse", "event-beacon-diamond", "event-beacon-icon",
  ]);
  assert.equal(beacon.children[0].getAttribute("r"), "10");
  assert.equal(beacon.children[1].getAttribute("d"), "M 0 -8 L 8 0 L 0 8 L -8 0 Z");
  assert.equal(beacon.children[2].getAttribute("y"), "4");
  assert.equal(beacon.children[2].getAttribute("text-anchor"), "middle");
  assert.equal(byClass("event-disc").length, 0);
});

test("active events without a resolvable place render no beacon", () => {
  const battle = battleFixture();
  battle.historical_events[0].place_ids = [];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  assert.equal(descendants(svg).some((element) => element.classList.contains("event-beacon")), false);
});

test("zoomend reprojects a beacon without replacing its keyed node", () => {
  const { maps, byClass } = setup();
  const beacon = byClass("event-beacon")[0];
  const before = beacon.getAttribute("transform");

  maps[0].projectionOffset = 25;
  maps[0].fire("zoomend");

  assert.equal(byClass("event-beacon")[0], beacon);
  assert.notEqual(beacon.getAttribute("transform"), before);
});

test("beacons exit after playback but disappear immediately on seek", () => {
  const { clock, controller, byClass } = setup();
  const opening = byClass("event-beacon")[0];

  controller.renderAt(1100, { mode: "playback" });
  assert.equal(opening.classList.contains("is-exiting"), true);
  assert.equal(byClass("event-beacon").length, 2);
  assert.equal(controller._beaconExitTimers.size, 1);
  clock.flushTimeouts();
  assert.equal(byClass("event-beacon").length, 1);
  assert.equal(controller._beaconExitTimers.size, 0);

  const finish = byClass("event-beacon")[0];
  controller.seek(500);
  assert.equal(byClass("event-beacon").length, 1);
  assert.equal(finish.parentNode, null);
  assert.equal(finish.classList.contains("is-exiting"), false);
});

test("reactivating a keyed beacon cancels its stale exit callback", () => {
  const { clock, controller, byClass } = setup();
  const opening = byClass("event-beacon")[0];
  controller.renderAt(1100, { mode: "playback" });
  const timerId = controller._beaconExitTimers.get("opening");
  const staleRemoval = clock.timeouts.get(timerId);

  controller.renderAt(500, { mode: "playback" });
  staleRemoval();

  assert.equal(byClass("event-beacon").includes(opening), true);
  assert.equal(opening.classList.contains("is-exiting"), false);
  assert.equal(controller._beaconExitTimers.has("opening"), false);
});

test("map reprojection preserves a playback-owned beacon exit timer", () => {
  const { clock, controller, maps, byClass } = setup();
  const opening = byClass("event-beacon")[0];
  controller.renderAt(1100, { mode: "playback" });
  const timerId = controller._beaconExitTimers.get("opening");
  const before = opening.getAttribute("transform");

  maps[0].projectionOffset = 25;
  maps[0].fire("move");

  assert.equal(byClass("event-beacon").includes(opening), true);
  assert.equal(opening.classList.contains("is-exiting"), true);
  assert.notEqual(opening.getAttribute("transform"), before);
  assert.equal(controller._beaconExitTimers.get("opening"), timerId);
  assert.equal(controller._beaconExitTimers.size, 1);
  clock.flushTimeouts();
  assert.equal(byClass("event-beacon").includes(opening), false);
});

test("nearby simultaneous events cluster into one counted beacon", () => {
  const battle = battleFixture();
  battle.historical_events.push({
    ...battle.historical_events[0],
    id: "opening_support",
    title: "Opening support",
    type: "reinforcement",
  });
  battle.animation_hints.timeline.ordered_event_ids.push("opening_support");
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);

  assert.equal(all.filter((element) => element.classList.contains("event-beacon")).length, 1);
  const count = all.find((element) => element.classList.contains("event-beacon-count"));
  assert.equal(count.textContent, "2");
});

test("movement trails default off and toggle without changing playback position", () => {
  const { controller, document, byClass } = setup();
  const button = document.getElementById("trails-button");
  assert.equal(controller.trailsEnabled, false);
  assert.equal(byClass("is-trail-active").length, 0);
  controller.seek(500);
  wirePlaybackControls(controller, document);
  button.dispatch("click");
  assert.equal(controller.currentPresentationMs, 500);
  assert.equal(controller.trailsEnabled, true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Trails: on");
});

test("enabled trails reveal progressively, fade once after playback crosses end, and clean up", () => {
  const battle = battleFixture();
  battle.movements = [battle.movements[0]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const byClass = (className) => descendants(svg).filter((element) => element.classList.contains(className));
  controller.setTrailsEnabled(true);
  controller.seek(500);
  const trail = byClass("movement-path")[0];
  const reveal = byClass("movement-reveal-mask")[0];
  assert.equal(trail.classList.contains("is-trail-active"), true);
  assert.equal(reveal.getAttribute("stroke-dashoffset"), "0.5");
  assert.equal(reveal.style.strokeDashoffset, "0.5");
  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1100, { mode: "playback" });
  assert.equal(trail.classList.contains("is-trail-fading"), true);
  assert.equal(reveal.style.strokeDashoffset, "0");
  assert.equal(controller._trailFadeTimers.size, 1);
  controller.renderAt(1200, { mode: "playback" });
  assert.equal(controller._trailFadeTimers.size, 1);
  clock.flushTimeouts();
  assert.equal(trail.classList.contains("is-trail-fading"), false);
  assert.equal(trail.classList.contains("is-trail-hidden"), true);
  controller.seek(500);
  assert.equal(trail.classList.contains("is-trail-fading"), false);
  controller.setTrailsEnabled(false);
  assert.equal(byClass("movement-path").every((path) => path.classList.contains("is-trail-hidden")), true);
});

test("a trail ending at the timeline boundary fades when playback reaches equality", () => {
  const battle = battleFixture();
  battle.movements = [battle.movements[1]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const byClass = (className) => descendants(svg).filter((element) => element.classList.contains(className));
  controller.setTrailsEnabled(true);
  controller.renderAt(controller.compiled.presentationDurationMs - 100, { mode: "playback" });
  controller.renderAt(controller.compiled.presentationDurationMs, { mode: "playback" });
  const terminalTrail = byClass("movement-path")[0];
  assert.equal(terminalTrail.classList.contains("is-trail-active"), false);
  assert.equal(terminalTrail.classList.contains("is-trail-fading"), true);
  assert.equal(controller._trailFadeTimers.size, 1);
  clock.flushTimeouts();
  assert.equal(terminalTrail.classList.contains("is-trail-fading"), false);
  assert.equal(terminalTrail.classList.contains("is-trail-hidden"), true);
});

test("reduced motion removes completed trails and ended beacons without exit timers", () => {
  const battle = battleFixture();
  battle.movements = [battle.movements[0]];
  const clock = new FrameClock(true);
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const byClass = (className) => descendants(svg).filter((element) => element.classList.contains(className));
  const opening = byClass("event-beacon")[0];

  controller.setTrailsEnabled(true);
  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1100, { mode: "playback" });

  const trail = byClass("movement-path")[0];
  assert.equal(trail.classList.contains("is-trail-fading"), false);
  assert.equal(trail.classList.contains("is-trail-hidden"), true);
  assert.equal(controller._trailFadeTimers.size, 0);
  assert.equal(opening.parentNode, null);
  assert.equal(controller._beaconExitTimers.size, 0);
  assert.equal(clock.timeouts.size, 1);
});

test("destroy cancels owned trail and beacon timers and clears transient state", () => {
  const battle = battleFixture();
  battle.movements = [battle.movements[0]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const trail = descendants(svg).find((element) => element.classList.contains("movement-path"));

  controller.setTrailsEnabled(true);
  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1100, { mode: "playback" });
  const ownedTimers = [
    ...controller._trailFadeTimers.values(),
    ...controller._beaconExitTimers.values(),
  ];
  assert.equal(ownedTimers.length, 2);

  controller.destroy();

  assert.equal(controller._trailFadeTimers.size, 0);
  assert.equal(controller._beaconExitTimers.size, 0);
  assert.equal(controller._beaconEls.size, 0);
  assert.equal(controller.sampledState, null);
  assert.equal(controller._lastTrailHistoricalMs, null);
  assert.equal(trail.classList.contains("is-trail-fading"), false);
  assert.equal(trail.classList.contains("is-trail-hidden"), true);
  assert.ok(ownedTimers.every((timer) => clock.clearedTimeouts.includes(timer)));
});

test("every movement owns a reveal mask and inferred dashes survive reveal progress", () => {
  const battle = battleFixture();
  battle.movements[0].precision = "inferred";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);
  const paths = all.filter((element) => element.classList.contains("movement-path"));
  const reveals = all.filter((element) => element.classList.contains("movement-reveal-mask"));
  assert.equal(reveals.length, battle.movements.length);
  assert.equal(new Set(paths.map((path) => path.getAttribute("mask"))).size, battle.movements.length);
  controller.setTrailsEnabled(true);
  controller.seek(500);
  assert.equal(paths[0].classList.contains("is-inferred"), true);
  assert.equal(reveals[0].getAttribute("stroke-dashoffset"), "0.5");
  assert.equal(reveals[0].style.strokeDashoffset, "0.5");
});

test("animation handles request id zero and timestamp zero, then advances continuously", () => {
  const { clock, controller, unit } = setup();
  const initialTransform = unit("alpha").getAttribute("transform");

  controller.play();
  assert.equal(controller._frame, 0);
  clock.frame(0);
  assert.equal(controller._lastFrameTime, 0);
  clock.frame(250);

  assert.equal(controller.currentPresentationMs, 250);
  assert.notEqual(unit("alpha").getAttribute("transform"), initialTransform);
  const pendingFrame = controller._frame;
  controller.pause();
  assert.equal(controller.isPlaying, false);
  assert.equal(controller._frame, null);
  assert.ok(clock.cancelled.includes(pendingFrame));
});

test("pause cancels the current frame, end pauses exactly, and replay restarts at zero", () => {
  const { clock, controller } = setup();
  controller.play();
  const firstRequest = controller._frame;
  controller.pause();
  assert.ok(clock.cancelled.includes(firstRequest));

  controller.play();
  clock.frame(0);
  clock.frame(2000);
  assert.equal(controller.currentPresentationMs, controller.compiled.presentationDurationMs);
  assert.equal(controller.isPlaying, false);

  controller.play();
  assert.equal(controller.currentPresentationMs, 0);
  assert.equal(controller.isPlaying, true);
});

test("seek deterministically applies movement, engagement, sunk, and visibility state backward", () => {
  const { controller, unit, byClass } = setup();
  const bravo = unit("bravo");
  const paths = byClass("movement-path");
  const engagement = byClass("engagement-line")[0];

  controller.seek(500);
  assert.equal(bravo.classList.contains("is-hit"), true);
  assert.equal(bravo.classList.contains("is-sunk"), false);
  assert.equal(engagement.classList.contains("is-active"), true);
  assert.equal(paths[0].classList.contains("is-active"), true);
  assert.equal(paths[1].classList.contains("is-visible"), false);

  controller.seek(1500);
  assert.equal(bravo.classList.contains("is-hit"), false);
  assert.equal(bravo.classList.contains("is-sunk"), true);
  assert.equal(engagement.classList.contains("is-active"), false);
  assert.equal(paths[0].classList.contains("is-completed"), true);
  assert.equal(paths[1].classList.contains("is-active"), true);

  controller.seek(500);
  assert.equal(bravo.classList.contains("is-hit"), true);
  assert.equal(bravo.classList.contains("is-sunk"), false);
  assert.equal(paths[1].classList.contains("is-visible"), false);
});

test("continuous scrubber and historical clock follow every sampled seek", () => {
  const { controller, document } = setup();
  const scrubber = document.getElementById("event-scrubber");

  assert.equal(scrubber.max, String(controller.compiled.presentationDurationMs));
  controller.seek(1250);
  assert.equal(scrubber.value, "1250");
  assert.equal(document.getElementById("historical-time").textContent, "2020-01-01 00:00:01");
  assert.equal(document.getElementById("event-progress").textContent, "2 / 2");
});

test("historical clock preserves positive and negative document offsets", () => {
  for (const offset of ["+02:00", "-05:00"]) {
    const battle = battleFixture();
    const replaceOffset = (value) => typeof value === "string" && value.endsWith("Z")
      ? `${value.slice(0, -1)}${offset}` : value;
    for (const event of battle.historical_events) {
      event.time.start = replaceOffset(event.time.start);
      event.time.end = replaceOffset(event.time.end);
    }
    for (const movement of battle.movements) {
      movement.time.start = replaceOffset(movement.time.start);
      movement.time.end = replaceOffset(movement.time.end);
    }
    for (const engagement of battle.engagements) {
      engagement.time.start = replaceOffset(engagement.time.start);
      engagement.time.end = replaceOffset(engagement.time.end);
    }
    const clock = new FrameClock();
    const document = new FakeDocument(clock.window);
    installLeaflet();
    const controller = renderBattle(battle, document);
    controller.seek(1250);
    assert.equal(document.getElementById("historical-time").textContent, "2020-01-01 00:00:01");
  }
});

test("wirePlaybackControls routes continuous controls once when rewired", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const calls = [];
  const controller = {
    followEnabled: true,
    trailsEnabled: false,
    modernBordersEnabled: false,
    frontsEnabled: true,
    toggle: () => calls.push(["toggle"]),
    pause: () => calls.push(["pause"]),
    seek: (value) => calls.push(["seek", value]),
    prev: () => calls.push(["prev"]),
    next: () => calls.push(["next"]),
    focusActiveEvents: () => calls.push(["focus"]),
    setSpeed: (value) => calls.push(["speed", value]),
    setFollowEnabled(value) { calls.push(["follow", value]); this.followEnabled = value; },
    setTrailsEnabled(value) { calls.push(["trails", value]); this.trailsEnabled = value; },
    setModernBordersEnabled(value) { calls.push(["borders", value]); this.modernBordersEnabled = value; },
    setFrontsEnabled(value) { calls.push(["fronts", value]); this.frontsEnabled = value; },
  };
  wirePlaybackControls(controller, document);
  wirePlaybackControls(controller, document);

  document.getElementById("play-button").dispatch("click");
  document.getElementById("reset-button").dispatch("click");
  document.getElementById("prev-button").dispatch("click");
  document.getElementById("next-button").dispatch("click");
  const scrubber = document.getElementById("event-scrubber");
  scrubber.value = "375.5";
  scrubber.dispatch("input");
  document.querySelectorAll("#speed-controls [data-speed]")[2].dispatch("click");
  document.getElementById("follow-button").dispatch("click");
  document.getElementById("trails-button").dispatch("click");
  document.getElementById("modern-borders-button").dispatch("click");
  document.getElementById("fronts-button").dispatch("click");
  document.getElementById("focus-event-button").dispatch("click");

  assert.deepEqual(calls, [
    ["toggle"],
    ["pause"], ["seek", 0],
    ["pause"], ["prev"],
    ["pause"], ["next"],
    ["pause"], ["seek", 375.5],
    ["speed", 2],
    ["follow", false],
    ["trails", true],
    ["borders", true],
    ["fronts", false],
    ["focus"],
  ]);
});

test("fronts control rewires once without pausing or changing time", () => {
  const document = new FakeDocument(new FrameClock().window);
  const calls = [];
  const old = {
    frontsEnabled: false,
    setFrontsEnabled: () => calls.push("old"),
  };
  const current = {
    frontsEnabled: true,
    currentPresentationMs: 625,
    isPlaying: true,
    setFrontsEnabled(value) {
      calls.push(["current", value]);
      this.frontsEnabled = value;
    },
  };
  wirePlaybackControls(old, document);
  wirePlaybackControls(current, document);
  document.getElementById("fronts-button").dispatch("click");

  assert.deepEqual(calls, [["current", false]]);
  assert.equal(current.currentPresentationMs, 625);
  assert.equal(current.isPlaying, true);
});

test("frontline control cycles the real controller without changing playback", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(hybridFrontlineBattleFixture(), document);
  wirePlaybackControls(controller, document);
  controller.seek(250);
  controller.play();
  const button = document.getElementById("fronts-button");
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const layer = descendants(svg).find((element) => element.classList.contains("frontline-layer"));
  const before = { time: controller.currentPresentationMs, playing: controller.isPlaying };

  for (const mode of ["source", "derived", "off", "hybrid"]) {
    button.dispatch("click");
    assert.equal(controller.frontlineMode, mode);
    assert.equal(button.textContent, `Fronts: ${mode}`);
    assert.equal(button.getAttribute("aria-pressed"), String(mode !== "off"));
    assert.deepEqual({ time: controller.currentPresentationMs, playing: controller.isPlaying }, before);
    assert.equal(layer.getAttribute("hidden"), mode === "off" ? "" : null);
    if (mode === "source") assert.ok(descendants(svg).some((element) => element.classList.contains("is-source-backed")));
    if (mode === "derived") assert.ok(descendants(svg).some((element) => element.classList.contains("is-derived")));
  }
});

test("frontline controller validates modes and preserves the legacy boolean alias", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(hybridFrontlineBattleFixture(), document);
  const button = document.getElementById("fronts-button");

  assert.deepEqual(FRONTLINE_MODES, ["hybrid", "source", "derived", "off"]);
  assert.equal(controller.FRONTLINE_MODES, undefined);
  assert.equal(controller.frontlineMode, "hybrid");
  assert.equal(button.textContent, "Fronts: hybrid");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(controller.setFrontlineMode("bogus"), "hybrid");
  assert.equal(controller.frontlineMode, "hybrid");
  assert.equal(controller.setFrontsEnabled(false), false);
  assert.equal(controller.frontlineMode, "off");
  assert.equal(button.textContent, "Fronts: off");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(controller.setFrontsEnabled(true), true);
  assert.equal(controller.frontlineMode, "hybrid");
});

test("rendered unavailable frontlines keep hybrid requested but expose actual hidden state", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battleFixture(), document);
  const button = document.getElementById("fronts-button");

  assert.equal(controller.frontlineMode, "hybrid");
  assert.equal(controller.frontsEnabled, false);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Fronts: hybrid");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("source and derived frontline modes never borrow from each other", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(hybridFrontlineBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = () => descendants(svg);

  controller.setFrontlineMode("source");
  assert.equal(all().filter((element) => element.classList.contains("front-line")).length, 1);
  assert.equal(all().every((element) => !element.classList.contains("is-derived")), true);
  assert.equal(all().some((element) => element.classList.contains("front-influence")), false);
  assert.equal(document.getElementById("frontline-summary").textContent, "SOURCE-BACKED");

  controller.setFrontlineMode("derived");
  const derivedLines = all().filter((element) => element.classList.contains("front-line"));
  assert.ok(derivedLines.length >= 1);
  assert.equal(derivedLines.every((element) => element.classList.contains("is-derived")), true);
  assert.equal(derivedLines.every((element, index) =>
    element.getAttribute("data-frontline-key") === `derived:line:${index}`), true);
  assert.equal(all().some((element) => element.classList.contains("is-source-backed")), false);
  assert.match(document.getElementById("frontline-summary").textContent,
    /^DERIVED FROM UNIT POSITIONS · LOW CONFIDENCE$/);
});

test("derived mode renders every disconnected contact line", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(multiContourBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.setFrontlineMode("derived");

  const lines = descendants(svg).filter((element) => element.classList.contains("front-line"));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.getAttribute("data-frontline-key")),
    ["derived:line:0", "derived:line:1"]);
});

test("mixed hybrid convergence isolates one morph from one local crossfade", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(multiContourBattleFixture({ source: true, mixed: true }), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(250, { mode: "playback" });

  const primary = descendants(svg).filter((element) =>
    /^hybrid:line:/.test(element.getAttribute("data-frontline-key") || ""));
  const secondary = descendants(svg).filter((element) =>
    /^hybrid:derived:/.test(element.getAttribute("data-frontline-key") || ""));
  assert.equal(primary.length, 2);
  assert.equal(secondary.length, 1);
  assert.equal(controller._frontTransitionTimers.size, 1);
  assert.equal(primary.filter((line) =>
    line.classList.contains("is-front-entering") || line.classList.contains("is-front-exiting")).length, 1);
});

test("hybrid renderer spatially matches source fronts supplied in reverse order", () => {
  const battle = multiContourBattleFixture({ source: true });
  for (const snapshot of battle.frontline_snapshots) snapshot.front_lines.reverse();
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(146.4466094);

  const centers = descendants(svg)
    .filter((element) => /^hybrid:line:/.test(element.getAttribute("data-frontline-key") || ""))
    .map((line) => {
      const values = line.getAttribute("d").match(/-?\d+(?:\.\d+)?/g).map(Number);
      const xs = values.filter((_, index) => index % 2 === 0)
        .map((x) => maps[0].center[1] + (x - 400) / 100);
      return xs.reduce((total, x) => total + x, 0) / xs.length;
    })
    .sort((left, right) => left - right);
  assert.equal(controller._frontlineStatus.sourceWeight.toFixed(6), "0.500000");
  assert.equal(centers.length, 2);
  assert.ok(centers[0] < 2, `west front collapsed to ${centers[0]}`);
  assert.ok(centers[1] > 8, `east front collapsed to ${centers[1]}`);
});

test("derived grid stays data-bound through pan, zoom, and later availability", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.actors = battle.actors.filter(({ id }) => id === "alpha" || id === "bravo");
  battle.movements = battle.movements.filter(({ actor_id: actorId }) =>
    actorId === "alpha" || actorId === "bravo");
  for (const movement of battle.movements) {
    if (movement.actor_id === "alpha") movement.path.coordinates = [[0, 0], [0, 0]];
    if (movement.actor_id === "bravo") movement.path.coordinates = [[0, 0.4], [0, 0.4]];
  }
  battle.places[0].geometry.coordinates = [0, 0];
  battle.places[1].geometry.coordinates = [0, 0.4];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.setFrontlineMode("derived");
  const paths = () => descendants(svg)
    .filter((element) => element.classList.contains("front-line"))
    .map((line) => line.getAttribute("d"));
  const geographicPaths = () => {
    const scale = 2 ** (maps[0].zoom - 8);
    return paths().map((path) => {
      const values = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
      return Array.from({ length: values.length / 2 }, (_, index) => [
        Number((maps[0].center[1]
          + (values[index * 2] - 400 - maps[0].projectionOffset) / (100 * scale)).toFixed(2)),
        Number((maps[0].center[0]
          + (300 - values[index * 2 + 1]) / (100 * scale)).toFixed(2)),
      ]);
    });
  };
  const initial = paths();
  const initialGeography = geographicPaths();
  const assertStableGeography = () => {
    const current = geographicPaths();
    assert.equal(current.length, initialGeography.length);
    current.forEach((line, lineIndex) => {
      assert.equal(line.length, initialGeography[lineIndex].length);
      line.forEach((point, pointIndex) => {
        assert.ok(Math.abs(point[0] - initialGeography[lineIndex][pointIndex][0]) <= 0.011);
        assert.ok(Math.abs(point[1] - initialGeography[lineIndex][pointIndex][1]) <= 0.011);
      });
    });
  };

  maps[0].projectionOffset = 25;
  maps[0].fire("move");
  const panned = paths();
  assert.notDeepEqual(panned, initial);
  assertStableGeography();

  maps[0].zoom = 9;
  maps[0].fire("zoomend");
  assert.notDeepEqual(paths(), panned);
  assertStableGeography();

  const changing = frontlineFallbackBattleFixture();
  changing.movements.find(({ actor_id: id }) => id === "alpha").path.coordinates = [[0, 0], [0, 0]];
  changing.movements.find(({ actor_id: id }) => id === "bravo").path.coordinates = [[0, 0], [0, 0.4]];
  const otherDocument = new FakeDocument(clock.window);
  installLeaflet();
  const changingController = renderBattle(changing, otherDocument);
  const changingSvg = otherDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  assert.equal(otherDocument.getElementById("fronts-button").disabled, false);
  assert.equal(descendants(changingSvg).some((element) => element.classList.contains("front-line")), false);
  changingController.seek(1000);
  assert.equal(descendants(changingSvg).some((element) => element.classList.contains("front-line")), true);
});

test("hybrid uses exact source anchors and a U-shaped source correction between them", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const battle = hybridFrontlineBattleFixture();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const lines = () => descendants(svg).filter((element) => element.classList.contains("front-line"));
  const pathNumbers = () => lines()[0].getAttribute("d").match(/-?\d+(?:\.\d+)?/g).map(Number);

  assert.equal(controller._frontlineStatus.sourceWeight, 1);
  assert.equal(pathNumbers().filter((_, index) => index % 2 === 0).every((x) => x === 300), true);
  assert.deepEqual([pathNumbers()[1], pathNumbers().at(-1)], [350, 250]);
  controller.seek(250);
  assert.equal(controller._frontlineStatus.sourceWeight, 0.25);
  assert.match(document.getElementById("frontline-summary").textContent,
    /^HYBRID · 推導 75% \/ 史料校正 25%$/);
  assert.equal(lines().every((line) => line.classList.contains("is-derived")), true);
  controller.seek(500);
  assert.equal(controller._frontlineStatus.sourceWeight, 0);
  assert.equal(document.getElementById("frontline-summary").textContent,
    "HYBRID · 推導 100% / 史料校正 0%");
  controller.seek(1000);
  assert.equal(controller._frontlineStatus.sourceWeight, 1);
  assert.equal(pathNumbers().filter((_, index) => index % 2 === 0).every((x) => x === 400), true);
  assert.deepEqual([pathNumbers()[1], pathNumbers().at(-1)], [350, 250]);
});

test("hybrid topology mismatch does not show source-only lines at zero source weight", () => {
  const battle = hybridFrontlineBattleFixture();
  for (const snapshot of battle.frontline_snapshots) {
    snapshot.front_lines.push({
      id: "source_only",
      geometry: { type: "LineString", coordinates: [[3, -0.5], [3, 0.5]] },
    });
  }
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(500);

  const lines = descendants(svg).filter((element) => element.classList.contains("front-line"));
  assert.equal(controller._frontlineStatus.sourceWeight, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines.every((line) => line.classList.contains("is-derived")), true);
});

test("hybrid control areas reuse source topology crossfade timing", () => {
  const battle = hybridFrontlineBattleFixture();
  battle.frontline_snapshots[1].control_areas[0].id = "arriving_area";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(1000, { mode: "playback" });

  const oldArea = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area");
  const newArea = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:arriving_area");
  assert.equal(oldArea.classList.contains("is-front-exiting"), true);
  assert.equal(newArea.classList.contains("is-front-entering"), true);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("topology")), 500);
  clock.flushTimeouts();
  assert.equal(oldArea.parentNode, null);
  assert.equal(newArea.classList.contains("is-front-entering"), false);
});

test("hybrid delays changed enclosure areas without fabricating a source line reveal", () => {
  const battle = enclosureBattleFixture();
  battle.actors[0].kind = "division";
  battle.actors[1].kind = "brigade";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(1000, { mode: "playback" });

  const area = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area");
  assert.equal(area.classList.contains("is-enclosure-area-entering"), true);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("enclosure")), 900);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("front-enclosure-mask-path") ||
    element.classList.contains("is-enclosure-exiting")), false);
  clock.flushTimeouts();
  assert.equal(area.classList.contains("is-enclosure-area-entering"), false);
});

test("hybrid source-only and derived-only lines animate their one-sided topology", () => {
  const sourceOnly = hybridFrontlineBattleFixture();
  for (const snapshot of sourceOnly.frontline_snapshots) {
    snapshot.front_lines.push({
      id: "source_only",
      geometry: { type: "LineString", coordinates: [[3, -0.5], [3, 0.5]] },
    });
  }
  const sourceClock = new FrameClock();
  const sourceDocument = new FakeDocument(sourceClock.window);
  installLeaflet();
  const sourceController = renderBattle(sourceOnly, sourceDocument);
  const sourceSvg = sourceDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  sourceController.renderAt(250, { mode: "playback" });
  const departing = descendants(sourceSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:1");
  assert.equal(departing.classList.contains("is-front-exiting"), true);
  assert.equal(sourceClock.timeoutDelays.get(sourceController._frontTransitionTimers.get("hybrid:1")), 500);
  sourceClock.flushTimeouts();
  assert.equal(departing.parentNode, null);
  sourceController.renderAt(900, { mode: "playback" });
  const returning = descendants(sourceSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:1");
  assert.equal(returning.classList.contains("is-front-entering"), true);
  assert.equal(sourceClock.timeoutDelays.get(sourceController._frontTransitionTimers.get("hybrid:1")), 500);
  sourceClock.flushTimeouts();

  const derivedOnly = hybridFrontlineBattleFixture();
  for (const snapshot of derivedOnly.frontline_snapshots) snapshot.front_lines = [];
  const derivedClock = new FrameClock();
  const derivedDocument = new FakeDocument(derivedClock.window);
  installLeaflet();
  const derivedController = renderBattle(derivedOnly, derivedDocument);
  const derivedSvg = derivedDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  derivedController.renderAt(250, { mode: "playback" });
  const arriving = descendants(derivedSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:0");
  assert.equal(arriving.classList.contains("is-front-entering"), true);
  assert.equal(derivedClock.timeoutDelays.get(derivedController._frontTransitionTimers.get("hybrid:0")), 500);
  derivedClock.flushTimeouts();
  assert.equal(arriving.classList.contains("is-front-entering"), false);
  derivedController.renderAt(900, { mode: "playback" });
  assert.equal(arriving.classList.contains("is-front-exiting"), true);
  assert.equal(derivedClock.timeoutDelays.get(derivedController._frontTransitionTimers.get("hybrid:0")), 500);
  derivedClock.flushTimeouts();
  assert.equal(arriving.parentNode, null);
});

test("hybrid one-sided and crossfade artifacts clear on seek, reduced motion, replacement, and destroy", () => {
  const mismatch = () => {
    const battle = hybridFrontlineBattleFixture();
    for (const snapshot of battle.frontline_snapshots) {
      snapshot.front_lines.push({
        id: "source_only",
        geometry: { type: "LineString", coordinates: [[3, -0.5], [3, 0.5]] },
      });
    }
    return battle;
  };
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(mismatch(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(250, { mode: "playback" });
  const timers = [...controller._frontTransitionTimers.values()];
  controller.seek(300);
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(timers.every((timer) => clock.clearedTimeouts.includes(timer)), true);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting")), false);

  controller.renderAt(250, { mode: "playback" });
  const replacementTimer = [...controller._frontTransitionTimers.values()][0];
  const replacement = renderBattle(mismatch(), document);
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(clock.clearedTimeouts.includes(replacementTimer), true);
  replacement.renderAt(250, { mode: "playback" });
  const destroyTimer = [...replacement._frontTransitionTimers.values()][0];
  replacement.destroy();
  assert.equal(replacement._frontTransitionTimers.size, 0);
  assert.equal(clock.clearedTimeouts.includes(destroyTimer), true);

  const reducedClock = new FrameClock(true);
  const reducedDocument = new FakeDocument(reducedClock.window);
  installLeaflet();
  const reducedBattle = hybridFrontlineBattleFixture();
  for (const snapshot of reducedBattle.frontline_snapshots) snapshot.front_lines = [];
  const reduced = renderBattle(reducedBattle, reducedDocument);
  const reducedSvg = reducedDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  reduced.renderAt(250, { mode: "playback" });
  assert.equal(reduced._frontTransitionTimers.size, 0);
  assert.equal(descendants(reducedSvg).some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting")), false);
});

test("hybrid mismatch reuses its timer and settles derived artifacts at a source anchor", () => {
  const battle = hybridFrontlineBattleFixture();
  for (const snapshot of battle.frontline_snapshots) {
    snapshot.front_lines.push({
      id: "source_only",
      geometry: { type: "LineString", coordinates: [[3, -0.5], [3, 0.5]] },
    });
  }
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(250, { mode: "playback" });
  const timer = controller._frontTransitionTimers.get("hybrid:0");
  controller.renderAt(300, { mode: "playback" });

  assert.equal(controller._frontTransitionTimers.get("hybrid:0"), timer);
  assert.equal(clock.clearedTimeouts.includes(timer), false);
  controller.renderAt(1000, { mode: "playback" });
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting")), false);
  assert.equal(descendants(svg).filter((element) => element.classList.contains("front-line")).length, 2);
});

test("hybrid retires a stale crossfade timer when its line becomes compatible", () => {
  const battle = hybridFrontlineBattleFixture();
  for (const snapshot of battle.frontline_snapshots) {
    snapshot.front_lines.push({
      id: "temporary_source_only",
      geometry: { type: "LineString", coordinates: [[3, -0.5], [3, 0.5]] },
    });
  }
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(250, { mode: "playback" });
  const timer = controller._frontTransitionTimers.get("hybrid:0");
  const staleCallback = clock.timeouts.get(timer);
  for (const snapshot of battle.frontline_snapshots) snapshot.front_lines.pop();
  controller.renderAt(300, { mode: "playback" });
  const current = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:0");

  assert.ok(current?.parentNode);
  assert.equal(controller._frontTransitionTimers.has("hybrid:0"), false);
  assert.ok(clock.clearedTimeouts.includes(timer));
  staleCallback();
  assert.ok(current.parentNode);
});

test("hybrid replaces timer ownership when one-sided and paired transitions trade an index", () => {
  const closedSource = {
    id: "closed_source",
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 0], [0, 1], [0, 0]] },
  };

  const oneToPair = hybridFrontlineBattleFixture();
  for (const snapshot of oneToPair.frontline_snapshots) snapshot.front_lines = [];
  const firstClock = new FrameClock();
  const firstDocument = new FakeDocument(firstClock.window);
  installLeaflet();
  const first = renderBattle(oneToPair, firstDocument);
  const firstSvg = firstDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  first.renderAt(250, { mode: "playback" });
  const oneSidedTimer = first._frontTransitionTimers.get("hybrid:0");
  for (const snapshot of oneToPair.frontline_snapshots) snapshot.front_lines = [structuredClone(closedSource)];
  first.renderAt(300, { mode: "playback" });
  assert.notEqual(first._frontTransitionTimers.get("hybrid:0"), oneSidedTimer);
  assert.equal(firstClock.clearedTimeouts.includes(oneSidedTimer), true);
  firstClock.flushTimeouts();
  assert.equal(descendants(firstSvg).some((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:0"), false);
  assert.ok(descendants(firstSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:derived:0")?.parentNode);

  const pairToOne = hybridFrontlineBattleFixture();
  for (const snapshot of pairToOne.frontline_snapshots) snapshot.front_lines = [structuredClone(closedSource)];
  const secondClock = new FrameClock();
  const secondDocument = new FakeDocument(secondClock.window);
  installLeaflet();
  const second = renderBattle(pairToOne, secondDocument);
  const secondSvg = secondDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  second.renderAt(250, { mode: "playback" });
  const pairedTimer = second._frontTransitionTimers.get("hybrid:0");
  for (const snapshot of pairToOne.frontline_snapshots) snapshot.front_lines = [];
  second.renderAt(300, { mode: "playback" });
  assert.notEqual(second._frontTransitionTimers.get("hybrid:0"), pairedTimer);
  assert.equal(secondClock.clearedTimeouts.includes(pairedTimer), true);
  secondClock.flushTimeouts();
  assert.ok(descendants(secondSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:line:0")?.parentNode);
  assert.equal(descendants(secondSvg).some((element) =>
    element.getAttribute("data-frontline-key") === "hybrid:derived:0"), false);
});

test("hybrid area topology settlement cannot orphan a newer line crossfade", () => {
  const battle = multiContourBattleFixture({ source: true, mixed: true });
  battle.frontline_snapshots[0].control_areas[0].id = "departing_area";
  battle.frontline_snapshots[1].control_areas[0].id = "current_area";
  const third = structuredClone(battle.frontline_snapshots[1]);
  third.id = "front_2";
  third.time = { ...third.time, label: "front_2", start: "2020-01-01T00:00:02Z" };
  battle.frontline_snapshots.push(third);
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(1250, { mode: "playback" });
  const areaTimer = controller._frontTransitionTimers.get("topology");
  assert.equal(clock.timeoutDelays.get(areaTimer), 500);
  controller.renderAt(1900, { mode: "playback" });
  const lineTimer = controller._frontTransitionTimers.get("hybrid:0");
  assert.equal(clock.timeoutDelays.get(lineTimer), 500);
  const settleAreas = clock.timeouts.get(areaTimer);
  const settleLines = clock.timeouts.get(lineTimer);

  settleAreas();
  controller.renderAt(1950, { mode: "playback" });
  settleLines();
  clock.flushTimeouts();

  const hybridPaths = descendants(svg).filter((element) =>
    /^hybrid:(?:line|derived):/.test(element.getAttribute("data-frontline-key") || ""));
  assert.deepEqual(hybridPaths.map((path) => path.getAttribute("data-frontline-key")),
    ["hybrid:line:0", "hybrid:line:1"]);
  assert.equal(hybridPaths.some((path) =>
    path.classList.contains("is-front-entering") || path.classList.contains("is-front-exiting")), false);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("hybrid keeps source control areas and falls back to source interpolation without enough units", () => {
  const battle = hybridFrontlineBattleFixture();
  battle.actors.forEach((actor) => { actor.kind = "ship"; });
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(500);
  assert.ok(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area"));
  assert.ok(descendants(svg).some((element) => element.classList.contains("is-source-backed")));
  assert.equal(controller._frontlineStatus.kind, "source-fallback");
  assert.equal(document.getElementById("frontline-summary").textContent, "單位資料不足，使用史料補間");

  controller.setFrontlineMode("derived");
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-line")), false);
  assert.match(document.getElementById("frontline-summary").textContent, /insufficient units/i);
});

test("hybrid without source stays derived while source mode reports unavailable", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineFallbackBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  assert.ok(descendants(svg).some((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived")));
  controller.setFrontlineMode("source");
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-line")), false);
  assert.match(document.getElementById("frontline-summary").textContent, /source-backed frontline unavailable/i);
  assert.equal(document.getElementById("fronts-button").disabled, false);
});

test("switching frontline modes clears transitions and redraws the same instant", () => {
  const battle = topologyChangeBattleFixture();
  battle.actors.forEach((actor) => { actor.kind = "division"; });
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.setFrontlineMode("source");
  controller.renderAt(0, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });
  assert.ok(controller._frontTransitionTimers.size > 0);
  const before = { time: controller.currentPresentationMs, playing: controller.isPlaying };

  controller.setFrontlineMode("derived");

  assert.deepEqual({ time: controller.currentPresentationMs, playing: controller.isPlaying }, before);
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting") ||
    element.classList.contains("is-enclosure-exiting")), false);
});

test("frontline button starts hybrid in HTML and reset disables it without changing its mode label", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(html, /id="fronts-button"[^>]*aria-pressed="false"[^>]*disabled>Fronts: hybrid<\/button>/);
  assert.match(html, /id="frontline-details"/);
  const document = new FakeDocument(new FrameClock().window);
  resetBattleUI(document);
  assert.equal(document.getElementById("fronts-button").textContent, "Fronts: hybrid");
  assert.equal(document.getElementById("fronts-button").getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("fronts-button").disabled, true);
});

test("source-backed frontlines render in fixed order and toggle independently", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);
  const layer = all.find((element) => element.classList.contains("frontline-layer"));
  const area = all.find((element) => element.classList.contains("front-control-area"));
  const line = all.find((element) => element.classList.contains("front-line"));
  const movement = all.find((element) => element.classList.contains("movement-path"));
  const unit = all.find((element) => element.classList.contains("unit"));
  const beacon = all.find((element) => element.classList.contains("event-beacon-layer"));
  const button = document.getElementById("fronts-button");

  assert.ok(layer && area && line && movement && unit && beacon);
  assert.ok(svg.children.indexOf(layer) < svg.children.indexOf(movement));
  assert.ok(svg.children.indexOf(layer) < svg.children.indexOf(unit));
  assert.ok(svg.children.indexOf(layer) < svg.children.indexOf(beacon));
  assert.ok(layer.children.indexOf(area.parentNode) < layer.children.indexOf(line.parentNode));
  assert.ok(line.classList.contains("is-source-backed"));
  assert.equal(area.getAttribute("fill"), "#2468ac");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Fronts: hybrid");
  assert.equal(button.getAttribute("aria-pressed"), "true");

  const before = {
    time: controller.currentPresentationMs,
    playing: controller.isPlaying,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    borders: controller.modernBordersEnabled,
    focusDisabled: document.getElementById("focus-event-button").disabled,
    beaconChildren: [...beacon.children],
    historicalTime: document.getElementById("historical-time").textContent,
    unitTransform: unit.getAttribute("transform"),
  };
  controller.setFrontsEnabled(false);
  assert.equal(layer.getAttribute("hidden"), "");
  assert.deepEqual({
    time: controller.currentPresentationMs,
    playing: controller.isPlaying,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    borders: controller.modernBordersEnabled,
    focusDisabled: document.getElementById("focus-event-button").disabled,
    beaconChildren: [...beacon.children],
    historicalTime: document.getElementById("historical-time").textContent,
    unitTransform: unit.getAttribute("transform"),
  }, before);
});

test("frontline inspector shows source-backed provenance and interpolation safely", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const battle = frontlineBattleFixture();
  const controller = renderBattle(battle, document);
  controller.setFrontlineMode("source");
  assert.equal(document.getElementById("frontline-summary").textContent, "SOURCE-BACKED");
  assert.match(document.getElementById("frontline-details").textContent, /exact.*Interpolated/);
  controller.seek(500);

  const status = document.getElementById("frontline-status");
  const summary = document.getElementById("frontline-summary");
  const details = document.getElementById("frontline-details");
  const sources = document.getElementById("frontline-sources");
  assert.equal(status.hidden, false);
  assert.equal(summary.textContent, "SOURCE-BACKED");
  assert.match(details.textContent, /front_0 → front_1/);
  assert.match(details.textContent, /inferred/);
  assert.match(details.textContent, /60%/);
  assert.match(details.textContent, /Opening/);
  assert.match(details.textContent, /Interpolated/);
  assert.equal(sources.children.length, 1);
  const anchor = sources.children[0].children[0];
  assert.equal(anchor.tagName, "A");
  assert.equal(anchor.textContent, "<Front source>");
  assert.equal(anchor.getAttribute("href"), "https://example.test/front");
  assert.equal(sources.innerHTML, "");
});

test("frontline inspector labels topology crossfade", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  controller.setFrontlineMode("source");
  controller.seek(500);
  assert.equal(document.getElementById("frontline-summary").textContent, "SOURCE-BACKED");
  assert.match(document.getElementById("frontline-details").textContent, /Crossfade/);
});

test("frontline inspector does not link unsafe source URLs", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const battle = frontlineBattleFixture();
  battle.sources[0].url = "javascript:alert(1)";
  renderBattle(battle, document);
  const label = document.getElementById("frontline-sources").children[0].children[0];
  assert.equal(label.tagName, "SPAN");
  assert.equal(label.textContent, "<Front source>");
  assert.equal(label.getAttribute("href"), null);
});

test("frontline inspector labels derived provenance without inventing a source", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(frontlineFallbackBattleFixture(), document);

  const status = document.getElementById("frontline-status");
  assert.equal(status.hidden, false);
  const summary = document.getElementById("frontline-summary").textContent;
  assert.equal(summary, "DERIVED FROM UNIT POSITIONS · LOW CONFIDENCE");
  assert.equal(document.getElementById("frontline-sources").children.length, 0);
});

test("frontline inspector is hidden when fronts are off or unavailable", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineBattleFixture(), document);
  assert.equal(document.getElementById("frontline-status").hidden, false);
  controller.setFrontsEnabled(false);
  assert.equal(document.getElementById("frontline-status").hidden, true);

  const otherDocument = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battleFixture(), otherDocument);
  assert.equal(otherDocument.getElementById("frontline-status").hidden, true);
});

test("land fallback defaults on and renders only eligible influences with a derived line", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineFallbackBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);
  const influences = all.filter((element) => element.classList.contains("front-influence"));
  const line = all.find((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived"));
  const label = all.find((element) =>
    element.classList.contains("frontline-confidence-label") && element.classList.contains("is-derived"));

  assert.equal(controller.frontsEnabled, true);
  assert.equal(document.getElementById("fronts-button").disabled, false);
  assert.deepEqual(influences.map((element) => element.getAttribute("data-front-actor-id")).sort(), ["alpha", "bravo"]);
  assert.equal(influences.every((element) => element.getAttribute("r") === "28"), true);
  assert.ok(line);
  assert.equal(label.textContent, "DERIVED FROM UNIT POSITIONS · ≤35%");
});

test("derived frontlines exclude actors positioned only by the global place fallback", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.movements = battle.movements.filter(({ actor_id: actorId }) => actorId !== "bravo");
  for (const event of battle.historical_events) {
    event.actor_ids = event.actor_ids.filter((actorId) => actorId !== "bravo");
    event.target_actor_ids = event.target_actor_ids.filter((actorId) => actorId !== "bravo");
  }
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(500);

  assert.equal(controller.frontsEnabled, false);
  assert.equal(document.getElementById("fronts-button").disabled, true);
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-line")), false);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-front-actor-id") === "bravo"), false);
});

test("a later located event does not legitimize an earlier global fallback position", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.movements = battle.movements.filter(({ actor_id: actorId }) => actorId !== "bravo");
  battle.historical_events[0].place_ids = [];
  battle.historical_events[1].target_actor_ids = ["bravo"];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(500);

  assert.equal(controller.compiled.explicitStartingPositionActorIds.has("bravo"), false);
  assert.equal(controller.frontsEnabled, false);
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-line")), false);
});

test("an actor with an event Point location remains eligible for a derived frontline", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.movements = battle.movements.filter(({ actor_id: actorId }) => actorId !== "bravo");
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(500);

  assert.equal(controller.compiled.explicitStartingPositionActorIds.has("bravo"), true);
  assert.equal(controller.frontsEnabled, true);
  assert.ok(descendants(svg).find((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived")));
  assert.ok(descendants(svg).find((element) =>
    element.getAttribute("data-front-actor-id") === "bravo"));
});

test("source mode at the current time suppresses derived rendering", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.frontline_snapshots = frontlineBattleFixture().frontline_snapshots.slice(0, 1);
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  controller.setFrontlineMode("source");
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);

  assert.equal(all.some((element) => element.classList.contains("front-influence")), false);
  assert.equal(all.some((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-source-backed")), true);
  assert.equal(all.some((element) => element.classList.contains("is-derived")), false);
});

test("hybrid source fallback omits unavailable derived influence circles", () => {
  const battle = hybridFrontlineBattleFixture();
  battle.actors.find(({ id }) => id === "bravo").side_id = "blue";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  assert.equal(controller._frontlineStatus.kind, "source-fallback");
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-influence")), false);
  assert.ok(descendants(svg).find((element) => element.classList.contains("is-source-backed")));
});

test("one-side fallback leaves the overall frontline control unavailable", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.actors.find(({ id }) => id === "bravo").side_id = "blue";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);

  assert.equal(controller.frontsEnabled, false);
  assert.equal(document.getElementById("fronts-button").disabled, true);
  assert.equal(all.filter((element) => element.classList.contains("front-influence")).length, 0);
  assert.equal(all.some((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived")), false);
});

test("all-naval battle has no fallback and keeps Fronts disabled", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.actors.forEach((actor) => { actor.kind = "fleet"; });
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  assert.equal(controller.frontsEnabled, false);
  assert.equal(document.getElementById("fronts-button").disabled, true);
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-influence")), false);
});

test("fallback descriptors ignore strength casualties and outcome", () => {
  const describe = (battle) => {
    const clock = new FrameClock();
    const document = new FakeDocument(clock.window);
    installLeaflet();
    renderBattle(battle, document);
    const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
    return descendants(svg)
      .filter((element) => element.classList.contains("front-influence")
        || element.classList.contains("is-derived"))
      .map((element) => ({
        tag: element.tagName,
        className: element.getAttribute("class"),
        actorId: element.getAttribute("data-front-actor-id"),
        cx: element.getAttribute("cx"),
        cy: element.getAttribute("cy"),
        d: element.getAttribute("d"),
        text: element.textContent,
      }));
  };
  const first = frontlineFallbackBattleFixture();
  const second = structuredClone(first);
  second.actors[0].strength = 1;
  second.actors[0].casualties = 9999;
  second.outcome = { winner_side_ids: ["red"], source_ids: [], summary: "Red wins" };

  assert.deepEqual(describe(first), describe(second));
});

test("fallback influence centers reproject while their screen radius stays fixed", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  renderBattle(frontlineFallbackBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const influence = descendants(svg).find((element) => element.classList.contains("front-influence"));
  const before = influence.getAttribute("cx");

  maps[0].projectionOffset = 25;
  maps[0].fire("move");

  assert.notEqual(influence.getAttribute("cx"), before);
  assert.equal(influence.getAttribute("r"), "28");
});

test("antimeridian battle data uses narrow circular bounds for a derived frontline", () => {
  const battle = antimeridianFrontlineBattleFixture();
  battle.animation_hints.map.initial_center = [180, 0];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const derivedLine = () => descendants(svg).find((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived"));
  const geographicLine = () => {
    const scale = 2 ** (maps[0].zoom - 8);
    const values = derivedLine().getAttribute("d").match(/-?\d+(?:\.\d+)?/g).map(Number);
    return values.filter((_, index) => index % 2 === 0).map((x) => Number((
      maps[0].center[1] + (x - 400 - maps[0].projectionOffset) / (100 * scale)
    ).toFixed(3)));
  };

  assert.equal(controller._frontlineStatus.kind, "derived");
  assert.ok(derivedLine());
  assert.deepEqual(maps[0].setViewCalls[0].center, [0, 180]);
  const influenceXs = descendants(svg)
    .filter((element) => element.classList.contains("front-influence"))
    .map((element) => Number(element.getAttribute("cx")));
  assert.ok(Math.max(...influenceXs) - Math.min(...influenceXs) < 100);
  assert.ok(influenceXs.every((x) => x > 300 && x < 500));
  const lineXs = derivedLine().getAttribute("d").match(/-?\d+(?:\.\d+)?/g).map(Number)
    .filter((_, index) => index % 2 === 0);
  assert.ok(lineXs.every((x) => x > 300 && x < 500));
  const before = derivedLine().getAttribute("d");
  const beforeGeography = geographicLine();
  maps[0].projectionOffset = 25;
  maps[0].fire("move");
  assert.notEqual(derivedLine().getAttribute("d"), before);
  assert.deepEqual(geographicLine(), beforeGeography);
  maps[0].zoom = 9;
  maps[0].fire("zoomend");
  assert.equal(controller._frontlineStatus.kind, "derived");
  assert.ok(derivedLine());
  assert.deepEqual(geographicLine(), beforeGeography);
});

test("antimeridian fitBounds stays on the circular battle world copy", () => {
  const battle = antimeridianFrontlineBattleFixture();
  delete battle.animation_hints.map.initial_center;
  delete battle.animation_hints.map.initial_zoom;
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  const fitLongitudes = maps[0].fitBoundsCalls[0].bounds.points.map(([, longitude]) => longitude);
  assert.ok(Math.max(...fitLongitudes) - Math.min(...fitLongitudes) < 1);
  assert.ok(Math.abs(maps[0].center[1] - 180) < 0.01);
  const influenceXs = descendants(svg)
    .filter((element) => element.classList.contains("front-influence"))
    .map((element) => Number(element.getAttribute("cx")));
  assert.ok(Math.max(...influenceXs) - Math.min(...influenceXs) < 100);
  assert.ok(influenceXs.every((x) => x > 300 && x < 500));
});

test("fallback pairing becomes more conservative when zoomed in", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.animation_hints.map.initial_zoom = 12;
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const all = descendants(svg);

  assert.equal(all.filter((element) => element.classList.contains("front-influence")).length, 2);
  assert.equal(all.some((element) =>
    element.classList.contains("front-line") && element.classList.contains("is-derived")), false);
});

test("fallback pairing stays screen-bounded at high Mercator latitudes", () => {
  const renderAtLatitude = (latitude) => {
    const battle = frontlineFallbackBattleFixture();
    battle.movements.find(({ actor_id: actorId }) => actorId === "alpha").path.coordinates =
      [[0, latitude], [0, latitude]];
    battle.movements.find(({ actor_id: actorId }) => actorId === "bravo").path.coordinates =
      [[0, latitude + 1], [0, latitude + 1]];
    battle.animation_hints.map.initial_center = [0, latitude];
    const clock = new FrameClock();
    const document = new FakeDocument(clock.window);
    installLeaflet(undefined, { mercator: true });
    renderBattle(battle, document);
    const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
    return descendants(svg).some((element) =>
      element.classList.contains("front-line") && element.classList.contains("is-derived"));
  };

  assert.equal(renderAtLatitude(0), true);
  assert.equal(renderAtLatitude(75), false);
});

test("land actors without sampled coordinates do not enable fallback", () => {
  const battle = frontlineFallbackBattleFixture();
  battle.places = [];
  battle.movements = [];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);

  assert.equal(controller.frontsEnabled, false);
  assert.equal(document.getElementById("fronts-button").disabled, true);
});

test("frontline geometry updates keyed nodes and inferred snapshots show confidence", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const firstLine = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const firstArea = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "area:blue_area");
  const beforePath = firstLine.getAttribute("d");

  controller.seek(500);
  assert.match(firstLine.getAttribute("d"), /^M 350\.0 350\.0 /);

  controller.seek(1000);

  const all = descendants(svg);
  assert.equal(all.find((element) => element.getAttribute("data-frontline-key") === "line:main_front"), firstLine);
  assert.equal(all.find((element) => element.getAttribute("data-frontline-key") === "area:blue_area"), firstArea);
  assert.notEqual(firstLine.getAttribute("d"), beforePath);
  assert.ok(firstLine.classList.contains("is-inferred"));
  assert.equal(all.find((element) => element.classList.contains("frontline-confidence-label")).textContent, "推定 · 60%");
});

test("compatible frontline playback keeps keyed nodes while geometry changes continuously", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const line = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const before = line.getAttribute("d");

  controller.renderAt(500, { mode: "playback" });

  assert.equal(descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front"), line);
  assert.notEqual(line.getAttribute("d"), before);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("enclosure interpolation holds the open geometry until playback crosses its boundary", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const line = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const open = line.getAttribute("d");

  controller.renderAt(500, { mode: "playback" });

  assert.equal(line.getAttribute("d"), open);
  assert.equal(controller._frontTransitionTimers.has("enclosure"), false);
});

test("enclosure playback reveals the final line with a mask and delayed control area", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const line = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const open = line.getAttribute("d");
  controller.renderAt(500, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });

  const all = descendants(svg);
  const masks = all.filter((element) => element.tagName === "MASK" &&
    element.children[0]?.classList.contains("front-enclosure-mask-path"));
  const exiting = all.find((element) => element.classList.contains("is-enclosure-exiting"));
  const area = all.find((element) => element.getAttribute("data-frontline-key") === "area:blue_area");
  assert.equal(masks.length, 1);
  assert.equal(exiting.getAttribute("d"), open);
  assert.notEqual(line.getAttribute("d"), open);
  assert.match(line.getAttribute("mask"), /^url\(#front-enclosure-/);
  assert.equal(masks[0].children[0].getAttribute("d"), line.getAttribute("d"));
  assert.equal(masks[0].children[0].getAttribute("pathLength"), "1");
  assert.equal(area.classList.contains("is-enclosure-area-entering"), true);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("enclosure")), 900);

  clock.flushTimeouts();
  assert.equal(line.getAttribute("mask"), null);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("front-enclosure-mask-path")), false);
  assert.equal(exiting.parentNode, null);
  assert.equal(area.classList.contains("is-enclosure-area-entering"), false);
});

test("one enclosure boundary reveals every stable line that closes", () => {
  const battle = enclosureBattleFixture();
  battle.frontline_snapshots[0].front_lines.push({
    id: "second_front", geometry: { type: "LineString", coordinates: [[3, -1], [3, 1]] },
  });
  battle.frontline_snapshots[1].front_lines.push({
    id: "second_front", geometry: { type: "LineString", coordinates: [[3, -1], [4, 0], [3, 1], [3, -1]] },
  });
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(1000, { mode: "playback" });

  const lines = descendants(svg).filter((element) => element.classList.contains("front-line"));
  const targets = lines.filter((element) => element.getAttribute("data-frontline-key") &&
    !element.classList.contains("is-enclosure-exiting"));
  assert.equal(targets.filter((line) => /^url\(#front-enclosure-/.test(line.getAttribute("mask"))).length, 2);
  assert.equal(new Set(targets.map((line) => line.getAttribute("mask"))).size, 2);
  assert.equal(lines.filter((line) => line.classList.contains("is-enclosure-exiting")).length, 2);
  assert.deepEqual(controller._frontlineStatus.state.enclosureLineIds, ["main_front", "second_front"]);
  clock.flushTimeouts();
  assert.equal(descendants(svg).filter((element) => element.classList.contains("is-enclosure-exiting")).length, 0);
  assert.equal(targets.every((line) => line.getAttribute("mask") === null), true);
});

test("enclosure and unrelated topology changes compose with independent timers", () => {
  const battle = enclosureBattleFixture();
  battle.frontline_snapshots[0].front_lines.push({
    id: "departing", geometry: { type: "LineString", coordinates: [[3, -1], [3, 1]] },
  });
  battle.frontline_snapshots[1].front_lines.push({
    id: "arriving", geometry: { type: "LineString", coordinates: [[4, -1], [4, 1]] },
  });
  battle.frontline_snapshots[1].control_areas[0].id = "arriving_area";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(1000, { mode: "playback" });

  const all = descendants(svg);
  assert.equal(all.filter((element) => element.classList.contains("front-enclosure-mask-path")).length, 1);
  assert.equal(all.some((element) => element.getAttribute("data-frontline-key") === "line:departing" &&
    element.classList.contains("is-front-exiting")), true);
  assert.equal(all.some((element) => element.getAttribute("data-frontline-key") === "line:arriving" &&
    element.classList.contains("is-front-entering")), true);
  assert.equal(all.some((element) => element.getAttribute("data-frontline-key") === "area:blue_area" &&
    element.classList.contains("is-front-exiting")), true);
  assert.equal(all.some((element) => element.getAttribute("data-frontline-key") === "area:arriving_area" &&
    element.classList.contains("is-front-entering")), true);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("topology")), 500);
  assert.equal(clock.timeoutDelays.get(controller._frontTransitionTimers.get("enclosure")), 900);
  const topologyTimer = controller._frontTransitionTimers.get("topology");
  clock.timeouts.get(topologyTimer)();
  assert.equal(controller._frontTransitionTimers.has("enclosure"), true);
  assert.match(all.find((element) => element.getAttribute("data-frontline-key") === "line:main_front").getAttribute("mask"), /^url/);
  clock.flushTimeouts();
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("enclosure delays only entering or materially changed target areas", () => {
  const battle = enclosureBattleFixture();
  for (const snapshot of battle.frontline_snapshots) {
    snapshot.control_areas.push({
      id: "unchanged_area", side_id: "red",
      geometry: { type: "Polygon", coordinates: [[[3, -1], [4, -1], [3, 0], [3, -1]]] },
    });
  }
  battle.frontline_snapshots[1].control_areas[0].geometry.coordinates = [[[0, -1], [2, -1], [2, 1], [0, -1]]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(1000, { mode: "playback" });

  const changed = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "area:blue_area");
  const unchanged = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "area:unchanged_area");
  assert.equal(changed.classList.contains("is-enclosure-area-entering"), true);
  assert.equal(unchanged.classList.contains("is-enclosure-area-entering"), false);
});

test("equivalent area geometry with reordered object keys does not blink", () => {
  const battle = enclosureBattleFixture();
  const area = battle.frontline_snapshots[1].control_areas[0];
  area.geometry = {
    coordinates: structuredClone(battle.frontline_snapshots[0].control_areas[0].geometry.coordinates),
    type: "Polygon",
  };
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(1000, { mode: "playback" });

  const target = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "area:blue_area");
  assert.equal(target.classList.contains("is-enclosure-area-entering"), false);
});

test("enclosure crossing recreates a detached keyed target and settles without reveal artifacts", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const stale = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  controller.renderAt(500, { mode: "playback" });
  stale.remove();

  controller.renderAt(1000, { mode: "playback" });

  const target = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  assert.ok(target?.parentNode);
  assert.notEqual(target, stale);
  assert.equal(target.getAttribute("mask"), null);
  assert.equal(controller._frontTransitionTimers.has("enclosure"), false);
  assert.equal(descendants(svg).some((element) => element.classList.contains("front-enclosure-mask-path")), false);
  assert.equal(descendants(svg).some((element) => element.classList.contains("is-enclosure-area-entering")), false);
});

test("high-speed enclosure inspector uses the crossed snapshots provenance", () => {
  const battle = enclosureBattleFixture();
  battle.sources.push({
    id: "closed-source", title: "Closure source", url: "https://example.test/closure",
    retrieved_at: "2026-08-03", license: "CC BY 4.0",
  });
  battle.frontline_snapshots[1].source_ids = ["closed-source"];
  battle.frontline_snapshots[1].event_id = "finish";
  battle.frontline_snapshots[1].confidence = 0.55;
  const later = structuredClone(battle.frontline_snapshots[1]);
  later.id = "front_2";
  later.time = { ...later.time, label: "later", start: "2020-01-01T00:00:02Z" };
  later.source_ids = ["front-source"];
  later.event_id = "opening";
  later.confidence = 0.95;
  battle.frontline_snapshots.push(later);
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  controller.setFrontlineMode("source");

  controller.renderAt(2000, { mode: "playback" });

  const summary = document.getElementById("frontline-summary").textContent;
  const details = document.getElementById("frontline-details").textContent;
  const sources = document.getElementById("frontline-sources");
  assert.equal(summary, "SOURCE-BACKED");
  assert.match(details, /front_0 → front_1/);
  assert.match(details, /55% confidence/);
  assert.match(details, /Opening/);
  assert.match(details, /Finish/);
  assert.match(details, /Enclosure reveal/);
  assert.deepEqual(sources.children.map((item) => item.children[0].textContent), ["<Front source>", "Closure source"]);
});

test("enclosure reveal preserves inferred styling and is immediate for seek or reduced motion", () => {
  for (const reduced of [false, true]) {
    const clock = new FrameClock(reduced);
    const document = new FakeDocument(clock.window);
    installLeaflet();
    const controller = renderBattle(enclosureBattleFixture({ inferred: true }), document);
    controller.renderAt(1000, { mode: reduced ? "playback" : "seek" });
    const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
    const line = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
    assert.equal(line.classList.contains("is-inferred"), true);
    assert.equal(line.getAttribute("mask"), null);
    assert.equal(controller._frontTransitionTimers.has("enclosure"), false);
  }
});

test("initial render, scrub, reset, and previous-next navigation settle enclosure immediately", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(enclosureBattleFixture(), document);
  wirePlaybackControls(controller, document);
  const artifacts = () => descendants(document.getElementById("battle-map")).filter((element) =>
    element.classList.contains("front-enclosure-mask-path") ||
    element.classList.contains("is-enclosure-exiting") ||
    element.classList.contains("is-enclosure-area-entering"));
  assert.equal(artifacts().length, 0);
  document.getElementById("event-scrubber").oninput({ target: { value: "1000" } });
  assert.equal(artifacts().length, 0);
  document.getElementById("reset-button").onclick();
  assert.equal(artifacts().length, 0);
  document.getElementById("next-button").onclick();
  assert.equal(artifacts().length, 0);
  document.getElementById("prev-button").onclick();
  assert.equal(artifacts().length, 0);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("a multi-keyframe playback jump reveals the last enclosure present in the final snapshot", () => {
  const battle = enclosureBattleFixture();
  battle.frontline_snapshots[0].front_lines.push({
    id: "last_front", geometry: { type: "LineString", coordinates: [[2, -1], [2, 1]] },
  });
  const middle = structuredClone(battle.frontline_snapshots[1]);
  middle.id = "front_2";
  middle.time = { ...middle.time, label: "front_2", start: "2020-01-01T00:00:02Z" };
  middle.front_lines.push(structuredClone(battle.frontline_snapshots[0].front_lines[1]));
  const final = structuredClone(middle);
  final.id = "front_3";
  final.time = { ...final.time, label: "front_3", start: "2020-01-01T00:00:03Z" };
  final.front_lines.find(({ id }) => id === "last_front").geometry.coordinates = [[2, -1], [3, 0], [2, 1], [2, -1]];
  battle.frontline_snapshots.push(middle, final);
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);

  controller.renderAt(3000, { mode: "playback" });

  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const target = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:last_front");
  assert.match(target.getAttribute("mask"), /^url\(#front-enclosure-/);
  assert.equal(controller._frontTransitionTimers.has("enclosure"), true);
});

test("a jump past enclosure reveals the final sampled geometry and later topology", () => {
  const battle = enclosureBattleFixture();
  const final = structuredClone(battle.frontline_snapshots[1]);
  final.id = "front_2";
  final.time = { ...final.time, label: "front_2", start: "2020-01-01T00:00:02Z" };
  final.front_lines[0].geometry.coordinates = [[4, -1], [5, 0], [4, 1], [4, -1]];
  final.front_lines.push({ id: "later_front", geometry: { type: "LineString", coordinates: [[6, -1], [6, 1]] } });
  final.control_areas[0].geometry.coordinates = [[[3, -1], [5, -1], [5, 1], [3, -1]]];
  battle.frontline_snapshots.push(final);

  const expectedClock = new FrameClock();
  const expectedDocument = new FakeDocument(expectedClock.window);
  installLeaflet();
  const expectedController = renderBattle(battle, expectedDocument);
  expectedController.setFrontlineMode("source");
  expectedController.seek(2000);
  const expectedSvg = expectedDocument.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const expectedLineD = descendants(expectedSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front").getAttribute("d");
  const expectedAreaD = descendants(expectedSvg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area").getAttribute("d");

  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  controller.setFrontlineMode("source");
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(2000, { mode: "playback" });

  const target = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const area = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "area:blue_area");
  const later = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:later_front");
  assert.equal(target.getAttribute("d"), expectedLineD);
  assert.equal(area.getAttribute("d"), expectedAreaD);
  assert.match(target.getAttribute("mask"), /^url\(#front-enclosure-/);
  assert.equal(later.classList.contains("is-front-entering"), true);
  assert.equal(document.getElementById("frontline-summary").textContent, "SOURCE-BACKED");
  assert.match(document.getElementById("frontline-details").textContent, /front_0 → front_1.*Enclosure reveal/);
});

test("a later enclosure transition clears every artifact owned by the prior reveal", () => {
  const battle = enclosureBattleFixture();
  battle.frontline_snapshots[0].front_lines.push({
    id: "second_front", geometry: { type: "LineString", coordinates: [[3, -1], [3, 1]] },
  });
  battle.frontline_snapshots[1].front_lines.push(structuredClone(battle.frontline_snapshots[0].front_lines[1]));
  const final = structuredClone(battle.frontline_snapshots[1]);
  final.id = "front_2";
  final.time = { ...final.time, label: "front_2", start: "2020-01-01T00:00:02Z" };
  final.front_lines[1].geometry.coordinates = [[3, -1], [4, 0], [3, 1], [3, -1]];
  battle.frontline_snapshots.push(final);
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(1000, { mode: "playback" });
  const firstTarget = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const firstMask = firstTarget.getAttribute("mask");

  controller.renderAt(2000, { mode: "playback" });

  const artifacts = descendants(svg);
  const secondTarget = artifacts.find((element) => element.getAttribute("data-frontline-key") === "line:second_front");
  assert.equal(firstTarget.getAttribute("mask"), null);
  assert.notEqual(secondTarget.getAttribute("mask"), firstMask);
  assert.equal(artifacts.filter((element) => element.classList.contains("front-enclosure-mask-path")).length, 1);
  assert.equal(artifacts.filter((element) => element.classList.contains("is-enclosure-exiting")).length, 1);
  assert.equal(controller._frontTransitionTimers.size, 1);
});

test("replacement and destroy remove enclosure nodes, classes, masks, clones, and timers", () => {
  for (const replace of [true, false]) {
    const clock = new FrameClock();
    const document = new FakeDocument(clock.window);
    installLeaflet();
    const controller = renderBattle(enclosureBattleFixture(), document);
    const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
    controller.renderAt(1000, { mode: "playback" });
    const target = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
    const maskPath = descendants(svg).find((element) => element.classList.contains("front-enclosure-mask-path"));
    const mask = maskPath.parentNode;
    const old = descendants(svg).find((element) => element.classList.contains("is-enclosure-exiting"));
    const area = descendants(svg).find((element) => element.classList.contains("is-enclosure-area-entering"));
    if (replace) renderBattle(frontlineBattleFixture(), document);
    else controller.destroy();
    assert.equal(controller._frontTransitionTimers.size, 0);
    assert.equal(target.getAttribute("mask"), null);
    assert.equal(mask.parentNode, null);
    assert.equal(old.parentNode, null);
    assert.equal(area.classList.contains("is-enclosure-area-entering"), false);
  }
});

test("enclosure artifacts clear on reprojection, fronts off, replacement, and destroy", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const start = () => {
    const controller = renderBattle(enclosureBattleFixture(), document);
    controller.renderAt(1000, { mode: "playback" });
    return controller;
  };
  const clean = (controller) => {
    const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
    assert.equal(controller._frontTransitionTimers.size, 0);
    assert.equal(descendants(svg).some((element) => element.classList.contains("front-enclosure-mask-path") ||
      element.classList.contains("is-enclosure-exiting") ||
      element.classList.contains("is-enclosure-area-entering")), false);
  };
  let controller = start();
  const firstMaskId = descendants(document.getElementById("battle-map")).find((element) =>
    element.children[0]?.classList.contains("front-enclosure-mask-path"))?.getAttribute("id");
  maps.at(-1).fire("move");
  clean(controller);
  controller = start();
  const replacementMaskId = descendants(document.getElementById("battle-map")).find((element) =>
    element.children[0]?.classList.contains("front-enclosure-mask-path"))?.getAttribute("id");
  assert.notEqual(replacementMaskId, firstMaskId);
  controller.setFrontsEnabled(false);
  clean(controller);
  controller = start();
  const replaced = renderBattle(frontlineBattleFixture(), document);
  assert.equal(controller._frontTransitionTimers.size, 0);
  controller = start();
  controller.destroy();
  assert.equal(controller._frontTransitionTimers.size, 0);
  replaced.destroy();
});

test("incompatible frontline playback crossfades old and new nodes for 500ms", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const oldLine = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front");

  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });

  const newLine = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front");
  const oldArea = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area");
  const newArea = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:split_area");
  assert.equal(oldLine.classList.contains("is-front-exiting"), true);
  assert.equal(newLine.classList.contains("is-front-entering"), true);
  assert.equal(oldArea.classList.contains("is-front-exiting"), true);
  assert.equal(newArea.classList.contains("is-front-entering"), true);
  assert.equal(controller._frontTransitionTimers.size, 1);
  assert.equal(clock.timeoutDelays.get([...controller._frontTransitionTimers.values()][0]), 500);
  assert.equal(clock.timeouts.size, 2);

  clock.flushTimeouts();

  assert.equal(oldLine.parentNode, null);
  assert.equal(oldArea.parentNode, null);
  assert.equal(newLine.classList.contains("is-front-entering"), false);
  assert.equal(newArea.classList.contains("is-front-entering"), false);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("partial topology changes preserve stable keyed geometry through the crossfade", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(partialTopologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const stableLine = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:stable_front");
  const stableArea = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "area:stable_area");
  const initialLinePath = stableLine.getAttribute("d");

  controller.renderAt(500, { mode: "playback" });
  assert.notEqual(stableLine.getAttribute("d"), initialLinePath);
  controller.renderAt(1000, { mode: "playback" });

  assert.equal(stableLine.classList.contains("is-front-entering"), false);
  assert.equal(stableLine.classList.contains("is-front-exiting"), false);
  assert.equal(stableArea.classList.contains("is-front-entering"), false);
  assert.equal(stableArea.classList.contains("is-front-exiting"), false);
  clock.flushTimeouts();
  assert.equal(stableLine.parentNode !== null, true);
  assert.equal(stableArea.parentNode !== null, true);
});

test("a playback frame jump across an incompatible keyframe still crossfades", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const oldLine = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front");

  controller.renderAt(1000, { mode: "playback" });

  const newLine = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front");
  assert.equal(oldLine.classList.contains("is-front-exiting"), true);
  assert.equal(newLine.classList.contains("is-front-entering"), true);
  assert.equal(controller._frontTransitionTimers.size, 1);
});

test("an incompatible polygon with the same stable id crossfades through a temporary old node", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(incompatibleStableAreaFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });

  const all = descendants(svg);
  const keys = all.map((element) => element.getAttribute("data-frontline-key")).filter(Boolean);
  const areas = all.filter((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area");
  const areaNodes = all.filter((element) => element.classList.contains("front-control-area"));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(controller._frontTransitionTimers.size, 1);
  assert.equal(areas[0].classList.contains("is-front-entering"), true);
  assert.equal(areas.length, 1);
  assert.equal(areaNodes.length, 2);
  assert.equal(areaNodes.filter((area) => area.classList.contains("is-front-exiting")).length, 1);
  assert.equal(areaNodes.filter((area) => area.classList.contains("is-front-entering")).length, 1);

  clock.flushTimeouts();

  const settled = descendants(svg).filter((element) =>
    element.getAttribute("data-frontline-key") === "area:blue_area");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].classList.contains("is-front-entering"), false);
  assert.equal(settled[0].classList.contains("is-front-exiting"), false);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("an unsafe same-id line resampling crossfades instead of reusing one node", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(incompatibleStableLineFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(1000, { mode: "playback" });

  const lines = descendants(svg).filter((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front");
  const lineNodes = descendants(svg).filter((element) => element.classList.contains("front-line"));
  assert.equal(lines.length, 1);
  assert.equal(lineNodes.length, 2);
  assert.equal(lineNodes.filter((line) => line.classList.contains("is-front-exiting")).length, 1);
  assert.equal(lineNodes.filter((line) => line.classList.contains("is-front-entering")).length, 1);
});

test("a frame crossing A-to-B-to-A topology crossfades the repeated final key", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(repeatedTopologyCrossingFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(2000, { mode: "playback" });

  const lines = descendants(svg).filter((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front");
  const lineNodes = descendants(svg).filter((element) => element.classList.contains("front-line"));
  assert.equal(lines.length, 1);
  assert.equal(lineNodes.length, 2);
  assert.equal(lineNodes.filter((line) => line.classList.contains("is-front-exiting")).length, 1);
  assert.equal(lineNodes.filter((line) => line.classList.contains("is-front-entering")).length, 1);
  assert.equal(controller._frontTransitionTimers.size, 1);
});

test("map reprojection settles a frontline crossfade before projecting the target", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  controller.renderAt(1000, { mode: "playback" });
  const target = descendants(svg).find((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front");
  const before = target.getAttribute("d");

  maps[0].projectionOffset = 25;
  maps[0].fire("move");

  const geometry = descendants(svg).filter((element) =>
    element.classList.contains("front-line") || element.classList.contains("front-control-area"));
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(geometry.some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting")), false);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front"), false);
  assert.notEqual(target.getAttribute("d"), before);
});

test("frontline seek replaces topology immediately and backward seek is deterministic", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.seek(1000);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front"), false);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front"), true);
  assert.equal(descendants(svg).some((element) =>
    element.classList.contains("is-front-entering") || element.classList.contains("is-front-exiting")), false);
  assert.equal(controller._frontTransitionTimers.size, 0);

  controller.seek(500);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front"), true);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front"), false);
  assert.equal(controller._frontTransitionTimers.size, 0);
});

test("reduced motion replaces incompatible frontlines without a timeout", () => {
  const clock = new FrameClock(true);
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");

  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });

  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:main_front"), false);
  assert.equal(descendants(svg).some((element) =>
    element.getAttribute("data-frontline-key") === "line:split_front"), true);
  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.equal(clock.timeouts.size, 1);
});

test("disabling frontlines clears an active topology transition", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(topologyChangeBattleFixture(), document);

  controller.renderAt(900, { mode: "playback" });
  controller.renderAt(1000, { mode: "playback" });
  const timer = [...controller._frontTransitionTimers.values()][0];
  controller.setFrontsEnabled(false);

  assert.equal(controller._frontTransitionTimers.size, 0);
  assert.ok(clock.clearedTimeouts.includes(timer));
});

test("destroy and document replacement clear active frontline transition timers", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const first = renderBattle(topologyChangeBattleFixture(), document);
  first.renderAt(900, { mode: "playback" });
  first.renderAt(1000, { mode: "playback" });
  const firstTimer = [...first._frontTransitionTimers.values()][0];

  const second = renderBattle(topologyChangeBattleFixture(), document);

  assert.equal(first._frontTransitionTimers.size, 0);
  assert.ok(clock.clearedTimeouts.includes(firstTimer));
  second.renderAt(900, { mode: "playback" });
  second.renderAt(1000, { mode: "playback" });
  const secondTimer = [...second._frontTransitionTimers.values()][0];
  second.destroy();
  assert.equal(second._frontTransitionTimers.size, 0);
  assert.ok(clock.clearedTimeouts.includes(secondTimer));
});

test("frontline SVG paths keep adjacent dateline coordinates on one world copy", () => {
  const battle = frontlineBattleFixture();
  for (const snapshot of battle.frontline_snapshots) {
    snapshot.front_lines[0].geometry.coordinates = [[179, 0], [-179, 0]];
  }
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const line = descendants(svg).find((element) => element.getAttribute("data-frontline-key") === "line:main_front");
  const xCoordinates = [...line.getAttribute("d").matchAll(/[ML] (-?\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]));
  const largestJump = Math.max(...xCoordinates.slice(1)
    .map((x, index) => Math.abs(x - xCoordinates[index])));

  assert.ok(largestJump < 10, `projected frontline jumped ${largestJump}px across world copies`);
});

test("frontline availability resets and is recomputed for replacement documents", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const first = renderBattle(frontlineBattleFixture(), document);
  first.setFrontsEnabled(false);
  const second = renderBattle(frontlineBattleFixture(), document);
  assert.equal(second.frontsEnabled, true);

  const third = renderBattle(battleFixture(), document);
  const button = document.getElementById("fronts-button");
  assert.equal(third.frontsEnabled, false);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Fronts: hybrid");
});

test("battle UI enables focus only when a current plan has coordinates and reset disables it", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();

  const controller = setBattleDocument(battleFixture(), { documentRef: document });
  assert.equal(document.getElementById("modern-borders-button").disabled, false);
  assert.equal(document.getElementById("focus-event-button").disabled, false);

  const borders = document.getElementById("modern-borders-button");
  borders.textContent = "Modern borders: on";
  borders.setAttribute("aria-pressed", "true");
  document.getElementById("focus-event-button").disabled = false;
  resetBattleUI(document);

  assert.equal(controller._destroyed, true);
  assert.equal(borders.disabled, true);
  assert.equal(borders.textContent, "Modern borders: off");
  assert.equal(borders.getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("focus-event-button").disabled, true);
});

test("focus uses a matching camera hint without changing renderer state", async () => {
  const battle = battleFixture();
  battle.animation_hints.camera = [{ event_id: "opening", center: [121, 25], zoom: 9 }];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = setBattleDocument(battle, { documentRef: document });
  controller.seek(500);
  controller.setFollowEnabled(false);
  controller.setTrailsEnabled(true);
  await controller.setModernBordersEnabled(true);
  controller.play();
  const before = {
    isPlaying: controller.isPlaying,
    time: controller.currentPresentationMs,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    borders: controller.modernBordersEnabled,
    index: controller.currentIndex,
    positions: [...controller.sampledState.actorPositions].map(([id, point]) => [id, [...point]]),
  };

  assert.equal(controller.focusActiveEvents(), true);

  assert.deepEqual(maps[0].pointFlyCalls.at(-1), {
    point: [25, 121],
    zoom: 9,
    options: { duration: 0.9, animate: true },
  });
  assert.deepEqual({
    isPlaying: controller.isPlaying,
    time: controller.currentPresentationMs,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    borders: controller.modernBordersEnabled,
    index: controller.currentIndex,
    positions: [...controller.sampledState.actorPositions].map(([id, point]) => [id, [...point]]),
  }, before);
});

test("focus fits simultaneous event, actor, movement, and engagement points", () => {
  const battle = battleFixture();
  battle.historical_events[0].time.end = "2020-01-01T00:00:02Z";
  battle.historical_events[1].time.start = "2020-01-01T00:00:00Z";
  battle.historical_events[0].target_actor_ids = [];
  battle.historical_events[1].actor_ids = ["bravo"];
  battle.actors.push(
    { id: "mover", name: "Mover", kind: "division", side_id: "blue", commander_ids: [] },
    { id: "gunner", name: "Gunner", kind: "division", side_id: "blue", commander_ids: [] },
    { id: "target", name: "Target", kind: "division", side_id: "red", commander_ids: [] },
  );
  const timed = (label, start, end) => ({ label, start, end, precision: "exact", confidence: 1 });
  battle.movements.push(
    {
      id: "mover_active", event_id: "opening", actor_id: "mover",
      time: timed("move", "2020-01-01T00:00:00Z", "2020-01-01T00:00:02Z"),
      path: { type: "LineString", coordinates: [[3, 3], [30, 30]] },
      precision: "exact", confidence: 1,
    },
    {
      id: "gunner_position", event_id: "opening", actor_id: "gunner",
      time: timed("position", "2019-12-31T23:59:59Z", "2020-01-01T00:00:00Z"),
      path: { type: "LineString", coordinates: [[4, 4], [4, 4]] },
      precision: "exact", confidence: 1,
    },
    {
      id: "target_position", event_id: "opening", actor_id: "target",
      time: timed("position", "2019-12-31T23:59:59Z", "2020-01-01T00:00:00Z"),
      path: { type: "LineString", coordinates: [[5, 5], [5, 5]] },
      precision: "exact", confidence: 1,
    },
  );
  battle.engagements[0].attacker_actor_id = "gunner";
  battle.engagements[0].target_actor_id = "target";
  battle.engagements[0].result_actor_id = "target";
  battle.engagements[0].time.end = "2020-01-01T00:00:02Z";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  controller.seek(2000);
  maps[0].fire("moveend");

  assert.equal(controller.focusActiveEvents(), true);

  const call = maps[0].flyCalls.at(-1);
  assert.equal(call.bounds.padRatio, 0.3);
  assert.equal(call.options.maxZoom, 10);
  assert.equal(call.options.duration, 0.9);
  assert.equal(call.options.animate, true);
  assert.deepEqual(call.bounds.points, [
    [0, 0], [0, 2], [0, 1], [1, 0], [16.5, 16.5], [4, 4], [5, 5], [3, 3], [30, 30],
  ]);
});

test("focus falls back to the currently selected event between active windows", () => {
  const battle = battleFixture();
  battle.historical_events[0].time.end = "2020-01-01T00:00:00.500Z";
  battle.historical_events[1].time.start = "2020-01-01T00:00:01.500Z";
  for (const event of battle.historical_events) {
    event.actor_ids = [];
    event.target_actor_ids = [];
  }
  battle.movements = [];
  battle.engagements = [];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  controller.seek(1000);

  assert.equal(controller.sampledState.activeEventIds.size, 0);
  assert.equal(controller.currentIndex, 0);
  assert.equal(controller.focusActiveEvents(), true);
  assert.deepEqual(maps[0].pointFlyCalls.at(-1), {
    point: [0, 0],
    zoom: 8,
    options: { duration: 0.9, animate: true },
  });
});

test("focus is disabled and does not move when no current coordinates exist", () => {
  const battle = battleFixture();
  for (const event of battle.historical_events) {
    event.actor_ids = [];
    event.target_actor_ids = [];
    event.place_ids = [];
  }
  battle.movements = [];
  battle.engagements = [];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = setBattleDocument(battle, { documentRef: document });
  const before = {
    fly: maps[0].flyCalls.length,
    point: maps[0].pointFlyCalls.length,
    fit: maps[0].fitBoundsCalls.length,
    view: maps[0].setViewCalls.length,
  };

  assert.equal(document.getElementById("focus-event-button").disabled, true);
  assert.equal(controller.focusActiveEvents(), false);
  assert.deepEqual({
    fly: maps[0].flyCalls.length,
    point: maps[0].pointFlyCalls.length,
    fit: maps[0].fitBoundsCalls.length,
    view: maps[0].setViewCalls.length,
  }, before);
});

test("reduced motion focuses with setView instead of a flight", () => {
  const battle = battleFixture();
  battle.animation_hints.camera = [{ event_id: "opening", center: [121, 25], zoom: 9 }];
  const clock = new FrameClock(true);
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const beforeSetViews = maps[0].setViewCalls.length;

  assert.equal(controller.focusActiveEvents(), true);
  assert.equal(maps[0].pointFlyCalls.length, 0);
  assert.equal(maps[0].flyCalls.length, 0);
  assert.deepEqual(maps[0].setViewCalls.slice(beforeSetViews), [{
    center: [25, 121],
    zoom: 9,
    options: { animate: false },
  }]);

  maps[0].fire("moveend");
  controller.seek(1000);
  assert.equal(controller.focusActiveEvents(), true);
  assert.equal(maps[0].flyCalls.length, 0);
  assert.equal(maps[0].pointFlyCalls.length, 0);
  assert.equal(maps[0].fitBoundsCalls.at(-1).bounds.padRatio, 0.3);
  assert.deepEqual(maps[0].fitBoundsCalls.at(-1).options, {
    maxZoom: 10,
    animate: false,
  });
});

test("focus zoom preserves Follow, dragging overrides it, and camera errors restore the flag", () => {
  const { controller, maps } = setup();
  const map = maps[0];
  controller.setFollowEnabled(true);

  assert.equal(controller.focusActiveEvents(), true);
  map.fire("zoomstart");
  assert.equal(controller.followEnabled, true);
  map.fire("dragstart");
  assert.equal(controller.followEnabled, false);
  map.fire("moveend");
  assert.equal(controller._programmaticMove, false);

  controller.setFollowEnabled(true);
  map.flyToBounds = () => { throw new Error("camera failed"); };
  assert.throws(() => controller.focusActiveEvents(), /camera failed/);
  assert.equal(controller._programmaticMove, false);
  assert.equal(controller.followEnabled, true);
});

test("focus is safe without a sample and after destroy", () => {
  const { controller, document, maps } = setup();
  const map = maps[0];
  controller.sampledState = null;
  assert.equal(controller.focusActiveEvents(), false);
  controller.renderAt(0);
  controller.destroy();
  const moves = map.flyCalls.length + map.pointFlyCalls.length
    + map.fitBoundsCalls.length + map.setViewCalls.length;

  assert.equal(document.getElementById("focus-event-button").disabled, true);
  assert.equal(controller.focusActiveEvents(), false);
  assert.equal(
    map.flyCalls.length + map.pointFlyCalls.length + map.fitBoundsCalls.length + map.setViewCalls.length,
    moves,
  );
});

test("render replacement recalculates the native Focus disabled state", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battleFixture(), document);
  assert.equal(document.getElementById("focus-event-button").disabled, false);

  const empty = battleFixture();
  for (const event of empty.historical_events) {
    event.actor_ids = [];
    event.target_actor_ids = [];
    event.place_ids = [];
  }
  empty.movements = [];
  empty.engagements = [];
  renderBattle(empty, document);
  assert.equal(document.getElementById("focus-event-button").disabled, true);

  renderBattle(battleFixture(), document);
  assert.equal(document.getElementById("focus-event-button").disabled, false);
});

test("modern borders default off and use the dedicated pane and exact noninteractive style", async () => {
  const { controller, document, maps } = setup();
  const pane = maps[0].getPane("modernBordersPane");
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const overlayZIndex = Number(css.match(/\.battle-overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);

  assert.equal(controller.modernBordersEnabled, false);
  assert.equal(controller._modernBordersLayer, null);
  assert.equal(controller._modernBordersPromise, null);
  assert.equal(document.getElementById("modern-borders-button").getAttribute("aria-pressed"), "false");
  assert.equal(pane.style.zIndex, "350");
  assert.equal(pane.style.pointerEvents, "none");
  assert.equal(Number.isFinite(overlayZIndex), true);
  assert.equal(overlayZIndex > Number(pane.style.zIndex), true);

  await controller.setModernBordersEnabled(true);
  assert.equal(maps.fetchCalls.length, 1);
  assert.equal(maps.fetchCalls[0][0], "./data/modern-borders-50m.geojson");
  assert.equal(maps.geoJSONCalls.length, 1);
  assert.deepEqual(maps.geoJSONCalls[0].options, {
    pane: "modernBordersPane",
    style: {
      color: "#59636b",
      weight: 1,
      opacity: 0.55,
      fill: false,
      interactive: false,
    },
  });
  assert.equal(maps[0].hasLayer(maps.geoJSONCalls[0]), true);
});

test("modern borders lazily load once, reuse one layer, and preserve playback state", async () => {
  const { controller, document, maps } = setup();
  controller.seek(500);
  controller.setFollowEnabled(false);
  controller.setTrailsEnabled(true);
  controller.play();
  const before = {
    time: controller.currentPresentationMs,
    playing: controller.isPlaying,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    sampled: controller.sampledState,
    flyCalls: maps[0].flyCalls.length,
    pointFlyCalls: maps[0].pointFlyCalls.length,
  };

  await controller.setModernBordersEnabled(true);
  const layer = controller._modernBordersLayer;
  await controller.setModernBordersEnabled(false);
  await controller.setModernBordersEnabled(true);

  assert.equal(maps.fetchCalls.length, 1);
  assert.equal(maps.geoJSONCalls.length, 1);
  assert.equal(controller._modernBordersLayer, layer);
  assert.equal(maps[0].hasLayer(layer), true);
  assert.equal(controller.modernBordersEnabled, true);
  assert.equal(document.getElementById("modern-borders-button").textContent, "Modern borders: on");
  assert.deepEqual({
    time: controller.currentPresentationMs,
    playing: controller.isPlaying,
    follow: controller.followEnabled,
    trails: controller.trailsEnabled,
    sampled: controller.sampledState,
    flyCalls: maps[0].flyCalls.length,
    pointFlyCalls: maps[0].pointFlyCalls.length,
  }, before);
});

test("pending modern borders load obeys the latest off request", async () => {
  const pending = deferred();
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet(() => pending.promise);
  const controller = renderBattle(battleFixture(), document);

  const turningOn = controller.setModernBordersEnabled(true);
  await controller.setModernBordersEnabled(false);
  pending.resolve({ ok: true, json: async () => ({ type: "FeatureCollection", features: [] }) });
  await turningOn;

  assert.equal(controller.modernBordersEnabled, false);
  assert.equal(document.getElementById("modern-borders-button").getAttribute("aria-pressed"), "false");
  assert.equal(maps[0].layers.size, 0);
});

test("modern borders failure stays off, warns without destroying playback, and can retry", async () => {
  let attempts = 0;
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
    return Promise.resolve({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [] }),
    });
  });
  const controller = setBattleDocument(battleFixtureWithWarning(), { documentRef: document });
  controller.play();

  await controller.setModernBordersEnabled(true);
  const warning = document.getElementById("validation-warnings");
  assert.equal(controller.modernBordersEnabled, false);
  assert.equal(controller._modernBordersPromise, null);
  assert.equal(controller._destroyed, false);
  assert.equal(controller.isPlaying, true);
  assert.equal(warning.hidden, false);
  assert.equal(warning.children[0].textContent, "Warnings (2)");
  assert.match(warning.children[1].children[0].textContent, /unknown actor icon token/);
  assert.match(warning.children[1].children[1].textContent, /network down/);

  await controller.setModernBordersEnabled(true);
  assert.equal(attempts, 2);
  assert.equal(controller.modernBordersEnabled, true);
  assert.equal(maps[0].layers.size, 1);
  assert.equal(warning.children[0].textContent, "JSON validation warnings (1)");
  assert.equal(warning.children[1].children.length, 1);
  assert.match(warning.children[1].children[0].textContent, /unknown actor icon token/);
});

test("a map-only failure keeps the map layer warning title", async () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet(async () => { throw new Error("network down"); });
  const controller = setBattleDocument(battleFixture(), { documentRef: document });
  const warning = document.getElementById("validation-warnings");

  await controller.setModernBordersEnabled(true);

  assert.equal(warning.children[0].textContent, "Map layer warning (1)");
  assert.match(warning.children[1].children[0].textContent, /network down/);
});

test("turning borders off clears only the map warning", async () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet(async () => { throw new Error("network down"); });
  const controller = setBattleDocument(battleFixtureWithWarning(), { documentRef: document });
  const warning = document.getElementById("validation-warnings");

  await controller.setModernBordersEnabled(true);
  await controller.setModernBordersEnabled(false);

  assert.equal(warning.children[0].textContent, "JSON validation warnings (1)");
  assert.equal(warning.children[1].children.length, 1);
  assert.match(warning.children[1].children[0].textContent, /unknown actor icon token/);
});

test("late border failure after off does not add a map warning", async () => {
  const pending = deferred();
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet(() => pending.promise);
  const controller = setBattleDocument(battleFixtureWithWarning(), { documentRef: document });

  const turningOn = controller.setModernBordersEnabled(true);
  await controller.setModernBordersEnabled(false);
  pending.reject(new Error("late failure"));
  await turningOn;

  const warning = document.getElementById("validation-warnings");
  assert.equal(warning.children[0].textContent, "JSON validation warnings (1)");
  assert.equal(warning.children[1].children.length, 1);
  assert.match(warning.children[1].children[0].textContent, /unknown actor icon token/);
  assert.doesNotMatch(warning.children[1].children[0].textContent, /late failure/);
});

test("destroy removes loaded borders and a late load cannot re-add them", async () => {
  const loaded = setup();
  await loaded.controller.setModernBordersEnabled(true);
  const layer = loaded.controller._modernBordersLayer;
  loaded.controller.destroy();
  assert.equal(loaded.maps[0].hasLayer(layer), false);

  const pending = deferred();
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet(() => pending.promise);
  const controller = renderBattle(battleFixture(), document);
  const turningOn = controller.setModernBordersEnabled(true);
  controller.destroy();
  pending.resolve({ ok: true, json: async () => ({ type: "FeatureCollection", features: [] }) });
  await turningOn;

  assert.equal(maps[0].layers.size, 0);
  assert.equal(controller.modernBordersEnabled, false);
});

test("replacement render resets modern borders off", async () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const first = renderBattle(battleFixture(), document);
  await first.setModernBordersEnabled(true);

  const second = renderBattle(battleFixture(), document);

  assert.equal(first._destroyed, true);
  assert.equal(second.modernBordersEnabled, false);
  assert.equal(document.getElementById("modern-borders-button").textContent, "Modern borders: off");
  assert.equal(document.getElementById("modern-borders-button").getAttribute("aria-pressed"), "false");
  assert.equal(maps[0].layers.size, 0);
});

test("setSpeed updates exactly one selected control without jumping time", () => {
  const { controller, document } = setup();
  controller.seek(400);
  controller.setSpeed(2);

  assert.equal(controller.currentPresentationMs, 400);
  assert.equal(controller.playbackRate, 2);
  const buttons = document.querySelectorAll("#speed-controls [data-speed]");
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-pressed")), ["false", "false", "true", "false"]);
});

test("event cards retain for three seconds, expire non-current cards, and recur without frame duplicates", () => {
  const { clock, controller, document } = setup();
  const stack = document.getElementById("event-card-stack");
  assert.equal(stack.children.length, 1);

  controller.seek(200);
  assert.equal(stack.children.length, 1);
  clock.now = 100;
  controller.seek(1200);
  assert.equal(stack.children.length, 2);
  controller.play();
  stack.children.at(-1).dispatch("pointerenter");
  assert.equal(controller.isPlaying, false);

  clock.now = 2999;
  controller.seek(1200);
  assert.equal(stack.children.length, 2);
  clock.now = 3000;
  controller.seek(1200);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.children[0].dataset.eventId, "finish");
  clock.now = 4000;
  controller.seek(1200);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.children[0].dataset.eventId, "finish");

  controller.seek(200);
  assert.equal(stack.children.length, 1);
  controller.seek(200);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.children.at(-1).children.some((child) => child.textContent === "Opening"), true);
});

test("event card stack caps at three and keeps the current card", () => {
  const battle = battleFixture();
  const timed = (label, start, end) => ({ label, start, end, precision: "exact", confidence: 1 });
  battle.historical_events.push(
    { id: "third", title: "Third", type: "defend", time: timed("third", "2020-01-01T00:00:02Z", "2020-01-01T00:00:03Z"), actor_ids: ["alpha"], target_actor_ids: [], place_ids: ["east"], source_ids: [], precision: "exact", confidence: 1 },
    { id: "fourth", title: "Fourth", type: "capture", time: timed("fourth", "2020-01-01T00:00:03Z", "2020-01-01T00:00:04Z"), actor_ids: ["alpha"], target_actor_ids: [], place_ids: ["east"], source_ids: [], precision: "exact", confidence: 1 },
  );
  battle.animation_hints.timeline.ordered_event_ids.push("third", "fourth");
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const stack = document.getElementById("event-card-stack");
  clock.now = 100;
  controller.seek(1200);
  clock.now = 200;
  controller.seek(2200);
  clock.now = 300;
  controller.seek(3200);

  assert.equal(stack.children.length, 3);
  assert.deepEqual(stack.children.map((card) => card.dataset.eventId), ["finish", "third", "fourth"]);
  assert.equal(stack.children.at(-1).dataset.eventId, "fourth");
});

test("overlapping active events each create cards and the latest event is current", () => {
  const battle = battleFixture();
  battle.historical_events[0].time.end = "2020-01-01T00:00:03Z";
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const stack = document.getElementById("event-card-stack");
  assert.deepEqual(stack.children.map((card) => card.dataset.eventId), ["opening"]);

  controller.seek(1200);
  assert.equal(controller.currentIndex, 1);
  assert.deepEqual(stack.children.map((card) => card.dataset.eventId), ["opening", "finish"]);
  controller.seek(1300);
  assert.equal(stack.children.length, 2);
  controller.seek(2500);
  controller.seek(1200);
  assert.deepEqual(stack.children.map((card) => card.dataset.eventId), ["opening", "finish", "finish"]);
});

test("event cards consume keyboard pause events before document shortcuts can re-toggle", () => {
  const { controller, document } = setup();
  const card = document.getElementById("event-card-stack").children[0];
  assert.equal(card.getAttribute("role"), "button");
  assert.equal(card.getAttribute("tabindex"), "0");
  assert.match(card.getAttribute("aria-label"), /pause/i);

  for (const key of ["Enter", " "]) {
    let prevented = false;
    let stopped = false;
    const event = {
      key,
      target: card,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    };
    controller.play();
    card.dispatch("keydown", event);
    if (!stopped) document.dispatch("keydown", event);
    assert.equal(controller.isPlaying, false);
    assert.equal(document.getElementById("play-button").textContent, "Play");
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  }

  let documentPrevented = false;
  document.dispatch("keydown", {
    key: " ",
    target: new FakeElement("div"),
    preventDefault() { documentPrevented = true; },
  });
  assert.equal(controller.isPlaying, true);
  assert.equal(documentPrevented, true);
  controller.pause();
});

test("compression notice is deterministic and synthetic clocks never fabricate epoch dates", () => {
  const battle = battleFixture();
  battle.historical_events[1].time = {
    label: "later", start: "2020-01-01T01:00:00Z", end: "2020-01-01T01:00:01Z", precision: "exact", confidence: 1,
  };
  battle.movements[1].time = battle.historical_events[1].time;
  battle.movements[1].waypoint_times = ["2020-01-01T01:00:00Z", "2020-01-01T01:00:01Z"];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(battle, document);
  const gap = controller.compiled.compressedGaps[0];
  controller.seek(gap.presentationStartMs + 100);
  assert.equal(document.getElementById("compression-notice").hidden, false);
  assert.match(document.getElementById("compression-notice").textContent, /^Compressed \d+ min inactive interval$/);
  controller.seek(0);
  assert.equal(document.getElementById("compression-notice").hidden, true);

  const syntheticBattle = battleFixture();
  for (const event of syntheticBattle.historical_events) event.time = { label: "unknown", precision: "unknown", confidence: 0.5 };
  for (const movement of syntheticBattle.movements) delete movement.time;
  const syntheticDocument = new FakeDocument(clock.window);
  const syntheticController = renderBattle(syntheticBattle, syntheticDocument);
  syntheticController.seek(1000);
  assert.equal(syntheticDocument.getElementById("historical-time").textContent, "Animation time 00:01");
});

test("date-only legacy playback uses the animation clock while moving continuously", () => {
  const legacyBattle = battleFixture();
  legacyBattle.schema_version = "0.1.0";
  for (const event of legacyBattle.historical_events) {
    event.time = { label: "1 January 2020", start: "2020-01-01", precision: "day", confidence: 0.7 };
  }
  for (const movement of legacyBattle.movements) delete movement.time;
  legacyBattle.engagements = [];
  legacyBattle.animation_hints.timeline = {
    default_event_duration_ms: 1_000,
    historical_seconds_per_playback_second: 1,
    ordered_event_ids: ["opening", "finish"],
  };
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(legacyBattle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const alpha = descendants(svg).find((element) => element.getAttribute("data-actor-id") === "alpha");
  const initialTransform = alpha.getAttribute("transform");

  controller.seek(500);
  assert.notEqual(alpha.getAttribute("transform"), initialTransform);
  controller.seek(1_000);
  assert.equal(document.getElementById("historical-time").textContent, "Animation time 00:01");
});

test("follow uses wall-clock throttling and manual map interaction suspends it", () => {
  const battle = battleFixture();
  battle.movements[0].path.coordinates = [[0, 0], [8, 0]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const map = maps[0];

  clock.now = 500;
  controller.seek(900);
  assert.equal(map.flyCalls.length, 1);
  assert.equal(map.flyCalls[0].bounds.padRatio, 0.35);
  assert.equal(map.flyCalls[0].options.maxZoom, map.getZoom());
  assert.ok(map.flyCalls[0].options.duration >= 0.8 && map.flyCalls[0].options.duration <= 2.4);
  assert.equal(controller._programmaticMove, true);
  map.fire("moveend");
  controller.seek(1000);
  controller.seek(600);
  assert.equal(map.flyCalls.length, 1);
  clock.now = 999;
  controller.seek(900);
  assert.equal(map.flyCalls.length, 1);
  clock.now = 1000;
  controller.seek(900);
  assert.equal(map.flyCalls.length, 2);
  map.fire("moveend");
  assert.equal(controller._programmaticMove, false);
  map.fire("dragstart");
  assert.equal(controller.followEnabled, false);
  assert.equal(document.getElementById("follow-button").textContent, "Follow: off");
});

test("single-point follow preserves zoom and reduced motion disables camera animation", () => {
  const battle = battleFixture();
  battle.actors = [battle.actors[0]];
  battle.historical_events[0].target_actor_ids = [];
  battle.historical_events[1].target_actor_ids = [];
  battle.movements = battle.movements.filter(({ actor_id }) => actor_id === "alpha");
  battle.movements[0].path.coordinates = [[0, 0], [8, 0]];
  battle.engagements = [];
  const clock = new FrameClock(true);
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  clock.now = 500;
  controller.seek(900);

  assert.equal(maps[0].flyCalls.length, 0);
  assert.equal(maps[0].pointFlyCalls.length, 1);
  assert.equal(maps[0].pointFlyCalls[0].zoom, maps[0].getZoom());
  assert.equal(maps[0].pointFlyCalls[0].options.animate, false);
  assert.equal(maps[0].pointFlyCalls[0].options.duration, 0);
  const firstTimelineButton = document.querySelectorAll("#timeline button")[0];
  assert.equal(firstTimelineButton.scrollOptions.behavior, "auto");
});

test("zoom hierarchy exposes near, middle, and far SVG classes", () => {
  const { controller, svg, maps } = setup();
  const map = maps[0];
  map.zoom = 11;
  map.fire("zoomend");
  assert.equal(svg.classList.contains("labels-near"), true);
  map.zoom = 9;
  map.fire("zoomend");
  assert.equal(svg.classList.contains("labels-middle"), true);
  map.zoom = 7;
  map.fire("zoomend");
  assert.equal(svg.classList.contains("labels-far"), true);
  controller.destroy();
});

test("near-zoom clustered units suppress secondary labels and restore them when separated or zoomed out", () => {
  const battle = battleFixture();
  battle.movements[2].path.coordinates = [[0.05, 0], [0.05, 0]];
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const controller = renderBattle(battle, document);
  const svg = document.getElementById("battle-map").children.find((child) => child.tagName === "SVG");
  const subLabels = descendants(svg).filter((element) => element.classList.contains("unit-sub-label"));
  const map = maps[0];

  map.zoom = 11;
  map.fire("zoomend");
  controller.seek(0);
  assert.equal(subLabels.filter((label) => label.classList.contains("is-collision-hidden")).length, 1);

  controller.seek(1_500);
  assert.equal(subLabels.some((label) => label.classList.contains("is-collision-hidden")), false);

  controller.seek(0);
  map.zoom = 9;
  map.fire("zoomend");
  assert.equal(subLabels.some((label) => label.classList.contains("is-collision-hidden")), false);
  controller.destroy();
});

test("rapid render replacement cancels stale invalidateSize timeouts", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const first = renderBattle(battleFixture(), document);
  first.renderAt(1100, { mode: "playback" });
  assert.equal(first._beaconExitTimers.size, 1);
  const second = renderBattle(battleFixture(), document);

  assert.equal(first._destroyed, true);
  assert.equal(first._beaconEls.size, 0);
  assert.equal(first._beaconExitTimers.size, 0);
  assert.ok(clock.clearedTimeouts.includes(0));
  clock.flushTimeouts();
  assert.equal(maps[0].invalidateCount, 0);
  assert.equal(maps[1].invalidateCount, 1);
  second.destroy();
});

test("inferred path dashes use normalized pathLength fractions without overriding reveal offset", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.movement-path\.is-inferred\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";

  assert.match(rule, /stroke-dasharray:\s*0\.04\s+0\.025/);
  assert.doesNotMatch(rule, /stroke-dashoffset/);
});

test("pulse beacon CSS uses the paper token and exact pulse geometry", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const diamond = css.match(/\.event-beacon-diamond\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const labels = css.match(/\.event-beacon-icon,\s*\.event-beacon-count\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const pulse = css.match(/\.event-beacon-pulse\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";

  assert.match(diamond, /fill:\s*var\(--accent\)/);
  assert.match(diamond, /stroke:\s*var\(--paper\)/);
  assert.match(labels, /fill:\s*var\(--paper\)/);
  assert.match(labels, /font-weight:\s*800/);
  assert.match(pulse, /transform-box:\s*fill-box/);
});

test("reduced-motion CSS disables beacon pulse animation and overlay transitions", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const media = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || "";

  assert.match(media, /\.event-beacon-pulse[\s\S]*animation:\s*none\s*!important/);
  assert.match(media, /\.event-beacon[\s\S]*transition:\s*none\s*!important/);
  assert.match(media, /\.movement-path[\s\S]*transition:\s*none\s*!important/);
  assert.match(media, /\.front-line[\s\S]*animation:\s*none\s*!important/);
});

test("frontline topology CSS crossfades entering and exiting geometry for 500ms", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.front-line\.is-front-entering,[\s\S]*animation:\s*front-fade-in 500ms ease-out both/);
  assert.match(css, /\.front-line\.is-front-exiting,[\s\S]*animation:\s*front-fade-out 500ms ease-in both/);
  assert.match(css, /@keyframes front-fade-in/);
  assert.match(css, /@keyframes front-fade-out/);
});

test("frontline enclosure CSS reveals normalized masks and delays source-opacity areas", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const media = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || "";

  assert.match(css, /\.front-line\.is-enclosure-exiting\s*\{[\s\S]*animation:\s*front-fade-out 350ms ease-in both/);
  assert.match(css, /\.front-enclosure-mask-path\s*\{[\s\S]*stroke-dasharray:\s*1;[\s\S]*stroke-dashoffset:\s*1;[\s\S]*animation:\s*front-enclosure-reveal 900ms ease-out both/);
  assert.match(css, /\.front-control-area\.is-enclosure-area-entering\s*\{[\s\S]*animation:\s*front-fade-in 360ms ease-out 540ms both/);
  assert.match(media, /\.front-enclosure-mask-path[\s\S]*animation:\s*none\s*!important/);
});

test("destroy is idempotent and cancels frames and listeners exactly once", () => {
  const { clock, controller, document, maps } = setup();
  controller.play();
  const frame = controller._frame;
  controller.destroy();
  controller.destroy();

  assert.ok(clock.cancelled.includes(frame));
  assert.equal(document.listeners.get("keydown")?.size ?? 0, 0);
  assert.equal(maps[0].offCount, 1);
  assert.equal(maps[0].removeCount, 1);
});

test("destroy clears the public frontline inspector state", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  const controller = renderBattle(frontlineBattleFixture(), document);
  const status = document.getElementById("frontline-status");
  const summary = document.getElementById("frontline-summary");
  const details = document.getElementById("frontline-details");
  const sources = document.getElementById("frontline-sources");
  assert.equal(status.hidden, false);
  assert.notEqual(summary.textContent, "");
  assert.notEqual(details.textContent, "");
  assert.notEqual(sources.children.length, 0);

  controller.destroy();

  assert.equal(status.hidden, true);
  assert.equal(summary.textContent, "");
  assert.equal(details.textContent, "");
  assert.equal(sources.children.length, 0);
  assert.equal(controller.frontlineMode, "hybrid");
  assert.equal(document.getElementById("fronts-button").textContent, "Fronts: hybrid");
  assert.equal(document.getElementById("fronts-button").getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("fronts-button").disabled, true);
});

test("destroy tears down owned controls and timeline handlers and blocks public re-entry", () => {
  const { clock, controller, document, maps } = setup();
  wirePlaybackControls(controller, document);
  const timelineButton = document.querySelectorAll("#timeline button")[1];
  const eventCard = document.getElementById("event-card-stack").children[0];
  controller.destroy();
  const flyCount = maps[0].flyCalls.length + maps[0].pointFlyCalls.length;

  document.getElementById("play-button").dispatch("click");
  timelineButton.dispatch("click");
  controller.play();
  controller.seek(900);
  assert.equal(clock.callbacks.size, 0);
  assert.equal(maps[0].flyCalls.length + maps[0].pointFlyCalls.length, flyCount);
  assert.equal(document.getElementById("modern-borders-button").onclick, null);
  assert.equal(document.getElementById("focus-event-button").onclick, null);
  assert.equal(timelineButton.listeners.get("click")?.size ?? 0, 0);
  assert.equal(eventCard.listeners.get("keydown")?.size ?? 0, 0);
});

test("control teardown clears only handlers it owns", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const controller = {
    followEnabled: true, toggle() {}, pause() {}, seek() {}, prev() {}, next() {}, setSpeed() {}, setFollowEnabled() {},
  };
  const teardown = wirePlaybackControls(controller, document);
  const foreignHandler = () => {};
  document.getElementById("play-button").onclick = foreignHandler;
  teardown();
  assert.equal(document.getElementById("play-button").onclick, foreignHandler);
});

test("empty timelines reset progress and use a sentinel current index", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  installLeaflet();
  renderBattle(battleFixture(), document);
  const empty = battleFixture();
  empty.historical_events = [];
  empty.movements = [];
  empty.engagements = [];
  empty.animation_hints.timeline.ordered_event_ids = [];
  const controller = renderBattle(empty, document);

  assert.equal(controller.currentIndex, -1);
  assert.equal(document.getElementById("event-progress").textContent, "0 / 0");
});

test("render replacement cannot be damaged by a stale controller destroy", () => {
  const clock = new FrameClock();
  const document = new FakeDocument(clock.window);
  const maps = installLeaflet();
  const mapEl = document.getElementById("battle-map");
  const first = renderBattle(battleFixture(), document);
  const second = renderBattle(battleFixture(), document);

  assert.equal(maps[0].removeCount, 1);
  assert.equal(mapEl._battleController, second);
  first.destroy();
  assert.equal(maps[0].removeCount, 1);
  assert.equal(maps[1].removeCount, 0);
  assert.equal(mapEl._battleController, second);
});

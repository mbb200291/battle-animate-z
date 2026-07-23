import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
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

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === "class") this.classList.replaceFrom(stringValue);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
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
      "modern-borders-button", "validation-warnings", "error-banner",
    ]) {
      this.elements.set(id, new FakeElement(id === "battle-map" ? "div" : "span", id));
    }
    this.elements.get("focus-event-button").disabled = true;
    this.elements.get("modern-borders-button").textContent = "Modern borders: off";
    this.elements.get("modern-borders-button").setAttribute("aria-pressed", "false");
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
      setTimeout: (callback) => {
        const id = this.nextTimeoutId;
        this.nextTimeoutId += 1;
        this.timeouts.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        this.clearedTimeouts.push(id);
        this.timeouts.delete(id);
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
  constructor(container) {
    this.container = container;
    this.listeners = new Map();
    this.removeCount = 0;
    this.offCount = 0;
    this.zoom = 8;
    this.flyCalls = [];
    this.pointFlyCalls = [];
    this.fitBoundsCalls = [];
    this.setViewCalls = [];
    this.invalidateCount = 0;
    this.projectionOffset = 0;
    this.panes = new Map();
    this.layers = new Set();
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
    this.zoom = zoom;
    this.setViewCalls.push({ center, zoom, options });
    return this;
  }
  fitBounds(bounds, options) {
    this.fitBoundsCalls.push({ bounds, options });
    return this;
  }
  invalidateSize() { this.invalidateCount += 1; }
  getZoom() { return this.zoom; }
  getSize() { return { x: this.container.clientWidth, y: this.container.clientHeight }; }
  latLngToContainerPoint([lat, lon]) {
    return { x: lon * 100 + 400 + this.projectionOffset, y: 300 - lat * 100 };
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

function installLeaflet(fetchImpl) {
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
      const map = new FakeMap(container);
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
    ["focus"],
  ]);
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
      path: { type: "LineString", coordinates: [[3, 3], [3, 3]] },
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
    [0, 0], [0, 2], [0, 1], [1, 0], [3, 3], [4, 4], [5, 5],
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
  assert.equal(warning.children[0].textContent, "Map layer warning (2)");
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
  battle.movements[2].path.coordinates = [[0.1, 0], [0.1, 0]];
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

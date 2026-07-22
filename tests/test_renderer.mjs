import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderBattle, wirePlaybackControls } from "../app/animate.js";

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
      "reset-button", "prev-button", "next-button",
    ]) {
      this.elements.set(id, new FakeElement(id === "battle-map" ? "div" : "span", id));
    }
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
    this.invalidateCount = 0;
  }

  getContainer() { return this.container; }
  setView(_center, zoom) { this.zoom = zoom; return this; }
  fitBounds() { return this; }
  invalidateSize() { this.invalidateCount += 1; }
  getZoom() { return this.zoom; }
  getSize() { return { x: this.container.clientWidth, y: this.container.clientHeight }; }
  latLngToContainerPoint([lat, lon]) { return { x: lon * 100 + 400, y: 300 - lat * 100 }; }
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

function installLeaflet() {
  const maps = [];
  globalThis.L = {
    map(container) {
      const map = new FakeMap(container);
      maps.push(map);
      return map;
    },
    tileLayer() { return { addTo() {} }; },
    latLngBounds(points) {
      return {
        points,
        padRatio: null,
        pad(ratio) { this.padRatio = ratio; return this; },
      };
    },
  };
  return maps;
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
    toggle: () => calls.push(["toggle"]),
    pause: () => calls.push(["pause"]),
    seek: (value) => calls.push(["seek", value]),
    prev: () => calls.push(["prev"]),
    next: () => calls.push(["next"]),
    setSpeed: (value) => calls.push(["speed", value]),
    setFollowEnabled(value) { calls.push(["follow", value]); this.followEnabled = value; },
    setTrailsEnabled(value) { calls.push(["trails", value]); this.trailsEnabled = value; },
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

  assert.deepEqual(calls, [
    ["toggle"],
    ["pause"], ["seek", 0],
    ["pause"], ["prev"],
    ["pause"], ["next"],
    ["pause"], ["seek", 375.5],
    ["speed", 2],
    ["follow", false],
    ["trails", true],
  ]);
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
  const second = renderBattle(battleFixture(), document);

  assert.equal(first._destroyed, true);
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

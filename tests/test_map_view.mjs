import assert from "node:assert/strict";
import test from "node:test";

import { buildFocusPlan } from "../app/map-view.js";

const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });

test("uses a matching valid camera hint for one active event", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a"]),
    eventWindows: [{
      id: "event-a",
      event: { actor_ids: ["unit-a"], place_ids: ["place-a"] },
    }],
    places: new Map([["place-a", { geometry: point(120, 24) }]]),
    actorPositions: new Map([["unit-a", [120.1, 24.1]]]),
    cameras: [{ event_id: "event-a", center: [121, 25], zoom: 9 }],
  });

  assert.deepEqual(plan, { kind: "view", center: [121, 25], zoom: 9 });
});

test("treats a non-array camera container as empty", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a"]),
    eventWindows: [{
      id: "event-a",
      event: { actor_ids: [], place_ids: ["place-a"] },
    }],
    places: new Map([["place-a", { geometry: point(120, 24) }]]),
    actorPositions: new Map(),
    cameras: {},
  });

  assert.deepEqual(plan, { kind: "view", center: [120, 24], zoom: 8 });
});

test("ignores null and malformed camera items", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a"]),
    eventWindows: [{
      id: "event-a",
      event: { actor_ids: [], place_ids: ["place-a"] },
    }],
    places: new Map([["place-a", { geometry: point(120, 24) }]]),
    actorPositions: new Map(),
    cameras: [null, [], { event_id: "event-a", center: [121, 25] }],
  });

  assert.deepEqual(plan, { kind: "view", center: [120, 24], zoom: 8 });
});

test("fits points from every simultaneously active event", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event-a", "event-b"]),
    eventWindows: [
      { id: "event-a", event: { actor_ids: ["a"], place_ids: ["pa"] } },
      { id: "event-b", event: { actor_ids: ["b"], place_ids: ["pb"] } },
    ],
    places: new Map([
      ["pa", { geometry: point(120, 24) }],
      ["pb", { geometry: point(123, 26) }],
    ]),
    actorPositions: new Map([
      ["a", [120.2, 24.2]],
      ["b", [122.8, 25.8]],
    ]),
  });

  assert.deepEqual(plan, {
    kind: "bounds",
    points: [[120, 24], [123, 26], [120.2, 24.2], [122.8, 25.8]],
    maxZoom: 10,
  });
});

test("falls back to the selected event when none are active", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(),
    selectedEventId: "selected",
    eventWindows: [{
      id: "selected",
      event: { actor_ids: [], place_ids: ["place"] },
    }],
    places: new Map([["place", { geometry: point(10, 20) }]]),
    actorPositions: new Map(),
  });

  assert.deepEqual(plan, { kind: "view", center: [10, 20], zoom: 8 });
});

test("returns none when no usable coordinates exist", () => {
  assert.deepEqual(buildFocusPlan({
    activeEventIds: new Set(),
    eventWindows: [],
    places: new Map(),
    actorPositions: new Map(),
  }), { kind: "none" });
});

test("collects valid Point, LineString, and Polygon coordinates and ignores invalid values", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event"]),
    eventWindows: [{
      id: "event",
      event: {
        actor_ids: ["valid-actor", "invalid-actor"],
        place_ids: ["point", "line", "polygon", "invalid"],
      },
    }],
    places: new Map([
      ["point", { geometry: point(1, 2) }],
      ["line", { geometry: { type: "LineString", coordinates: [[3, 4], ["x", 5], [6, 7]] } }],
      ["polygon", { geometry: { type: "Polygon", coordinates: [[[8, 9], [10, 11], [8, 9]], [[12, 13]]] } }],
      ["invalid", { geometry: { type: "LineString", coordinates: "not-an-array" } }],
    ]),
    actorPositions: new Map([
      ["valid-actor", [14, 15]],
      ["invalid-actor", [Number.NaN, 16]],
    ]),
    cameras: [{ event_id: "event", center: ["bad", 0], zoom: 7 }],
  });

  assert.deepEqual(plan, {
    kind: "bounds",
    points: [[1, 2], [3, 4], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15]],
    maxZoom: 10,
  });
});

test("includes target and extra actors after event actors", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event"]),
    eventWindows: [{
      id: "event",
      event: {
        actor_ids: ["actor"],
        target_actor_ids: ["target"],
        place_ids: [],
      },
    }],
    places: new Map(),
    actorPositions: new Map([
      ["actor", [1, 1]],
      ["target", [2, 2]],
      ["extra", [3, 3]],
    ]),
    extraActorIds: ["extra"],
  });

  assert.deepEqual(plan, {
    kind: "bounds",
    points: [[1, 1], [2, 2], [3, 3]],
    maxZoom: 10,
  });
});

test("includes valid extra points and deduplicates them with collected coordinates", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event"]),
    eventWindows: [{
      id: "event",
      event: { actor_ids: [], target_actor_ids: [], place_ids: ["place"] },
    }],
    places: new Map([["place", { geometry: point(1, 1) }]]),
    actorPositions: new Map(),
    extraPoints: [[1, 1], [2, 2], [2, 2, 3], null, [Number.NaN, 3]],
  });

  assert.deepEqual(plan, {
    kind: "bounds",
    points: [[1, 1], [2, 2]],
    maxZoom: 10,
  });
});

test("deduplicates coordinates while preserving their first collection order", () => {
  const plan = buildFocusPlan({
    activeEventIds: new Set(["event"]),
    eventWindows: [{
      id: "event",
      event: {
        actor_ids: ["actor"],
        target_actor_ids: ["target"],
        place_ids: ["line"],
      },
    }],
    places: new Map([[
      "line",
      { geometry: { type: "LineString", coordinates: [[5, 6], [7, 8], [5, 6]] } },
    ]]),
    actorPositions: new Map([
      ["actor", [7, 8]],
      ["target", [9, 10]],
      ["extra", [5, 6]],
    ]),
    extraActorIds: ["extra", "target"],
  });

  assert.deepEqual(plan, {
    kind: "bounds",
    points: [[5, 6], [7, 8], [9, 10]],
    maxZoom: 10,
  });
});

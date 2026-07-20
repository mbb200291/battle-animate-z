import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compileTimeline,
  parseBattleTime,
  sampleTimeline,
  toHistoricalTime,
  toPresentationTime,
} from "../app/timeline.js";

const iso = (minutes) => {
  const totalSeconds = Math.round(minutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const remaining = totalSeconds % 3600;
  return `1894-09-17T${String(hours).padStart(2, "0")}:${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}Z`;
};

function battle(overrides = {}) {
  return {
    places: [],
    actors: [],
    historical_events: [],
    movements: [],
    engagements: [],
    animation_hints: { timeline: {} },
    ...overrides,
  };
}

function event(id, start, end, extras = {}) {
  const time = {};
  if (start !== undefined) time.start = start;
  if (end !== undefined) time.end = end;
  return { id, actor_ids: [], place_ids: [], time, ...extras };
}

function movement(id, actorId, eventId, coordinates, start, end, extras = {}) {
  const value = { id, actor_id: actorId, event_id: eventId, path: { type: "LineString", coordinates }, ...extras };
  if (start !== undefined || end !== undefined) {
    value.time = {};
    if (start !== undefined) value.time.start = start;
    if (end !== undefined) value.time.end = end;
  }
  return value;
}

test("parseBattleTime treats offset-free battle time as UTC-like", () => {
  assert.equal(parseBattleTime("1894-09-17T12:34:56.250"), Date.UTC(1894, 8, 17, 12, 34, 56, 250));
});

test("parseBattleTime applies explicit offsets", () => {
  assert.equal(parseBattleTime("1894-09-17T12:30+08:00"), Date.UTC(1894, 8, 17, 4, 30));
  assert.equal(parseBattleTime("1894-09-17T12:30:15-02:30"), Date.UTC(1894, 8, 17, 15, 0, 15));
});

test("parseBattleTime supports reduced year and month precision", () => {
  assert.equal(parseBattleTime("1894"), Date.UTC(1894, 0, 1));
  assert.equal(parseBattleTime("1894-09"), Date.UTC(1894, 8, 1));
});

test("parseBattleTime rejects non-grammar strings and invalid dates", () => {
  for (const value of ["1894/09/17", "18940917", "1894-W37", "1894-02-29", "1894-13", "1894-09-17 12:00", "1894-09-17T24:00", 1894, null]) {
    assert.equal(parseBattleTime(value), null, String(value));
  }
});

test("parseBattleTime truncates one through nine fractional digits to Python microseconds", () => {
  const base = Date.UTC(2000, 0, 1);
  const digits = "123456789";
  for (let length = 1; length <= digits.length; length += 1) {
    const fraction = digits.slice(0, length);
    const microseconds = Number(fraction.slice(0, 6).padEnd(6, "0"));
    assert.equal(parseBattleTime(`2000-01-01T00:00:00.${fraction}Z`), base + microseconds / 1000);
  }
});

test("uniform path sampling uses cumulative projected distance", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[120, 30], [121, 30], [123, 30]], iso(0), iso(10))],
  }));

  assert.deepEqual(sampleTimeline(timeline, timeline.presentationDurationMs / 2).actorPositions.get("a"), [121.5, 30]);
});

test("northbound movement heading is negative pi over two", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[120, 30], [120, 31]], iso(0), iso(10))],
  }));

  assert.equal(sampleTimeline(timeline, timeline.presentationDurationMs / 2).headings.get("a"), -Math.PI / 2);
});

test("waypoint times control piecewise movement timing exactly", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [10, 0], [20, 0]], iso(0), iso(10), {
      waypoint_times: [iso(0), iso(8), iso(10)],
    })],
  }));

  assert.deepEqual(sampleTimeline(timeline, toPresentationTime(timeline, parseBattleTime(iso(8)))).actorPositions.get("a"), [10, 0]);
});

test("ordered event ids come first and unlisted events retain source order", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("a"), event("b"), event("c")],
    animation_hints: { timeline: { ordered_event_ids: ["c", "missing", "a"] } },
  }));

  assert.deepEqual(timeline.eventWindows.map(({ id }) => id), ["c", "a", "b"]);
});

test("movement timing prefers its endpoints, then linked event, then legacy duration", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }, { id: "b" }, { id: "c" }],
    historical_events: [event("e", iso(5), iso(15))],
    movements: [
      movement("own", "a", "e", [[0, 0], [1, 0]], iso(7), iso(8)),
      movement("fill-end", "b", "e", [[0, 1], [1, 1]], iso(10)),
      movement("fill-start", "c", "e", [[0, 2], [1, 2]], undefined, iso(12)),
    ],
  }));

  const byId = new Map(timeline.tracks.map((track) => [track.id, track]));
  assert.deepEqual([byId.get("own").startMs, byId.get("own").endMs], [parseBattleTime(iso(7)), parseBattleTime(iso(8))]);
  assert.deepEqual([byId.get("fill-end").startMs, byId.get("fill-end").endMs], [parseBattleTime(iso(10)), parseBattleTime(iso(15))]);
  assert.deepEqual([byId.get("fill-start").startMs, byId.get("fill-start").endMs], [parseBattleTime(iso(5)), parseBattleTime(iso(12))]);
});

test("fully legacy documents get sequential synthetic ranges from zero", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e1"), event("e2")],
    movements: [movement("m", "a", "e2", [[0, 0], [1, 0]])],
    animation_hints: { timeline: { default_event_duration_ms: 2_000, historical_seconds_per_playback_second: 30 } },
  }));

  assert.deepEqual(timeline.eventWindows.map(({ startMs, endMs, synthetic }) => [startMs, endMs, synthetic]), [
    [0, 60_000, true],
    [60_000, 120_000, true],
  ]);
  assert.equal(timeline.tracks[0].synthetic, true);
  assert.deepEqual([timeline.tracks[0].startMs, timeline.tracks[0].endMs], [60_000, 120_000]);
});

test("an ordered untimed event fills the interval between timed events", () => {
  const fixture = battle({
    actors: [{ id: "a" }],
    historical_events: [event("later", iso(10), iso(15)), event("untimed"), event("early", iso(0), iso(5))],
    movements: [movement("linked", "a", "untimed", [[0, 0], [1, 0]])],
    animation_hints: { timeline: { ordered_event_ids: ["early", "untimed", "later"], default_event_duration_ms: 1_000 } },
  });
  const timeline = compileTimeline(fixture);
  const byId = new Map(timeline.eventWindows.map((window) => [window.id, window]));

  assert.deepEqual([byId.get("untimed").startMs, byId.get("untimed").endMs], [parseBattleTime(iso(5)), parseBattleTime(iso(6))]);
  assert.deepEqual([timeline.tracks[0].startMs, timeline.tracks[0].endMs], [parseBattleTime(iso(5)), parseBattleTime(iso(6))]);
  assert.equal(timeline.tracks[0].synthetic, true);
});

test("untimed blocks backfill before and continue after known event anchors", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("before-1"), event("before-2"), event("anchor", iso(10), iso(11)), event("after")],
    animation_hints: { timeline: { default_event_duration_ms: 2_000 } },
  }));
  const byId = new Map(timeline.eventWindows.map((window) => [window.id, window]));

  assert.deepEqual([byId.get("before-1").startMs, byId.get("before-1").endMs], [parseBattleTime(iso(6)), parseBattleTime(iso(8))]);
  assert.deepEqual([byId.get("before-2").startMs, byId.get("before-2").endMs], [parseBattleTime(iso(8)), parseBattleTime(iso(10))]);
  assert.deepEqual([byId.get("after").startMs, byId.get("after").endMs], [parseBattleTime(iso(11)), parseBattleTime(iso(13))]);
});

test("multiple untimed events shorten deterministically inside a small anchored gap", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("left", iso(0), iso(10)), event("middle-1"), event("middle-2"), event("right", iso(11), iso(12))],
    animation_hints: { timeline: { default_event_duration_ms: 2_000 } },
  }));
  const byId = new Map(timeline.eventWindows.map((window) => [window.id, window]));

  assert.deepEqual([byId.get("middle-1").startMs, byId.get("middle-1").endMs], [parseBattleTime(iso(10)), parseBattleTime(iso(10.5))]);
  assert.deepEqual([byId.get("middle-2").startMs, byId.get("middle-2").endMs], [parseBattleTime(iso(10.5)), parseBattleTime(iso(11))]);
  assert.ok(byId.get("middle-1").endMs > byId.get("middle-1").startMs);
  assert.ok(byId.get("middle-2").endMs > byId.get("middle-2").startMs);
});

test("mixed timelines anchor untimed events in the historical era", () => {
  const timeline = compileTimeline(battle({ historical_events: [event("legacy"), event("real", iso(5), iso(10))] }));
  assert.ok(timeline.eventWindows[0].startMs > Date.UTC(1800, 0, 1));
});

test("actor positions persist before, between, and after tracks and latest overlap wins", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("all", iso(0), iso(30))],
    movements: [
      movement("first", "a", "all", [[0, 0], [10, 0]], iso(5), iso(10)),
      movement("second", "a", "all", [[10, 0], [20, 0]], iso(20), iso(25)),
      movement("overlap", "a", "all", [[100, 0], [200, 0]], iso(8), iso(9)),
    ],
  }));
  const at = (m) => sampleTimeline(timeline, toPresentationTime(timeline, parseBattleTime(iso(m)))).actorPositions.get("a");

  assert.deepEqual(at(0), [0, 0]);
  assert.deepEqual(at(7), [4, 0]);
  assert.deepEqual(at(8.5), [150, 0]);
  assert.deepEqual(at(15), [200, 0]);
  assert.deepEqual(at(22.5), [15, 0]);
  assert.deepEqual(at(30), [20, 0]);
});

test("actor starting position uses the chronologically earliest track", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("all", iso(0), iso(30))],
    movements: [
      movement("later-source-first", "a", "all", [[20, 20], [21, 20]], iso(20), iso(25)),
      movement("earlier-source-last", "a", "all", [[1, 1], [2, 1]], iso(5), iso(10)),
    ],
  }));

  assert.deepEqual(sampleTimeline(timeline, 0).actorPositions.get("a"), [1, 1]);
});

test("starting position falls back through event places then first place", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "event-actor" }, { id: "fallback" }],
    places: [
      { id: "first", geometry: { type: "Point", coordinates: [1, 2] } },
      { id: "event-place", geometry: { type: "Polygon", coordinates: [[[9, 8], [10, 8], [9, 8]]] } },
    ],
    historical_events: [event("e", iso(0), iso(1), { actor_ids: ["event-actor"], place_ids: ["event-place"] })],
  }));
  const sample = sampleTimeline(timeline, 0);

  assert.deepEqual(sample.actorPositions.get("event-actor"), [9, 8]);
  assert.deepEqual(sample.actorPositions.get("fallback"), [1, 2]);
});

test("long inactive gaps compress to the configured duration and mappings round trip", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("a", iso(0), iso(1)), event("b", iso(21), iso(22))],
    animation_hints: { timeline: { historical_seconds_per_playback_second: 60, idle_compression_threshold_seconds: 900, idle_compressed_duration_ms: 1_200 } },
  }));

  assert.equal(timeline.compressedGaps.length, 1);
  assert.equal(timeline.compressedGaps[0].presentationDurationMs, 1_200);
  assert.equal(timeline.presentationDurationMs, 3_200);
  const gap = timeline.compressedGaps[0];
  assert.equal(sampleTimeline(timeline, gap.presentationStartMs + 600).compressedGap, gap);
  for (const historicalMs of [timeline.historicalStartMs, gap.historicalStartMs, (gap.historicalStartMs + gap.historicalEndMs) / 2, gap.historicalEndMs, timeline.historicalEndMs]) {
    assert.ok(Math.abs(toHistoricalTime(timeline, toPresentationTime(timeline, historicalMs)) - historicalMs) < 0.001);
  }
});

test("short inactive gaps remain at the normal scale", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("a", iso(0), iso(1)), event("b", iso(11), iso(12))],
    animation_hints: { timeline: { historical_seconds_per_playback_second: 60, idle_compression_threshold_seconds: 900 } },
  }));
  assert.equal(timeline.compressedGaps.length, 0);
  assert.equal(timeline.presentationDurationMs, 12_000);
});

test("historical speed scale controls presentation duration", () => {
  const fixture = battle({ historical_events: [event("e", iso(0), iso(10))] });
  fixture.animation_hints.timeline.historical_seconds_per_playback_second = 120;
  assert.equal(compileTimeline(fixture).presentationDurationMs, 5_000);
});

test("event and engagement activity and destructive results use effective windows", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "attacker" }, { id: "target" }],
    historical_events: [event("e", iso(0), iso(10))],
    engagements: [
      { id: "linked", event_id: "e", attacker_actor_id: "attacker", target_actor_id: "target", result: "sunk" },
      { id: "timed", event_id: "e", attacker_actor_id: "attacker", target_actor_id: "target", result: "captured", result_actor_id: "attacker", time: { start: iso(2), end: iso(3) } },
    ],
  }));
  const at = (m) => sampleTimeline(timeline, toPresentationTime(timeline, parseBattleTime(iso(m))));

  assert.deepEqual([...at(1).activeEventIds], ["e"]);
  assert.deepEqual([...at(1).activeEngagementIds], ["linked"]);
  assert.deepEqual([...at(3).activeEngagementIds], ["linked", "timed"]);
  assert.deepEqual([...at(3).persistentOutcomeActorIds], ["attacker"]);
  assert.deepEqual([...at(10).persistentOutcomeActorIds], ["target", "attacker"]);
});

test("sampling is deterministic when seeking backward", () => {
  const fixture = battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [10, 0]], iso(0), iso(10))],
  });
  const timeline = compileTimeline(typeof structuredClone === "function" ? structuredClone(fixture) : JSON.parse(JSON.stringify(fixture)));
  const middle = timeline.presentationDurationMs / 2;
  const first = sampleTimeline(timeline, middle);
  sampleTimeline(timeline, timeline.presentationDurationMs);
  const second = sampleTimeline(timeline, middle);

  assert.deepEqual([...second.actorPositions], [...first.actorPositions]);
  assert.deepEqual([...second.headings], [...first.headings]);
  assert.deepEqual([...second.activeEventIds], [...first.activeEventIds]);
});

test("empty documents compile and sample without throwing", () => {
  const timeline = compileTimeline({});
  const sample = sampleTimeline(timeline, 0);

  assert.ok(timeline.presentationDurationMs > 0);
  assert.equal(sample.actorPositions.size, 0);
  assert.equal(sample.activeEventIds.size, 0);
  assert.equal(Number.isFinite(sample.historicalMs), true);
});

test("historical mapping preserves a legitimate epoch-zero end bound", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("epoch", undefined, "1970-01-01T00:00:00Z")],
  }));

  assert.equal(timeline.historicalEndMs, 0);
  for (const historicalMs of [timeline.historicalStartMs, timeline.historicalStartMs / 2, 0]) {
    const presentationMs = toPresentationTime(timeline, historicalMs);
    assert.ok(Math.abs(toHistoricalTime(timeline, presentationMs) - historicalMs) < 0.001);
  }
  assert.equal(toPresentationTime(timeline, 0), timeline.presentationDurationMs);
});

test("final stationary segments retain the latest non-stationary heading", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [0, 1], [0, 1]], iso(0), iso(10))],
  }));

  assert.equal(sampleTimeline(timeline, timeline.presentationDurationMs).headings.get("a"), -Math.PI / 2);
});

test("entirely stationary tracks use the default zero heading", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [0, 0]], iso(0), iso(10))],
  }));

  assert.equal(sampleTimeline(timeline, 0).headings.get("a"), 0);
});

test("zero configured compression duration normalizes to an invertible positive span", () => {
  const timeline = compileTimeline(battle({
    historical_events: [event("a", iso(0), iso(1)), event("b", iso(21), iso(22))],
    animation_hints: { timeline: { historical_seconds_per_playback_second: 60, idle_compression_threshold_seconds: 900, idle_compressed_duration_ms: 0 } },
  }));
  const gap = timeline.compressedGaps[0];

  assert.equal(gap.presentationDurationMs, 1_200);
  for (const historicalMs of [gap.historicalStartMs, (gap.historicalStartMs + gap.historicalEndMs) / 2, gap.historicalEndMs]) {
    assert.ok(Math.abs(toHistoricalTime(timeline, toPresentationTime(timeline, historicalMs)) - historicalMs) < 0.001);
  }
});

test("timeline module has no mutable global collections", () => {
  const source = readFileSync(new URL("../app/timeline.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^const\s+[A-Z_]+\s*=\s*new\s+(?:Set|Map)\b/m);
});

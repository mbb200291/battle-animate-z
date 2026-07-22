import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compileTimeline,
  parseBattleTime,
  sampleTimeline,
  trackProgressAt,
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
    const expected = (base / 1000 + microseconds / 1_000_000) * 1000;
    assert.equal(parseBattleTime(`2000-01-01T00:00:00.${fraction}Z`), expected);
  }
});

test("parseBattleTime matches Python float arithmetic for historical fractional timestamps", () => {
  const pythonExpected = [
    ["1894-09-17T12:34:56.1", -2375868303900.0],
    ["1894-09-17T12:34:56.12Z", -2375868303880.0],
    ["1894-09-17T12:34:56.123+08:30", -2375898903877.0],
    ["1894-09-17T12:34:56.1234", -2375868303876.5996],
    ["1894-09-17T12:34:56.12345+08:30", -2375898903876.5503],
    ["1894-09-17T12:34:56.123456Z", -2375868303876.544],
    ["1894-09-17T12:34:56.1234567-02:30", -2375859303876.544],
    ["1894-09-17T12:34:56.12345678", -2375868303876.544],
    ["1894-09-17T12:34:56.123456789+05:45", -2375889003876.544],
  ];

  for (const [value, expected] of pythonExpected) {
    assert.equal(parseBattleTime(value), expected, value);
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

test("track progress follows uniform movement time across cumulative path length", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [1, 0], [3, 0]], iso(0), iso(10))],
  }));
  const track = timeline.tracks[0];

  assert.equal(trackProgressAt(track, parseBattleTime(iso(0))), 0);
  assert.equal(trackProgressAt(track, parseBattleTime(iso(5))), 0.5);
  assert.equal(trackProgressAt(track, parseBattleTime(iso(10))), 1);
});

test("track progress converts waypoint timing to cumulative-length progress", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [1, 0], [3, 0]], iso(0), iso(10), {
      waypoint_times: [iso(0), iso(8), iso(10)],
    })],
  }));
  const track = timeline.tracks[0];

  assert.ok(Math.abs(trackProgressAt(track, parseBattleTime(iso(4))) - 1 / 6) < 1e-12);
  assert.ok(Math.abs(trackProgressAt(track, parseBattleTime(iso(9))) - 2 / 3) < 1e-12);
});

test("track progress is safe for invalid inputs and stationary paths", () => {
  assert.equal(trackProgressAt(null, 0), 0);
  assert.equal(trackProgressAt({}, 0), 0);
  assert.equal(trackProgressAt({ startMs: 0, endMs: 10, coordinates: [[0, 0]], cumulativeLengths: [0] }, Number.NaN), 0);

  const stationary = {
    startMs: 0,
    endMs: 10,
    coordinates: [[0, 0], [0, 0]],
    cumulativeLengths: [0, 0],
    waypointTimes: null,
  };
  assert.equal(trackProgressAt(stationary, -1), 0);
  assert.equal(trackProgressAt(stationary, 5), 0.5);
  assert.equal(trackProgressAt(stationary, 11), 1);
});

test("track progress rejects malformed nonempty compiled tracks", () => {
  const valid = {
    startMs: 0,
    endMs: 10,
    coordinates: [[0, 0], [1, 0], [3, 0]],
    cumulativeLengths: [0, 1, 3],
    waypointTimes: null,
  };
  const malformed = [
    { ...valid, cumulativeLengths: [0, Number.NaN, 3] },
    { ...valid, cumulativeLengths: [0, 1] },
    { ...valid, cumulativeLengths: [0, 2, 1] },
    { ...valid, startMs: Number.NaN },
    { ...valid, endMs: Number.POSITIVE_INFINITY },
    { ...valid, waypointTimes: [0, 5] },
    { ...valid, waypointTimes: [0, Number.NaN, 10] },
    { ...valid, waypointTimes: [0, 8, 7] },
    { ...valid, waypointTimes: [-1, 5, 10] },
    { ...valid, waypointTimes: [0, 5, 11] },
  ];

  for (const track of malformed) assert.equal(trackProgressAt(track, 5), 0);
});

test("compiled tracks use frozen prevalidated progress metadata without rescanning coordinates", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [1, 0], [3, 0]], iso(0), iso(10), {
      waypoint_times: [iso(0), iso(8), iso(10)],
    })],
  }));
  const track = timeline.tracks[0];

  assert.equal(Object.isFrozen(track._progress), true);
  assert.equal(Object.isFrozen(track._progress.cumulativeLengths), true);
  assert.equal(Object.isFrozen(track._progress.waypointTimes), true);
  track.coordinates = new Proxy(track.coordinates, {
    get() {
      throw new Error("trackProgressAt rescanned compiled coordinates");
    },
  });
  assert.ok(Math.abs(trackProgressAt(track, parseBattleTime(iso(4))) - 1 / 6) < 1e-12);
});

test("waypoint sampling retains the heading of a timed stationary segment", () => {
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("e", iso(0), iso(10))],
    movements: [movement("m", "a", "e", [[0, 0], [1, 0], [1, 0], [1, 1]], iso(0), iso(10), {
      waypoint_times: [iso(0), iso(4), iso(8), iso(10)],
    })],
  }));

  const sample = sampleTimeline(timeline, toPresentationTime(timeline, parseBattleTime(iso(5))));
  assert.equal(Math.abs(sample.headings.get("a")), 0);
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

test("date-only legacy events keep their calendar anchor but use ordered synthetic fallback windows", () => {
  const anchor = parseBattleTime("1815-06-18");
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [
      event("advance", undefined, undefined, { time: { label: "morning", start: "1815-06-18", precision: "day", confidence: 0.7 } }),
      event("retreat", undefined, undefined, { time: { label: "evening", start: "1815-06-18", precision: "day", confidence: 0.7 } }),
    ],
    movements: [
      movement("out", "a", "advance", [[0, 0], [10, 0]]),
      movement("back", "a", "retreat", [[10, 0], [0, 0]]),
    ],
    animation_hints: {
      timeline: {
        default_event_duration_ms: 1_000,
        historical_seconds_per_playback_second: 60,
        ordered_event_ids: ["advance", "retreat"],
      },
    },
  }));

  assert.deepEqual(timeline.eventWindows.map(({ startMs, endMs, synthetic }) => [startMs, endMs, synthetic]), [
    [anchor, anchor + 60_000, true],
    [anchor + 60_000, anchor + 120_000, true],
  ]);
  assert.equal(timeline.presentationDurationMs, 2_000);
  assert.deepEqual(sampleTimeline(timeline, 500).actorPositions.get("a"), [5, 0]);
  assert.deepEqual(sampleTimeline(timeline, 1_500).actorPositions.get("a"), [5, 0]);
  assert.equal(sampleTimeline(timeline, 1_000).synthetic, true);
});

test("year and month precision without a time of day also use synthetic fallback display", () => {
  for (const [precision, start] of [["year", "1815"], ["month", "1815-06"]]) {
    const timeline = compileTimeline(battle({
      historical_events: [event(precision, undefined, undefined, {
        time: { label: start, start, precision, confidence: 0.7 },
      })],
      animation_hints: { timeline: { default_event_duration_ms: 1_000 } },
    }));

    assert.equal(timeline.eventWindows[0].startMs, parseBattleTime(start), precision);
    assert.equal(timeline.eventWindows[0].synthetic, true, precision);
    assert.equal(sampleTimeline(timeline, 500).synthetic, true, precision);
  }
});

test("bounded coarse year month and day ranges retain their historical anchors", () => {
  for (const [precision, start, end] of [
    ["year", "1815", "1817"],
    ["month", "1815-06", "1815-08"],
    ["day", "1815-06-18", "1815-06-20"],
  ]) {
    const timeline = compileTimeline(battle({
      historical_events: [event(precision, undefined, undefined, {
        time: { label: `${start}–${end}`, start, end, precision, confidence: 0.7 },
      })],
    }));
    const window = timeline.eventWindows[0];

    assert.equal(window.startMs, parseBattleTime(start), precision);
    assert.equal(window.endMs, parseBattleTime(end), precision);
    assert.equal(window.synthetic, true, precision);
  }
});

test("standalone bounded coarse ranges use one bounded fallback presentation slot", () => {
  for (const [precision, start, end] of [
    ["year", "1815", "1817"],
    ["month", "1815-06", "1815-08"],
    ["day", "1815-06-18", "1815-06-20"],
  ]) {
    const timeline = compileTimeline(battle({
      historical_events: [event(precision, undefined, undefined, {
        time: { label: `${start}–${end}`, start, end, precision, confidence: 0.7 },
      })],
      animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
    }));
    const midpoint = (parseBattleTime(start) + parseBattleTime(end)) / 2;

    assert.equal(timeline.presentationDurationMs, 1_000, precision);
    assert.equal(timeline.timeWarp.length, 1, precision);
    assert.equal(timeline.timeWarp[0].synthetic, true, precision);
    assert.equal(timeline.timeWarp[0].compressed, false, precision);
    assert.ok(Math.abs(toHistoricalTime(timeline, toPresentationTime(timeline, midpoint)) - midpoint) < 0.001, precision);
  }
});

test("precise windows override broad coarse playback while surrounding portions stay bounded", () => {
  const broadStart = parseBattleTime("2020-01-01");
  const preciseStart = parseBattleTime("2020-01-02T12:00:00Z");
  const preciseEnd = parseBattleTime("2020-01-02T12:10:00Z");
  const broadEnd = parseBattleTime("2020-01-03");
  const preciseTime = { label: "precise", start: "2020-01-02T12:00:00Z", end: "2020-01-02T12:10:00Z", precision: "range", confidence: 0.9 };

  for (const preciseKind of ["event", "movement", "engagement"]) {
    const fixture = battle({
      actors: [{ id: "a" }, { id: "b" }],
      historical_events: [event("broad", undefined, undefined, {
        time: { label: "three days", start: "2020-01-01", end: "2020-01-03", precision: "day", confidence: 0.7 },
      })],
      animation_hints: {
        timeline: {
          default_event_duration_ms: 1_000,
          historical_seconds_per_playback_second: 60,
          idle_compression_threshold_seconds: 900,
          idle_compressed_duration_ms: 1_200,
        },
      },
    });
    if (preciseKind === "event") {
      fixture.historical_events.push(event("precise", undefined, undefined, { time: preciseTime }));
    } else if (preciseKind === "movement") {
      fixture.movements.push(movement("precise", "a", "broad", [[0, 0], [1, 0]], undefined, undefined, { time: preciseTime }));
    } else {
      fixture.engagements.push({
        id: "precise",
        event_id: "broad",
        attacker_actor_id: "a",
        target_actor_id: "b",
        time: preciseTime,
      });
    }

    const timeline = compileTimeline(fixture);
    assert.equal(timeline.presentationDurationMs, 12_000, preciseKind);
    assert.deepEqual(
      timeline.timeWarp.map(({ historicalStartMs, historicalEndMs, presentationDurationMs, synthetic, compressed }) => [
        historicalStartMs,
        historicalEndMs,
        presentationDurationMs,
        synthetic,
        compressed,
      ]),
      [
        [broadStart, preciseStart, 1_000, true, false],
        [preciseStart, preciseEnd, 10_000, false, false],
        [preciseEnd, broadEnd, 1_000, true, false],
      ],
      preciseKind,
    );
    assert.equal(timeline.compressedGaps.length, 0, preciseKind);
    assert.equal(sampleTimeline(timeline, 500).synthetic, true, preciseKind);
    assert.equal(sampleTimeline(timeline, toPresentationTime(timeline, preciseStart)).synthetic, false, `${preciseKind}: precise start`);
    assert.equal(sampleTimeline(timeline, 6_000).synthetic, false, preciseKind);
    assert.equal(sampleTimeline(timeline, toPresentationTime(timeline, preciseEnd)).synthetic, false, `${preciseKind}: precise end`);
    assert.equal(sampleTimeline(timeline, 11_500).synthetic, true, preciseKind);
    for (const historicalMs of [broadStart, preciseStart, (preciseStart + preciseEnd) / 2, preciseEnd, broadEnd]) {
      assert.ok(
        Math.abs(toHistoricalTime(timeline, toPresentationTime(timeline, historicalMs)) - historicalMs) < 0.001,
        `${preciseKind}: ${historicalMs}`,
      );
    }
  }
});

test("coarse untimed coarse sequences receive three full non-overlapping fallback slots", () => {
  const anchor = parseBattleTime("1815-06-18");
  const coarse = (id) => event(id, undefined, undefined, {
    time: { label: id, start: "1815-06-18", precision: "day", confidence: 0.7 },
  });
  const timeline = compileTimeline(battle({
    historical_events: [coarse("first"), event("untimed"), coarse("last")],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(timeline.eventWindows.map(({ startMs, endMs, synthetic }) => [startMs, endMs, synthetic]), [
    [anchor, anchor + 60_000, true],
    [anchor + 60_000, anchor + 120_000, true],
    [anchor + 120_000, anchor + 180_000, true],
  ]);
});

test("movement and engagement own coarse timing uses synthetic ranges outside linked events", () => {
  const movementStart = parseBattleTime("1815-06-18");
  const boundedMovementEnd = parseBattleTime("1815-06-20");
  const engagementStart = parseBattleTime("1815-07");
  const engagementEnd = parseBattleTime("1815-09");
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }, { id: "b" }],
    historical_events: [event("linked", "2020-01-01T12:00:00", "2020-01-01T12:10:00")],
    movements: [
      movement("coarse-move", "a", "linked", [[0, 0], [1, 0]], undefined, undefined, {
        time: { label: "day", start: "1815-06-18", precision: "day", confidence: 0.5 },
      }),
      movement("bounded-coarse-move", "b", "linked", [[0, 1], [1, 1]], undefined, undefined, {
        time: { label: "two days", start: "1815-06-18", end: "1815-06-20", precision: "day", confidence: 0.5 },
      }),
    ],
    engagements: [
      {
        id: "coarse-engagement",
        event_id: "linked",
        attacker_actor_id: "a",
        target_actor_id: "b",
        time: { label: "summer", start: "1815-07", end: "1815-09", precision: "month", confidence: 0.5 },
      },
      {
        id: "unbounded-coarse-engagement",
        event_id: "linked",
        attacker_actor_id: "a",
        target_actor_id: "b",
        time: { label: "month", start: "1815-07", precision: "month", confidence: 0.5 },
      },
    ],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(
    [timeline.tracks[0].startMs, timeline.tracks[0].endMs, timeline.tracks[0].synthetic],
    [movementStart, movementStart + 60_000, true],
  );
  assert.deepEqual(
    [timeline.engagementWindows[0].startMs, timeline.engagementWindows[0].endMs, timeline.engagementWindows[0].synthetic],
    [engagementStart, engagementEnd, true],
  );
  assert.deepEqual(
    [timeline.tracks[1].startMs, timeline.tracks[1].endMs, timeline.tracks[1].synthetic],
    [movementStart, boundedMovementEnd, true],
  );
  assert.deepEqual(
    [timeline.engagementWindows[1].startMs, timeline.engagementWindows[1].endMs, timeline.engagementWindows[1].synthetic],
    [engagementStart, engagementStart + 60_000, true],
  );
});

test("same-day coarse movement fallbacks sequence per actor across distinct linked events", () => {
  const anchor = parseBattleTime("1815-06-18");
  const coarseTime = { label: "day", start: "1815-06-18", precision: "day", confidence: 0.5 };
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [
      event("coarse-1", undefined, undefined, { time: coarseTime }),
      event("coarse-2", undefined, undefined, { time: coarseTime }),
    ],
    movements: [
      movement("first", "a", "coarse-1", [[0, 0], [10, 0]], undefined, undefined, { time: coarseTime }),
      movement("second", "a", "coarse-2", [[10, 0], [20, 0]], undefined, undefined, { time: coarseTime }),
    ],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(timeline.tracks.map(({ startMs, endMs }) => [startMs, endMs]), [
    [anchor, anchor + 60_000],
    [anchor + 60_000, anchor + 120_000],
  ]);
  assert.deepEqual(sampleTimeline(timeline, 500).actorPositions.get("a"), [5, 0]);
  assert.deepEqual(sampleTimeline(timeline, 1_000).actorPositions.get("a"), [10, 0]);
  assert.deepEqual(sampleTimeline(timeline, 1_500).actorPositions.get("a"), [15, 0]);
});

test("bounded coarse movement keeps its own endpoints when linked event shares its anchor", () => {
  const start = parseBattleTime("1815-06-18");
  const end = parseBattleTime("1815-06-20");
  const eventTime = { label: "day", start: "1815-06-18", precision: "day", confidence: 0.5 };
  const movementTime = {
    label: "multi-day route",
    start: "1815-06-18",
    end: "1815-06-20",
    precision: "day",
    confidence: 0.5,
  };
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("coarse", undefined, undefined, { time: eventTime })],
    movements: [movement("bounded", "a", "coarse", [[0, 0], [10, 0]], undefined, undefined, { time: movementTime })],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(
    [timeline.tracks[0].startMs, timeline.tracks[0].endMs],
    [start, end],
  );
});

test("connected unbounded coarse tracks under one event receive sequential fallback slots", () => {
  const anchor = parseBattleTime("1815-06-18");
  const coarseTime = { label: "day", start: "1815-06-18", precision: "day", confidence: 0.5 };
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }],
    historical_events: [event("coarse", undefined, undefined, { time: coarseTime })],
    movements: [
      movement("first", "a", "coarse", [[0, 0], [10, 0]], undefined, undefined, { time: coarseTime }),
      movement("second", "a", "coarse", [[10, 0], [20, 0]], undefined, undefined, { time: coarseTime }),
    ],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(timeline.tracks.map(({ startMs, endMs }) => [startMs, endMs]), [
    [anchor, anchor + 60_000],
    [anchor + 60_000, anchor + 120_000],
  ]);
  assert.deepEqual(sampleTimeline(timeline, 500).actorPositions.get("a"), [5, 0]);
  assert.deepEqual(sampleTimeline(timeline, 1_500).actorPositions.get("a"), [15, 0]);
});

test("zero-duration precise windows are synthetic while routes and outcomes still complete", () => {
  const instant = iso(5);
  const instantMs = parseBattleTime(instant);
  const timeline = compileTimeline(battle({
    actors: [{ id: "a" }, { id: "b" }],
    historical_events: [
      event("instant", instant, instant),
      event("later", iso(7), iso(8)),
    ],
    movements: [movement("instant-move", "a", "instant", [[0, 0], [10, 0]], instant, instant)],
    engagements: [{
      id: "instant-hit",
      event_id: "instant",
      attacker_actor_id: "a",
      target_actor_id: "b",
      result: "sunk",
      time: { start: instant, end: instant },
    }],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));

  assert.deepEqual(
    [timeline.eventWindows[0].startMs, timeline.eventWindows[0].endMs, timeline.eventWindows[0].synthetic],
    [instantMs, instantMs + 60_000, true],
  );
  const track = timeline.tracks[0];
  const engagement = timeline.engagementWindows[0];
  assert.deepEqual([track.startMs, track.endMs, track.synthetic], [instantMs, instantMs + 60_000, true]);
  assert.deepEqual([engagement.startMs, engagement.endMs, engagement.synthetic], [instantMs, instantMs + 60_000, true]);
  const midpoint = sampleTimeline(timeline, toPresentationTime(timeline, instantMs + 30_000));
  assert.equal(midpoint.synthetic, true);
  assert.deepEqual(midpoint.actorPositions.get("a"), [5, 0]);
  const completed = sampleTimeline(timeline, toPresentationTime(timeline, instantMs + 90_000));
  assert.deepEqual(completed.actorPositions.get("a"), [10, 0]);
  assert.equal(completed.persistentOutcomeActorIds.has("b"), true);
});

test("mixed coarse and explicit windows mark only the coarse fallback as synthetic", () => {
  const timeline = compileTimeline(battle({
    historical_events: [
      event("coarse", undefined, undefined, { time: { label: "day", start: "1815-06-18", precision: "day", confidence: 0.7 } }),
      event("explicit", "1815-06-19T12:00:00", "1815-06-19T12:10:00", {
        time: { label: "noon", start: "1815-06-19T12:00:00", end: "1815-06-19T12:10:00", precision: "range", confidence: 0.8 },
      }),
    ],
    animation_hints: { timeline: { default_event_duration_ms: 1_000, historical_seconds_per_playback_second: 60 } },
  }));
  const [coarse, explicit] = timeline.eventWindows;

  assert.equal(coarse.synthetic, true);
  assert.equal(explicit.synthetic, false);
  assert.equal(timeline.synthetic, false);
  assert.equal(sampleTimeline(timeline, toPresentationTime(timeline, coarse.startMs + 30_000)).synthetic, true);
  assert.equal(sampleTimeline(timeline, toPresentationTime(timeline, explicit.startMs + 300_000)).synthetic, false);
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

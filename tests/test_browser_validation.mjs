import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as animate from "../app/animate.js";

const { validateBattle } = animate;

function fixture(version = "0.3.0") {
  const battle = {
    schema_version: version,
    metadata: {},
    battle: { name: "Test", summary: "Test", part_of: "Test", date: { label: "18 June 1815" } },
    sides: [{ id: "side-a", name: "A" }, { id: "side-b", name: "B" }],
    commanders: [{ id: "commander-a", side_id: "side-a" }],
    actors: [
      { id: "actor-a", name: "A", side_id: "side-a", commander_ids: ["commander-a"] },
      { id: "actor-b", name: "B", side_id: "side-b", commander_ids: [] },
    ],
    places: [
      { id: "place-a", name: "A", geometry: { type: "Point", coordinates: [0, 0] } },
      { id: "place-b", name: "B", geometry: { type: "Point", coordinates: [1, 1] } },
    ],
    historical_events: [{
      id: "event-a",
      type: "advance",
      actor_ids: ["actor-a"],
      target_actor_ids: ["actor-b"],
      place_ids: ["place-a"],
      source_ids: ["source-a"],
      time: { label: "10:00–10:10", start: "1815-06-18T10:00:00Z", end: "1815-06-18T10:10:00Z" },
    }],
    movements: [{
      id: "movement-a",
      event_id: "event-a",
      actor_id: "actor-a",
      from_place_id: "place-a",
      to_place_id: "place-b",
      precision: "exact",
      time: { start: "1815-06-18T10:00:00Z", end: "1815-06-18T10:10:00Z", confidence: 0.5 },
      path: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      waypoint_times: ["1815-06-18T10:00:00Z", "1815-06-18T10:10:00Z"],
    }],
    engagements: [{
      id: "engagement-a",
      event_id: "event-a",
      attacker_actor_id: "actor-a",
      target_actor_id: "actor-b",
      at_place_id: "place-a",
      source_ids: ["source-a"],
      time: { start: "1815-06-18T10:05:00Z", end: "1815-06-18T10:06:00Z" },
    }],
    outcome: { winner_side_ids: ["side-a"], source_ids: ["source-a"] },
    sources: [{ id: "source-a" }],
    animation_hints: { style: { actor_icons: { "actor-a": "infantry" } } },
  };
  if (version !== "0.3.0") {
    delete battle.movements[0].time;
    delete battle.movements[0].waypoint_times;
  }
  return battle;
}

function frontlineBattle() {
  const battle = fixture();
  battle.schema_version = "0.4.0";
  battle.frontline_snapshots = [{
    id: "front_day_1",
    time: {
      label: "1942-11-19T08:00:00Z",
      start: "1942-11-19T08:00:00Z",
      precision: "hour",
      confidence: 0.9,
    },
    event_id: "event-a",
    front_lines: [{
      id: "front_main",
      geometry: {
        type: "LineString",
        coordinates: [[43.1, 49.2], [44.0, 48.9]],
      },
    }],
    control_areas: [{
      id: "area_a",
      side_id: "side-a",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [42.5, 49.8],
          [44.0, 49.5],
          [44.0, 48.9],
          [42.5, 49.0],
          [42.5, 49.8],
        ]],
      },
    }],
    precision: "approximate",
    confidence: 0.8,
    source_ids: ["source-a"],
  }];
  return battle;
}

function messages(result, kind) {
  return result[kind].join("\n");
}

test("valid v0.3 document has structured empty diagnostics", () => {
  assert.deepEqual(validateBattle(fixture()), { errors: [], warnings: [] });
});

test("valid v0.4 frontline document has structured empty diagnostics", () => {
  assert.deepEqual(validateBattle(frontlineBattle()), { errors: [], warnings: [] });
});

test("frontline snapshot without a start warns but remains valid", () => {
  const battle = frontlineBattle();
  delete battle.frontline_snapshots[0].time.start;
  assert.deepEqual(validateBattle(battle), {
    errors: [],
    warnings: [
      "$.frontline_snapshots[0].time: snapshot without time.start is excluded from animation",
    ],
  });
});

test("frontline containers and members reject malformed shapes without throwing", () => {
  const cases = [
    ["container object", (battle) => { battle.frontline_snapshots = {}; }, /\$\.frontline_snapshots.*expected array/i],
    ["null snapshot", (battle) => { battle.frontline_snapshots[0] = null; }, /\$\.frontline_snapshots\[0\].*expected object/i],
    ["null front line", (battle) => { battle.frontline_snapshots[0].front_lines[0] = null; }, /\$\.frontline_snapshots\[0\]\.front_lines\[0\].*expected object/i],
    ["null control area", (battle) => { battle.frontline_snapshots[0].control_areas[0] = null; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\].*expected object/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle);
    let result;
    assert.doesNotThrow(() => { result = validateBattle(battle); }, label);
    assert.equal(result.errors.length, 1, `${label}: ${result.errors.join("\n")}`);
    assert.match(result.errors[0], expected, label);
  }
});

test("frontline snapshot, line, and area objects allow only schema properties", () => {
  const cases = [
    ["snapshot", (battle) => { battle.frontline_snapshots[0].note = "extra"; }, /\$\.frontline_snapshots\[0\]\.note.*additional property/i],
    ["front line", (battle) => { battle.frontline_snapshots[0].front_lines[0].note = "extra"; }, /\$\.frontline_snapshots\[0\]\.front_lines\[0\]\.note.*additional property/i],
    ["control area", (battle) => { battle.frontline_snapshots[0].control_areas[0].note = "extra"; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\]\.note.*additional property/i],
    ["line geometry", (battle) => { battle.frontline_snapshots[0].front_lines[0].geometry.note = "extra"; }, /\$\.frontline_snapshots\[0\]\.front_lines\[0\]\.geometry\.note.*additional property/i],
    ["area geometry", (battle) => { battle.frontline_snapshots[0].control_areas[0].geometry.note = "extra"; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\]\.geometry\.note.*additional property/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle);
    const errors = validateBattle(battle).errors;
    assert.equal(errors.length, 1, `${label}: ${errors.join("\n")}`);
    assert.match(errors[0], expected, label);
  }
});

test("frontline snapshot, line, and area required fields are enforced", () => {
  const cases = [
    ["snapshot id", (snapshot) => { delete snapshot.id; }, /\$\.frontline_snapshots\[0\]\.id.*required/i],
    ["snapshot time", (snapshot) => { delete snapshot.time; }, /\$\.frontline_snapshots\[0\]\.time.*required/i],
    ["snapshot precision", (snapshot) => { delete snapshot.precision; }, /\$\.frontline_snapshots\[0\]\.precision.*required/i],
    ["snapshot confidence", (snapshot) => { delete snapshot.confidence; }, /\$\.frontline_snapshots\[0\]\.confidence.*required/i],
    ["snapshot sources", (snapshot) => { delete snapshot.source_ids; }, /\$\.frontline_snapshots\[0\]\.source_ids.*required/i],
    ["line id", (snapshot) => { delete snapshot.front_lines[0].id; }, /\$\.frontline_snapshots\[0\]\.front_lines\[0\]\.id.*required/i],
    ["line geometry", (snapshot) => { delete snapshot.front_lines[0].geometry; }, /\$\.frontline_snapshots\[0\]\.front_lines\[0\]\.geometry.*required/i],
    ["area id", (snapshot) => { delete snapshot.control_areas[0].id; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\]\.id.*required/i],
    ["area side", (snapshot) => { delete snapshot.control_areas[0].side_id; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\]\.side_id.*required/i],
    ["area geometry", (snapshot) => { delete snapshot.control_areas[0].geometry; }, /\$\.frontline_snapshots\[0\]\.control_areas\[0\]\.geometry.*required/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0]);
    assert.match(messages(validateBattle(battle), "errors"), expected, label);
  }
});

test("frontline scalar and source shapes follow the v0.4 schema", () => {
  const cases = [
    ["snapshot id", (snapshot) => { snapshot.id = "1 bad"; }, /\.id.*identifier/i],
    ["event id", (snapshot) => { snapshot.event_id = []; }, /\.event_id.*expected identifier/i],
    ["precision", (snapshot) => { snapshot.precision = "certain"; }, /\.precision.*expected one of/i],
    ["confidence", (snapshot) => { snapshot.confidence = 1.1; }, /\.confidence.*expected value <= 1/i],
    ["sources container", (snapshot) => { snapshot.source_ids = {}; }, /\.source_ids.*expected array/i],
    ["sources minimum", (snapshot) => { snapshot.source_ids = []; }, /\.source_ids.*expected at least 1 item/i],
    ["source id", (snapshot) => { snapshot.source_ids = ["1 bad"]; }, /\.source_ids\[0\].*identifier/i],
    ["line id", (snapshot) => { snapshot.front_lines[0].id = ""; }, /\.front_lines\[0\]\.id.*identifier/i],
    ["area id", (snapshot) => { snapshot.control_areas[0].id = ""; }, /\.control_areas\[0\]\.id.*identifier/i],
    ["side id", (snapshot) => { snapshot.control_areas[0].side_id = {}; }, /\.side_id.*expected identifier/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0]);
    let result;
    assert.doesNotThrow(() => { result = validateBattle(battle); }, label);
    assert.match(messages(result, "errors"), expected, label);
  }
});

test("frontline collections must contain at least one shape when present", () => {
  for (const collection of ["front_lines", "control_areas"]) {
    const battle = frontlineBattle();
    battle.frontline_snapshots[0][collection] = [];
    assert.match(
      messages(validateBattle(battle), "errors"),
      new RegExp(`frontline_snapshots\\[0\\]\\.${collection}.*expected at least 1 item`, "i"),
      collection,
    );
  }
});

test("frontline LineString geometry requires exact keys and at least two coordinate pairs", () => {
  const cases = [
    ["type", (geometry) => { geometry.type = "Polygon"; }, /\.geometry\.type.*expected "LineString"/i],
    ["coordinates container", (geometry) => { geometry.coordinates = {}; }, /\.geometry\.coordinates.*expected array/i],
    ["minimum", (geometry) => { geometry.coordinates = [[0, 0]]; }, /\.geometry\.coordinates.*expected at least 2 item/i],
    ["position", (geometry) => { geometry.coordinates[1] = [0]; }, /\.geometry\.coordinates\[1\].*coordinate pair/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0].front_lines[0].geometry);
    assert.match(messages(validateBattle(battle), "errors"), expected, label);
  }
  for (const field of ["type", "coordinates"]) {
    const battle = frontlineBattle();
    delete battle.frontline_snapshots[0].front_lines[0].geometry[field];
    assert.match(
      messages(validateBattle(battle), "errors"),
      new RegExp(`geometry\\.${field}.*required`, "i"),
      field,
    );
  }
});

test("frontline Polygon geometry follows existing schema ring rules", () => {
  const cases = [
    ["geometry object", (area) => { area.geometry = null; }, /\.geometry.*expected object/i],
    ["type", (area) => { area.geometry.type = "LineString"; }, /\.geometry\.type.*expected "Polygon"/i],
    ["coordinates container", (area) => { area.geometry.coordinates = {}; }, /\.geometry\.coordinates.*expected array/i],
    ["rings minimum", (area) => { area.geometry.coordinates = []; }, /\.geometry\.coordinates.*expected at least 1 item/i],
    ["ring container", (area) => { area.geometry.coordinates = [null]; }, /\.geometry\.coordinates\[0\].*expected array/i],
    ["ring minimum", (area) => { area.geometry.coordinates = [[[0, 0], [1, 1], [0, 0]]]; }, /\.geometry\.coordinates\[0\].*expected at least 4 item/i],
    ["position", (area) => { area.geometry.coordinates[0][1] = [0]; }, /\.geometry\.coordinates\[0\]\[1\].*coordinate pair/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0].control_areas[0]);
    assert.match(messages(validateBattle(battle), "errors"), expected, label);
  }
});

test("frontline BattleTime enforces exact shape, required values, and lexical time", () => {
  const cases = [
    ["object", (snapshot) => { snapshot.time = null; }, /\.time.*expected object/i],
    ["extra", (snapshot) => { snapshot.time.note = "extra"; }, /\.time\.note.*additional property/i],
    ["label missing", (snapshot) => { delete snapshot.time.label; }, /\.time\.label.*required/i],
    ["precision missing", (snapshot) => { delete snapshot.time.precision; }, /\.time\.precision.*required/i],
    ["confidence missing", (snapshot) => { delete snapshot.time.confidence; }, /\.time\.confidence.*required/i],
    ["label type", (snapshot) => { snapshot.time.label = 1; }, /\.time\.label.*expected string/i],
    ["precision enum", (snapshot) => { snapshot.time.precision = "minute"; }, /\.time\.precision.*expected one of/i],
    ["confidence range", (snapshot) => { snapshot.time.confidence = -0.1; }, /\.time\.confidence.*expected value >= 0/i],
    ["start type", (snapshot) => { snapshot.time.start = 1; }, /\.time\.start.*expected string/i],
    ["start lexical", (snapshot) => { snapshot.time.start = "not-a-date"; }, /\.time\.start.*invalid ISO battle time/i],
    ["end lexical", (snapshot) => { snapshot.time.end = "1942-13-01"; }, /\.time\.end.*invalid ISO battle time/i],
    ["reversed", (snapshot) => { snapshot.time.end = "1942-11-19T07:59:00Z"; }, /\.time.*end must not be before start/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0]);
    assert.match(messages(validateBattle(battle), "errors"), expected, label);
  }
});

test("frontline snapshot requires a line or control area collection", () => {
  const battle = frontlineBattle();
  delete battle.frontline_snapshots[0].front_lines;
  delete battle.frontline_snapshots[0].control_areas;
  assert.deepEqual(validateBattle(battle).errors, [
    "$.frontline_snapshots[0]: must include front_lines or control_areas",
  ]);
});

test("frontline references report exact indexed paths", () => {
  const cases = [
    [
      (snapshot) => { snapshot.event_id = "missing-event"; },
      '$.frontline_snapshots[0].event_id: unknown id "missing-event"',
    ],
    [
      (snapshot) => { snapshot.control_areas[0].side_id = "missing-side"; },
      '$.frontline_snapshots[0].control_areas[0].side_id: unknown id "missing-side"',
    ],
    [
      (snapshot) => { snapshot.source_ids = ["missing-source"]; },
      '$.frontline_snapshots[0].source_ids[0]: unknown source id "missing-source"',
    ],
  ];
  for (const [mutate, expected] of cases) {
    const battle = frontlineBattle();
    mutate(battle.frontline_snapshots[0]);
    assert.deepEqual(validateBattle(battle).errors, [expected]);
  }
});

test("frontline ids are unique at their Python-defined scopes", () => {
  const duplicateSnapshot = frontlineBattle();
  const later = structuredClone(duplicateSnapshot.frontline_snapshots[0]);
  later.time.start = "1942-11-19T09:00:00Z";
  duplicateSnapshot.frontline_snapshots.push(later);
  assert.match(
    messages(validateBattle(duplicateSnapshot), "errors"),
    /\$\.frontline_snapshots\[1\]\.id: duplicate id "front_day_1"/,
  );

  for (const collection of ["front_lines", "control_areas"]) {
    const battle = frontlineBattle();
    battle.frontline_snapshots[0][collection].push(
      structuredClone(battle.frontline_snapshots[0][collection][0]),
    );
    assert.match(
      messages(validateBattle(battle), "errors"),
      new RegExp(`\\$\\.frontline_snapshots\\[0\\]\\.${collection}\\[1\\]\\.id: duplicate id`),
      collection,
    );
  }

  const stable = frontlineBattle();
  const next = structuredClone(stable.frontline_snapshots[0]);
  next.id = "front_day_2";
  next.time.start = "1942-11-19T09:00:00Z";
  stable.frontline_snapshots.push(next);
  assert.deepEqual(validateBattle(stable).errors, []);
});

test("frontline starts must be strictly increasing", () => {
  for (const start of ["1942-11-19T08:00:00Z", "1942-11-19T07:59:00Z"]) {
    const battle = frontlineBattle();
    const later = structuredClone(battle.frontline_snapshots[0]);
    later.id = "front_day_2";
    later.time.start = start;
    battle.frontline_snapshots.push(later);
    assert.match(
      messages(validateBattle(battle), "errors"),
      /\$\.frontline_snapshots\[1\]\.time\.start: values must be strictly increasing/,
      start,
    );
  }
});

test("missing frontline start does not reset the last valid ordering baseline", () => {
  for (const finalStart of ["1942-11-19T08:00:00Z", "1942-11-19T07:59:00Z"]) {
    const battle = frontlineBattle();
    const missing = structuredClone(battle.frontline_snapshots[0]);
    missing.id = "front_day_2";
    delete missing.time.start;
    const final = structuredClone(battle.frontline_snapshots[0]);
    final.id = "front_day_3";
    final.time.start = finalStart;
    battle.frontline_snapshots.push(missing, final);
    const result = validateBattle(battle);
    assert.match(
      messages(result, "errors"),
      /\$\.frontline_snapshots\[2\]\.time\.start: values must be strictly increasing/,
      finalStart,
    );
    assert.deepEqual(result.warnings, [
      "$.frontline_snapshots[1].time: snapshot without time.start is excluded from animation",
    ]);
  }
});

test("malformed frontline start is an error and never a missing-start warning", () => {
  const battle = frontlineBattle();
  battle.frontline_snapshots[0].time.start = "not-a-date";
  const result = validateBattle(battle);
  assert.deepEqual(result.errors, [
    "$.frontline_snapshots[0].time.start: invalid ISO battle time",
  ]);
  assert.deepEqual(result.warnings, []);
});

test("non-object input returns structured errors", () => {
  const result = validateBattle(null);
  assert.ok(result.errors.some((item) => item.includes("not a JSON object")));
  assert.deepEqual(result.warnings, []);
});

test("renderer-required top-level containers reject malformed shapes", () => {
  const arrayKeys = [
    "sides", "commanders", "actors", "places", "historical_events", "movements", "sources", "engagements",
  ];
  for (const key of arrayKeys) {
    const battle = fixture();
    battle[key] = {};
    const matching = validateBattle(battle).errors.filter((item) => item.includes(`$.${key}`));
    assert.equal(matching.length, 1, key);
    assert.match(matching[0], /expected array/i, key);
  }

  for (const key of ["metadata", "battle", "outcome", "animation_hints"]) {
    const battle = fixture();
    battle[key] = [];
    const matching = validateBattle(battle).errors.filter((item) => item.includes(`$.${key}`));
    assert.equal(matching.length, 1, key);
    assert.match(matching[0], /expected object/i, key);
  }
});

test("renderer-required collection members and nested containers reject malformed shapes", () => {
  const cases = [
    ["side item", (battle) => { battle.sides[0] = null; }, /\$\.sides\[0\].*expected object/i],
    ["actor item", (battle) => { battle.actors[0] = []; }, /\$\.actors\[0\].*expected object/i],
    ["place item", (battle) => { battle.places[0] = null; }, /\$\.places\[0\].*expected object/i],
    ["event item", (battle) => { battle.historical_events[0] = null; }, /\$\.historical_events\[0\].*expected object/i],
    ["movement item", (battle) => { battle.movements[0] = null; }, /\$\.movements\[0\].*expected object/i],
    ["engagement item", (battle) => { battle.engagements[0] = null; }, /\$\.engagements\[0\].*expected object/i],
    ["battle date", (battle) => { battle.battle.date = null; }, /\$\.battle\.date.*expected object/i],
    ["place geometry", (battle) => { delete battle.places[0].geometry; }, /\$\.places\[0\]\.geometry.*expected object/i],
    ["place coordinates", (battle) => { battle.places[0].geometry.coordinates = {}; }, /\$\.places\[0\]\.geometry\.coordinates.*expected array/i],
    ["point coordinate", (battle) => { battle.places[0].geometry.coordinates = [0]; }, /\$\.places\[0\]\.geometry\.coordinates.*coordinate pair/i],
    ["line coordinate", (battle) => { battle.places[0].geometry = { type: "LineString", coordinates: [null] }; }, /\$\.places\[0\]\.geometry\.coordinates\[0\].*coordinate pair/i],
    ["empty line", (battle) => { battle.places[0].geometry = { type: "LineString", coordinates: [] }; }, /\$\.places\[0\]\.geometry\.coordinates.*position/i],
    ["polygon ring", (battle) => { battle.places[0].geometry = { type: "Polygon", coordinates: [] }; }, /\$\.places\[0\]\.geometry\.coordinates.*ring/i],
    ["event time", (battle) => { delete battle.historical_events[0].time; }, /\$\.historical_events\[0\]\.time.*expected object/i],
    ["event actors", (battle) => { battle.historical_events[0].actor_ids = {}; }, /\$\.historical_events\[0\]\.actor_ids.*expected array/i],
    ["movement path", (battle) => { delete battle.movements[0].path; }, /\$\.movements\[0\]\.path.*expected object/i],
    ["movement coordinates", (battle) => { delete battle.movements[0].path.coordinates; }, /\$\.movements\[0\]\.path\.coordinates.*expected array/i],
    ["movement coordinate", (battle) => { battle.movements[0].path.coordinates[1] = null; }, /\$\.movements\[0\]\.path\.coordinates\[1\].*coordinate pair/i],
    ["event icon", (battle) => { battle.animation_hints.style.event_icons = { advance: 5 }; }, /\$\.animation_hints\.style\.event_icons\.advance.*expected string/i],
    ["map center", (battle) => { battle.animation_hints.map = { initial_center: [0] }; }, /\$\.animation_hints\.map\.initial_center.*coordinate pair/i],
    ["map zoom", (battle) => { battle.animation_hints.map = { initial_zoom: "8" }; }, /\$\.animation_hints\.map\.initial_zoom.*finite number/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = fixture();
    mutate(battle);
    const errors = validateBattle(battle).errors;
    assert.equal(errors.length, 1, `${label}: ${errors.join("\n")}`);
    assert.match(errors[0], expected, label);
  }
});

test("camera hints enforce the schema container, item, required fields, and shapes", () => {
  const cases = [
    ["camera object", (battle) => { battle.animation_hints.camera = {}; }, /\$\.animation_hints\.camera.*expected array/i],
    ["camera null", (battle) => { battle.animation_hints.camera = null; }, /\$\.animation_hints\.camera.*expected array/i],
    ["camera null item", (battle) => { battle.animation_hints.camera = [null]; }, /\$\.animation_hints\.camera\[0\].*expected object/i],
    ["camera array item", (battle) => { battle.animation_hints.camera = [[]]; }, /\$\.animation_hints\.camera\[0\].*expected object/i],
    ["camera event id missing", (battle) => { battle.animation_hints.camera = [{ center: [0, 0] }]; }, /\$\.animation_hints\.camera\[0\]\.event_id.*required/i],
    ["camera event id malformed", (battle) => { battle.animation_hints.camera = [{ event_id: "1 bad", center: [0, 0] }]; }, /\$\.animation_hints\.camera\[0\]\.event_id.*identifier/i],
    ["camera center missing", (battle) => { battle.animation_hints.camera = [{ event_id: "event-a" }]; }, /\$\.animation_hints\.camera\[0\]\.center.*required/i],
    ["camera center malformed", (battle) => { battle.animation_hints.camera = [{ event_id: "event-a", center: [0, Infinity] }]; }, /\$\.animation_hints\.camera\[0\]\.center.*coordinate pair/i],
    ["camera center too long", (battle) => { battle.animation_hints.camera = [{ event_id: "event-a", center: [0, 0, 0] }]; }, /\$\.animation_hints\.camera\[0\]\.center.*coordinate pair/i],
    ["camera zoom malformed", (battle) => { battle.animation_hints.camera = [{ event_id: "event-a", center: [0, 0], zoom: NaN }]; }, /\$\.animation_hints\.camera\[0\]\.zoom.*finite number/i],
    ["camera extra property", (battle) => { battle.animation_hints.camera = [{ event_id: "event-a", center: [0, 0], note: "extra" }]; }, /\$\.animation_hints\.camera\[0\]\.note.*additional property/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const battle = fixture();
    mutate(battle);
    const errors = validateBattle(battle).errors;
    assert.equal(errors.length, 1, `${label}: ${errors.join("\n")}`);
    assert.match(errors[0], expected, label);
  }

  const validWithoutZoom = fixture();
  validWithoutZoom.animation_hints.camera = [{ event_id: "event-a", center: [0, 0] }];
  assert.deepEqual(validateBattle(validWithoutZoom).errors, []);
});

test("camera hint event ids must resolve to historical events", () => {
  const battle = fixture();
  battle.animation_hints.camera = [{ event_id: "missing-event", center: [0, 0], zoom: 8 }];
  assert.match(messages(validateBattle(battle), "errors"), /animation_hints\.camera\[0\]\.event_id.*missing-event/i);
});

test("movement, event, and engagement times reject malformed and reversed ranges", () => {
  const battle = fixture();
  battle.movements[0].time.start = "bad";
  battle.historical_events[0].time = { start: "1815-06-18T10:10Z", end: "1815-06-18T10:00Z" };
  battle.engagements[0].time.end = "nope";
  const errors = messages(validateBattle(battle), "errors");
  assert.match(errors, /movements\[0\]\.time\.start.*invalid/i);
  assert.match(errors, /historical_events\[0\]\.time.*before start/i);
  assert.match(errors, /engagements\[0\]\.time\.end.*invalid/i);
});

test("present timing and waypoint containers must have the expected shape", () => {
  const battle = fixture();
  battle.historical_events[0].time = null;
  battle.movements[0].time = "10:00";
  battle.movements[0].waypoint_times = "10:00,10:10";
  battle.engagements[0].time = [];
  const errors = messages(validateBattle(battle), "errors");
  assert.match(errors, /historical_events\[0\]\.time.*expected object/i);
  assert.match(errors, /movements\[0\]\.time.*expected object/i);
  assert.match(errors, /movements\[0\]\.waypoint_times.*expected array/i);
  assert.match(errors, /engagements\[0\]\.time.*expected object/i);
});

test("waypoints enforce count, strict order, and explicit movement bounds", () => {
  const battle = fixture();
  battle.movements[0].path.coordinates.push([2, 2]);
  battle.movements[0].waypoint_times = [
    "1815-06-18T09:59:00Z",
    "1815-06-18T09:59:00Z",
    "1815-06-18T10:11:00Z",
    "1815-06-18T10:12:00Z",
  ];
  const errors = messages(validateBattle(battle), "errors");
  assert.match(errors, /waypoint_times.*count/i);
  assert.match(errors, /waypoint_times.*strictly increasing/i);
  assert.match(errors, /waypoint_times\[0\].*before movement start/i);
  assert.match(errors, /waypoint_times\[3\].*after movement end/i);
});

test("invalid and non-string waypoints each get one appropriate diagnostic", () => {
  const invalid = fixture();
  invalid.movements[0].waypoint_times[0] = "bad";
  const invalidErrors = validateBattle(invalid).errors.filter((item) => item.includes("waypoint_times[0]"));
  assert.equal(invalidErrors.length, 1);
  assert.match(invalidErrors[0], /invalid ISO battle time/i);

  const nonString = fixture();
  nonString.movements[0].waypoint_times[0] = 123;
  const nonStringErrors = validateBattle(nonString).errors.filter((item) => item.includes("waypoint_times[0]"));
  assert.equal(nonStringErrors.length, 1);
  assert.match(nonStringErrors[0], /expected string/i);
});

test("offset-bearing and local date-times cannot mix within a range", () => {
  const battle = fixture();
  battle.historical_events[0].time = { start: "1815-06-18" };
  battle.movements[0].time.start = "1815-06-18T10:00:00";
  assert.match(messages(validateBattle(battle), "errors"), /movements\[0\]\.time\.end.*mixed offset-bearing/i);
});

test("offset style is consistent across events, movements, waypoints, and engagements", () => {
  const battle = fixture();
  battle.historical_events[0].time.start = "1815-06-18T10:00:00";
  const errors = messages(validateBattle(battle), "errors");
  assert.match(errors, /historical_events\[0\]\.time\.end.*mixed offset-bearing/i);
  assert.match(errors, /movements\[0\]\.time\.start.*mixed offset-bearing/i);
  assert.match(errors, /movements\[0\]\.waypoint_times\[0\].*mixed offset-bearing/i);
  assert.match(errors, /engagements\[0\]\.time\.start.*mixed offset-bearing/i);
});

test("date-only and reduced dates do not participate in offset consistency", () => {
  const battle = fixture();
  battle.historical_events[0].time = { start: "1815", end: "1815-06-18" };
  assert.doesNotMatch(messages(validateBattle(battle), "errors"), /mixed offset-bearing/i);
});

test("v0.3 unknown actor icon and inferred high-confidence timing are warnings only", () => {
  const battle = fixture();
  battle.animation_hints.style.actor_icons["actor-a"] = "🚢";
  battle.movements[0].precision = "inferred";
  battle.movements[0].time.confidence = 0.9;
  const result = validateBattle(battle);
  assert.deepEqual(result.errors, []);
  assert.match(messages(result, "warnings"), /actor_icons\.actor-a.*unknown actor icon/i);
  assert.match(messages(result, "warnings"), /movements\[0\]\.time\.confidence.*<= 0\.6/i);
});

test("old v0.2 emoji actor icons remain allowed without warnings", () => {
  const battle = fixture("0.2.0");
  battle.animation_hints.style.actor_icons["actor-a"] = "🚢";
  assert.deepEqual(validateBattle(battle).warnings, []);
});

test("frontline snapshots require schema version 0.4.0", () => {
  for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
    const battle = frontlineBattle();
    battle.schema_version = version;
    assert.match(
      messages(validateBattle(battle), "errors"),
      /\$\.frontline_snapshots: requires schema_version "0\.4\.0"/,
    );
  }
  assert.doesNotMatch(
    messages(validateBattle(frontlineBattle()), "errors"),
    /\$\.frontline_snapshots: requires schema_version/,
  );
});

test("v0.4 unknown actor icons use the controlled-token warning", () => {
  const battle = frontlineBattle();
  battle.animation_hints.style.actor_icons["actor-a"] = "army";
  const result = validateBattle(battle);
  assert.deepEqual(result.errors, []);
  assert.match(messages(result, "warnings"), /actor_icons\.actor-a.*unknown actor icon token "army"/i);
});

test("disconnected overlapping movements are fatal", () => {
  const battle = fixture();
  const later = structuredClone(battle.movements[0]);
  later.id = "movement-b";
  later.time = { start: "1815-06-18T10:05:00Z", end: "1815-06-18T10:15:00Z", confidence: 0.5 };
  later.waypoint_times = [later.time.start, later.time.end];
  later.path.coordinates = [[9, 9], [10, 10]];
  battle.movements.push(later);
  assert.match(messages(validateBattle(battle), "errors"), /movements\[1\].*conflicting overlapping/i);
});

test("connected overlapping movements warn that later movement wins", () => {
  const battle = fixture();
  const later = structuredClone(battle.movements[0]);
  later.id = "movement-b";
  later.time = { start: "1815-06-18T10:05:00Z", end: "1815-06-18T10:15:00Z", confidence: 0.5 };
  later.waypoint_times = [later.time.start, later.time.end];
  later.path.coordinates = [[1, 1], [2, 2]];
  battle.movements.push(later);
  const result = validateBattle(battle);
  assert.deepEqual(result.errors, []);
  assert.match(messages(result, "warnings"), /movements\[1\].*overlap resolved.*later/i);
});

test("nested overlap checks every still-active previous movement", () => {
  const battle = fixture();
  battle.movements[0].time.end = "1815-06-18T10:20:00Z";
  battle.movements[0].waypoint_times[1] = battle.movements[0].time.end;
  const middle = structuredClone(battle.movements[0]);
  middle.id = "movement-middle";
  middle.time = { start: "1815-06-18T10:01:00Z", end: "1815-06-18T10:02:00Z", confidence: 0.5 };
  middle.waypoint_times = [middle.time.start, middle.time.end];
  middle.path.coordinates = [[1, 1], [2, 2]];
  const later = structuredClone(middle);
  later.id = "movement-later";
  later.time = { start: "1815-06-18T10:03:00Z", end: "1815-06-18T10:04:00Z", confidence: 0.5 };
  later.waypoint_times = [later.time.start, later.time.end];
  later.path.coordinates = [[2, 2], [3, 3]];
  battle.movements.push(middle, later);
  assert.match(messages(validateBattle(battle), "errors"), /movements\[2\].*conflicting overlapping/i);
});

test("existing cross-reference checks remain active", () => {
  const battle = fixture();
  battle.commanders[0].side_id = "missing-side";
  battle.movements[0].event_id = "missing-event";
  battle.engagements[0].target_actor_id = "missing-actor";
  const errors = messages(validateBattle(battle), "errors");
  assert.match(errors, /commanders\[0\]\.side_id.*missing-side/);
  assert.match(errors, /movements\[0\]\.event_id.*missing-event/);
  assert.match(errors, /engagements\[0\]\.target_actor_id.*missing-actor/);
});

function fakeDocument() {
  const makeElement = (id = "") => ({
    id,
    hidden: true,
    disabled: false,
    textContent: "",
    value: "",
    max: "",
    children: [],
    attributes: new Map(),
    style: {},
    replaceChildren(...children) { this.children = children; this.textContent = children.map((child) => child.textContent).join(""); },
    append(...children) { this.children.push(...children); this.textContent += children.map((child) => child.textContent).join(""); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
  });
  const ids = [
    "error-banner", "validation-warnings", "battle-map", "battle-name", "battle-date", "battle-summary",
    "legend", "timeline", "event-card-stack", "event-type", "event-title", "event-description",
    "event-precision", "event-confidence", "confidence-bar", "engagements", "event-scrubber",
    "event-progress", "historical-time", "compression-notice", "play-button", "reset-button",
    "prev-button", "next-button", "follow-button", "speed-controls", "file-input", "paste-button",
  ];
  const elements = new Map(ids.map((id) => [id, makeElement(id)]));
  const speedButtons = [0.5, 1, 2, 4].map((speed) => {
    const button = makeElement();
    button.dataset = { speed: String(speed) };
    return button;
  });
  elements.get("speed-controls").children = speedButtons;
  const documentRef = {
    getElementById: (id) => elements.get(id),
    createElement(tag) {
      const element = makeElement();
      element.tag = tag;
      return element;
    },
    querySelectorAll(selector) {
      return selector === "#speed-controls [data-speed]" ? speedButtons : [];
    },
    elements,
  };
  return documentRef;
}

test("frontline validation blocks fatal rendering but permits warning-only documents", () => {
  const documentRef = fakeDocument();
  const rendered = [];
  let destroyed = 0;
  const render = (battle) => {
    rendered.push(battle);
    return { destroy() { destroyed += 1; } };
  };
  const warned = frontlineBattle();
  delete warned.frontline_snapshots[0].time.start;
  const controller = animate.setBattleDocument(warned, {
    documentRef,
    render,
    wireControls() {},
  });
  assert.ok(controller);
  assert.equal(rendered.length, 1);
  assert.equal(documentRef.elements.get("validation-warnings").hidden, false);
  assert.match(
    documentRef.elements.get("validation-warnings").textContent,
    /snapshot without time\.start is excluded from animation/,
  );

  const invalid = frontlineBattle();
  invalid.frontline_snapshots[0].front_lines = [];
  const result = animate.setBattleDocument(invalid, {
    documentRef,
    render,
    wireControls() {},
    previousController: controller,
  });
  assert.equal(result, undefined);
  assert.equal(rendered.length, 1);
  assert.equal(destroyed, 1);
  assert.equal(documentRef.elements.get("error-banner").hidden, false);
});

test("warnings render safely without blocking and clear on replacement; fatal input destroys prior map", () => {
  const { setBattleDocument } = animate;
  const documentRef = fakeDocument();
  const rendered = [];
  let destroyed = 0;
  const render = (battle) => {
    rendered.push(battle);
    return { destroy() { destroyed += 1; } };
  };
  const warned = fixture();
  warned.animation_hints.style.actor_icons["actor-a"] = "<img src=x onerror=alert(1)>";
  const first = setBattleDocument(warned, { documentRef, render, wireControls() {} });
  assert.equal(rendered.length, 1);
  assert.equal(documentRef.elements.get("validation-warnings").hidden, false);
  assert.match(documentRef.elements.get("validation-warnings").textContent, /<img src=x/);

  const second = setBattleDocument(fixture(), { documentRef, render, wireControls() {}, previousController: first });
  assert.equal(rendered.length, 2);
  assert.equal(documentRef.elements.get("validation-warnings").hidden, true);

  const fatal = fixture();
  fatal.movements[0].time.start = "bad";
  const result = setBattleDocument(fatal, { documentRef, render, wireControls() {}, previousController: second });
  assert.equal(result, undefined);
  assert.equal(rendered.length, 2);
  assert.equal(destroyed, 2);
  assert.equal(documentRef.elements.get("error-banner").hidden, false);
});

test("malformed renderer collection blocks rendering and destroys the previous controller", () => {
  const documentRef = fakeDocument();
  let renderCalls = 0;
  let destroyCalls = 0;
  const malformed = fixture();
  malformed.sides = {};
  const result = animate.setBattleDocument(malformed, {
    documentRef,
    render() { renderCalls += 1; },
    wireControls() {},
    previousController: { destroy() { destroyCalls += 1; } },
  });
  assert.equal(result, undefined);
  assert.equal(renderCalls, 0);
  assert.equal(destroyCalls, 1);
  assert.match(documentRef.elements.get("error-banner").textContent, /\$\.sides.*expected array/i);
});

test("malformed renderer members and nested shapes never render and tear down safely", () => {
  const cases = [
    (battle) => { battle.actors[0] = null; },
    (battle) => { delete battle.places[0].geometry; },
    (battle) => { delete battle.movements[0].path.coordinates; },
    (battle) => { battle.animation_hints.style.event_icons = { advance: 5 }; },
    (battle) => { battle.animation_hints.map = { initial_center: null }; },
    (battle) => { battle.animation_hints.map = { initial_zoom: Number.POSITIVE_INFINITY }; },
    (battle) => { battle.animation_hints.camera = {}; },
    (battle) => { battle.animation_hints.camera = null; },
    (battle) => { battle.animation_hints.camera = [null]; },
    (battle) => { battle.animation_hints.camera = [{ event_id: "event-a", center: null }]; },
  ];
  for (const mutate of cases) {
    const documentRef = fakeDocument();
    let renderCalls = 0;
    let destroyCalls = 0;
    const malformed = fixture();
    mutate(malformed);
    const result = animate.setBattleDocument(malformed, {
      documentRef,
      render() { renderCalls += 1; },
      wireControls() {},
      previousController: { destroy() { destroyCalls += 1; } },
    });
    assert.equal(result, undefined);
    assert.equal(renderCalls, 0);
    assert.equal(destroyCalls, 1);
    assert.equal(documentRef.elements.get("error-banner").hidden, false);
  }
});

test("fatal validation resets every derived battle field and transport then a valid load recovers", () => {
  const documentRef = fakeDocument();
  for (const id of [
    "battle-name", "battle-date", "battle-summary", "event-type", "event-title", "event-description",
    "event-precision", "event-confidence", "event-progress", "historical-time", "compression-notice",
  ]) documentRef.elements.get(id).textContent = `stale-${id}`;
  for (const id of ["legend", "timeline", "event-card-stack", "engagements"]) {
    documentRef.elements.get(id).children = [{ textContent: "stale" }];
  }
  const scrubber = documentRef.elements.get("event-scrubber");
  scrubber.value = "900";
  scrubber.max = "1800";
  let destroyed = 0;
  const invalid = fixture();
  invalid.movements[0].time.start = "bad";

  const failed = animate.setBattleDocument(invalid, {
    documentRef,
    render() { throw new Error("must not render"); },
    wireControls() {},
    previousController: { destroy() { destroyed += 1; } },
  });

  assert.equal(failed, undefined);
  assert.equal(destroyed, 1);
  for (const id of [
    "battle-name", "battle-date", "battle-summary", "event-type", "event-title", "event-description",
    "event-precision", "event-confidence",
  ]) assert.equal(documentRef.elements.get(id).textContent, "", id);
  for (const id of ["legend", "timeline", "event-card-stack", "engagements"]) {
    assert.equal(documentRef.elements.get(id).children.length, 0, id);
  }
  assert.equal(documentRef.elements.get("event-progress").textContent, "0 / 0");
  assert.equal(documentRef.elements.get("historical-time").textContent, "Animation time 00:00");
  assert.equal(scrubber.value, "0");
  assert.equal(scrubber.max, "0");
  for (const id of ["play-button", "reset-button", "prev-button", "next-button", "follow-button", "event-scrubber"]) {
    assert.equal(documentRef.elements.get(id).disabled, true, id);
  }
  assert.equal(documentRef.elements.get("file-input").disabled, false);
  assert.equal(documentRef.elements.get("paste-button").disabled, false);

  const recovered = animate.setBattleDocument(fixture(), {
    documentRef,
    render() {
      documentRef.elements.get("battle-name").textContent = "Recovered";
      return { destroy() {} };
    },
    wireControls() {},
  });
  assert.ok(recovered);
  assert.equal(documentRef.elements.get("battle-name").textContent, "Recovered");
  assert.equal(documentRef.elements.get("play-button").disabled, false);
  assert.equal(scrubber.disabled, false);
});

test("text parser resets stale UI on parse failure and safely recovers on the next valid document", () => {
  const documentRef = fakeDocument();
  let destroyed = 0;
  const render = (battle) => {
    documentRef.elements.get("battle-name").textContent = battle.battle.name;
    return { destroy() { destroyed += 1; } };
  };
  const first = animate.setBattleDocumentFromText(JSON.stringify(fixture()), { documentRef, render, wireControls() {} });
  assert.ok(first);
  const failed = animate.setBattleDocumentFromText("{broken", {
    documentRef,
    render,
    wireControls() {},
    previousController: first,
  });
  assert.equal(failed, undefined);
  assert.equal(destroyed, 1);
  assert.equal(documentRef.elements.get("battle-name").textContent, "");
  assert.match(documentRef.elements.get("error-banner").textContent, /Invalid JSON/i);
  const recovered = animate.setBattleDocumentFromText(JSON.stringify(fixture()), { documentRef, render, wireControls() {} });
  assert.ok(recovered);
  assert.equal(documentRef.elements.get("battle-name").textContent, "Test");
  assert.equal(documentRef.elements.get("play-button").disabled, false);
});

test("index delegates pasted text parsing to the production document parser", () => {
  const source = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(source, /setBattleDocumentFromText/);
  assert.doesNotMatch(source, /JSON\.parse\(text\)/);
});

import assert from "node:assert/strict";
import test from "node:test";

import * as animate from "../app/animate.js";

const { validateBattle } = animate;

function fixture(version = "0.3.0") {
  const battle = {
    schema_version: version,
    metadata: {},
    battle: {},
    sides: [{ id: "side-a" }, { id: "side-b" }],
    commanders: [{ id: "commander-a", side_id: "side-a" }],
    actors: [
      { id: "actor-a", side_id: "side-a", commander_ids: ["commander-a"] },
      { id: "actor-b", side_id: "side-b", commander_ids: [] },
    ],
    places: [{ id: "place-a" }, { id: "place-b" }],
    historical_events: [{
      id: "event-a",
      type: "advance",
      actor_ids: ["actor-a"],
      target_actor_ids: ["actor-b"],
      place_ids: ["place-a"],
      source_ids: ["source-a"],
      time: { start: "1815-06-18T10:00:00Z", end: "1815-06-18T10:10:00Z" },
    }],
    movements: [{
      id: "movement-a",
      event_id: "event-a",
      actor_id: "actor-a",
      from_place_id: "place-a",
      to_place_id: "place-b",
      precision: "exact",
      time: { start: "1815-06-18T10:00:00Z", end: "1815-06-18T10:10:00Z", confidence: 0.5 },
      path: { coordinates: [[0, 0], [1, 1]] },
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

function messages(result, kind) {
  return result[kind].join("\n");
}

test("valid v0.3 document has structured empty diagnostics", () => {
  assert.deepEqual(validateBattle(fixture()), { errors: [], warnings: [] });
});

test("non-object input returns structured errors", () => {
  const result = validateBattle(null);
  assert.ok(result.errors.some((item) => item.includes("not a JSON object")));
  assert.deepEqual(result.warnings, []);
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
  const elements = new Map(["error-banner", "validation-warnings", "battle-map"].map((id) => [id, {
    id,
    hidden: true,
    textContent: "",
    replaceChildren(...children) { this.children = children; this.textContent = children.map((child) => child.textContent).join(""); },
    append(...children) { this.children = [...(this.children || []), ...children]; this.textContent += children.map((child) => child.textContent).join(""); },
  }]));
  return {
    getElementById: (id) => elements.get(id),
    createElement(tag) {
      return {
        tag,
        textContent: "",
        children: [],
        append(...children) { this.children.push(...children); this.textContent += children.map((child) => child.textContent).join(""); },
      };
    },
    elements,
  };
}

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

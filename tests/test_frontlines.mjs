import assert from "node:assert/strict";
import test from "node:test";

import * as frontlineGeometry from "../app/frontlines.js";
import {
  deriveFrontlineFallback,
  enclosureLineIds,
  interpolateFrontlineSnapshots,
  isClosedFrontline,
  resampleLine,
  resampleRing,
  selectFrontlineInfluences,
} from "../app/frontlines.js";

const line = (id, coordinates) => ({
  id,
  geometry: { type: "LineString", coordinates },
});

const area = (id, sideId, coordinates) => ({
  id,
  side_id: sideId,
  geometry: { type: "Polygon", coordinates },
});

test("isClosedFrontline recognizes closed rings and rejects open lines", () => {
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [1, 1], [0, 0]]), true);
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [1, 1], [0, 1]]), false);
});

test("isClosedFrontline uses inclusive tolerance and wrapped longitude", () => {
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [1, 1], [0.000001, 0.000001]]), true);
  assert.equal(isClosedFrontline([[0, 0], [2, 0], [1, 1], [0.0000011, 0]]), false);
  assert.equal(isClosedFrontline([[180, 0], [170, 1], [-170, 1], [-180, 0]]), true);
});

test("isClosedFrontline rejects degenerate and malformed coordinates without mutation", () => {
  const valid = [[0, 0], [2, 0], [1, 1], [0, 0]];
  const before = JSON.stringify(valid);
  assert.equal(isClosedFrontline([[0, 0], [1, 1], [0, 0]]), false);
  assert.equal(isClosedFrontline([[0, 0], [1, 1], null, [0, 0]]), false);
  assert.equal(isClosedFrontline(null), false);
  assert.equal(isClosedFrontline(valid), true);
  assert.equal(JSON.stringify(valid), before);
});

test("enclosureLineIds returns stable open-to-closed IDs in source order", () => {
  const before = {
    front_lines: [
      line("second", [[10, 0], [11, 1], [10, 1], [10, 2]]),
      line("first", [[0, 0], [2, 0], [1, 1], [0, 1]]),
      line("reopened", [[20, 0], [22, 0], [21, 1], [20, 0]]),
      line(undefined, [[30, 0], [32, 0], [31, 1], [30, 1]]),
    ],
  };
  const after = {
    front_lines: [
      line("first", [[0, 0], [2, 0], [1, 1], [0, 0]]),
      line("second", [[10, 0], [11, 1], [10, 1], [10, 0]]),
      line("reopened", [[20, 0], [22, 0], [21, 1], [20, 2]]),
      line(undefined, [[30, 0], [32, 0], [31, 1], [30, 0]]),
    ],
  };
  const inputs = JSON.stringify([before, after]);

  const ids = enclosureLineIds(before, after);

  assert.deepEqual(ids, ["second", "first"]);
  assert.notEqual(ids, enclosureLineIds(before, after));
  assert.equal(JSON.stringify([before, after]), inputs);
});

test("enclosureLineIds excludes non-LineStrings and malformed or missing matches", () => {
  const malformed = { id: "bad", geometry: { type: "LineString", coordinates: null } };
  const polygon = { id: "polygon", geometry: { type: "Polygon", coordinates: [] } };
  assert.deepEqual(enclosureLineIds(
    { front_lines: [malformed, polygon, line("missing", [[0, 0], [1, 0], [1, 1], [0, 1]])] },
    { front_lines: [line("bad", [[0, 0], [2, 0], [1, 1], [0, 0]]), polygon] },
  ), []);
  assert.deepEqual(enclosureLineIds(null, null), []);
});

test("resampleLine includes endpoints and returns fresh coordinates", () => {
  const input = [[0, 0], [10, 0]];
  const sampled = resampleLine(input, 3);
  assert.deepEqual(sampled, [[0, 0], [5, 0], [10, 0]]);
  assert.notEqual(sampled, input);
  assert.notEqual(sampled[0], input[0]);
  assert.deepEqual(input, [[0, 0], [10, 0]]);
});

test("resampleLine locally unwraps dateline crossings", () => {
  const midpoint = resampleLine([[179, 0], [-179, 0]], 3)[1][0];
  assert.equal(Math.abs(midpoint), 180);
});

test("resampleRing returns the requested unique samples plus a fresh closing point", () => {
  const input = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const sampled = resampleRing(input, 4);
  assert.equal(sampled.length, 5);
  assert.deepEqual(sampled.at(-1), sampled[0]);
  assert.notEqual(sampled.at(-1), sampled[0]);
  assert.equal(new Set(sampled.slice(0, -1).map(String)).size, 4);
  assert.deepEqual(input.at(-1), input[0]);
});

test("matching stable IDs interpolate compatible lines and polygon rings", () => {
  const from = {
    precision: "approximate",
    confidence: 0.7,
    front_lines: [line("main", [[0, 0], [10, 0]])],
    control_areas: [area("held", "blue", [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]])],
  };
  const to = {
    precision: "inferred",
    confidence: 0.4,
    front_lines: [line("main", [[0, 2], [10, 2]])],
    control_areas: [area("held", "blue", [[[2, 0], [4, 0], [4, 2], [2, 2], [2, 0]]])],
  };

  const result = interpolateFrontlineSnapshots(from, to, 0.5);
  assert.deepEqual(result.interpolatedLines[0].geometry.coordinates[0], [0, 1]);
  assert.deepEqual(result.interpolatedLines[0].geometry.coordinates.at(-1), [10, 1]);
  assert.equal(result.interpolatedLines[0].precision, "inferred");
  assert.equal(result.interpolatedLines[0].confidence, 0.4);
  assert.equal(result.interpolatedAreas[0].sideId, "blue");
  assert.deepEqual(result.interpolatedAreas[0].geometry.coordinates[0][0], [1, 0]);
  assert.equal(result.interpolatedAreas[0].precision, "inferred");
  assert.equal(result.interpolatedAreas[0].confidence, 0.4);
});

test("equivalent reversed lines retain their shape during interpolation", () => {
  const from = { front_lines: [line("main", [[179, 0], [-179, 0], [-178, 1]])] };
  const to = { front_lines: [line("main", [[-178, 1], [-179, 0], [179, 0]])] };
  const before = JSON.stringify([from, to]);

  const coordinates = interpolateFrontlineSnapshots(from, to, 0.5)
    .interpolatedLines[0].geometry.coordinates;

  assert.equal(coordinates.length, 48);
  assert.ok(coordinates.some((point) => Math.abs(point[1] - 1) < 0.01));
  assert.ok(coordinates.every(([longitude]) => Math.abs(longitude) > 170));
  assert.equal(JSON.stringify([from, to]), before);
});

test("equivalent rotated and reversed rings retain their shape during interpolation", () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const rotatedReversed = [[4, 4], [4, 0], [0, 0], [0, 4], [4, 4]];
  const from = { control_areas: [area("held", "blue", [square])] };
  const to = { control_areas: [area("held", "blue", [rotatedReversed])] };
  const before = JSON.stringify([from, to]);

  const ring = interpolateFrontlineSnapshots(from, to, 0.5)
    .interpolatedAreas[0].geometry.coordinates[0];

  assert.equal(ring.length, 65);
  assert.deepEqual(ring.at(-1), ring[0]);
  assert.notEqual(ring.at(-1), ring[0]);
  assert.ok(Math.max(...ring.map(([x]) => x)) - Math.min(...ring.map(([x]) => x)) > 3.9);
  assert.ok(Math.max(...ring.map(([, y]) => y)) - Math.min(...ring.map(([, y]) => y)) > 3.9);
  assert.equal(JSON.stringify([from, to]), before);
});

test("unmatched IDs and incompatible polygon ring counts crossfade", () => {
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]];
  const result = interpolateFrontlineSnapshots(
    {
      front_lines: [line("old", [[0, 0], [1, 0]])],
      control_areas: [area("held", "a", [outer])],
    },
    {
      front_lines: [line("new", [[0, 1], [1, 1]])],
      control_areas: [area("held", "a", [outer, hole])],
    },
    0.5,
  );

  assert.deepEqual(result.interpolatedLines, []);
  assert.deepEqual(result.interpolatedAreas, []);
  assert.deepEqual(result.exitingLines.map(({ id }) => id), ["old"]);
  assert.deepEqual(result.enteringLines.map(({ id }) => id), ["new"]);
  assert.deepEqual(result.exitingAreas.map(({ id }) => id), ["held"]);
  assert.deepEqual(result.enteringAreas.map(({ id }) => id), ["held"]);
});

test("snapshot interpolation does not mutate either snapshot", () => {
  const from = { front_lines: [line("main", [[179, 0], [-179, 0]])], control_areas: [] };
  const to = { front_lines: [line("main", [[178, 2], [-178, 2]])], control_areas: [] };
  const before = JSON.stringify([from, to]);
  interpolateFrontlineSnapshots(from, to, 0.5);
  assert.equal(JSON.stringify([from, to]), before);
});

test("transition metadata keeps approximate over exact precision", () => {
  const result = interpolateFrontlineSnapshots(
    { precision: "exact", confidence: 0.8, front_lines: [line("main", [[0, 0], [1, 0]])] },
    { precision: "approximate", confidence: 0.6, front_lines: [line("main", [[0, 1], [1, 1]])] },
    0.5,
  );
  assert.equal(result.interpolatedLines[0].precision, "approximate");
  assert.equal(result.interpolatedLines[0].confidence, 0.6);
});

const actors = [
  { id: "a1", side_id: "a", kind: "division" },
  { id: "a2", side_id: "a", kind: "brigade" },
  { id: "b1", side_id: "b", kind: "corps" },
  { id: "ship", side_id: "b", kind: "ship" },
];

test("fallback emits eligible influences and fixed uncertainty metadata", () => {
  const positions = new Map([
    ["a1", [0, 0]], ["a2", [0, 2]], ["b1", [4, 1]], ["ship", [1, 1]],
  ]);
  const derived = deriveFrontlineFallback({ actors, positions, maxPairDistance: 10 });
  assert.equal(derived.confidence, 0.35);
  assert.equal(derived.precision, "inferred");
  assert.equal(derived.label, "DERIVED FROM UNIT POSITIONS");
  assert.equal(derived.influences.some(({ actorId }) => actorId === "ship"), false);
  assert.deepEqual(derived.influences.map(({ actorId }) => actorId), ["a1", "a2", "b1"]);
});

test("frontline influences select positioned leaf land units", () => {
  const actors = [
    { id: "corps", side_id: "a", kind: "corps" },
    { id: "division", parent_id: "corps", side_id: "a", kind: "division" },
    { id: "enemy", side_id: "b", kind: "division" },
  ];
  const positions = new Map([["corps", [0, 0]], ["division", [1, 0]], ["enemy", [4, 0]]]);

  assert.deepEqual(selectFrontlineInfluences(actors, positions), [
    { actorId: "division", sideId: "a", position: [1, 0] },
    { actorId: "enemy", sideId: "b", position: [4, 0] },
  ]);
  assert.deepEqual(deriveFrontlineFallback({ actors, positions }).influences.map(({ actorId }) => actorId), [
    "division", "enemy",
  ]);
});

test("ineligible positioned children do not suppress eligible land parents", () => {
  const actors = [
    { id: "corps", side_id: "a", kind: "corps" },
    { id: "ship", parent_id: "corps", side_id: "a", kind: "ship" },
    { id: "enemy", side_id: "b", kind: "division" },
  ];
  const positions = new Map([["corps", [0, 0]], ["ship", [1, 0]], ["enemy", [4, 0]]]);

  assert.deepEqual(selectFrontlineInfluences(actors, positions).map(({ actorId }) => actorId), [
    "corps", "enemy",
  ]);
});

test("fallback is unavailable unless eligible land influences occupy exactly two sides", () => {
  const oneSide = deriveFrontlineFallback({
    actors: [{ id: "a", side_id: "a", kind: "division" }],
    positions: new Map([["a", [0, 0]]]),
  });
  const threeSides = deriveFrontlineFallback({
    actors: ["a", "b", "c"].map((id, index) => ({ id, side_id: id, kind: "division" })),
    positions: new Map([["a", [0, 0]], ["b", [2, 0]], ["c", [4, 0]]]),
  });

  for (const derived of [oneSide, threeSides]) {
    assert.equal(derived.available, false);
    assert.equal(derived.reason, "requires-two-sides");
    assert.deepEqual(derived.pairs, []);
    assert.equal(derived.contactLine, null);
    assert.deepEqual(derived.contactLines, []);
  }
  assert.deepEqual(oneSide.influences.map(({ actorId }) => actorId), ["a"]);
  assert.deepEqual(threeSides.influences.map(({ actorId }) => actorId), ["a", "b", "c"]);
});

const fieldActors = [
  { id: "a1", side_id: "a", kind: "division" },
  { id: "a2", side_id: "a", kind: "division" },
  { id: "b1", side_id: "b", kind: "division" },
  { id: "b2", side_id: "b", kind: "division" },
];
const fieldBounds = [[-1, -1], [5, 5]];
const fieldPositions = () => new Map([
  ["a1", [0, 0]], ["a2", [0, 4]], ["b1", [4, 0]], ["b2", [4, 4]],
]);

function xNearY(lines, targetY) {
  return lines.flat()
    .sort((left, right) => Math.abs(left[1] - targetY) - Math.abs(right[1] - targetY))
    .slice(0, 4)
    .reduce((total, [x]) => total + x, 0) / 4;
}

test("influence field forms a vertical front between two unit rows", () => {
  const derived = deriveFrontlineFallback({
    actors: fieldActors,
    positions: fieldPositions(),
    bounds: fieldBounds,
    gridSize: 24,
    maxPairDistance: 6,
  });

  assert.equal(derived.available, true);
  assert.equal(derived.reason, null);
  assert.ok(derived.contactLines.length >= 1);
  assert.ok(derived.contactLines.flat().every(([x]) => Math.abs(x - 2) < 0.4));
  assert.deepEqual(derived.contactLine, derived.contactLines[0]);
  assert.deepEqual(derived.pairs, []);
});

test("contact filtering retains an endpoint on the inclusive half-distance boundary", () => {
  const derived = deriveFrontlineFallback({
    actors: [
      { id: "a", side_id: "a", kind: "division" },
      { id: "b", side_id: "b", kind: "division" },
    ],
    positions: new Map([["a", [0, 0]], ["b", [4, 0]]]),
    gridSize: 3,
    maxPairDistance: 4,
  });

  assert.equal(derived.available, true);
  assert.ok(derived.contactLines.length > 0);
});

test("ambiguous marching cells use the bilinear asymptotic decider", () => {
  assert.deepEqual(
    frontlineGeometry.ambiguousEdgePairs([0.0830, -0.9238, 0.3564, -0.0287]),
    [[0, 1], [2, 3]],
  );
  assert.deepEqual(
    frontlineGeometry.ambiguousEdgePairs([1, -1, 1, -1]),
    [[0, 1], [2, 3]],
  );
});

test("numeric contact-line ordering stays left-to-right across ten degrees", () => {
  const orderedBefore = frontlineGeometry.canonicalizeContactLines([
    [[10.004, 1], [10.004, -1]],
    [[9.995, -1], [9.995, 1]],
  ]);
  const orderedAfter = frontlineGeometry.canonicalizeContactLines([
    [[10.014, 1], [10.014, -1]],
    [[10.005, -1], [10.005, 1]],
  ]);

  assert.deepEqual(orderedBefore.map((line) => line[0][0]), [9.995, 10.004]);
  assert.deepEqual(orderedAfter.map((line) => line[0][0]), [10.005, 10.014]);
  assert.ok(orderedBefore[0][0][1] < orderedBefore[0].at(-1)[1]);
  assert.ok(orderedAfter[0][0][1] < orderedAfter[0].at(-1)[1]);
});

test("grid-vertex zeroes do not emit duplicate or degenerate contact coordinates", () => {
  const sideA = [[-1, 0], [1, 0], [0, 1]];
  const sideB = [[0, -1], [1, 1]];
  const actors = [
    ...sideA.map((_, index) => ({ id: `a${index}`, side_id: "a", kind: "division" })),
    ...sideB.map((_, index) => ({ id: `b${index}`, side_id: "b", kind: "division" })),
  ];
  const positions = new Map([
    ...sideA.map((point, index) => [`a${index}`, point]),
    ...sideB.map((point, index) => [`b${index}`, point]),
  ]);
  const derived = deriveFrontlineFallback({
    actors,
    positions,
    bounds: [[-1, -1], [1, 1]],
    gridSize: 3,
  });

  assert.ok(derived.contactLine.length >= 2);
  for (const coordinates of derived.contactLines) {
    assert.ok(new Set(coordinates.map(([x, y]) => `${x},${y}`)).size >= 2);
    for (let index = 1; index < coordinates.length; index += 1) {
      assert.notDeepEqual(coordinates[index], coordinates[index - 1]);
    }
  }
});

test("grid-vertex crossings stitch one continuous diagonal contact line", () => {
  const actors = [
    { id: "a", side_id: "a", kind: "division" },
    { id: "b", side_id: "b", kind: "division" },
  ];
  const positions = new Map([["a", [0, 1]], ["b", [1, 0]]]);

  for (const gridSize of [5, 31]) {
    const derived = deriveFrontlineFallback({ actors, positions, gridSize });
    assert.equal(derived.contactLines.length, 1, `gridSize ${gridSize}`);
    assert.ok(derived.contactLine.length >= 2, `gridSize ${gridSize}`);
  }
});

test("a local advance bends only the nearby derived front", () => {
  const before = deriveFrontlineFallback({
    actors: fieldActors,
    positions: fieldPositions(),
    bounds: fieldBounds,
    gridSize: 32,
    maxPairDistance: 6,
  });
  const advanced = fieldPositions();
  advanced.set("a2", [2, 4]);
  const after = deriveFrontlineFallback({
    actors: fieldActors,
    positions: advanced,
    bounds: fieldBounds,
    gridSize: 32,
    maxPairDistance: 6,
  });

  assert.ok(xNearY(after.contactLines, 4) > xNearY(before.contactLines, 4) + 0.5);
  assert.ok(Math.abs(xNearY(after.contactLines, 0) - xNearY(before.contactLines, 0)) < 0.25);
});

test("derived contours are deterministic and independent of actor and map order", () => {
  const options = {
    actors: fieldActors,
    positions: fieldPositions(),
    bounds: fieldBounds,
    gridSize: 24,
    maxPairDistance: 6,
  };
  const forward = deriveFrontlineFallback(options);
  const reversed = deriveFrontlineFallback({
    ...options,
    actors: [...fieldActors].reverse(),
    positions: new Map([...fieldPositions()].reverse()),
    bounds: [...fieldBounds].reverse(),
  });

  assert.deepEqual(deriveFrontlineFallback(options), forward);
  assert.deepEqual(reversed, forward);
});

test("derived contours close around an enclosed side", () => {
  const enclosureActors = [
    { id: "a1", side_id: "a", kind: "division" },
    { id: "a2", side_id: "a", kind: "division" },
    ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => ({ id, side_id: "b", kind: "division" })),
  ];
  const enclosurePositions = new Map([
    ["a1", [-0.75, 0]], ["a2", [0.75, 0]],
    ["b1", [-4, -4]], ["b2", [0, -4]], ["b3", [4, -4]],
    ["b4", [4, 4]], ["b5", [0, 4]], ["b6", [-4, 4]],
  ]);
  const derived = deriveFrontlineFallback({
    actors: enclosureActors,
    positions: enclosurePositions,
    bounds: [[-5, -5], [5, 5]],
    gridSize: 40,
  });

  assert.ok(derived.contactLines.some((coordinates) => isClosedFrontline(coordinates)));
});

test("influence field unwraps dateline bounds and does not mutate inputs", () => {
  const datelineActors = [...fieldActors];
  const positions = new Map([
    ["a1", [179, 0]], ["a2", [179, 4]], ["b1", [-179, 0]], ["b2", [-179, 4]],
  ]);
  const bounds = [[178, -1], [-178, 5]];
  const before = JSON.stringify({ actors: datelineActors, positions: [...positions], bounds });
  const derived = deriveFrontlineFallback({
    actors: datelineActors,
    positions,
    bounds,
    gridSize: 24,
    maxPairDistance: 4,
  });

  assert.equal(derived.available, true);
  assert.ok(derived.contactLines.flat().every(([longitude, latitude]) =>
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && Number.isFinite(latitude)));
  assert.equal(JSON.stringify({ actors: datelineActors, positions: [...positions], bounds }), before);
});

test("malformed bounds fall back safely to deterministic data bounds", () => {
  const derived = deriveFrontlineFallback({
    actors: fieldActors,
    positions: fieldPositions(),
    bounds: [[0, 0], [Number.NaN, 4]],
    gridSize: 24,
    maxPairDistance: 6,
  });

  assert.equal(derived.available, true);
  assert.ok(derived.contactLines.flat().every((point) => point.every(Number.isFinite)));
});

test("coincident opposing units retain influences without a contact line", () => {
  const derived = deriveFrontlineFallback({
    actors: [
      { id: "a", side_id: "a", kind: "army" },
      { id: "b", side_id: "b", kind: "army" },
    ],
    positions: new Map([["a", [1, 1]], ["b", [1, 1]]]),
    maxPairDistance: 10,
  });
  assert.equal(derived.influences.length, 2);
  assert.equal(derived.contactLine, null);
});

test("one side or over-distance enemies retain influences without a contact line", () => {
  const oneSide = deriveFrontlineFallback({
    actors: actors.slice(0, 2),
    positions: new Map([["a1", [0, 0]], ["a2", [1, 0]]]),
    maxPairDistance: 10,
  });
  assert.equal(oneSide.influences.length, 2);
  assert.equal(oneSide.contactLine, null);

  const distant = deriveFrontlineFallback({
    actors: [actors[0], actors[2]],
    positions: new Map([["a1", [0, 0]], ["b1", [20, 0]]]),
    maxPairDistance: 10,
  });
  assert.equal(distant.influences.length, 2);
  assert.equal(distant.contactLine, null);
  assert.deepEqual(distant.pairs, []);
});

test("fallback excludes generic and non-land actor kinds", () => {
  const kinds = ["army", "corps", "division", "brigade", "regiment", "unit", "ship", "fleet", "person", "other"];
  const allActors = kinds.map((kind, index) => ({ id: `u${index}`, side_id: index % 2 ? "b" : "a", kind }));
  const positions = new Map(allActors.map((actor, index) => [actor.id, [index, 0]]));
  const derived = deriveFrontlineFallback({ actors: allActors, positions, maxPairDistance: 20 });
  assert.deepEqual(derived.influences.map(({ actorId }) => actorId), ["u0", "u1", "u2", "u3", "u4"]);
});

test("fallback never reads combat strength, casualties, or outcome", () => {
  const guarded = new Proxy(
    { id: "a1", side_id: "a", kind: "division" },
    {
      get(target, property, receiver) {
        if (["strength", "casualties", "outcome"].includes(property)) {
          throw new Error(`forbidden read: ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const derived = deriveFrontlineFallback({
    actors: [guarded, { id: "b1", side_id: "b", kind: "division" }],
    positions: new Map([["a1", [0, 0]], ["b1", [2, 0]]]),
    maxPairDistance: 10,
  });
  assert.equal(derived.influences.length, 2);
  assert.deepEqual(derived.pairs, []);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ACTOR_ICON_TOKENS, SYMBOL_DEFS, resolveSymbol } from "../app/symbols.js";

const EXPECTED_TOKENS = [
  "warship_generic",
  "warship_ironclad",
  "warship_battleship",
  "warship_armored_cruiser",
  "warship_protected_cruiser",
  "warship_destroyer",
  "warship_torpedo_boat",
  "naval_transport",
  "fleet_generic",
  "infantry",
  "cavalry",
  "artillery",
  "armor",
  "engineer",
  "logistics",
  "headquarters",
  "fortress",
  "aircraft",
  "aircraft_fighter",
  "aircraft_bomber",
  "unit_generic",
];

const SVG_NUMBER_SOURCE = String.raw`[+-]?(?:\d+\.?(?:\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const SVG_COMMAND_ARITY = Object.freeze({ M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 });

function tokenizeSvgPath(path) {
  if (typeof path !== "string" || path.trim() === "") return null;
  const whitespace = /[\t\n\f\r ]*/y;
  const command = /[MmLlHhVvCcSsQqTtAaZz]/y;
  const number = new RegExp(SVG_NUMBER_SOURCE, "y");
  const tokens = [];
  let index = 0;
  let previousType = null;

  while (index < path.length) {
    whitespace.lastIndex = index;
    whitespace.exec(path);
    index = whitespace.lastIndex;
    if (index === path.length) break;

    let hasComma = false;
    if (path[index] === ",") {
      if (previousType !== "number") return null;
      hasComma = true;
      index += 1;
      whitespace.lastIndex = index;
      whitespace.exec(path);
      index = whitespace.lastIndex;
      if (index === path.length || path[index] === ",") return null;
    }

    command.lastIndex = index;
    const commandMatch = command.exec(path);
    if (commandMatch) {
      if (hasComma) return null;
      tokens.push({ type: "command", value: commandMatch[0] });
      index = command.lastIndex;
      previousType = "command";
      continue;
    }

    number.lastIndex = index;
    const numberMatch = number.exec(path);
    if (!numberMatch) return null;
    const value = Number(numberMatch[0]);
    if (!Number.isFinite(value)) return null;
    tokens.push({ type: "number", value, raw: numberMatch[0] });
    index = number.lastIndex;
    previousType = "number";
  }

  return tokens;
}

function isValidSvgPath(path) {
  const tokens = tokenizeSvgPath(path);
  if (!tokens?.length || tokens[0].type !== "command" || tokens[0].value.toUpperCase() !== "M") return false;

  let currentCommand = null;
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index].type === "command") {
      currentCommand = tokens[index].value.toUpperCase();
      index += 1;
      if (currentCommand === "Z") {
        currentCommand = null;
        continue;
      }
    }
    if (!currentCommand || !(currentCommand in SVG_COMMAND_ARITY)) return false;

    const parameters = [];
    while (index < tokens.length && tokens[index].type === "number") {
      parameters.push(tokens[index]);
      index += 1;
    }
    const arity = SVG_COMMAND_ARITY[currentCommand];
    if (parameters.length === 0 || parameters.length % arity !== 0) return false;
    if (currentCommand === "A") {
      for (let group = 0; group < parameters.length; group += arity) {
        if (!/^[01]$/.test(parameters[group + 3].raw) || !/^[01]$/.test(parameters[group + 4].raw)) return false;
      }
    }
  }

  return true;
}

function parseViewBox(viewBox) {
  if (typeof viewBox !== "string") return null;
  const parts = viewBox.trim().split(/[\s,]+/);
  const numberPattern = new RegExp(`^(?:${SVG_NUMBER_SOURCE})$`);
  if (parts.length !== 4 || parts.some((part) => !numberPattern.test(part))) return null;
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? values : null;
}

test("catalog exposes the exact controlled vocabulary in deterministic order", () => {
  assert.deepEqual(ACTOR_ICON_TOKENS, EXPECTED_TOKENS);
  assert.deepEqual(Object.keys(SYMBOL_DEFS), EXPECTED_TOKENS);
  assert.equal(ACTOR_ICON_TOKENS.length, 21);
  assert.equal(new Set(ACTOR_ICON_TOKENS).size, ACTOR_ICON_TOKENS.length);
});

test("SVG path validation rejects malformed and unsupported data", () => {
  for (const path of [
    "M 0 0 totally-invalid",
    "M 0",
    "M 0 0 L 1",
    "M 0 0 A 1 1 0 0 1 2",
    "M 0 0 R 1 1",
    "M 0 0 L NaN 1",
    "M 0 0 L Infinity 1",
    "M 0 0 A 1 1 0 2 0 4 4",
    "M 0 0 A 1 1 0 0.0 1 4 4",
    "M 0 0 A 1 1 0 1.0 0 4 4",
    "M 0 0 A 1 1 0 +0 1 4 4",
    "M 0 0 A 1 1 0 -0 1 4 4",
    "M 0 0 A 1 1 0 01e0 0 4 4",
    "M,0 0",
    "M0,,0",
    "M0 0,",
  ]) {
    assert.equal(isValidSvgPath(path), false, path);
  }
  assert.equal(isValidSvgPath("M0,0L1,1"), true);
  assert.equal(isValidSvgPath("M 0 0 1 1 H 2 3 V 4 C 1 2 3 4 5 6 S 7 8 9 10 Q 1 2 3 4 T 5 6 A 2 3 45 0 1 7 8 Z"), true);
});

test("every definition contains safe custom SVG path metadata", () => {
  const forbidden = /[^\x00-\x7f]|[<>]|url\s*\(|data:|on\w+\s*=/i;
  for (const [token, definition] of Object.entries(SYMBOL_DEFS)) {
    const viewBox = parseViewBox(definition.viewBox);
    assert.ok(viewBox, token);
    assert.ok(viewBox[2] > 0, `${token} viewBox width`);
    assert.ok(viewBox[3] > 0, `${token} viewBox height`);
    assert.ok(Array.isArray(definition.paths) && definition.paths.length > 0, token);
    for (const path of definition.paths) {
      assert.equal(typeof path, "string", token);
      assert.equal(isValidSvgPath(path), true, token);
      assert.doesNotMatch(path, forbidden, token);
    }
    assert.equal(typeof definition.rotatesWithHeading, "boolean", token);
    assert.ok(["naval", "land", "air", "generic"].includes(definition.family), token);
    assert.equal(definition.baseHeadingDegrees, 0, token);
  }
});

test("the registry, token list, definitions, and nested paths are immutable", () => {
  assert.ok(Object.isFrozen(SYMBOL_DEFS));
  assert.ok(Object.isFrozen(ACTOR_ICON_TOKENS));
  for (const definition of Object.values(SYMBOL_DEFS)) {
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.paths));
  }
  assert.throws(() => ACTOR_ICON_TOKENS.push("new_token"), TypeError);
  assert.throws(() => { SYMBOL_DEFS.infantry.family = "air"; }, TypeError);
  assert.throws(() => SYMBOL_DEFS.infantry.paths.push("M 0 0"), TypeError);
  assert.equal(SYMBOL_DEFS.infantry.family, "land");
});

test("unknown requested tokens use ship and fleet rotating fallbacks", () => {
  const ship = resolveSymbol({ kind: "ship" }, "not_registered");
  const fleet = resolveSymbol({ kind: "fleet" }, "not_registered");
  assert.equal(ship.token, "warship_generic");
  assert.equal(ship.rotatesWithHeading, true);
  assert.equal(fleet.token, "fleet_generic");
  assert.equal(fleet.rotatesWithHeading, true);
});

test("land kinds resolve to infantry with their echelon marker", () => {
  const expected = { army: "XXXX", corps: "XXX", division: "XX", brigade: "X", regiment: "III" };
  for (const [kind, echelon] of Object.entries(expected)) {
    const symbol = resolveSymbol({ kind }, "missing");
    assert.equal(symbol.token, "infantry", kind);
    assert.equal(symbol.echelon, echelon, kind);
    assert.equal(symbol.rotatesWithHeading, false, kind);
  }
});

test("person and unknown actor kinds use semantic fallbacks", () => {
  assert.equal(resolveSymbol({ kind: "person" }).token, "headquarters");
  for (const actor of [
    { kind: "unit" },
    { kind: "other" },
    { kind: "unknown" },
    { kind: "__proto__" },
    { kind: "constructor" },
    { kind: "toString" },
    {},
    null,
    undefined,
  ]) {
    const symbol = resolveSymbol(actor);
    assert.equal(symbol.token, "unit_generic");
    assert.equal(symbol.echelon, "");
  }
  assert.equal(resolveSymbol({ kind: "constructor" }, "aircraft").echelon, "");
});

test("a known requested token wins regardless of actor kind", () => {
  const symbol = resolveSymbol({ kind: "ship" }, "cavalry");
  assert.equal(symbol.token, "cavalry");
  assert.equal(symbol.family, "land");
  assert.equal(symbol.rotatesWithHeading, false);
});

test("naval and air symbols rotate while land and generic symbols stay upright", () => {
  for (const definition of Object.values(SYMBOL_DEFS)) {
    const shouldRotate = definition.family === "naval" || definition.family === "air";
    assert.equal(definition.rotatesWithHeading, shouldRotate);
  }
});

test("air silhouettes explicitly declare east-facing base orientation", () => {
  for (const token of ["aircraft", "aircraft_fighter", "aircraft_bomber"]) {
    assert.equal(SYMBOL_DEFS[token].baseHeadingDegrees, 0);
  }
});

test("resolveSymbol returns independent deeply immutable results", () => {
  const first = resolveSymbol({ kind: "division" }, "infantry");
  const second = resolveSymbol({ kind: "division" }, "infantry");
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.paths, second.paths);
  assert.notStrictEqual(first.paths, SYMBOL_DEFS.infantry.paths);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.paths));
  assert.throws(() => { first.echelon = "changed"; }, TypeError);
  assert.throws(() => first.paths.push("M 0 0"), TypeError);
  assert.equal(second.echelon, "XX");
  assert.deepEqual(first.paths, SYMBOL_DEFS.infantry.paths);
});

test("JavaScript tokens stay synchronized with the Python validator", () => {
  const source = readFileSync(new URL("../battle_animation/validator.py", import.meta.url), "utf8");
  const block = source.match(/ACTOR_ICON_TOKENS\s*=\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, "ACTOR_ICON_TOKENS set not found in validator.py");
  const pythonTokens = [...block[1].matchAll(/[\"']([^\"']+)[\"']/g)].map((match) => match[1]);
  assert.deepEqual(new Set(pythonTokens), new Set(ACTOR_ICON_TOKENS));
  assert.equal(pythonTokens.length, ACTOR_ICON_TOKENS.length);
});

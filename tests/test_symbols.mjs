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

test("catalog exposes the exact controlled vocabulary in deterministic order", () => {
  assert.deepEqual(ACTOR_ICON_TOKENS, EXPECTED_TOKENS);
  assert.deepEqual(Object.keys(SYMBOL_DEFS), EXPECTED_TOKENS);
  assert.equal(ACTOR_ICON_TOKENS.length, 21);
  assert.equal(new Set(ACTOR_ICON_TOKENS).size, ACTOR_ICON_TOKENS.length);
});

test("every definition contains safe custom SVG path metadata", () => {
  const forbidden = /[^\x00-\x7f]|[<>]|url\s*\(|data:|on\w+\s*=/i;
  for (const [token, definition] of Object.entries(SYMBOL_DEFS)) {
    assert.equal(typeof definition.viewBox, "string", token);
    assert.match(definition.viewBox, /^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/, token);
    assert.ok(Array.isArray(definition.paths) && definition.paths.length > 0, token);
    for (const path of definition.paths) {
      assert.equal(typeof path, "string", token);
      assert.match(path, /^M(?:\s*-?\d|\s*\.)/i, token);
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

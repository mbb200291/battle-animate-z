const defineSymbol = (viewBox, paths, rotatesWithHeading, family) => Object.freeze({
  viewBox,
  paths: Object.freeze([...paths]),
  rotatesWithHeading,
  family,
  baseHeadingDegrees: 0,
});

export const SYMBOL_DEFS = Object.freeze({
  warship_generic: defineSymbol("-32 -20 64 40", [
    "M -28 -7 L 18 -7 L 30 0 L 18 7 L -28 7 L -22 0 Z",
    "M -8 -4 L 9 -4 L 14 0 L 9 4 L -8 4 Z",
  ], true, "naval"),
  warship_ironclad: defineSymbol("-32 -20 64 40", [
    "M -26 -10 L 17 -10 L 29 0 L 17 10 L -26 10 L -30 0 Z",
    "M -12 -7 A 7 7 0 1 0 -12 7 A 7 7 0 1 0 -12 -7 Z",
    "M 8 -6 A 6 6 0 1 0 8 6 A 6 6 0 1 0 8 -6 Z",
  ], true, "naval"),
  warship_battleship: defineSymbol("-38 -20 76 40", [
    "M -35 -7 L 23 -7 L 36 0 L 23 7 L -35 7 L -29 0 Z",
    "M -18 -6 A 6 6 0 1 0 -18 6 A 6 6 0 1 0 -18 -6 Z",
    "M 13 -6 A 6 6 0 1 0 13 6 A 6 6 0 1 0 13 -6 Z",
    "M -5 -4 L 5 -4 L 8 0 L 5 4 L -5 4 Z",
  ], true, "naval"),
  warship_armored_cruiser: defineSymbol("-34 -20 68 40", [
    "M -31 -8 L 19 -8 L 32 0 L 19 8 L -31 8 L -25 0 Z",
    "M -15 -5 A 5 5 0 1 0 -15 5 A 5 5 0 1 0 -15 -5 Z",
    "M 10 -5 A 5 5 0 1 0 10 5 A 5 5 0 1 0 10 -5 Z",
  ], true, "naval"),
  warship_protected_cruiser: defineSymbol("-34 -20 68 40", [
    "M -31 -6 L 20 -6 L 32 0 L 20 6 L -31 6 L -25 0 Z",
    "M -11 -4 L 10 -4 L 16 0 L 10 4 L -11 4 Z",
  ], true, "naval"),
  warship_destroyer: defineSymbol("-36 -16 72 32", [
    "M -33 -4 L 23 -4 L 34 0 L 23 4 L -33 4 L -27 0 Z",
    "M -7 -3 L 8 -3 L 12 0 L 8 3 L -7 3 Z",
  ], true, "naval"),
  warship_torpedo_boat: defineSymbol("-28 -14 56 28", [
    "M -24 -3 L 17 -3 L 26 0 L 17 3 L -24 3 L -19 0 Z",
    "M -4 -2 L 7 -2 L 10 0 L 7 2 L -4 2 Z",
  ], true, "naval"),
  naval_transport: defineSymbol("-34 -20 68 40", [
    "M -31 -8 L 19 -8 L 32 0 L 19 8 L -31 8 L -25 0 Z",
    "M -18 -5 L -7 -5 L -7 5 L -18 5 Z",
    "M -3 -5 L 8 -5 L 8 5 L -3 5 Z",
    "M 12 -4 L 19 -4 L 19 4 L 12 4 Z",
  ], true, "naval"),
  fleet_generic: defineSymbol("-36 -24 72 48", [
    "M -31 -15 L 12 -15 L 22 -11 L 12 -7 L -31 -7 L -26 -11 Z",
    "M -25 -4 L 22 -4 L 34 0 L 22 4 L -25 4 L -19 0 Z",
    "M -31 7 L 12 7 L 22 11 L 12 15 L -31 15 L -26 11 Z",
  ], true, "naval"),
  infantry: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -14 -9 L 14 9 M 14 -9 L -14 9",
  ], false, "land"),
  cavalry: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -14 9 L 0 -9 L 14 9",
  ], false, "land"),
  artillery: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -10 0 A 10 10 0 1 0 10 0 A 10 10 0 1 0 -10 0 Z",
  ], false, "land"),
  armor: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -13 -7 L 8 -7 L 14 0 L 8 7 L -13 7 Z",
  ], false, "land"),
  engineer: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -14 8 L 0 -9 L 14 8 M -10 8 L 10 8",
  ], false, "land"),
  logistics: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -13 -7 L 7 -7 L 13 0 L 7 7 L -13 7 Z M -7 0 L 8 0",
  ], false, "land"),
  headquarters: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -12 -9 L -12 9 M 12 -9 L 12 9 M -12 0 L 12 0",
  ], false, "land"),
  fortress: defineSymbol("-24 -22 48 44", [
    "M -20 -14 L 20 -14 L 20 14 L -20 14 Z",
    "M -14 9 L -14 -6 L -8 -6 L -8 -10 L -2 -10 L -2 -6 L 4 -6 L 4 -10 L 10 -10 L 10 -6 L 14 -6 L 14 9 Z",
  ], false, "land"),
  aircraft: defineSymbol("-32 -20 64 40", [
    "M -28 -3 L -5 -3 L 4 -17 L 10 -17 L 6 -3 L 27 -3 L 32 0 L 27 3 L 6 3 L 10 17 L 4 17 L -5 3 L -28 3 L -32 0 Z",
  ], true, "air"),
  aircraft_fighter: defineSymbol("-32 -20 64 40", [
    "M -29 -2 L -7 -3 L 2 -15 L 8 -15 L 6 -3 L 25 -2 L 32 0 L 25 2 L 6 3 L 8 15 L 2 15 L -7 3 L -29 2 L -25 0 Z",
  ], true, "air"),
  aircraft_bomber: defineSymbol("-34 -22 68 44", [
    "M -31 -4 L -7 -4 L 1 -19 L 10 -19 L 7 -4 L 27 -4 L 33 0 L 27 4 L 7 4 L 10 19 L 1 19 L -7 4 L -31 4 L -34 0 Z",
    "M -22 -8 L -14 -8 L -12 -4 L -24 -4 Z M -22 8 L -14 8 L -12 4 L -24 4 Z",
  ], true, "air"),
  unit_generic: defineSymbol("-24 -22 48 44", [
    "M 0 -16 L 20 0 L 0 16 L -20 0 Z",
  ], false, "generic"),
});

export const ACTOR_ICON_TOKENS = Object.freeze(Object.keys(SYMBOL_DEFS));

const KIND_FALLBACKS = Object.freeze({
  ship: "warship_generic",
  fleet: "fleet_generic",
  army: "infantry",
  corps: "infantry",
  division: "infantry",
  brigade: "infantry",
  regiment: "infantry",
  person: "headquarters",
});

const ECHELONS = Object.freeze({
  army: "XXXX",
  corps: "XXX",
  division: "XX",
  brigade: "X",
  regiment: "III",
});

export function resolveSymbol(actor, requestedToken) {
  const kind = actor && typeof actor === "object" ? actor.kind : undefined;
  const fallbackToken = Object.hasOwn(KIND_FALLBACKS, kind) ? KIND_FALLBACKS[kind] : "unit_generic";
  const token = typeof requestedToken === "string" && Object.hasOwn(SYMBOL_DEFS, requestedToken)
    ? requestedToken
    : fallbackToken;
  const definition = SYMBOL_DEFS[token];

  return Object.freeze({
    token,
    viewBox: definition.viewBox,
    paths: Object.freeze([...definition.paths]),
    rotatesWithHeading: definition.rotatesWithHeading,
    family: definition.family,
    baseHeadingDegrees: definition.baseHeadingDegrees,
    echelon: Object.hasOwn(ECHELONS, kind) ? ECHELONS[kind] : "",
  });
}

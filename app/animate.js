/* global L */
import { compileTimeline, parseBattleTime, sampleTimeline, trackProgressAt } from "./timeline.js";
import { ACTOR_ICON_TOKENS, resolveSymbol } from "./symbols.js";
import { BEACON_EXIT_MS, TRAIL_FADE_MS, clusterProjectedEvents } from "./overlay-effects.js";
import { buildFocusPlan } from "./map-view.js";
import { deriveFrontlineFallback, interpolateFrontlineSnapshots } from "./frontlines.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FRONT_CROSSFADE_MS = 500;
const FRONT_INFLUENCE_RADIUS = 28;
const FRONT_PAIR_MAX_PX = 160;

function fallbackPairDistance(project, influences, zoom) {
  let pixelsPerDegree = 0;
  for (const { position: [longitude, latitude] } of influences) {
    const origin = project([longitude, latitude]);
    const east = project([longitude + 1, latitude]);
    const latitudeStep = latitude >= 0
      ? Math.min(1, 89.9 - latitude)
      : Math.max(-1, -89.9 - latitude);
    const poleward = project([longitude, latitude + latitudeStep]);
    pixelsPerDegree = Math.max(
      pixelsPerDegree,
      Math.hypot(east.x - origin.x, east.y - origin.y),
      latitudeStep
        ? Math.hypot(poleward.x - origin.x, poleward.y - origin.y) / Math.abs(latitudeStep)
        : 0,
    );
  }
  const zoomLimit = Math.max(0.25, 4 * (2 ** (8 - zoom)));
  return pixelsPerDegree ? Math.min(zoomLimit, FRONT_PAIR_MAX_PX / pixelsPerDegree) : zoomLimit;
}

const DEFAULT_ICONS = {
  advance: "↗",
  retreat: "↘",
  attack: "✺",
  defend: "⛨",
  capture: "◆",
  surrender: "⚑",
  reinforcement: "＋",
  bombardment: "✷",
  landing: "▾",
  other: "•",
};

// Maps the descriptive icon names commonly used in animation_hints.style.event_icons
// (e.g. "burst", "shield") to glyphs the overlay can render directly.
const NAMED_ICONS = {
  "arrow-up": "↑",
  "arrow-down": "↓",
  "arrow-left": "←",
  "arrow-right": "→",
  "arrow-up-right": "↗",
  "arrow-down-right": "↘",
  burst: "✺",
  explosion: "✺",
  shield: "⛨",
  sword: "✦",
  swords: "✦",
  "crossed-swords": "✦",
  plus: "＋",
  flag: "⚑",
  anchor: "⚓",
  star: "★",
  dot: "•",
  circle: "●",
};

function resolveIcon(type, eventIcons) {
  const value = eventIcons[type];
  if (value) {
    if (NAMED_ICONS[value]) return NAMED_ICONS[value];
    if ([...value].length <= 2) return value; // already a glyph
  }
  return DEFAULT_ICONS[type] || "•";
}

// Distinct fallback palette so opposing sides are always visually separable
// even when a document omits side colors.
const SIDE_PALETTE = ["#2f6fb5", "#c0392b", "#2e8b57", "#8e44ad", "#d68910", "#16a085"];

const EVENT_TYPES = [
  "advance",
  "retreat",
  "attack",
  "defend",
  "capture",
  "surrender",
  "reinforcement",
  "bombardment",
  "landing",
  "other",
];

export async function loadBattle(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load battle JSON: ${response.status}`);
  }
  return response.json();
}

export function wirePlaybackControls(controller, documentRef = document) {
  documentRef._battlePlaybackTeardown?.();
  const $ = (id) => documentRef.getElementById(id);
  const bindings = [];
  const own = (element, property, handler) => {
    if (!element) return;
    element[property] = handler;
    bindings.push({ element, property, handler });
  };
  const play = $("play-button");
  own(play, "onclick", () => controller.toggle());
  const reset = $("reset-button");
  own(reset, "onclick", () => {
    controller.pause();
    controller.seek(0);
  });
  const previous = $("prev-button");
  own(previous, "onclick", () => {
    controller.pause();
    controller.prev();
  });
  const next = $("next-button");
  own(next, "onclick", () => {
    controller.pause();
    controller.next();
  });
  const scrubber = $("event-scrubber");
  own(scrubber, "oninput", (event) => {
    controller.pause();
    controller.seek(Number(event.target.value));
  });
  for (const button of documentRef.querySelectorAll("#speed-controls [data-speed]")) {
    own(button, "onclick", () => controller.setSpeed(Number(button.dataset.speed)));
  }
  const follow = $("follow-button");
  own(follow, "onclick", () => controller.setFollowEnabled(!controller.followEnabled));
  const trails = $("trails-button");
  own(trails, "onclick", () => controller.setTrailsEnabled(!controller.trailsEnabled));
  const modernBorders = $("modern-borders-button");
  own(modernBorders, "onclick", () => controller.setModernBordersEnabled(!controller.modernBordersEnabled));
  const fronts = $("fronts-button");
  own(fronts, "onclick", () => controller.setFrontsEnabled(!controller.frontsEnabled));
  const focus = $("focus-event-button");
  own(focus, "onclick", () => controller.focusActiveEvents());
  const teardown = () => {
    for (const { element, property, handler } of bindings) {
      if (element[property] === handler) element[property] = null;
    }
    if (documentRef._battlePlaybackTeardown === teardown) delete documentRef._battlePlaybackTeardown;
    if (controller._controlsTeardown === teardown) controller._controlsTeardown = null;
  };
  documentRef._battlePlaybackTeardown = teardown;
  controller._controlsTeardown = teardown;
  return teardown;
}

// Browser-side validation mirroring battle_animation/validator.py: required
// top-level keys, schema version, the event-type enum, and every cross-reference.
export function validateBattle(battle) {
  const errors = [];
  const warnings = [];
  if (!battle || typeof battle !== "object" || Array.isArray(battle)) {
    return { errors: ["document is not a JSON object"], warnings };
  }

  const required = [
    "schema_version",
    "metadata",
    "battle",
    "sides",
    "commanders",
    "actors",
    "places",
    "historical_events",
    "movements",
    "outcome",
    "sources",
    "animation_hints",
  ];
  for (const key of required) {
    if (!(key in battle)) errors.push(`missing required property "${key}"`);
  }
  const rendererShapesValid = validateRendererShapes(battle, errors);

  if ("schema_version" in battle && !["0.1.0", "0.2.0", "0.3.0", "0.4.0"].includes(battle.schema_version)) {
    errors.push(`schema_version must be "0.1.0", "0.2.0", "0.3.0", or "0.4.0", got ${JSON.stringify(battle.schema_version)}`);
  }
  if (!rendererShapesValid) return { errors, warnings };

  const array = (value) => Array.isArray(value) ? value : [];
  const objects = (value) => array(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
  const idSet = (key) => new Set(objects(battle[key]).map((item) => item.id));
  const sideIds = idSet("sides");
  const commanderIds = idSet("commanders");
  const actorIds = idSet("actors");
  const placeIds = idSet("places");
  const eventIds = idSet("historical_events");
  const sourceIds = idSet("sources");

  const check = (id, set, label) => {
    if (!set.has(id)) errors.push(`${label}: unknown id ${JSON.stringify(id)}`);
  };

  array(battle.commanders).forEach((commander, i) => {
    if (!commander || typeof commander !== "object" || Array.isArray(commander)) return;
    if ("side_id" in commander) check(commander.side_id, sideIds, `commanders[${i}].side_id`);
  });

  array(battle.actors).forEach((actor, i) => {
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) return;
    if ("side_id" in actor) check(actor.side_id, sideIds, `actors[${i}].side_id`);
    if ("parent_id" in actor) check(actor.parent_id, actorIds, `actors[${i}].parent_id`);
    array(actor.commander_ids).forEach((id) => check(id, commanderIds, `actors[${i}].commander_ids`));
  });

  array(battle.engagements).forEach((eng, i) => {
    if (!eng || typeof eng !== "object" || Array.isArray(eng)) return;
    if ("event_id" in eng) check(eng.event_id, eventIds, `engagements[${i}].event_id`);
    if ("attacker_actor_id" in eng) check(eng.attacker_actor_id, actorIds, `engagements[${i}].attacker_actor_id`);
    if ("target_actor_id" in eng) check(eng.target_actor_id, actorIds, `engagements[${i}].target_actor_id`);
    if ("result_actor_id" in eng) check(eng.result_actor_id, actorIds, `engagements[${i}].result_actor_id`);
    if ("at_place_id" in eng) check(eng.at_place_id, placeIds, `engagements[${i}].at_place_id`);
    array(eng.source_ids).forEach((id) => check(id, sourceIds, `engagements[${i}].source_ids`));
  });

  array(battle.historical_events).forEach((event, i) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    if (event.type && !EVENT_TYPES.includes(event.type)) {
      errors.push(`historical_events[${i}].type: invalid value ${JSON.stringify(event.type)}`);
    }
    array(event.actor_ids).forEach((id) => check(id, actorIds, `historical_events[${i}].actor_ids`));
    array(event.target_actor_ids).forEach((id) => check(id, actorIds, `historical_events[${i}].target_actor_ids`));
    array(event.place_ids).forEach((id) => check(id, placeIds, `historical_events[${i}].place_ids`));
    array(event.source_ids).forEach((id) => check(id, sourceIds, `historical_events[${i}].source_ids`));
  });

  array(battle.movements).forEach((movement, i) => {
    if (!movement || typeof movement !== "object" || Array.isArray(movement)) return;
    if ("event_id" in movement) check(movement.event_id, eventIds, `movements[${i}].event_id`);
    if ("actor_id" in movement) check(movement.actor_id, actorIds, `movements[${i}].actor_id`);
    if ("from_place_id" in movement) check(movement.from_place_id, placeIds, `movements[${i}].from_place_id`);
    if ("to_place_id" in movement) check(movement.to_place_id, placeIds, `movements[${i}].to_place_id`);
  });

  array(battle.animation_hints?.camera).forEach((camera, i) => {
    if (isObject(camera) && "event_id" in camera) {
      check(camera.event_id, eventIds, `animation_hints.camera[${i}].event_id`);
    }
  });

  const outcome = battle.outcome;
  if (outcome && typeof outcome === "object") {
    array(outcome.winner_side_ids).forEach((id) => check(id, sideIds, "outcome.winner_side_ids"));
    array(outcome.source_ids).forEach((id) => check(id, sourceIds, "outcome.source_ids"));
  }

  validateFrontlineSemantics(battle, eventIds, sideIds, sourceIds, errors, warnings);
  validateTiming(battle, errors, warnings);
  validateMovementOverlaps(battle, errors, warnings);
  validateActorIconTokens(battle, warnings);
  return { errors, warnings };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCoordinatePair(value, path, errors) {
  if (!Array.isArray(value)
      || value.length !== 2
      || !Number.isFinite(value[0])
      || !Number.isFinite(value[1])) {
    errors.push(`${path}: expected coordinate pair`);
    return false;
  }
  return true;
}

function validateExactObject(value, path, allowed, required, errors) {
  if (!isObject(value)) {
    errors.push(`${path}: expected object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: additional property is not allowed`);
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${path}.${key}: required property`);
  }
  return true;
}

function validateIdentifier(value, path, errors) {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) {
    errors.push(`${path}: expected identifier`);
    return false;
  }
  return true;
}

function validateConfidence(value, path, errors) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: expected finite number`);
  } else if (value < 0) {
    errors.push(`${path}: expected value >= 0`);
  } else if (value > 1) {
    errors.push(`${path}: expected value <= 1`);
  }
}

function validateDateValueShape(value, path, errors) {
  if (!validateExactObject(
    value,
    path,
    ["label", "start", "end", "precision", "confidence"],
    ["label", "precision", "confidence"],
    errors,
  )) return;
  if ("label" in value && typeof value.label !== "string") errors.push(`${path}.label: expected string`);
  for (const field of ["start", "end"]) {
    if (field in value && typeof value[field] !== "string") {
      errors.push(`${path}.${field}: expected string`);
    }
  }
  if ("precision" in value
      && !["year", "month", "day", "hour", "range", "unknown"].includes(value.precision)) {
    errors.push(`${path}.precision: expected one of ["year","month","day","hour","range","unknown"]`);
  }
  if ("confidence" in value) validateConfidence(value.confidence, `${path}.confidence`, errors);
}

function validateLineStringShape(value, path, errors) {
  if (!validateExactObject(value, path, ["type", "coordinates"], ["type", "coordinates"], errors)) return;
  if ("type" in value && value.type !== "LineString") {
    errors.push(`${path}.type: expected "LineString", got ${JSON.stringify(value.type)}`);
  }
  if (!("coordinates" in value)) return;
  if (!Array.isArray(value.coordinates)) {
    errors.push(`${path}.coordinates: expected array`);
    return;
  }
  if (value.coordinates.length < 2) errors.push(`${path}.coordinates: expected at least 2 items`);
  value.coordinates.forEach((position, index) => {
    validateCoordinatePair(position, `${path}.coordinates[${index}]`, errors);
  });
}

function validatePolygonShape(value, path, errors) {
  if (!validateExactObject(value, path, ["type", "coordinates"], ["type", "coordinates"], errors)) return;
  if ("type" in value && value.type !== "Polygon") {
    errors.push(`${path}.type: expected "Polygon", got ${JSON.stringify(value.type)}`);
  }
  if (!("coordinates" in value)) return;
  if (!Array.isArray(value.coordinates)) {
    errors.push(`${path}.coordinates: expected array`);
    return;
  }
  if (value.coordinates.length < 1) errors.push(`${path}.coordinates: expected at least 1 item`);
  value.coordinates.forEach((ring, ringIndex) => {
    const ringPath = `${path}.coordinates[${ringIndex}]`;
    if (!Array.isArray(ring)) {
      errors.push(`${ringPath}: expected array`);
      return;
    }
    if (ring.length < 4) errors.push(`${ringPath}: expected at least 4 items`);
    ring.forEach((position, positionIndex) => {
      validateCoordinatePair(position, `${ringPath}[${positionIndex}]`, errors);
    });
  });
}

function validateFrontlineShapes(battle, errors) {
  if (!Array.isArray(battle.frontline_snapshots)) return;
  battle.frontline_snapshots.forEach((snapshot, snapshotIndex) => {
    const path = `$.frontline_snapshots[${snapshotIndex}]`;
    if (!validateExactObject(
      snapshot,
      path,
      ["id", "time", "event_id", "front_lines", "control_areas", "precision", "confidence", "source_ids"],
      ["id", "time", "precision", "confidence", "source_ids"],
      errors,
    )) return;
    if ("id" in snapshot) validateIdentifier(snapshot.id, `${path}.id`, errors);
    if ("time" in snapshot) validateDateValueShape(snapshot.time, `${path}.time`, errors);
    if ("event_id" in snapshot) validateIdentifier(snapshot.event_id, `${path}.event_id`, errors);
    if ("precision" in snapshot
        && !["exact", "approximate", "inferred", "disputed", "unknown"].includes(snapshot.precision)) {
      errors.push(`${path}.precision: expected one of ["exact","approximate","inferred","disputed","unknown"]`);
    }
    if ("confidence" in snapshot) validateConfidence(snapshot.confidence, `${path}.confidence`, errors);
    if (!("front_lines" in snapshot) && !("control_areas" in snapshot)) {
      errors.push(`${path}: must include front_lines or control_areas`);
    }

    for (const collectionName of ["front_lines", "control_areas"]) {
      if (!(collectionName in snapshot)) continue;
      const collectionPath = `${path}.${collectionName}`;
      const collection = snapshot[collectionName];
      if (!Array.isArray(collection)) {
        errors.push(`${collectionPath}: expected array`);
        continue;
      }
      if (collection.length < 1) errors.push(`${collectionPath}: expected at least 1 item`);
      collection.forEach((shape, shapeIndex) => {
        const shapePath = `${collectionPath}[${shapeIndex}]`;
        const required = collectionName === "front_lines"
          ? ["id", "geometry"] : ["id", "side_id", "geometry"];
        if (!validateExactObject(shape, shapePath, required, required, errors)) return;
        if ("id" in shape) validateIdentifier(shape.id, `${shapePath}.id`, errors);
        if ("side_id" in shape) validateIdentifier(shape.side_id, `${shapePath}.side_id`, errors);
        if ("geometry" in shape) {
          if (collectionName === "front_lines") {
            validateLineStringShape(shape.geometry, `${shapePath}.geometry`, errors);
          } else {
            validatePolygonShape(shape.geometry, `${shapePath}.geometry`, errors);
          }
        }
      });
    }

    if ("source_ids" in snapshot) {
      if (!Array.isArray(snapshot.source_ids)) {
        errors.push(`${path}.source_ids: expected array`);
      } else {
        if (snapshot.source_ids.length < 1) {
          errors.push(`${path}.source_ids: expected at least 1 item`);
        }
        snapshot.source_ids.forEach((sourceId, sourceIndex) => {
          validateIdentifier(sourceId, `${path}.source_ids[${sourceIndex}]`, errors);
        });
      }
    }
  });
}

function validateRendererShapes(battle, errors) {
  const initialErrorCount = errors.length;
  const arrayKeys = [
    "sides",
    "commanders",
    "actors",
    "places",
    "historical_events",
    "movements",
    "sources",
    "engagements",
    "frontline_snapshots",
  ];
  for (const key of arrayKeys) {
    if (key in battle && !Array.isArray(battle[key])) errors.push(`$.${key}: expected array`);
  }
  for (const key of ["metadata", "battle", "outcome", "animation_hints"]) {
    if (key in battle && !isObject(battle[key])) {
      errors.push(`$.${key}: expected object`);
    }
  }

  const objectItemCollections = [
    "sides",
    "actors",
    "places",
    "historical_events",
    "movements",
    "engagements",
  ];
  for (const key of objectItemCollections) {
    if (!Array.isArray(battle[key])) continue;
    battle[key].forEach((item, index) => {
      if (!isObject(item)) errors.push(`$.${key}[${index}]: expected object`);
    });
  }

  if (isObject(battle.battle) && !isObject(battle.battle.date)) {
    errors.push("$.battle.date: expected object");
  }
  if (Array.isArray(battle.places)) {
    battle.places.forEach((place, index) => {
      if (!isObject(place)) return;
      if (!isObject(place.geometry)) {
        errors.push(`$.places[${index}].geometry: expected object`);
      } else if (!Array.isArray(place.geometry.coordinates)) {
        errors.push(`$.places[${index}].geometry.coordinates: expected array`);
      } else if (place.geometry.type === "Point") {
        validateCoordinatePair(place.geometry.coordinates, `$.places[${index}].geometry.coordinates`, errors);
      } else if (place.geometry.type === "LineString") {
        if (!place.geometry.coordinates.length) {
          errors.push(`$.places[${index}].geometry.coordinates: expected at least one position`);
        }
        place.geometry.coordinates.forEach((position, positionIndex) => {
          validateCoordinatePair(position, `$.places[${index}].geometry.coordinates[${positionIndex}]`, errors);
        });
      } else if (place.geometry.type === "Polygon") {
        if (!place.geometry.coordinates.length) {
          errors.push(`$.places[${index}].geometry.coordinates: expected coordinate ring`);
        }
        place.geometry.coordinates.forEach((ring, ringIndex) => {
          const ringPath = `$.places[${index}].geometry.coordinates[${ringIndex}]`;
          if (!Array.isArray(ring) || !ring.length) {
            errors.push(`${ringPath}: expected coordinate ring`);
            return;
          }
          ring.forEach((position, positionIndex) => {
            validateCoordinatePair(position, `${ringPath}[${positionIndex}]`, errors);
          });
        });
      }
    });
  }
  if (Array.isArray(battle.historical_events)) {
    battle.historical_events.forEach((event, index) => {
      if (!isObject(event)) return;
      if (!isObject(event.time)) errors.push(`$.historical_events[${index}].time: expected object`);
      for (const field of ["actor_ids", "target_actor_ids", "place_ids"]) {
        if (field in event && !Array.isArray(event[field])) {
          errors.push(`$.historical_events[${index}].${field}: expected array`);
        }
      }
    });
  }
  if (Array.isArray(battle.movements)) {
    battle.movements.forEach((movement, index) => {
      if (!isObject(movement)) return;
      if ("time" in movement && !isObject(movement.time)) {
        errors.push(`$.movements[${index}].time: expected object`);
      }
      if ("waypoint_times" in movement && !Array.isArray(movement.waypoint_times)) {
        errors.push(`$.movements[${index}].waypoint_times: expected array`);
      }
      if (!isObject(movement.path)) {
        errors.push(`$.movements[${index}].path: expected object`);
      } else if (!Array.isArray(movement.path.coordinates)) {
        errors.push(`$.movements[${index}].path.coordinates: expected array`);
      } else {
        movement.path.coordinates.forEach((position, positionIndex) => {
          validateCoordinatePair(position, `$.movements[${index}].path.coordinates[${positionIndex}]`, errors);
        });
      }
    });
  }
  if (Array.isArray(battle.engagements)) {
    battle.engagements.forEach((engagement, index) => {
      if (isObject(engagement) && "time" in engagement && !isObject(engagement.time)) {
        errors.push(`$.engagements[${index}].time: expected object`);
      }
    });
  }
  validateFrontlineShapes(battle, errors);
  if (isObject(battle.animation_hints)) {
    for (const field of ["map", "style", "timeline"]) {
      if (field in battle.animation_hints && !isObject(battle.animation_hints[field])) {
        errors.push(`$.animation_hints.${field}: expected object`);
      }
    }
    const style = battle.animation_hints.style;
    if (isObject(style) && "event_icons" in style) {
      if (!isObject(style.event_icons)) {
        errors.push("$.animation_hints.style.event_icons: expected object");
      } else {
        for (const [eventType, token] of Object.entries(style.event_icons)) {
          if (typeof token !== "string") {
            errors.push(`$.animation_hints.style.event_icons.${eventType}: expected string`);
          }
        }
      }
    }
    const mapHints = battle.animation_hints.map;
    if (isObject(mapHints)) {
      if ("initial_center" in mapHints) {
        validateCoordinatePair(
          mapHints.initial_center,
          "$.animation_hints.map.initial_center",
          errors,
        );
      }
      if ("initial_zoom" in mapHints
          && (typeof mapHints.initial_zoom !== "number" || !Number.isFinite(mapHints.initial_zoom))) {
        errors.push("$.animation_hints.map.initial_zoom: expected finite number");
      }
    }
    const camera = battle.animation_hints.camera;
    if ("camera" in battle.animation_hints && !Array.isArray(camera)) {
      errors.push("$.animation_hints.camera: expected array");
    } else if (Array.isArray(camera)) {
      camera.forEach((hint, index) => {
        const path = `$.animation_hints.camera[${index}]`;
        if (!isObject(hint)) {
          errors.push(`${path}: expected object`);
          return;
        }
        for (const key of Object.keys(hint)) {
          if (!["event_id", "center", "zoom"].includes(key)) {
            errors.push(`${path}.${key}: additional property is not allowed`);
          }
        }
        if (!("event_id" in hint)) {
          errors.push(`${path}.event_id: required property`);
        } else if (typeof hint.event_id !== "string"
            || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(hint.event_id)) {
          errors.push(`${path}.event_id: expected identifier`);
        }
        if (!("center" in hint)) errors.push(`${path}.center: required property`);
        else validateCoordinatePair(hint.center, `${path}.center`, errors);
        if ("zoom" in hint && !Number.isFinite(hint.zoom)) {
          errors.push(`${path}.zoom: expected finite number`);
        }
      });
    }
  }
  return errors.length === initialErrorCount;
}

function validateTimeRange(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: expected object`);
    return { start: null, end: null };
  }
  const parsed = { start: null, end: null };
  for (const field of ["start", "end"]) {
    if (!(field in value)) continue;
    if (typeof value[field] !== "string") {
      errors.push(`${path}.${field}: expected string`);
      continue;
    }
    parsed[field] = parseBattleTime(value[field]);
    if (parsed[field] === null) errors.push(`${path}.${field}: invalid ISO battle time`);
  }
  if (parsed.start !== null && parsed.end !== null && parsed.end < parsed.start) {
    errors.push(`${path}: end must not be before start`);
  }
  return parsed;
}

function validateUniqueIds(items, path, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (!isObject(item) || typeof item.id !== "string") return;
    if (seen.has(item.id)) errors.push(`${path}[${index}].id: duplicate id ${JSON.stringify(item.id)}`);
    seen.add(item.id);
  });
}

function validateFrontlineSemantics(battle, eventIds, sideIds, sourceIds, errors, warnings) {
  const snapshots = Array.isArray(battle.frontline_snapshots) ? battle.frontline_snapshots : [];
  validateUniqueIds(snapshots, "$.frontline_snapshots", errors);
  let previousStart = null;
  snapshots.forEach((snapshot, snapshotIndex) => {
    if (!isObject(snapshot)) return;
    const path = `$.frontline_snapshots[${snapshotIndex}]`;
    for (const collectionName of ["front_lines", "control_areas"]) {
      validateUniqueIds(snapshot[collectionName] || [], `${path}.${collectionName}`, errors);
    }
    if ("event_id" in snapshot && !eventIds.has(snapshot.event_id)) {
      errors.push(`${path}.event_id: unknown id ${JSON.stringify(snapshot.event_id)}`);
    }
    (snapshot.control_areas || []).forEach((area, areaIndex) => {
      if (!sideIds.has(area.side_id)) {
        errors.push(
          `${path}.control_areas[${areaIndex}].side_id: unknown id ${JSON.stringify(area.side_id)}`,
        );
      }
    });
    snapshot.source_ids.forEach((sourceId, sourceIndex) => {
      if (!sourceIds.has(sourceId)) {
        errors.push(
          `${path}.source_ids[${sourceIndex}]: unknown source id ${JSON.stringify(sourceId)}`,
        );
      }
    });

    const timePath = `${path}.time`;
    if (!("start" in snapshot.time)) {
      warnings.push(`${timePath}: snapshot without time.start is excluded from animation`);
      return;
    }
    const start = parseBattleTime(snapshot.time.start);
    if (start === null) return;
    if (previousStart !== null && start <= previousStart) {
      errors.push(`${timePath}.start: values must be strictly increasing`);
    }
    previousStart = start;
  });
}

function timingValues(battle) {
  const values = [];
  for (const collectionName of ["historical_events", "movements", "engagements", "frontline_snapshots"]) {
    const collection = Array.isArray(battle[collectionName]) ? battle[collectionName] : [];
    collection.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      if (item.time && typeof item.time === "object" && !Array.isArray(item.time)) {
        for (const field of ["start", "end"]) {
          if (field in item.time) values.push([`$.${collectionName}[${index}].time.${field}`, item.time[field]]);
        }
      }
      if (collectionName === "movements" && Array.isArray(item.waypoint_times)) {
        item.waypoint_times.forEach((value, waypointIndex) => {
          values.push([`$.movements[${index}].waypoint_times[${waypointIndex}]`, value]);
        });
      }
    });
  }
  return values;
}

function validateOffsetStyles(battle, errors) {
  let expectedOffsetStyle = null;
  for (const [path, value] of timingValues(battle)) {
    if (typeof value !== "string" || !value.includes("T") || parseBattleTime(value) === null) continue;
    const offsetBearing = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (expectedOffsetStyle === null) expectedOffsetStyle = offsetBearing;
    else if (offsetBearing !== expectedOffsetStyle) {
      errors.push(`${path}: mixed offset-bearing and battle-local date-times are not allowed`);
    }
  }
}

function validateTiming(battle, errors, warnings) {
  validateOffsetStyles(battle, errors);
  for (const collectionName of ["historical_events", "engagements", "frontline_snapshots"]) {
    const collection = Array.isArray(battle[collectionName]) ? battle[collectionName] : [];
    collection.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item) && "time" in item) {
        validateTimeRange(item.time, `$.${collectionName}[${index}].time`, errors);
      }
    });
  }

  const movements = Array.isArray(battle.movements) ? battle.movements : [];
  movements.forEach((movement, index) => {
    if (!movement || typeof movement !== "object" || Array.isArray(movement)) return;
    const path = `$.movements[${index}]`;
    const range = "time" in movement
      ? validateTimeRange(movement.time, `${path}.time`, errors)
      : { start: null, end: null };
    if (movement.precision === "inferred"
        && movement.time && typeof movement.time === "object"
        && typeof movement.time.confidence === "number"
        && Number.isFinite(movement.time.confidence)
        && movement.time.confidence > 0.6) {
      warnings.push(`${path}.time.confidence: inferred time confidence must be <= 0.6`);
    }
    if (!("waypoint_times" in movement)) return;
    if (!Array.isArray(movement.waypoint_times)) {
      errors.push(`${path}.waypoint_times: expected array`);
      return;
    }
    const coordinates = movement.path && typeof movement.path === "object" && Array.isArray(movement.path.coordinates)
      ? movement.path.coordinates : null;
    if (coordinates && coordinates.length !== movement.waypoint_times.length) {
      errors.push(`${path}.waypoint_times: count must match path coordinate count`);
    }
    const parsed = movement.waypoint_times.map((value, waypointIndex) => {
      if (typeof value !== "string") {
        errors.push(`${path}.waypoint_times[${waypointIndex}]: expected string`);
        return null;
      }
      const result = parseBattleTime(value);
      if (result === null) errors.push(`${path}.waypoint_times[${waypointIndex}]: invalid ISO battle time`);
      return result;
    });
    if (parsed.some((later, i) => i > 0 && later !== null && parsed[i - 1] !== null && later <= parsed[i - 1])) {
      errors.push(`${path}.waypoint_times: values must be strictly increasing`);
    }
    if (parsed.length && parsed[0] !== null && range.start !== null && parsed[0] < range.start) {
      errors.push(`${path}.waypoint_times[0]: value is before movement start`);
    }
    const last = parsed.length - 1;
    if (last >= 0 && parsed[last] !== null && range.end !== null && parsed[last] > range.end) {
      errors.push(`${path}.waypoint_times[${last}]: value is after movement end`);
    }
  });
}

function movementCoordinates(movement) {
  return movement?.path && Array.isArray(movement.path.coordinates) ? movement.path.coordinates : null;
}

function validateMovementOverlaps(battle, errors, warnings) {
  const byActor = new Map();
  const movements = Array.isArray(battle.movements) ? battle.movements : [];
  movements.forEach((movement, index) => {
    if (!movement || typeof movement !== "object" || !movement.time || typeof movement.time !== "object") return;
    if (!("start" in movement.time) || !("end" in movement.time)) return;
    const start = parseBattleTime(movement.time.start);
    const end = parseBattleTime(movement.time.end);
    if (start === null || end === null || end < start) return;
    const entries = byActor.get(movement.actor_id) || [];
    entries.push({ start, end, index, movement });
    byActor.set(movement.actor_id, entries);
  });
  for (const [actorId, entries] of byActor) {
    entries.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    entries.slice(1).forEach((later, laterOffset) => {
      const previousEntries = entries.slice(0, laterOffset + 1).filter((previous) => later.start < previous.end);
      if (!previousEntries.length) return;
      const laterCoordinates = movementCoordinates(later.movement);
      const connected = Boolean(laterCoordinates?.length) && previousEntries.every((previous) => {
        const previousCoordinates = movementCoordinates(previous.movement);
        return Boolean(previousCoordinates?.length)
          && JSON.stringify(previousCoordinates.at(-1)) === JSON.stringify(laterCoordinates[0]);
      });
      const path = `$.movements[${later.index}]`;
      if (connected) warnings.push(`${path}: overlap resolved in favor of later movement`);
      else errors.push(`${path}: conflicting overlapping movements for actor ${JSON.stringify(actorId)}`);
    });
  }
}

function validateActorIconTokens(battle, warnings) {
  if (battle.schema_version !== "0.3.0") return;
  const actorIcons = battle.animation_hints?.style?.actor_icons;
  if (!actorIcons || typeof actorIcons !== "object" || Array.isArray(actorIcons)) return;
  const allowed = new Set(ACTOR_ICON_TOKENS);
  for (const [actorId, token] of Object.entries(actorIcons)) {
    if (typeof token !== "string" || !allowed.has(token)) {
      warnings.push(`$.animation_hints.style.actor_icons.${actorId}: unknown actor icon token ${JSON.stringify(token)}`);
    }
  }
}

export function showDiagnosticList(documentRef, elementId, heading, diagnostics) {
  const box = documentRef.getElementById(elementId);
  if (!box) return;
  box.replaceChildren();
  if (!diagnostics.length) {
    box.hidden = true;
    return;
  }
  const title = documentRef.createElement("strong");
  title.textContent = `${heading} (${diagnostics.length})`;
  const list = documentRef.createElement("ul");
  for (const diagnostic of diagnostics.slice(0, 12)) {
    const item = documentRef.createElement("li");
    item.textContent = diagnostic;
    list.append(item);
  }
  if (diagnostics.length > 12) {
    const item = documentRef.createElement("li");
    item.textContent = `… and ${diagnostics.length - 12} more`;
    list.append(item);
  }
  box.append(title, list);
  box.hidden = false;
}

function showBattleWarnings(documentRef) {
  const documentWarnings = documentRef._battleDocumentWarnings || [];
  const mapWarning = documentRef._battleRuntimeMapWarning;
  const heading = documentWarnings.length && mapWarning
    ? "Warnings"
    : mapWarning ? "Map layer warning" : "JSON validation warnings";
  showDiagnosticList(
    documentRef,
    "validation-warnings",
    heading,
    mapWarning ? [...documentWarnings, mapWarning] : documentWarnings,
  );
}

function setTransportEnabled(documentRef, enabled) {
  for (const id of [
    "play-button", "reset-button", "prev-button", "next-button", "follow-button",
    "trails-button", "modern-borders-button", "event-scrubber",
  ]) {
    const element = documentRef.getElementById(id);
    if (element) element.disabled = !enabled;
  }
  for (const button of documentRef.querySelectorAll?.("#speed-controls [data-speed]") || []) {
    button.disabled = !enabled;
  }
}

export function resetBattleUI(documentRef = document) {
  documentRef._battlePlaybackTeardown?.();
  documentRef.getElementById("battle-map")?._battleController?.destroy?.();
  documentRef._battleRuntimeMapWarning = null;
  showBattleWarnings(documentRef);
  for (const id of [
    "battle-name", "battle-date", "battle-summary", "event-type", "event-title", "event-description",
    "event-precision", "event-confidence",
  ]) setText(documentRef, id, "");
  for (const id of ["legend", "timeline", "event-card-stack", "engagements"]) {
    documentRef.getElementById(id)?.replaceChildren();
  }
  setText(documentRef, "event-progress", "0 / 0");
  setText(documentRef, "historical-time", "Animation time 00:00");
  const scrubber = documentRef.getElementById("event-scrubber");
  if (scrubber) {
    scrubber.value = "0";
    scrubber.max = "0";
  }
  const notice = documentRef.getElementById("compression-notice");
  if (notice) {
    notice.textContent = "";
    notice.hidden = true;
  }
  const confidenceBar = documentRef.getElementById("confidence-bar");
  if (confidenceBar) confidenceBar.style.width = "";
  const play = documentRef.getElementById("play-button");
  if (play) {
    play.textContent = "Play";
    play.setAttribute("aria-pressed", "false");
  }
  const follow = documentRef.getElementById("follow-button");
  if (follow) {
    follow.textContent = "Follow: off";
    follow.setAttribute("aria-pressed", "false");
  }
  const trails = documentRef.getElementById("trails-button");
  if (trails) {
    trails.textContent = "Trails: off";
    trails.setAttribute("aria-pressed", "false");
  }
  const modernBorders = documentRef.getElementById("modern-borders-button");
  if (modernBorders) {
    modernBorders.textContent = "Modern borders: off";
    modernBorders.setAttribute("aria-pressed", "false");
  }
  const fronts = documentRef.getElementById("fronts-button");
  if (fronts) {
    fronts.textContent = "Fronts: off";
    fronts.setAttribute("aria-pressed", "false");
    fronts.disabled = true;
  }
  const frontlineStatus = documentRef.getElementById("frontline-status");
  if (frontlineStatus) frontlineStatus.hidden = true;
  setText(documentRef, "frontline-summary", "");
  documentRef.getElementById("frontline-sources")?.replaceChildren();
  const focus = documentRef.getElementById("focus-event-button");
  if (focus) focus.disabled = true;
  setTransportEnabled(documentRef, false);
}

export function setBattleDocument(battle, {
  documentRef = document,
  render = renderBattle,
  wireControls = wirePlaybackControls,
  previousController,
} = {}) {
  previousController?.destroy?.();
  const { errors, warnings } = validateBattle(battle);
  showDiagnosticList(documentRef, "error-banner", "JSON validation failed", errors);
  documentRef._battleDocumentWarnings = warnings;
  documentRef._battleRuntimeMapWarning = null;
  showBattleWarnings(documentRef);
  if (errors.length) {
    resetBattleUI(documentRef);
    return undefined;
  }
  const controller = render(battle, documentRef);
  setTransportEnabled(documentRef, true);
  wireControls(controller, documentRef);
  return controller;
}

export function setBattleDocumentFromText(text, options = {}) {
  let battle;
  try {
    battle = JSON.parse(text);
  } catch (error) {
    options.previousController?.destroy?.();
    const documentRef = options.documentRef || document;
    documentRef._battleDocumentWarnings = [];
    documentRef._battleRuntimeMapWarning = null;
    resetBattleUI(documentRef);
    showDiagnosticList(documentRef, "error-banner", "JSON validation failed", [`Invalid JSON: ${error.message}`]);
    return undefined;
  }
  return setBattleDocument(battle, options);
}

export function renderBattle(battle, documentRef = document) {
  const $ = (id) => documentRef.getElementById(id);
  const mapEl = $("battle-map");
  const cardStack = $("event-card-stack");
  const windowRef = documentRef.defaultView || globalThis;
  const reducedMotion = Boolean(windowRef.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  // Tear down a previous render so the same container can be reused.
  if (mapEl._battleController) mapEl._battleController.destroy();
  if (cardStack) cardStack.replaceChildren();

  const sides = new Map(battle.sides.map((side) => [side.id, side]));
  const actors = new Map(battle.actors.map((actor) => [actor.id, actor]));
  const places = new Map(battle.places.map((place) => [place.id, place]));
  const sources = new Map(battle.sources.map((source) => [source.id, source]));
  const events = new Map(battle.historical_events.map((event) => [event.id, event]));
  const compiled = compileTimeline(battle);
  const initialSample = sampleTimeline(compiled, 0);
  const fallbackAvailable = battle.schema_version === "0.4.0"
    && deriveFrontlineFallback({
      actors: battle.actors,
      positions: initialSample.actorPositions,
    }).influences.length > 0;
  const frontlinesAvailable = compiled.frontlineKeyframes.length > 0 || fallbackAvailable;
  const displayOffsetMinutes = battleDisplayOffsetMinutes(battle);

  const style = battle.animation_hints?.style || {};
  const sideColors = style.side_colors || {};
  const eventIcons = style.event_icons || {};
  const actorIcons = style.actor_icons || {};
  const sideIndex = new Map(battle.sides.map((side, index) => [side.id, index]));
  const colorOf = (sideId) =>
    sideColors[sideId] || sides.get(sideId)?.color || SIDE_PALETTE[(sideIndex.get(sideId) ?? 0) % SIDE_PALETTE.length];
  const iconOf = (type) => resolveIcon(type, eventIcons);
  const orderedEvents = compiled.eventWindows.map(({ event }) => event);
  const orderIndex = new Map(orderedEvents.map((event, index) => [event.id, index]));

  // --- Leaflet map + road-free terrain tiles ---
  const map = L.map(mapEl, { zoomControl: true });
  L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 16,
    maxZoom: 18,
    attribution: 'Powered by <a href="https://www.esri.com/">Esri</a> | Sources: Maxar, Airbus, USGS, NGA, NASA, CGIAR, NLS, OS, NMA, Geodatastyrelsen, GSA, GSI, Intermap, and the GIS User Community | Made with Natural Earth.',
  }).addTo(map);
  const modernBordersPane = map.createPane("modernBordersPane");
  modernBordersPane.style.zIndex = "350";
  modernBordersPane.style.pointerEvents = "none";

  const allCoords = collectCoordinates(battle);
  const mapHints = battle.animation_hints?.map || {};
  if (Array.isArray(mapHints.initial_center) && typeof mapHints.initial_zoom === "number") {
    map.setView([mapHints.initial_center[1], mapHints.initial_center[0]], mapHints.initial_zoom);
  } else if (allCoords.length) {
    map.fitBounds(L.latLngBounds(allCoords.map(([lon, lat]) => [lat, lon])).pad(0.25));
  } else {
    map.setView([0, 0], 2);
  }
  const scheduleTimeout = windowRef.setTimeout?.bind(windowRef) || globalThis.setTimeout.bind(globalThis);
  const cancelTimeout = windowRef.clearTimeout?.bind(windowRef) || globalThis.clearTimeout.bind(globalThis);
  let invalidateTimer = scheduleTimeout(() => {
    invalidateTimer = null;
    map.invalidateSize();
  }, 0);

  // --- SVG overlay drawn on top of the map, re-projected on every map move ---
  const svg = documentRef.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "battle-overlay");
  map.getContainer().appendChild(svg);
  const defs = svgEl(documentRef, "defs");
  svg.append(defs);

  const project = ([lon, lat]) => map.latLngToContainerPoint([lat, lon]);
  const toPath = (coords) =>
    coords
      .map((coord, index) => {
        const point = project(coord);
        return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      })
      .join(" ");
  const toFrontlinePath = (coords) => {
    let previousLongitude;
    return coords
      .map(([longitude, latitude], index) => {
        while (previousLongitude !== undefined && longitude - previousLongitude > 180) longitude -= 360;
        while (previousLongitude !== undefined && longitude - previousLongitude < -180) longitude += 360;
        previousLongitude = longitude;
        const point = project([longitude, latitude]);
        return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      })
      .join(" ");
  };

  const placeEls = [];
  for (const place of battle.places) {
    const geometry = place.geometry;
    if (geometry.type === "Point") {
      const circle = svgEl(documentRef, "circle", { class: "place-dot", r: 5 });
      const label = svgEl(documentRef, "text", { class: "place-label" }, place.name);
      svg.append(circle, label);
      placeEls.push({ kind: "point", coord: geometry.coordinates, circle, label });
    } else if (geometry.type === "LineString") {
      const path = svgEl(documentRef, "path", { class: "place-line" });
      svg.append(path);
      placeEls.push({ kind: "open", coords: geometry.coordinates, path });
    } else if (geometry.type === "Polygon") {
      const path = svgEl(documentRef, "path", { class: "place-area" });
      svg.append(path);
      placeEls.push({ kind: "closed", coords: geometry.coordinates[0], path });
    }
  }

  const frontlineLayer = svgEl(documentRef, "g", { class: "frontline-layer" });
  const controlAreaLayer = svgEl(documentRef, "g", { class: "front-control-area-layer" });
  const frontLineLayer = svgEl(documentRef, "g", { class: "front-line-layer" });
  frontlineLayer.append(controlAreaLayer, frontLineLayer);
  svg.append(frontlineLayer);
  const frontlineEls = new Map();
  const transientFrontlineEls = new Set();

  const movementEls = new Map();
  for (const [sourceIndex, movement] of battle.movements.entries()) {
    const actor = actors.get(movement.actor_id);
    const path = svgEl(documentRef, "path", {
      class: "movement-path",
      pathLength: "1",
      stroke: colorOf(actor?.side_id),
      "stroke-width": style.movement_line_width || 4,
      mask: `url(#movement-reveal-${sourceIndex})`,
    });
    const mask = svgEl(documentRef, "mask", { id: `movement-reveal-${sourceIndex}` });
    const reveal = svgEl(documentRef, "path", {
      class: "movement-reveal-mask",
      pathLength: "1",
      stroke: "white",
      "stroke-width": (style.movement_line_width || 4) + 2,
      "stroke-dasharray": "1",
      "stroke-dashoffset": "1",
    });
    reveal.style.strokeDashoffset = "1";
    mask.append(reveal);
    defs.append(mask);
    if (movement.precision === "inferred" || (typeof movement.confidence === "number" && movement.confidence <= 0.6)) {
      path.classList.add("is-inferred");
    }
    svg.append(path);
    const track = compiled.tracks.find((candidate) =>
      candidate.id === movement.id || candidate.sourceIndex === sourceIndex);
    movementEls.set(sourceIndex, { coords: movement.path.coordinates, path, reveal, track });
  }

  // Engagement tracers are drawn between the attacker and target units, under
  // the unit icons. Their endpoints are re-projected from live unit positions.
  const engagements = battle.engagements || [];
  const engagementEls = new Map();
  for (const eng of engagements) {
    const attacker = actors.get(eng.attacker_actor_id);
    const line = svgEl(documentRef, "line", {
      class: `engagement-line type-${eng.type}`,
      stroke: colorOf(attacker?.side_id),
    });
    svg.append(line);
    engagementEls.set(eng.id, { eng, line });
  }

  const unitEls = new Map();
  for (const actor of battle.actors) {
    const symbol = resolveSymbol(actor, actorIcons[actor.id]);
    const unit = svgEl(documentRef, "g", { class: "unit", "data-actor-id": actor.id });
    const heading = svgEl(documentRef, "g", { class: "unit-heading" });
    const symbolGroup = svgEl(documentRef, "g", {
      class: `unit-symbol token-${symbol.token}`,
      transform: "scale(0.55)",
    });
    for (const pathData of symbol.paths) {
      symbolGroup.append(svgEl(documentRef, "path", {
        d: pathData,
        fill: colorOf(actor.side_id),
      }));
    }
    heading.append(symbolGroup);
    unit.append(heading);
    if (symbol.echelon) {
      unit.append(svgEl(documentRef, "text", {
        class: "unit-echelon",
        "text-anchor": "middle",
        y: -15,
      }, symbol.echelon));
    }
    const label = svgEl(documentRef, "text", { class: "unit-label", x: 20, y: 1 }, actor.name);
    const subLabel = svgEl(documentRef, "text", { class: "unit-sub-label", x: 20, y: 14 }, symbol.token.replaceAll("_", " "));
    unit.append(label, subLabel);
    svg.append(unit);
    unitEls.set(actor.id, { g: unit, heading, symbol, label, subLabel });
  }

  const beaconLayer = svgEl(documentRef, "g", { class: "event-beacon-layer" });
  svg.append(beaconLayer);
  const beaconEls = new Map();
  const beaconExitTimers = new Map();

  let actorPositions = new Map();

  function redrawStaticGeometry() {
    for (const place of placeEls) {
      if (place.kind === "point") {
        const point = project(place.coord);
        place.circle.setAttribute("cx", point.x);
        place.circle.setAttribute("cy", point.y);
        place.label.setAttribute("x", point.x + 9);
        place.label.setAttribute("y", point.y - 8);
      } else if (place.kind === "open") {
        place.path.setAttribute("d", toPath(place.coords));
      } else {
        place.path.setAttribute("d", `${toPath(place.coords)} Z`);
      }
    }
    for (const { coords, path, reveal } of movementEls.values()) {
      const d = toPath(coords);
      path.setAttribute("d", d);
      reveal.setAttribute("d", d);
    }
  }

  function keyedFrontlineElement(key, parent, name, className) {
    let element = frontlineEls.get(key);
    if (!element) {
      element = svgEl(documentRef, name, {
        class: className,
        "data-frontline-key": key,
      });
      parent.append(element);
      frontlineEls.set(key, element);
    }
    return element;
  }

  function clearFrontTransitions(owner) {
    for (const timer of owner._frontTransitionTimers.values()) cancelTimeout(timer);
    owner._frontTransitionTimers.clear();
    for (const element of transientFrontlineEls) element.remove();
    transientFrontlineEls.clear();
    for (const [key, element] of frontlineEls) {
      if (element.classList.contains("is-front-exiting")) {
        element.remove();
        frontlineEls.delete(key);
      } else {
        element.classList.remove("is-front-entering");
      }
    }
  }

  function frontlineGeometry(state) {
    const geometry = interpolateFrontlineSnapshots(state.before, state.after, state.progress);
    if (state.before === state.after) {
      const lineIds = new Set(geometry.interpolatedLines.map(({ id }) => id));
      const areaIds = new Set(geometry.interpolatedAreas.map(({ id }) => id));
      geometry.interpolatedLines.push(...(state.before.front_lines || [])
        .filter(({ id }) => !lineIds.has(id))
        .map((line) => ({
          ...line,
          precision: line.precision ?? state.before.precision,
          confidence: line.confidence ?? state.before.confidence,
        })));
      geometry.interpolatedAreas.push(...(state.before.control_areas || [])
        .filter(({ id }) => !areaIds.has(id))
        .map((area) => ({
          ...area,
          sideId: area.side_id,
          precision: area.precision ?? state.before.precision,
          confidence: area.confidence ?? state.before.confidence,
        })));
      return geometry;
    }
    if (state.transition !== "crossfade") return geometry;
    geometry.interpolatedLines.push(...geometry.exitingLines.map((line) => ({
      ...line,
      precision: line.precision ?? state.before.precision,
      confidence: line.confidence ?? state.before.confidence,
    })));
    geometry.interpolatedAreas.push(...geometry.exitingAreas.map((area) => ({
      ...area,
      sideId: area.side_id,
      precision: area.precision ?? state.before.precision,
      confidence: area.confidence ?? state.before.confidence,
    })));
    return geometry;
  }

  function crossedIncompatibleKeyframes(previousSampled, sampled) {
    if (!previousSampled || sampled.historicalMs <= previousSampled.historicalMs) return [];
    const crossed = [];
    for (let index = 1; index < compiled.frontlineKeyframes.length; index += 1) {
      const keyframe = compiled.frontlineKeyframes[index];
      if (keyframe.historicalMs > sampled.historicalMs) break;
      if (keyframe.historicalMs <= previousSampled.historicalMs || keyframe.historicalMs > sampled.historicalMs) {
        continue;
      }
      const prior = compiled.frontlineKeyframes[index - 1];
      const geometry = interpolateFrontlineSnapshots(prior.snapshot, keyframe.snapshot, 0);
      if (geometry.enteringLines.length || geometry.exitingLines.length
          || geometry.enteringAreas.length || geometry.exitingAreas.length) {
        crossed.push(geometry);
      }
    }
    return crossed;
  }

  function renderFrontlines(sampled, mode = "reproject", previousSampled = null) {
    if (mode === "seek") clearFrontTransitions(controller);
    const state = sampled.frontline;
    const active = new Set();
    controller._frontlineStatus = null;
    if (state) {
      controller._frontlineStatus = { kind: "source", state };
      const crossedGeometries = mode === "playback" && !reducedMotion
        ? crossedIncompatibleKeyframes(previousSampled, sampled)
        : [];
      const crossing = crossedGeometries.length > 0;
      const geometry = frontlineGeometry(state);
      const targetKeys = new Set([
        ...geometry.interpolatedAreas.map((area) => `area:${area.id}`),
        ...geometry.interpolatedLines.map((line) => `line:${line.id}`),
      ]);
      const entering = [];
      if (crossing) {
        clearFrontTransitions(controller);
        const sameKeyCrossfades = new Set();
        for (const [prefix, exitField, enterField] of [
          ["line", "exitingLines", "enteringLines"],
          ["area", "exitingAreas", "enteringAreas"],
        ]) {
          const exitingIds = new Set(crossedGeometries.flatMap((item) =>
            item[exitField].map(({ id }) => id)));
          const incomingIds = new Set(crossedGeometries.flatMap((item) =>
            item[enterField].map(({ id }) => id)));
          exitingIds.forEach((id) => {
            if (incomingIds.has(id)) sameKeyCrossfades.add(`${prefix}:${id}`);
          });
        }
        for (const [key, element] of frontlineEls) {
          if (sameKeyCrossfades.has(key)) {
            const exiting = element.cloneNode(true);
            exiting.classList.remove("is-front-entering");
            exiting.classList.add("is-front-exiting");
            element.parentNode.append(exiting);
            transientFrontlineEls.add(exiting);
            entering.push(element);
          } else if (!targetKeys.has(key)
              && (element.classList.contains("front-line") || element.classList.contains("front-control-area"))) {
            element.classList.add("is-front-exiting");
          }
        }
      }
      for (const area of geometry.interpolatedAreas) {
        const key = `area:${area.id}`;
        active.add(key);
        const existed = frontlineEls.has(key);
        const path = keyedFrontlineElement(key, controlAreaLayer, "path", "front-control-area");
        if (crossing && !existed) entering.push(path);
        path.setAttribute("d", `${toFrontlinePath(area.geometry.coordinates[0])} Z`);
        path.setAttribute("fill", sides.get(area.sideId)?.color || colorOf(area.sideId));
        path.classList.toggle("is-inferred", area.precision === "inferred");
      }
      for (const line of geometry.interpolatedLines) {
        const key = `line:${line.id}`;
        active.add(key);
        const existed = frontlineEls.has(key);
        const path = keyedFrontlineElement(key, frontLineLayer, "path", "front-line is-source-backed");
        if (crossing && !existed) entering.push(path);
        path.setAttribute("d", toFrontlinePath(line.geometry.coordinates));
        path.classList.toggle("is-inferred", line.precision === "inferred");
        let label = frontlineEls.get(`${key}:label`);
        if (line.precision === "inferred") {
          if (!label) {
            label = keyedFrontlineElement(`${key}:label`, frontLineLayer, "text", "frontline-confidence-label");
          }
          active.add(`${key}:label`);
          const point = project(line.geometry.coordinates[Math.floor(line.geometry.coordinates.length / 2)]);
          label.setAttribute("x", point.x + 7);
          label.setAttribute("y", point.y - 7);
          label.textContent = `推定 · ${Math.round(line.confidence * 100)}%`;
        }
      }
      if (crossing) {
        entering.forEach((element) => element.classList.add("is-front-entering"));
        const timer = scheduleTimeout(() => {
          if (controller._frontTransitionTimers.get("topology") !== timer) return;
          clearFrontTransitions(controller);
        }, FRONT_CROSSFADE_MS);
        controller._frontTransitionTimers.set("topology", timer);
      }
    } else if (battle.schema_version === "0.4.0") {
      const unboundedFallback = deriveFrontlineFallback({
        actors: battle.actors,
        positions: sampled.actorPositions,
      });
      const fallback = deriveFrontlineFallback({
        actors: battle.actors,
        positions: sampled.actorPositions,
        maxPairDistance: fallbackPairDistance(project, unboundedFallback.influences, map.getZoom()),
      });
      for (const influence of fallback.influences) {
        const key = `derived:influence:${influence.actorId}`;
        active.add(key);
        const circle = keyedFrontlineElement(key, controlAreaLayer, "circle", "front-influence");
        const point = project(influence.position);
        circle.setAttribute("data-front-actor-id", influence.actorId);
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", FRONT_INFLUENCE_RADIUS);
        circle.setAttribute("fill", colorOf(influence.sideId));
      }
      if (fallback.contactLine) {
        const lineKey = "derived:line";
        const labelKey = "derived:label";
        active.add(lineKey);
        active.add(labelKey);
        const path = keyedFrontlineElement(lineKey, frontLineLayer, "path", "front-line is-derived");
        path.setAttribute("d", toFrontlinePath(fallback.contactLine));
        const label = keyedFrontlineElement(
          labelKey,
          frontLineLayer,
          "text",
          "frontline-confidence-label is-derived",
        );
        const point = project(fallback.contactLine[Math.floor(fallback.contactLine.length / 2)]);
        label.setAttribute("x", point.x + 7);
        label.setAttribute("y", point.y - 7);
        label.textContent = `${fallback.label} · ≤${Math.round(fallback.confidence * 100)}%`;
      }
      if (fallback.influences.length) controller._frontlineStatus = { kind: "fallback" };
    }
    for (const [key, element] of frontlineEls) {
      if (!active.has(key) && !element.classList.contains("is-front-exiting")) {
        element.remove();
        frontlineEls.delete(key);
      }
    }
  }

  function updateFrontlineInspector(owner) {
    const section = $("frontline-status");
    const summary = $("frontline-summary");
    const sourceList = $("frontline-sources");
    if (!section || !summary || !sourceList) return;
    sourceList.replaceChildren();
    const status = owner.frontsEnabled ? owner._frontlineStatus : null;
    section.hidden = !status;
    if (!status) {
      summary.textContent = "";
      return;
    }
    if (status.kind === "fallback") {
      summary.textContent = "Not a source-backed frontline";
      return;
    }

    const { before, after, transition } = status.state;
    const snapshots = before === after ? [before] : [before, after];
    const time = snapshots.map((snapshot) => snapshot.time?.label || snapshot.id).join(" → ");
    const precision = snapshots.some((snapshot) => snapshot.precision === "inferred")
      ? "inferred"
      : snapshots.map((snapshot) => snapshot.precision).filter(Boolean).join(" → ");
    const confidence = Math.min(...snapshots.map((snapshot) => snapshot.confidence));
    const linkedEvents = [...new Set(snapshots
      .map((snapshot) => events.get(snapshot.event_id)?.title)
      .filter(Boolean))];
    const transitionLabel = transition === "crossfade" ? "Crossfade" : "Interpolated";
    const parts = [
      time,
      precision,
      `${Math.round(confidence * 100)}% confidence`,
      ...linkedEvents.map((title) => `Event: ${title}`),
      transitionLabel,
    ].filter(Boolean);
    summary.textContent = parts.join(" · ");

    const sourceIds = [...new Set(snapshots.flatMap((snapshot) => snapshot.source_ids || []))];
    for (const sourceId of sourceIds) {
      const source = sources.get(sourceId);
      if (!source) continue;
      const item = documentRef.createElement("li");
      const link = documentRef.createElement("a");
      link.textContent = source.title;
      if (/^https?:\/\//i.test(source.url)) {
        link.setAttribute("href", source.url);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
      item.append(link);
      sourceList.append(item);
    }
  }

  function updateActorPositions() {
    for (const [actorId, { g }] of unitEls) {
      const coord = actorPositions.get(actorId);
      g.classList.toggle("is-hidden", !coord);
      if (!coord) continue;
      const point = project(coord);
      g.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
    suppressSecondaryLabelCollisions();
  }

  function suppressSecondaryLabelCollisions() {
    const occupied = [];
    const near = map.getZoom() >= 11;
    for (const [actorId, { subLabel }] of unitEls) {
      const coord = actorPositions.get(actorId);
      if (!near || !coord) {
        subLabel.classList.remove("is-collision-hidden");
        continue;
      }
      const point = project(coord);
      const collides = occupied.some((accepted) =>
        Math.abs(point.x - accepted.x) < 80 && Math.abs(point.y - accepted.y) < 26);
      subLabel.classList.toggle("is-collision-hidden", collides);
      if (!collides) occupied.push(point);
    }
  }

  function redrawEngagementEndpoints() {
    for (const { eng, line } of engagementEls.values()) {
      const a = actorPositions.get(eng.attacker_actor_id);
      const b = actorPositions.get(eng.target_actor_id);
      line.classList.toggle("is-hidden", !a || !b);
      if (!a || !b) continue;
      const pa = project(a);
      const pb = project(b);
      line.setAttribute("x1", pa.x);
      line.setAttribute("y1", pa.y);
      line.setAttribute("x2", pb.x);
      line.setAttribute("y2", pb.y);
    }
  }

  function reprojectMap() {
    redrawStaticGeometry();
    if (controller._frontTransitionTimers.size) clearFrontTransitions(controller);
    if (controller.sampledState) renderFrontlines(controller.sampledState);
    updateActorPositions();
    redrawEngagementEndpoints();
    if (controller.sampledState) renderBeacons(controller.sampledState, "reproject");
  }

  buildLegend(battle, documentRef, colorOf);
  bindStaticText(battle, documentRef);
  const teardownTimeline = buildTimeline(orderedEvents, documentRef, (index) => {
    controller.pause();
    controller.showEvent(index);
  });

  const duration = compiled.presentationDurationMs;
  const requestFrame = windowRef.requestAnimationFrame.bind(windowRef);
  const cancelFrame = windowRef.cancelAnimationFrame.bind(windowRef);
  let renderedEventIndex = -1;
  let previousActiveEventIds = new Set();
  const visibleCards = [];

  function nowMs() {
    return windowRef.performance?.now ? windowRef.performance.now() : Date.now();
  }

  function appendTextElement(parent, tagName, className, text) {
    const element = documentRef.createElement(tagName);
    element.setAttribute("class", className);
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function appendEventCard(selected) {
    if (!cardStack) return;
    const event = selected.event;
    const card = documentRef.createElement("article");
    card.setAttribute("class", "event-card");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `${event.title}. Pause playback`);
    card.dataset.eventId = selected.id;
    appendTextElement(card, "p", "event-card-meta", `${event.time?.label || "Time unknown"} · ${event.type}`);
    appendTextElement(card, "h2", "event-card-title", event.title);
    if (event.description) appendTextElement(card, "p", "event-card-description", event.description);
    const confidence = typeof event.confidence === "number" ? `${Math.round(event.confidence * 100)}% confidence` : "confidence unknown";
    appendTextElement(card, "p", "event-card-evidence", `${event.precision || "unknown"} precision · ${confidence}`);
    for (const engagement of engagements.filter(({ event_id }) => event_id === event.id)) {
      const attacker = actors.get(engagement.attacker_actor_id)?.name || engagement.attacker_actor_id;
      const target = actors.get(engagement.target_actor_id)?.name || engagement.target_actor_id;
      appendTextElement(card, "p", "event-card-engagement", `${attacker} → ${target}${engagement.result && engagement.result !== "none" ? ` · ${engagement.result}` : ""}`);
    }
    const pause = () => controller.pause();
    const pauseFromKey = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      pause();
    };
    card.addEventListener("pointerenter", pause);
    card.addEventListener("click", pause);
    card.addEventListener("keydown", pauseFromKey);
    cardStack.append(card);
    visibleCards.push({
      element: card,
      id: selected.id,
      shownAt: nowMs(),
      dispose() {
        card.removeEventListener("pointerenter", pause);
        card.removeEventListener("click", pause);
        card.removeEventListener("keydown", pauseFromKey);
        card.remove();
      },
    });
    while (visibleCards.length > 3) visibleCards.shift().dispose();
  }

  function appendNewActiveEventCards(sampled) {
    const newlyActive = compiled.eventWindows
      .filter((window) => sampled.activeEventIds.has(window.id) && !previousActiveEventIds.has(window.id))
      .sort((a, b) => a.startMs - b.startMs || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
    for (const window of newlyActive) appendEventCard(window);
    previousActiveEventIds = new Set(sampled.activeEventIds);
  }

  function pruneEventCards(currentId) {
    const now = nowMs();
    for (let index = visibleCards.length - 1; index >= 0; index -= 1) {
      const item = visibleCards[index];
      if (item.id !== currentId && now - item.shownAt >= 3000) {
        item.dispose();
        visibleCards.splice(index, 1);
      }
    }
  }

  function selectedEventWindow(sampled) {
    const active = compiled.eventWindows
      .filter(({ id }) => sampled.activeEventIds.has(id))
      .reduce((latest, window) => {
        if (!latest || window.startMs > latest.startMs) return window;
        if (window.startMs === latest.startMs
            && (orderIndex.get(window.id) ?? 0) > (orderIndex.get(latest.id) ?? 0)) return window;
        return latest;
      }, null);
    if (active) return active;
    let latest = null;
    for (const window of compiled.eventWindows) {
      if (window.startMs <= sampled.historicalMs
          && (!latest || window.startMs > latest.startMs
            || (window.startMs === latest.startMs
              && (orderIndex.get(window.id) ?? 0) > (orderIndex.get(latest.id) ?? 0)))) latest = window;
    }
    return latest || compiled.eventWindows[0] || null;
  }

  function focusExtraActorIds(sampled) {
    const ids = new Set();
    for (const track of compiled.tracks) {
      if (sampled.historicalMs >= track.startMs && sampled.historicalMs <= track.endMs) {
        ids.add(track.actorId);
      }
    }
    for (const engagement of engagements) {
      if (!sampled.activeEngagementIds.has(engagement.id)) continue;
      ids.add(engagement.attacker_actor_id);
      ids.add(engagement.target_actor_id);
    }
    return [...ids];
  }

  function focusExtraPoints(sampled) {
    const points = [];
    for (const track of compiled.tracks) {
      if (sampled.historicalMs < track.startMs || sampled.historicalMs > track.endMs) continue;
      points.push(track.coordinates[0], track.coordinates.at(-1));
    }
    return points;
  }

  function currentFocusPlan(owner) {
    const sampled = owner.sampledState;
    if (!sampled) return { kind: "none" };
    const selected = Number.isInteger(owner.currentIndex)
      ? compiled.eventWindows[owner.currentIndex]
      : null;
    return buildFocusPlan({
      activeEventIds: sampled.activeEventIds,
      selectedEventId: selected?.id,
      eventWindows: compiled.eventWindows,
      places,
      actorPositions: sampled.actorPositions,
      cameras: battle.animation_hints?.camera || [],
      extraActorIds: focusExtraActorIds(sampled),
      extraPoints: focusExtraPoints(sampled),
    });
  }

  function displaySelectedEvent(owner, selected) {
    if (!selected) return;
    const selectedIndex = orderIndex.get(selected.id) ?? 0;
    owner.currentIndex = selectedIndex;
    if (selectedIndex === renderedEventIndex) return;
    updateTimeline(documentRef, selectedIndex, reducedMotion);
    const progress = $("event-progress");
    if (progress) progress.textContent = `${selectedIndex + 1} / ${orderedEvents.length}`;
    renderedEventIndex = selectedIndex;
  }

  function updatePlaybackReadout(sampled, presentationMs) {
    const scrubber = $("event-scrubber");
    if (scrubber) scrubber.value = String(presentationMs);
    const historicalTime = $("historical-time");
    if (historicalTime) {
      historicalTime.textContent = sampled.synthetic
        ? `Animation time ${formatElapsedTime(presentationMs)}`
        : formatHistoricalTime(sampled.historicalMs, displayOffsetMinutes);
    }
    const notice = $("compression-notice");
    if (notice) {
      notice.hidden = !sampled.compressedGap;
      notice.textContent = sampled.compressedGap
        ? `Compressed ${Math.max(1, Math.round(sampled.compressedGap.historicalDurationMs / 60000))} min inactive interval`
        : "";
    }
  }

  function applyZoomLabelClass() {
    const zoom = map.getZoom();
    svg.classList.toggle("labels-near", zoom >= 11);
    svg.classList.toggle("labels-middle", zoom >= 8 && zoom < 11);
    svg.classList.toggle("labels-far", zoom < 8);
  }

  function activeGeographicPoints(sampled) {
    const actorIds = new Set();
    for (const window of compiled.eventWindows) {
      if (!sampled.activeEventIds.has(window.id)) continue;
      for (const actorId of [...(window.event.actor_ids || []), ...(window.event.target_actor_ids || [])]) {
        actorIds.add(actorId);
      }
    }
    for (const track of compiled.tracks) {
      if (sampled.historicalMs >= track.startMs && sampled.historicalMs <= track.endMs) {
        actorIds.add(track.actorId);
      }
    }
    for (const engagement of engagements) {
      if (!sampled.activeEngagementIds.has(engagement.id)) continue;
      actorIds.add(engagement.attacker_actor_id);
      actorIds.add(engagement.target_actor_id);
    }
    return [...actorIds].map((actorId) => sampled.actorPositions.get(actorId)).filter(Boolean);
  }

  function moveMapProgrammatically(owner, move) {
    owner._programmaticMove = true;
    try {
      move();
    } catch (error) {
      owner._programmaticMove = false;
      throw error;
    }
  }

  function maybeFollow(owner, sampled) {
    if (!owner.followEnabled || owner._programmaticMove) return;
    const wallTime = nowMs();
    if (wallTime - owner._lastFollowCheck < 500) return;
    owner._lastFollowCheck = wallTime;
    const uniquePoints = [...new Map(activeGeographicPoints(sampled)
      .map((point) => [point.join("\u0000"), point])).values()];
    if (!uniquePoints.length) return;
    const size = map.getSize ? map.getSize() : { x: mapEl.clientWidth, y: mapEl.clientHeight };
    const insetX = size.x * 0.22;
    const insetY = size.y * 0.22;
    const projected = uniquePoints.map(project);
    const outside = projected.some(({ x, y }) =>
      x < insetX || x > size.x - insetX || y < insetY || y > size.y - insetY);
    if (!outside) return;
    const center = projected.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    center.x /= projected.length;
    center.y /= projected.length;
    const distance = Math.hypot(center.x - size.x / 2, center.y - size.y / 2);
    const flyDuration = Math.min(2.4, Math.max(0.8, 0.8 + distance / 500));
    const cameraOptions = reducedMotion
      ? { duration: 0, animate: false }
      : { duration: flyDuration, animate: true };
    moveMapProgrammatically(owner, () => {
      if (uniquePoints.length === 1) {
        const [lon, lat] = uniquePoints[0];
        map.flyTo([lat, lon], map.getZoom(), cameraOptions);
      } else {
        const bounds = L.latLngBounds(uniquePoints.map(([lon, lat]) => [lat, lon])).pad(0.35);
        map.flyToBounds(bounds, { ...cameraOptions, maxZoom: map.getZoom() });
      }
    });
  }

  function clearTrailEffects(owner) {
    for (const timer of owner._trailFadeTimers.values()) cancelTimeout(timer);
    owner._trailFadeTimers.clear();
    for (const { path } of movementEls.values()) {
      path.classList.remove("is-trail-active", "is-trail-fading");
      path.classList.add("is-trail-hidden");
    }
  }

  function beginTrailFade(owner, key, movementEl) {
    const prior = owner._trailFadeTimers.get(key);
    if (prior !== undefined) cancelTimeout(prior);
    movementEl.reveal.setAttribute("stroke-dashoffset", "0");
    movementEl.reveal.style.strokeDashoffset = "0";
    if (reducedMotion) {
      owner._trailFadeTimers.delete(key);
      movementEl.path.classList.remove("is-trail-active", "is-trail-fading");
      movementEl.path.classList.add("is-trail-hidden");
      return;
    }
    movementEl.path.classList.remove("is-trail-active", "is-trail-hidden");
    movementEl.path.classList.add("is-trail-fading");
    const timer = scheduleTimeout(() => {
      if (owner._trailFadeTimers.get(key) !== timer) return;
      owner._trailFadeTimers.delete(key);
      movementEl.path.classList.remove("is-trail-fading");
      movementEl.path.classList.add("is-trail-hidden");
    }, TRAIL_FADE_MS);
    owner._trailFadeTimers.set(key, timer);
  }

  function renderTrails(owner, historicalMs, mode) {
    if (mode === "seek") clearTrailEffects(owner);
    for (const [key, movementEl] of movementEls) {
      const { path, reveal, track } = movementEl;
      const active = owner.trailsEnabled && Boolean(track)
        && historicalMs >= track.startMs && historicalMs <= track.endMs;
      const crossedEnd = owner.trailsEnabled && mode === "playback" && Boolean(track)
        && owner._lastTrailHistoricalMs !== null
        && owner._lastTrailHistoricalMs < track.endMs && historicalMs >= track.endMs;
      if (active && !crossedEnd) {
        const timer = owner._trailFadeTimers.get(key);
        if (timer !== undefined) cancelTimeout(timer);
        owner._trailFadeTimers.delete(key);
        const revealOffset = String(1 - trackProgressAt(track, historicalMs));
        reveal.setAttribute("stroke-dashoffset", revealOffset);
        reveal.style.strokeDashoffset = revealOffset;
        path.classList.remove("is-trail-hidden", "is-trail-fading");
        path.classList.add("is-trail-active");
      } else if (crossedEnd) {
        beginTrailFade(owner, key, movementEl);
      } else if (!path.classList.contains("is-trail-fading")) {
        path.classList.remove("is-trail-active");
        path.classList.add("is-trail-hidden");
      }
    }
    owner._lastTrailHistoricalMs = historicalMs;
  }

  function removeBeacon(key) {
    const timer = beaconExitTimers.get(key);
    if (timer !== undefined) cancelTimeout(timer);
    beaconExitTimers.delete(key);
    beaconEls.get(key)?.remove();
    beaconEls.delete(key);
  }

  function reprojectBeacon(node) {
    const ids = (node.getAttribute("data-event-ids") || "").split(" ");
    const points = ids.flatMap((id) => {
      const event = compiled.eventWindows.find((window) => window.id === id)?.event;
      const coord = event && eventCoord(event, places);
      return Array.isArray(coord) ? [project(coord)] : [];
    });
    if (!points.length) return;
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    node.setAttribute("transform", `translate(${x} ${y})`);
  }

  function renderBeacons(sampled, mode) {
    const points = compiled.eventWindows.flatMap(({ id, event }) => {
      if (!sampled.activeEventIds.has(id)) return [];
      const coord = eventCoord(event, places);
      if (!Array.isArray(coord)) return [];
      const { x, y } = project(coord);
      return [{ id, x, y, type: event.type }];
    });
    const clusters = clusterProjectedEvents(points);
    const activeKeys = new Set(clusters.map(({ key }) => key));

    for (const [key, node] of beaconEls) {
      if (activeKeys.has(key)) continue;
      if (mode === "reproject" && beaconExitTimers.has(key)) {
        reprojectBeacon(node);
        continue;
      }
      if (mode !== "playback") {
        removeBeacon(key);
      } else if (reducedMotion) {
        removeBeacon(key);
      } else if (!beaconExitTimers.has(key)) {
        node.classList.add("is-exiting");
        const timer = scheduleTimeout(() => {
          if (beaconExitTimers.get(key) !== timer) return;
          removeBeacon(key);
        }, BEACON_EXIT_MS);
        beaconExitTimers.set(key, timer);
      }
    }

    for (const cluster of clusters) {
      let node = beaconEls.get(cluster.key);
      if (!node) {
        node = svgEl(documentRef, "g", {
          class: "event-beacon is-entering",
          "data-event-ids": cluster.ids.join(" "),
        });
        node.append(
          svgEl(documentRef, "circle", { class: "event-beacon-pulse", r: 10 }),
          svgEl(documentRef, "path", {
            class: "event-beacon-diamond",
            d: "M 0 -8 L 8 0 L 0 8 L -8 0 Z",
          }),
          svgEl(documentRef, "text", {
            class: cluster.count > 1 ? "event-beacon-count" : "event-beacon-icon",
            y: 4,
            "text-anchor": "middle",
          }, cluster.count > 1 ? String(cluster.count) : iconOf(cluster.type)),
        );
        beaconLayer.append(node);
        beaconEls.set(cluster.key, node);
      }
      const timer = beaconExitTimers.get(cluster.key);
      if (timer !== undefined) cancelTimeout(timer);
      beaconExitTimers.delete(cluster.key);
      node.classList.remove("is-exiting");
      node.setAttribute("transform", `translate(${cluster.x} ${cluster.y})`);
    }
  }

  const controller = {
    battle,
    compiled,
    orderedEvents,
    map,
    currentIndex: orderedEvents.length ? 0 : -1,
    currentPresentationMs: 0,
    sampledState: null,
    playbackRate: 1,
    followEnabled: true,
    trailsEnabled: false,
    modernBordersEnabled: false,
    frontsEnabled: frontlinesAvailable,
    isPlaying: false,
    _frame: null,
    _lastFrameTime: null,
    _lastFollowCheck: -Infinity,
    _trailFadeTimers: new Map(),
    _frontTransitionTimers: new Map(),
    _beaconEls: beaconEls,
    _beaconExitTimers: beaconExitTimers,
    _lastTrailHistoricalMs: null,
    _programmaticMove: false,
    _modernBordersLayer: null,
    _modernBordersPromise: null,
    _destroyed: false,

    renderAt(presentationMs, { mode = "seek" } = {}) {
      if (this._destroyed) return this.sampledState;
      const bounded = Math.min(duration, Math.max(0, Number.isFinite(presentationMs) ? presentationMs : 0));
      this.currentPresentationMs = bounded;
      const previousSampled = this.sampledState;
      const sampled = sampleTimeline(compiled, bounded);
      this.sampledState = sampled;
      actorPositions = sampled.actorPositions;
      renderFrontlines(sampled, mode, previousSampled);
      updateFrontlineInspector(this);
      updatePlaybackReadout(sampled, bounded);

      for (const [actorId, { g, heading, symbol }] of unitEls) {
        const radians = sampled.headings.get(actorId) || 0;
        const degrees = symbol.rotatesWithHeading
          ? radians * 180 / Math.PI + symbol.baseHeadingDegrees
          : symbol.baseHeadingDegrees;
        heading.setAttribute("transform", `rotate(${degrees})`);
        g.classList.toggle("is-sunk", sampled.persistentOutcomeActorIds.has(actorId));
      }
      updateActorPositions();

      const activeTargets = new Set();
      for (const [engagementId, { eng, line }] of engagementEls) {
        const active = sampled.activeEngagementIds.has(engagementId);
        line.classList.toggle("is-active", active);
        if (active) activeTargets.add(eng.target_actor_id);
      }
      for (const [actorId, { g }] of unitEls) {
        g.classList.toggle("is-hit", activeTargets.has(actorId)
          && !sampled.persistentOutcomeActorIds.has(actorId));
      }
      redrawEngagementEndpoints();

      for (const { path, track } of movementEls.values()) {
        const visible = Boolean(track) && sampled.historicalMs >= track.startMs;
        const completed = Boolean(track) && sampled.historicalMs > track.endMs;
        const active = Boolean(track) && sampled.historicalMs >= track.startMs
          && sampled.historicalMs <= track.endMs;
        path.classList.toggle("is-visible", visible);
        path.classList.toggle("is-completed", completed);
        path.classList.toggle("is-active", active);
      }
      renderTrails(this, sampled.historicalMs, mode);
      renderBeacons(sampled, mode);

      const selected = selectedEventWindow(sampled);
      appendNewActiveEventCards(sampled);
      displaySelectedEvent(this, selected);
      pruneEventCards(selected?.id);
      const focusButton = $("focus-event-button");
      if (focusButton) focusButton.disabled = currentFocusPlan(this).kind === "none";
      maybeFollow(this, sampled);
      return sampled;
    },

    seek(presentationMs) {
      if (this._destroyed) return this.sampledState;
      return this.renderAt(presentationMs);
    },

    setSpeed(rate) {
      if (this._destroyed) return this.playbackRate;
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new RangeError("playback rate must be a positive finite number");
      }
      this.playbackRate = rate;
      if (this.isPlaying && windowRef.performance?.now) this._lastFrameTime = windowRef.performance.now();
      for (const button of documentRef.querySelectorAll("#speed-controls [data-speed]")) {
        button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === rate));
      }
      return rate;
    },

    setFollowEnabled(enabled) {
      if (this._destroyed) return this.followEnabled;
      this.followEnabled = Boolean(enabled);
      if (this.followEnabled) this._lastFollowCheck = -Infinity;
      const button = $("follow-button");
      if (button) {
        button.setAttribute("aria-pressed", String(this.followEnabled));
        button.textContent = `Follow: ${this.followEnabled ? "on" : "off"}`;
      }
      return this.followEnabled;
    },

    setTrailsEnabled(enabled) {
      if (this._destroyed) return this.trailsEnabled;
      this.trailsEnabled = Boolean(enabled);
      if (!this.trailsEnabled) clearTrailEffects(this);
      const button = $("trails-button");
      if (button) {
        button.setAttribute("aria-pressed", String(this.trailsEnabled));
        button.textContent = `Trails: ${this.trailsEnabled ? "on" : "off"}`;
      }
      this.renderAt(this.currentPresentationMs);
      return this.trailsEnabled;
    },

    setFrontsEnabled(enabled) {
      if (this._destroyed) return this.frontsEnabled;
      this.frontsEnabled = Boolean(enabled) && frontlinesAvailable;
      if (!this.frontsEnabled) clearFrontTransitions(this);
      if (this.frontsEnabled) frontlineLayer.removeAttribute("hidden");
      else frontlineLayer.setAttribute("hidden", "");
      const button = $("fronts-button");
      if (button) {
        button.disabled = !frontlinesAvailable;
        button.setAttribute("aria-pressed", String(this.frontsEnabled));
        button.textContent = `Fronts: ${this.frontsEnabled ? "on" : "off"}`;
      }
      updateFrontlineInspector(this);
      return this.frontsEnabled;
    },

    async setModernBordersEnabled(enabled) {
      if (this._destroyed) return false;
      this.modernBordersEnabled = Boolean(enabled);
      const button = $("modern-borders-button");
      const syncButton = () => {
        if (!button) return;
        button.setAttribute("aria-pressed", String(this.modernBordersEnabled));
        button.textContent = `Modern borders: ${this.modernBordersEnabled ? "on" : "off"}`;
      };
      syncButton();
      if (!this.modernBordersEnabled) {
        if (this._modernBordersLayer && map.hasLayer(this._modernBordersLayer)) {
          map.removeLayer(this._modernBordersLayer);
        }
        documentRef._battleRuntimeMapWarning = null;
        showBattleWarnings(documentRef);
        return false;
      }

      let pending = this._modernBordersPromise;
      if (!this._modernBordersLayer && !pending) {
        pending = loadBattle("./data/modern-borders-50m.geojson")
          .then((data) => L.geoJSON(data, {
            pane: "modernBordersPane",
            style: {
              color: "#59636b",
              weight: 1,
              opacity: 0.55,
              fill: false,
              interactive: false,
            },
          }));
        this._modernBordersPromise = pending;
      }

      try {
        if (pending) {
          const layer = await pending;
          if (this._modernBordersPromise === pending) this._modernBordersPromise = null;
          if (this._destroyed) return false;
          this._modernBordersLayer ||= layer;
        }
        if (this.modernBordersEnabled && !map.hasLayer(this._modernBordersLayer)) {
          this._modernBordersLayer.addTo(map);
        }
        if (this.modernBordersEnabled) {
          documentRef._battleRuntimeMapWarning = null;
          showBattleWarnings(documentRef);
        }
        return this.modernBordersEnabled;
      } catch (error) {
        if (this._modernBordersPromise === pending) this._modernBordersPromise = null;
        if (this._destroyed || !this.modernBordersEnabled) return false;
        this.modernBordersEnabled = false;
        syncButton();
        documentRef._battleRuntimeMapWarning = `Unable to load modern borders: ${error.message}`;
        showBattleWarnings(documentRef);
        return false;
      }
    },

    focusActiveEvents() {
      if (this._destroyed || !this.sampledState) return false;
      const plan = currentFocusPlan(this);
      if (plan.kind === "none") return false;
      moveMapProgrammatically(this, () => {
        if (plan.kind === "view") {
          const [lon, lat] = plan.center;
          if (reducedMotion) map.setView([lat, lon], plan.zoom, { animate: false });
          else map.flyTo([lat, lon], plan.zoom, { duration: 0.9, animate: true });
        } else {
          const bounds = L.latLngBounds(plan.points.map(([lon, lat]) => [lat, lon])).pad(0.3);
          if (reducedMotion) map.fitBounds(bounds, { maxZoom: plan.maxZoom, animate: false });
          else map.flyToBounds(bounds, {
            maxZoom: plan.maxZoom,
            duration: 0.9,
            animate: true,
          });
        }
      });
      return true;
    },

    showEvent(index) {
      if (this._destroyed) return this.sampledState;
      const bounded = Math.max(0, Math.min(index, orderedEvents.length - 1));
      const window = compiled.eventWindows[bounded];
      if (!window) return this.seek(0);
      const sampled = this.seek(compiled.toPresentationTime(window.startMs));
      displaySelectedEvent(this, window);
      return sampled;
    },

    next() {
      if (this._destroyed) return;
      this.showEvent(this.currentIndex + 1);
    },
    prev() {
      if (this._destroyed) return;
      this.showEvent(this.currentIndex - 1);
    },

    play() {
      if (this._destroyed) return;
      if (this.isPlaying) return;
      if (this.currentPresentationMs >= duration) this.seek(0);
      this._setPlaying(true);
      this._lastFrameTime = null;
      this._frame = requestFrame((timestamp) => this._tick(timestamp));
    },
    pause() {
      if (this._destroyed) return;
      if (this._frame !== null) {
        cancelFrame(this._frame);
        this._frame = null;
      }
      this._lastFrameTime = null;
      this._setPlaying(false);
    },
    toggle() {
      if (this._destroyed) return;
      if (this.isPlaying) this.pause();
      else this.play();
    },
    _tick(timestamp) {
      if (this._destroyed || !this.isPlaying) return;
      if (this._lastFrameTime === null) this._lastFrameTime = timestamp;
      const elapsed = Math.max(0, timestamp - this._lastFrameTime);
      this._lastFrameTime = timestamp;
      const nextTime = Math.min(duration, this.currentPresentationMs + elapsed * this.playbackRate);
      this.renderAt(nextTime, { mode: "playback" });
      if (nextTime >= duration) {
        this.pause();
        return;
      }
      this._frame = requestFrame((nextTimestamp) => this._tick(nextTimestamp));
    },
    _setPlaying(playing) {
      this.isPlaying = playing;
      const button = $("play-button");
      if (button) {
        button.textContent = playing ? "Pause" : "Play";
        button.setAttribute("aria-pressed", String(playing));
      }
    },

    destroy() {
      if (this._destroyed) return;
      this.pause();
      this.modernBordersEnabled = false;
      if (this._modernBordersLayer && map.hasLayer(this._modernBordersLayer)) {
        map.removeLayer(this._modernBordersLayer);
      }
      clearTrailEffects(this);
      clearFrontTransitions(this);
      frontlineEls.clear();
      for (const key of [...beaconEls.keys()]) removeBeacon(key);
      this.sampledState = null;
      this._lastTrailHistoricalMs = null;
      this._destroyed = true;
      const focusButton = $("focus-event-button");
      if (focusButton) focusButton.disabled = true;
      this._controlsTeardown?.();
      teardownTimeline();
      if (invalidateTimer !== null) {
        cancelTimeout(invalidateTimer);
        invalidateTimer = null;
      }
      documentRef.removeEventListener("keydown", onKey);
      map.off();
      map.remove();
      svg.remove();
      for (const card of visibleCards.splice(0)) card.dispose();
      if (cardStack) cardStack.replaceChildren();
      if (mapEl._battleController === this) delete mapEl._battleController;
    },
  };

  function onKey(event) {
    if (event.target && /^(input|textarea|select|button)$/i.test(event.target.tagName)) return;
    if (event.key === "ArrowRight") {
      controller.pause();
      controller.next();
    } else if (event.key === "ArrowLeft") {
      controller.pause();
      controller.prev();
    } else if (event.key === " ") {
      event.preventDefault();
      controller.toggle();
    }
  }
  documentRef.addEventListener("keydown", onKey);

  const onMapMoveStart = () => svg.classList.add("is-moving");
  const onMapMoveEnd = () => {
    svg.classList.remove("is-moving");
    applyZoomLabelClass();
    suppressSecondaryLabelCollisions();
    controller._programmaticMove = false;
  };
  const onMapZoomEnd = () => {
    reprojectMap();
    onMapMoveEnd();
  };
  const onMapDragStart = () => controller.setFollowEnabled(false);
  const onManualMapZoomStart = () => {
    if (!controller._programmaticMove) controller.setFollowEnabled(false);
  };
  map.on("move zoom viewreset resize", reprojectMap);
  map.on("movestart zoomstart", onMapMoveStart);
  map.on("dragstart", onMapDragStart);
  map.on("zoomstart", onManualMapZoomStart);
  map.on("moveend", onMapMoveEnd);
  map.on("zoomend", onMapZoomEnd);

  const scrubber = $("event-scrubber");
  if (scrubber) scrubber.max = String(duration);
  const progress = $("event-progress");
  if (progress) progress.textContent = orderedEvents.length ? `1 / ${orderedEvents.length}` : "0 / 0";
  controller.setSpeed(1);
  controller.setFollowEnabled(true);
  controller.setTrailsEnabled(false);
  controller.setModernBordersEnabled(false);
  controller.setFrontsEnabled(frontlinesAvailable);

  mapEl._battleController = controller;
  redrawStaticGeometry();
  applyZoomLabelClass();
  controller.seek(0);
  return controller;
}

export function playTimeline(controller) {
  controller.play();
}

function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function battleDisplayOffsetMinutes(battle) {
  const ranges = [
    battle?.battle?.date,
    ...(battle?.historical_events || []).map((event) => event.time),
    ...(battle?.movements || []).flatMap((movement) => [movement.time, movement.waypoint_times]),
    ...(battle?.engagements || []).map((engagement) => engagement.time),
  ];
  const values = ranges.flatMap((range) => {
    if (Array.isArray(range)) return range;
    return range && typeof range === "object" ? [range.start, range.end] : [];
  });
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) continue;
    if (match[1] === "Z") return 0;
    const minutes = Number(match[3]) * 60 + Number(match[4]);
    return match[2] === "+" ? minutes : -minutes;
  }
  return 0;
}

function formatHistoricalTime(milliseconds, displayOffsetMinutes) {
  const iso = new Date(milliseconds + displayOffsetMinutes * 60000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function eventCoord(event, places) {
  const place = places.get((event.place_ids || [])[0]);
  if (place) return geometryPoint(place.geometry);
  return null;
}

function geometryPoint(geometry) {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return geometry.coordinates[0];
  if (geometry.type === "Polygon") return geometry.coordinates[0][0];
  return [0, 0];
}

function collectCoordinates(battle) {
  const points = [];
  for (const place of battle.places) {
    const geometry = place.geometry;
    if (geometry.type === "Point") points.push(geometry.coordinates);
    else if (geometry.type === "LineString") points.push(...geometry.coordinates);
    else if (geometry.type === "Polygon") for (const ring of geometry.coordinates) points.push(...ring);
  }
  for (const movement of battle.movements) {
    points.push(...movement.path.coordinates);
  }
  return points;
}

function buildLegend(battle, documentRef, colorOf) {
  const legend = documentRef.getElementById("legend");
  if (!legend) return;
  legend.replaceChildren();
  for (const side of battle.sides) {
    const row = documentRef.createElement("li");
    const swatch = documentRef.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = colorOf(side.id);
    const label = documentRef.createElement("span");
    label.textContent = side.name;
    row.append(swatch, label);
    legend.append(row);
  }
}

function bindStaticText(battle, documentRef) {
  setText(documentRef, "battle-name", battle.battle.name);
  setText(documentRef, "battle-date", `${battle.battle.date.label} / ${battle.battle.part_of}`);
  setText(documentRef, "battle-summary", battle.battle.summary);
}

function buildTimeline(events, documentRef, onSelect) {
  const timeline = documentRef.getElementById("timeline");
  timeline.replaceChildren();
  const bindings = [];
  events.forEach((event, index) => {
    const item = documentRef.createElement("li");
    const button = documentRef.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.innerHTML = `<strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.type)} / ${escapeHtml(event.time.label)}</span>`;
    const handler = () => onSelect(index);
    button.addEventListener("click", handler);
    bindings.push({ button, handler });
    item.append(button);
    timeline.append(item);
  });
  return () => {
    for (const { button, handler } of bindings) button.removeEventListener("click", handler);
  };
}

function updateTimeline(documentRef, index, reducedMotion = false) {
  const buttons = [...documentRef.querySelectorAll("#timeline button")];
  buttons.forEach((button, buttonIndex) => {
    button.setAttribute("aria-current", buttonIndex === index ? "true" : "false");
  });
  buttons[index]?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
}

function setText(documentRef, id, text) {
  const el = documentRef.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

function svgEl(documentRef, name, attrs = {}, text = "") {
  const element = documentRef.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  if (text) element.textContent = text;
  return element;
}

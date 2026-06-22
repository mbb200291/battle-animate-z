/* global L */
const SVG_NS = "http://www.w3.org/2000/svg";

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

// Default unit glyphs by actor kind. animation_hints.style.actor_icons can
// override per actor with a named icon or any emoji (e.g. "🚢", "🐎").
const DEFAULT_ACTOR_ICONS = {
  army: "🪖",
  corps: "🪖",
  division: "🎖️",
  brigade: "🎖️",
  regiment: "🎖️",
  fleet: "🚢",
  unit: "🔹",
  person: "🎖️",
  other: "🔹",
};

const NAMED_ACTOR_ICONS = {
  ship: "🚢",
  warship: "🚢",
  navy: "🚢",
  naval: "🚢",
  fleet: "🚢",
  boat: "⛵",
  infantry: "🪖",
  soldier: "🪖",
  army: "🪖",
  cavalry: "🐎",
  horse: "🐎",
  artillery: "💥",
  cannon: "💥",
  tank: "🛡️",
  armor: "🛡️",
  armored: "🛡️",
  plane: "✈️",
  aircraft: "✈️",
  air: "✈️",
  commander: "🎖️",
  hq: "🚩",
  fort: "🏰",
  fortress: "🏰",
};

function resolveActorIcon(actor, actorIcons) {
  const value = actorIcons[actor.id];
  if (value) {
    if (NAMED_ACTOR_ICONS[value]) return NAMED_ACTOR_ICONS[value];
    if ([...value].length <= 4) return value; // emoji or short glyph
  }
  return DEFAULT_ACTOR_ICONS[actor.kind] || "🔹";
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

// Browser-side validation mirroring battle_animation/validator.py: required
// top-level keys, schema version, the event-type enum, and every cross-reference.
export function validateBattle(battle) {
  const errors = [];
  if (!battle || typeof battle !== "object" || Array.isArray(battle)) {
    return ["document is not a JSON object"];
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

  if ("schema_version" in battle && battle.schema_version !== "0.1.0") {
    errors.push(`schema_version must be "0.1.0", got ${JSON.stringify(battle.schema_version)}`);
  }

  const idSet = (key) => new Set((battle[key] || []).map((item) => item && item.id));
  const sideIds = idSet("sides");
  const commanderIds = idSet("commanders");
  const actorIds = idSet("actors");
  const placeIds = idSet("places");
  const eventIds = idSet("historical_events");
  const sourceIds = idSet("sources");

  const check = (id, set, label) => {
    if (!set.has(id)) errors.push(`${label}: unknown id ${JSON.stringify(id)}`);
  };

  (battle.commanders || []).forEach((commander, i) => {
    if ("side_id" in commander) check(commander.side_id, sideIds, `commanders[${i}].side_id`);
  });

  (battle.actors || []).forEach((actor, i) => {
    if ("side_id" in actor) check(actor.side_id, sideIds, `actors[${i}].side_id`);
    (actor.commander_ids || []).forEach((id) => check(id, commanderIds, `actors[${i}].commander_ids`));
  });

  (battle.historical_events || []).forEach((event, i) => {
    if (event.type && !EVENT_TYPES.includes(event.type)) {
      errors.push(`historical_events[${i}].type: invalid value ${JSON.stringify(event.type)}`);
    }
    (event.actor_ids || []).forEach((id) => check(id, actorIds, `historical_events[${i}].actor_ids`));
    (event.target_actor_ids || []).forEach((id) => check(id, actorIds, `historical_events[${i}].target_actor_ids`));
    (event.place_ids || []).forEach((id) => check(id, placeIds, `historical_events[${i}].place_ids`));
    (event.source_ids || []).forEach((id) => check(id, sourceIds, `historical_events[${i}].source_ids`));
  });

  (battle.movements || []).forEach((movement, i) => {
    if ("event_id" in movement) check(movement.event_id, eventIds, `movements[${i}].event_id`);
    if ("actor_id" in movement) check(movement.actor_id, actorIds, `movements[${i}].actor_id`);
    if ("from_place_id" in movement) check(movement.from_place_id, placeIds, `movements[${i}].from_place_id`);
    if ("to_place_id" in movement) check(movement.to_place_id, placeIds, `movements[${i}].to_place_id`);
  });

  const outcome = battle.outcome;
  if (outcome && typeof outcome === "object") {
    (outcome.winner_side_ids || []).forEach((id) => check(id, sideIds, "outcome.winner_side_ids"));
    (outcome.source_ids || []).forEach((id) => check(id, sourceIds, "outcome.source_ids"));
  }

  return errors;
}

export function renderBattle(battle, documentRef = document) {
  const $ = (id) => documentRef.getElementById(id);
  const mapEl = $("battle-map");

  // Tear down a previous render so the same container can be reused.
  if (mapEl._battleController) mapEl._battleController.destroy();

  const sides = new Map(battle.sides.map((side) => [side.id, side]));
  const actors = new Map(battle.actors.map((actor) => [actor.id, actor]));
  const places = new Map(battle.places.map((place) => [place.id, place]));

  const style = battle.animation_hints?.style || {};
  const sideColors = style.side_colors || {};
  const eventIcons = style.event_icons || {};
  const actorIcons = style.actor_icons || {};
  const sideIndex = new Map(battle.sides.map((side, index) => [side.id, index]));
  const colorOf = (sideId) =>
    sideColors[sideId] || sides.get(sideId)?.color || SIDE_PALETTE[(sideIndex.get(sideId) ?? 0) % SIDE_PALETTE.length];
  const iconOf = (type) => resolveIcon(type, eventIcons);
  const actorIconOf = (actor) => resolveActorIcon(actor, actorIcons);

  const orderedEvents = orderEvents(battle);
  const orderIndex = new Map(orderedEvents.map((event, index) => [event.id, index]));
  const cameraByEvent = new Map((battle.animation_hints?.camera || []).map((cam) => [cam.event_id, cam]));

  // --- Leaflet map + OSM tiles ---
  const map = L.map(mapEl, { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const allCoords = collectCoordinates(battle);
  const mapHints = battle.animation_hints?.map || {};
  if (Array.isArray(mapHints.initial_center) && typeof mapHints.initial_zoom === "number") {
    map.setView([mapHints.initial_center[1], mapHints.initial_center[0]], mapHints.initial_zoom);
  } else if (allCoords.length) {
    map.fitBounds(L.latLngBounds(allCoords.map(([lon, lat]) => [lat, lon])).pad(0.25));
  } else {
    map.setView([0, 0], 2);
  }
  setTimeout(() => map.invalidateSize(), 0);

  // --- SVG overlay drawn on top of the map, re-projected on every map move ---
  const svg = documentRef.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "battle-overlay");
  map.getContainer().appendChild(svg);

  const project = ([lon, lat]) => map.latLngToContainerPoint([lat, lon]);
  const toPath = (coords) =>
    coords
      .map((coord, index) => {
        const point = project(coord);
        return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      })
      .join(" ");

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

  const movementEls = new Map();
  for (const movement of battle.movements) {
    const actor = actors.get(movement.actor_id);
    const path = svgEl(documentRef, "path", {
      class: "movement-path",
      pathLength: "1",
      stroke: colorOf(actor?.side_id),
      "stroke-width": style.movement_line_width || 4,
    });
    if (movement.precision === "inferred" || (typeof movement.confidence === "number" && movement.confidence <= 0.6)) {
      path.classList.add("is-inferred");
    }
    svg.append(path);
    movementEls.set(movement.id, { coords: movement.path.coordinates, path });
  }

  const unitEls = new Map();
  for (const actor of battle.actors) {
    const unit = svgEl(documentRef, "g", { class: "unit" });
    unit.append(
      svgEl(documentRef, "circle", { class: "unit-disc", r: 14, fill: colorOf(actor.side_id) }),
      svgEl(documentRef, "text", { class: "unit-icon", "text-anchor": "middle", y: 6 }, actorIconOf(actor)),
      svgEl(documentRef, "text", { class: "unit-label", x: 20, y: 5 }, actor.name)
    );
    svg.append(unit);
    unitEls.set(actor.id, { g: unit });
  }

  const markerEls = new Map();
  for (const event of orderedEvents) {
    const marker = svgEl(documentRef, "g", { class: "event-marker" });
    if (typeof event.confidence === "number" && event.confidence < 0.5) {
      marker.classList.add("is-low-confidence");
    }
    // Inner group carries the active-state scale so it never overrides the
    // outer group's positioning transform attribute.
    const inner = svgEl(documentRef, "g", { class: "event-marker-inner" });
    inner.append(
      svgEl(documentRef, "circle", { class: "event-disc", r: 16 }),
      svgEl(documentRef, "text", { class: "event-icon", y: 5 }, iconOf(event.type))
    );
    marker.append(inner);
    svg.append(marker);
    markerEls.set(event.id, { coord: eventCoord(event, places), g: marker });
  }

  const snapshots = buildSnapshots(battle, orderedEvents);
  let actorPositions = snapshots[0];

  function redraw() {
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
    for (const { coords, path } of movementEls.values()) {
      path.setAttribute("d", toPath(coords));
    }
    for (const { coord, g } of markerEls.values()) {
      const point = project(coord);
      g.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
    for (const [actorId, { g }] of unitEls) {
      const coord = actorPositions.get(actorId);
      if (!coord) continue;
      const point = project(coord);
      g.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
  }

  map.on("move zoom viewreset resize", redraw);
  map.on("movestart zoomstart", () => svg.classList.add("is-moving"));
  map.on("moveend zoomend", () => svg.classList.remove("is-moving"));

  buildLegend(battle, documentRef, colorOf);
  bindStaticText(battle, documentRef);
  buildTimeline(orderedEvents, documentRef, (index) => {
    controller.pause();
    controller.showEvent(index);
  });

  const duration = battle.animation_hints?.timeline?.default_event_duration_ms || 1800;

  const controller = {
    battle,
    orderedEvents,
    map,
    currentIndex: 0,
    isPlaying: false,
    _timer: null,

    showEvent(index) {
      const bounded = Math.max(0, Math.min(index, orderedEvents.length - 1));
      this.currentIndex = bounded;
      const event = orderedEvents[bounded];
      actorPositions = snapshots[bounded];

      for (const [eventId, { g }] of markerEls) {
        const order = orderIndex.get(eventId);
        g.classList.toggle("is-visible", order <= bounded);
        g.classList.toggle("is-active", eventId === event.id);
      }
      for (const movement of battle.movements) {
        const el = movementEls.get(movement.id);
        const order = orderIndex.get(movement.event_id);
        el.path.classList.toggle("is-visible", order !== undefined && order <= bounded);
        el.path.classList.toggle("is-active", movement.event_id === event.id);
      }

      redraw();
      updateInspector(documentRef, event);
      updateTimeline(documentRef, bounded);

      const scrubber = $("event-scrubber");
      if (scrubber) scrubber.value = String(bounded);
      const progress = $("event-progress");
      if (progress) progress.textContent = `${bounded + 1} / ${orderedEvents.length}`;

      const cam = cameraByEvent.get(event.id);
      if (cam && Array.isArray(cam.center)) {
        map.flyTo([cam.center[1], cam.center[0]], cam.zoom ?? map.getZoom(), { duration: 0.8 });
      }
    },

    next() {
      this.showEvent(this.currentIndex + 1);
    },
    prev() {
      this.showEvent(this.currentIndex - 1);
    },

    play() {
      if (this._timer) return;
      if (this.currentIndex >= orderedEvents.length - 1) this.showEvent(0);
      this._timer = setInterval(() => {
        if (this.currentIndex >= orderedEvents.length - 1) {
          this.pause();
          return;
        }
        this.showEvent(this.currentIndex + 1);
      }, duration);
      this._setPlaying(true);
    },
    pause() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this._setPlaying(false);
    },
    toggle() {
      if (this._timer) this.pause();
      else this.play();
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
      this.pause();
      documentRef.removeEventListener("keydown", onKey);
      map.off();
      map.remove();
      svg.remove();
      delete mapEl._battleController;
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

  const scrubber = $("event-scrubber");
  if (scrubber) scrubber.max = String(orderedEvents.length - 1);

  mapEl._battleController = controller;
  // Suppress transitions for the very first placement so units/markers appear
  // at their positions instead of flying in from the SVG origin.
  svg.classList.add("is-moving");
  controller.showEvent(0);
  requestAnimationFrame(() => svg.classList.remove("is-moving"));
  return controller;
}

export function playTimeline(controller) {
  controller.play();
}

function orderEvents(battle) {
  const eventsById = new Map(battle.historical_events.map((event) => [event.id, event]));
  const orderedIds = battle.animation_hints?.timeline?.ordered_event_ids || [];
  const ordered = orderedIds.map((id) => eventsById.get(id)).filter(Boolean);
  const missing = battle.historical_events.filter((event) => !orderedIds.includes(event.id));
  return [...ordered, ...missing];
}

// Cumulative actor positions after each ordered event, so scrubbing backward
// puts every unit where it actually was at that point in the timeline.
function buildSnapshots(battle, orderedEvents) {
  const current = new Map();
  for (const actor of battle.actors) {
    current.set(actor.id, firstActorCoord(actor.id, battle));
  }
  const snapshots = [];
  orderedEvents.forEach((event, index) => {
    for (const movement of battle.movements) {
      if (movement.event_id === event.id) {
        const coords = movement.path.coordinates;
        current.set(movement.actor_id, coords[coords.length - 1]);
      }
    }
    snapshots[index] = new Map(current);
  });
  if (snapshots.length === 0) snapshots[0] = new Map(current);
  return snapshots;
}

function firstActorCoord(actorId, battle) {
  const movement = battle.movements.find((item) => item.actor_id === actorId);
  if (movement) return movement.path.coordinates[0];
  const event = battle.historical_events.find((item) => (item.actor_ids || []).includes(actorId));
  if (event) {
    const place = battle.places.find((item) => item.id === (event.place_ids || [])[0]);
    if (place) return geometryPoint(place.geometry);
  }
  return geometryPoint(battle.places[0].geometry);
}

function eventCoord(event, places) {
  const place = places.get((event.place_ids || [])[0]);
  if (place) return geometryPoint(place.geometry);
  return [0, 0];
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
  events.forEach((event, index) => {
    const item = documentRef.createElement("li");
    const button = documentRef.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.innerHTML = `<strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.type)} / ${escapeHtml(event.time.label)}</span>`;
    button.addEventListener("click", () => onSelect(index));
    item.append(button);
    timeline.append(item);
  });
}

function updateInspector(documentRef, event) {
  setText(documentRef, "event-type", event.type);
  setText(documentRef, "event-title", event.title);
  setText(documentRef, "event-description", event.description || "");
  setText(documentRef, "event-precision", event.precision || "unknown");
  const confidence = typeof event.confidence === "number" ? event.confidence : 0;
  setText(documentRef, "event-confidence", `${Math.round(confidence * 100)}%`);
  const bar = documentRef.getElementById("confidence-bar");
  if (bar) bar.style.width = `${Math.round(confidence * 100)}%`;
}

function updateTimeline(documentRef, index) {
  const buttons = [...documentRef.querySelectorAll("#timeline button")];
  buttons.forEach((button, buttonIndex) => {
    button.setAttribute("aria-current", buttonIndex === index ? "true" : "false");
  });
  buttons[index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

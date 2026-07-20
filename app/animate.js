/* global L */
import { compileTimeline, sampleTimeline } from "./timeline.js";
import { resolveSymbol } from "./symbols.js";

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
  const $ = (id) => documentRef.getElementById(id);
  const play = $("play-button");
  if (play) play.onclick = () => controller.toggle();
  const reset = $("reset-button");
  if (reset) reset.onclick = () => {
    controller.pause();
    controller.seek(0);
  };
  const previous = $("prev-button");
  if (previous) previous.onclick = () => {
    controller.pause();
    controller.prev();
  };
  const next = $("next-button");
  if (next) next.onclick = () => {
    controller.pause();
    controller.next();
  };
  const scrubber = $("event-scrubber");
  if (scrubber) scrubber.oninput = (event) => {
    controller.pause();
    controller.seek(Number(event.target.value));
  };
  for (const button of documentRef.querySelectorAll("#speed-controls [data-speed]")) {
    button.onclick = () => controller.setSpeed(Number(button.dataset.speed));
  }
  const follow = $("follow-button");
  if (follow) follow.onclick = () => controller.setFollowEnabled(!controller.followEnabled);
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

  if ("schema_version" in battle && !["0.1.0", "0.2.0"].includes(battle.schema_version)) {
    errors.push(`schema_version must be "0.1.0" or "0.2.0", got ${JSON.stringify(battle.schema_version)}`);
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
    if ("parent_id" in actor) check(actor.parent_id, actorIds, `actors[${i}].parent_id`);
    (actor.commander_ids || []).forEach((id) => check(id, commanderIds, `actors[${i}].commander_ids`));
  });

  (battle.engagements || []).forEach((eng, i) => {
    if ("event_id" in eng) check(eng.event_id, eventIds, `engagements[${i}].event_id`);
    if ("attacker_actor_id" in eng) check(eng.attacker_actor_id, actorIds, `engagements[${i}].attacker_actor_id`);
    if ("target_actor_id" in eng) check(eng.target_actor_id, actorIds, `engagements[${i}].target_actor_id`);
    if ("result_actor_id" in eng) check(eng.result_actor_id, actorIds, `engagements[${i}].result_actor_id`);
    if ("at_place_id" in eng) check(eng.at_place_id, placeIds, `engagements[${i}].at_place_id`);
    (eng.source_ids || []).forEach((id) => check(id, sourceIds, `engagements[${i}].source_ids`));
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
  const cardStack = $("event-card-stack");

  // Tear down a previous render so the same container can be reused.
  if (mapEl._battleController) mapEl._battleController.destroy();
  if (cardStack) cardStack.replaceChildren();

  const sides = new Map(battle.sides.map((side) => [side.id, side]));
  const actors = new Map(battle.actors.map((actor) => [actor.id, actor]));
  const places = new Map(battle.places.map((place) => [place.id, place]));
  const compiled = compileTimeline(battle);
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
  for (const [sourceIndex, movement] of battle.movements.entries()) {
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
    const track = compiled.tracks.find((candidate) =>
      candidate.id === movement.id || candidate.sourceIndex === sourceIndex);
    movementEls.set(movement.id, { coords: movement.path.coordinates, path, track });
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
    unit.append(
      svgEl(documentRef, "text", { class: "unit-label", x: 20, y: 1 }, actor.name),
      svgEl(documentRef, "text", { class: "unit-sub-label", x: 20, y: 14 }, symbol.token.replaceAll("_", " ")),
    );
    svg.append(unit);
    unitEls.set(actor.id, { g: unit, heading, symbol });
  }

  const markerEls = new Map();
  for (const window of compiled.eventWindows) {
    const event = window.event;
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
    markerEls.set(event.id, { coord: eventCoord(event, places), g: marker, window });
  }

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
    for (const { coords, path } of movementEls.values()) {
      path.setAttribute("d", toPath(coords));
    }
    for (const { coord, g } of markerEls.values()) {
      const point = project(coord);
      g.setAttribute("transform", `translate(${point.x} ${point.y})`);
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
    updateActorPositions();
    redrawEngagementEndpoints();
  }

  buildLegend(battle, documentRef, colorOf);
  bindStaticText(battle, documentRef);
  buildTimeline(orderedEvents, documentRef, (index) => {
    controller.pause();
    controller.showEvent(index);
  });

  const duration = compiled.presentationDurationMs;
  const windowRef = documentRef.defaultView || globalThis;
  const requestFrame = windowRef.requestAnimationFrame.bind(windowRef);
  const cancelFrame = windowRef.cancelAnimationFrame.bind(windowRef);
  let renderedEventIndex = -1;
  let passageEventId = null;
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
    if (!cardStack || passageEventId === selected.id) return;
    passageEventId = selected.id;
    const event = selected.event;
    const card = documentRef.createElement("article");
    card.setAttribute("class", "event-card");
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
    card.addEventListener("pointerenter", pause);
    card.addEventListener("click", pause);
    cardStack.append(card);
    visibleCards.push({ element: card, id: selected.id, shownAt: nowMs() });
    while (visibleCards.length > 3) visibleCards.shift().element.remove();
  }

  function pruneEventCards(currentId) {
    const now = nowMs();
    for (let index = visibleCards.length - 1; index >= 0; index -= 1) {
      const item = visibleCards[index];
      if (item.id !== currentId && now - item.shownAt >= 3000) {
        item.element.remove();
        visibleCards.splice(index, 1);
      }
    }
  }

  function selectedEventWindow(sampled) {
    const active = compiled.eventWindows.find(({ id }) => sampled.activeEventIds.has(id));
    if (active) return active;
    let latest = null;
    for (const window of compiled.eventWindows) {
      if (window.startMs <= sampled.historicalMs
          && (!latest || window.startMs >= latest.startMs)) latest = window;
    }
    return latest || compiled.eventWindows[0] || null;
  }

  function displaySelectedEvent(owner, selected) {
    if (!selected) return;
    const selectedIndex = orderIndex.get(selected.id) ?? 0;
    owner.currentIndex = selectedIndex;
    if (selectedIndex === renderedEventIndex) return;
    updateTimeline(documentRef, selectedIndex);
    const progress = $("event-progress");
    if (progress) progress.textContent = `${selectedIndex + 1} / ${orderedEvents.length}`;
    appendEventCard(selected);
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

  function maybeFollow(owner, sampled) {
    if (!owner.followEnabled || owner._programmaticMove) return;
    const wallTime = nowMs();
    if (wallTime - owner._lastFollowCheck < 500) return;
    owner._lastFollowCheck = wallTime;
    const points = activeGeographicPoints(sampled);
    if (!points.length) return;
    const size = map.getSize ? map.getSize() : { x: mapEl.clientWidth, y: mapEl.clientHeight };
    const insetX = size.x * 0.22;
    const insetY = size.y * 0.22;
    const projected = points.map(project);
    const outside = projected.some(({ x, y }) =>
      x < insetX || x > size.x - insetX || y < insetY || y > size.y - insetY);
    if (!outside) return;
    const center = projected.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    center.x /= projected.length;
    center.y /= projected.length;
    const distance = Math.hypot(center.x - size.x / 2, center.y - size.y / 2);
    const flyDuration = Math.min(2.4, Math.max(0.8, 0.8 + distance / 500));
    const bounds = L.latLngBounds(points.map(([lon, lat]) => [lat, lon])).pad(0.35);
    owner._programmaticMove = true;
    try {
      map.flyToBounds(bounds, { duration: flyDuration, animate: true });
    } catch (error) {
      owner._programmaticMove = false;
      throw error;
    }
  }

  const controller = {
    battle,
    compiled,
    orderedEvents,
    map,
    currentIndex: 0,
    currentPresentationMs: 0,
    sampledState: null,
    playbackRate: 1,
    followEnabled: true,
    isPlaying: false,
    _frame: null,
    _lastFrameTime: null,
    _lastFollowCheck: -Infinity,
    _programmaticMove: false,
    _destroyed: false,

    renderAt(presentationMs) {
      const bounded = Math.min(duration, Math.max(0, Number.isFinite(presentationMs) ? presentationMs : 0));
      this.currentPresentationMs = bounded;
      const sampled = sampleTimeline(compiled, bounded);
      this.sampledState = sampled;
      actorPositions = sampled.actorPositions;
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
      for (const { g, window } of markerEls.values()) {
        g.classList.toggle("is-visible", sampled.historicalMs >= window.startMs);
        g.classList.toggle("is-active", sampled.activeEventIds.has(window.id));
      }

      displaySelectedEvent(this, selectedEventWindow(sampled));
      const selected = selectedEventWindow(sampled);
      pruneEventCards(selected?.id);
      maybeFollow(this, sampled);
      return sampled;
    },

    seek(presentationMs) {
      return this.renderAt(presentationMs);
    },

    setSpeed(rate) {
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
      this.followEnabled = Boolean(enabled);
      if (this.followEnabled) this._lastFollowCheck = -Infinity;
      const button = $("follow-button");
      if (button) {
        button.setAttribute("aria-pressed", String(this.followEnabled));
        button.textContent = `Follow: ${this.followEnabled ? "on" : "off"}`;
      }
      return this.followEnabled;
    },

    showEvent(index) {
      const bounded = Math.max(0, Math.min(index, orderedEvents.length - 1));
      const window = compiled.eventWindows[bounded];
      if (!window) return this.seek(0);
      const sampled = this.seek(compiled.toPresentationTime(window.startMs));
      displaySelectedEvent(this, window);
      return sampled;
    },

    next() {
      this.showEvent(this.currentIndex + 1);
    },
    prev() {
      this.showEvent(this.currentIndex - 1);
    },

    play() {
      if (this.isPlaying) return;
      if (this.currentPresentationMs >= duration) this.seek(0);
      this._setPlaying(true);
      this._lastFrameTime = null;
      this._frame = requestFrame((timestamp) => this._tick(timestamp));
    },
    pause() {
      if (this._frame !== null) {
        cancelFrame(this._frame);
        this._frame = null;
      }
      this._lastFrameTime = null;
      this._setPlaying(false);
    },
    toggle() {
      if (this.isPlaying) this.pause();
      else this.play();
    },
    _tick(timestamp) {
      if (!this.isPlaying) return;
      if (this._lastFrameTime === null) this._lastFrameTime = timestamp;
      const elapsed = Math.max(0, timestamp - this._lastFrameTime);
      this._lastFrameTime = timestamp;
      const nextTime = Math.min(duration, this.currentPresentationMs + elapsed * this.playbackRate);
      this.renderAt(nextTime);
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
      this._destroyed = true;
      this.pause();
      documentRef.removeEventListener("keydown", onKey);
      map.off();
      map.remove();
      svg.remove();
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
    controller._programmaticMove = false;
  };
  const onManualMapStart = () => {
    if (!controller._programmaticMove) controller.setFollowEnabled(false);
  };
  map.on("move zoom viewreset resize", reprojectMap);
  map.on("movestart zoomstart", onMapMoveStart);
  map.on("dragstart zoomstart", onManualMapStart);
  map.on("moveend zoomend", onMapMoveEnd);

  const scrubber = $("event-scrubber");
  if (scrubber) scrubber.max = String(duration);
  controller.setSpeed(1);
  controller.setFollowEnabled(true);

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

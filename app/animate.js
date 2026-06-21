const SVG_NS = "http://www.w3.org/2000/svg";

export async function loadBattle(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load battle JSON: ${response.status}`);
  }
  return response.json();
}

export function renderBattle(battle, documentRef = document) {
  const svg = documentRef.getElementById("battle-map");
  const places = new Map(battle.places.map((place) => [place.id, place]));
  const actors = new Map(battle.actors.map((actor) => [actor.id, actor]));
  const sides = new Map(battle.sides.map((side) => [side.id, side]));
  const orderedEvents = orderEvents(battle);
  const projection = createProjection(battle);
  const movementElements = new Map();
  const markerElements = new Map();
  const unitElements = new Map();

  svg.replaceChildren();
  drawGrid(svg);
  drawPlaces(svg, battle.places, projection);

  for (const movement of battle.movements) {
    const actor = actors.get(movement.actor_id);
    const side = sides.get(actor?.side_id);
    const path = svgEl("path", {
      class: "movement-path",
      d: toPath(movement.path.coordinates, projection),
      pathLength: "1",
      stroke: side?.color || "#19202a",
      "stroke-width": battle.animation_hints.style.movement_line_width || 4,
    });
    svg.append(path);
    movementElements.set(movement.id, path);
  }

  for (const actor of battle.actors) {
    const side = sides.get(actor.side_id);
    const start = firstActorPoint(actor.id, battle, projection);
    const unit = svgEl("g", {
      class: "unit",
      transform: `translate(${start.x} ${start.y})`,
    });
    unit.append(
      svgEl("circle", {
        r: "11",
        fill: side?.color || "#19202a",
        stroke: "#fffaf0",
        "stroke-width": "3",
      }),
      svgEl("text", {
        x: "16",
        y: "4",
        "font-size": "13",
        fill: "#19202a",
      }, actor.name)
    );
    svg.append(unit);
    unitElements.set(actor.id, unit);
  }

  for (const event of orderedEvents) {
    const point = eventPoint(event, places, projection);
    const marker = svgEl("g", {
      class: "event-marker",
      transform: `translate(${point.x} ${point.y})`,
    });
    marker.append(
      svgEl("circle", {
        r: "17",
        fill: "rgba(255,250,240,0.9)",
        stroke: "#19202a",
        "stroke-width": "2",
      }),
      svgEl("text", {
        y: "5",
        "text-anchor": "middle",
        "font-size": "15",
        fill: "#19202a",
      }, iconFor(event.type))
    );
    svg.append(marker);
    markerElements.set(event.id, marker);
  }

  bindStaticText(battle, documentRef);
  buildTimeline(orderedEvents, documentRef);

  const controller = {
    battle,
    orderedEvents,
    currentIndex: 0,
    showEvent(index) {
      const boundedIndex = Math.max(0, Math.min(index, orderedEvents.length - 1));
      this.currentIndex = boundedIndex;
      const event = orderedEvents[boundedIndex];
      updateInspector(event, documentRef);
      updateTimeline(boundedIndex, documentRef);
      updateMap(event, battle, projection, movementElements, markerElements, unitElements);
    },
  };

  const select = documentRef.getElementById("event-select");
  select.addEventListener("change", () => controller.showEvent(Number(select.value)));
  controller.showEvent(0);
  return controller;
}

export function playTimeline(controller) {
  const duration = controller.battle.animation_hints.timeline.default_event_duration_ms || 1400;
  controller.showEvent(0);
  let nextIndex = 1;
  const timer = setInterval(() => {
    if (nextIndex >= controller.orderedEvents.length) {
      clearInterval(timer);
      return;
    }
    controller.showEvent(nextIndex);
    nextIndex += 1;
  }, duration);
  return timer;
}

function orderEvents(battle) {
  const eventsById = new Map(battle.historical_events.map((event) => [event.id, event]));
  const orderedIds = battle.animation_hints.timeline.ordered_event_ids || [];
  const ordered = orderedIds.map((id) => eventsById.get(id)).filter(Boolean);
  const missing = battle.historical_events.filter((event) => !orderedIds.includes(event.id));
  return [...ordered, ...missing];
}

function createProjection(battle) {
  const points = [];
  for (const place of battle.places) {
    collectCoordinates(place.geometry, points);
  }
  for (const movement of battle.movements) {
    for (const coordinate of movement.path.coordinates) points.push(coordinate);
  }

  const longitudes = points.map((point) => point[0]);
  const latitudes = points.map((point) => point[1]);
  const padding = battle.animation_hints.map.bounds_padding || 0.01;
  const minLon = Math.min(...longitudes) - padding;
  const maxLon = Math.max(...longitudes) + padding;
  const minLat = Math.min(...latitudes) - padding;
  const maxLat = Math.max(...latitudes) + padding;

  return ([lon, lat]) => ({
    x: 70 + ((lon - minLon) / (maxLon - minLon || 1)) * 860,
    y: 540 - ((lat - minLat) / (maxLat - minLat || 1)) * 460,
  });
}

function collectCoordinates(geometry, points) {
  if (geometry.type === "Point") {
    points.push(geometry.coordinates);
  } else if (geometry.type === "LineString") {
    points.push(...geometry.coordinates);
  } else if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) points.push(...ring);
  }
}

function drawGrid(svg) {
  for (let x = 100; x <= 900; x += 100) {
    svg.append(svgEl("line", { x1: x, y1: 70, x2: x, y2: 550, stroke: "#ddd2bd", "stroke-width": "1" }));
  }
  for (let y = 100; y <= 500; y += 100) {
    svg.append(svgEl("line", { x1: 60, y1: y, x2: 940, y2: y, stroke: "#ddd2bd", "stroke-width": "1" }));
  }
}

function drawPlaces(svg, places, projection) {
  for (const place of places) {
    if (place.geometry.type !== "Point") continue;
    const point = projection(place.geometry.coordinates);
    svg.append(
      svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: "5",
        fill: "#19202a",
      }),
      svgEl("text", {
        class: "place-label",
        x: point.x + 10,
        y: point.y - 8,
      }, place.name)
    );
  }
}

function toPath(coordinates, projection) {
  return coordinates
    .map((coordinate, index) => {
      const point = projection(coordinate);
      return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function firstActorPoint(actorId, battle, projection) {
  const movement = battle.movements.find((item) => item.actor_id === actorId);
  if (movement) return projection(movement.path.coordinates[0]);
  const event = battle.historical_events.find((item) => item.actor_ids.includes(actorId));
  if (event) {
    const place = battle.places.find((item) => item.id === event.place_ids[0]);
    if (place?.geometry.type === "Point") return projection(place.geometry.coordinates);
  }
  return { x: 500, y: 310 };
}

function eventPoint(event, places, projection) {
  const place = places.get(event.place_ids[0]);
  if (place?.geometry.type === "Point") return projection(place.geometry.coordinates);
  return { x: 500, y: 310 };
}

function updateMap(event, battle, projection, movementElements, markerElements, unitElements) {
  for (const marker of markerElements.values()) marker.classList.remove("is-active");
  markerElements.get(event.id)?.classList.add("is-active");

  for (const path of movementElements.values()) path.classList.remove("is-active");
  for (const movement of battle.movements.filter((item) => item.event_id === event.id)) {
    movementElements.get(movement.id)?.classList.add("is-active");
    const end = projection(movement.path.coordinates[movement.path.coordinates.length - 1]);
    unitElements.get(movement.actor_id)?.setAttribute("transform", `translate(${end.x} ${end.y})`);
  }
}

function bindStaticText(battle, documentRef) {
  setText(documentRef, "battle-name", battle.battle.name);
  setText(documentRef, "battle-date", `${battle.battle.date.label} / ${battle.battle.part_of}`);
  setText(documentRef, "battle-summary", battle.battle.summary);
}

function buildTimeline(events, documentRef) {
  const select = documentRef.getElementById("event-select");
  const timeline = documentRef.getElementById("timeline");
  select.replaceChildren();
  timeline.replaceChildren();

  events.forEach((event, index) => {
    select.append(new Option(`${index + 1}. ${event.title}`, String(index)));
    const item = documentRef.createElement("li");
    const button = documentRef.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.innerHTML = `<strong>${event.title}</strong><span>${event.type} / ${event.time.label}</span>`;
    button.addEventListener("click", () => {
      select.value = String(index);
      select.dispatchEvent(new Event("change"));
    });
    item.append(button);
    timeline.append(item);
  });
}

function updateInspector(event, documentRef) {
  setText(documentRef, "event-type", event.type);
  setText(documentRef, "event-title", event.title);
  setText(documentRef, "event-description", event.description);
  setText(documentRef, "event-precision", event.precision);
  setText(documentRef, "event-confidence", `${Math.round(event.confidence * 100)}%`);
  documentRef.getElementById("event-select").value = String(
    [...documentRef.getElementById("event-select").options].findIndex((option) => option.textContent.includes(event.title))
  );
}

function updateTimeline(index, documentRef) {
  for (const [buttonIndex, button] of [...documentRef.querySelectorAll("#timeline button")].entries()) {
    button.setAttribute("aria-current", buttonIndex === index ? "true" : "false");
  }
}

function setText(documentRef, id, text) {
  documentRef.getElementById(id).textContent = text;
}

function iconFor(type) {
  return {
    advance: ">>",
    retreat: "<<",
    attack: "!",
    defend: "[]",
    capture: "#",
    surrender: "x",
    reinforcement: "+",
    bombardment: "*",
    landing: "v",
    other: ".",
  }[type] || ".";
}

function svgEl(name, attrs = {}, text = "") {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  if (text) element.textContent = text;
  return element;
}

const validPoint = (value) =>
  Array.isArray(value) && value.length >= 2
  && Number.isFinite(value[0]) && Number.isFinite(value[1]);

function geometryPoints(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "Point") return validPoint(geometry.coordinates) ? [geometry.coordinates] : [];
  if (geometry.type === "LineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates.filter(validPoint) : [];
  }
  if (geometry.type === "Polygon") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates.flat().filter(validPoint) : [];
  }
  return [];
}

export function buildFocusPlan({
  activeEventIds,
  selectedEventId,
  eventWindows,
  places,
  actorPositions,
  cameras = [],
  extraActorIds = [],
}) {
  let windows = eventWindows.filter(({ id }) => activeEventIds.has(id));
  if (!windows.length && selectedEventId) {
    windows = eventWindows.filter(({ id }) => id === selectedEventId);
  }

  const actorIds = new Set();
  const points = [];
  for (const { event } of windows) {
    for (const id of [...(event.actor_ids || []), ...(event.target_actor_ids || [])]) actorIds.add(id);
    for (const id of event.place_ids || []) points.push(...geometryPoints(places.get(id)?.geometry));
  }
  for (const id of extraActorIds) actorIds.add(id);
  for (const id of actorIds) {
    const position = actorPositions.get(id);
    if (validPoint(position)) points.push(position);
  }

  const unique = [...new Map(points.map((value) => [value.join("\u0000"), value])).values()];
  if (!unique.length) return { kind: "none" };
  if (windows.length === 1) {
    const camera = cameras.find(({ event_id: id, center, zoom }) =>
      id === windows[0].id && validPoint(center) && Number.isFinite(zoom));
    if (camera) return { kind: "view", center: camera.center, zoom: camera.zoom };
  }
  if (unique.length === 1) return { kind: "view", center: unique[0], zoom: 8 };
  return { kind: "bounds", points: unique, maxZoom: 10 };
}

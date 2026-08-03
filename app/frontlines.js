const LAND_KINDS = new Set(["army", "corps", "division", "brigade", "regiment"]);
const PRECISION_RANK = new Map([
  ["exact", 0],
  ["approximate", 1],
  ["inferred", 2],
  ["disputed", 3],
  ["unknown", 4],
]);

const isPoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]);

function unwrap(points) {
  if (!Array.isArray(points) || !points.every(isPoint)) return null;
  const result = points.map(([longitude, latitude]) => [longitude, latitude]);
  for (let index = 1; index < result.length; index += 1) {
    while (result[index][0] - result[index - 1][0] > 180) result[index][0] -= 360;
    while (result[index][0] - result[index - 1][0] < -180) result[index][0] += 360;
  }
  return result;
}

function wrapLongitude(longitude) {
  if (longitude >= -180 && longitude <= 180) return longitude;
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
}

function samplePath(points, count, closed) {
  const unwrapped = unwrap(points);
  if (!unwrapped || !Number.isInteger(count) || count < (closed ? 3 : 2)) return [];

  const path = closed && unwrapped.length > 1
    ? unwrapped.slice(0, -1)
    : unwrapped;
  if (path.length < (closed ? 3 : 2)) return [];
  if (closed) {
    const closing = [...path[0]];
    while (closing[0] - path.at(-1)[0] > 180) closing[0] -= 360;
    while (closing[0] - path.at(-1)[0] < -180) closing[0] += 360;
    path.push(closing);
  }

  const cumulative = [0];
  for (let index = 1; index < path.length; index += 1) {
    cumulative.push(cumulative.at(-1) + Math.hypot(
      path[index][0] - path[index - 1][0],
      path[index][1] - path[index - 1][1],
    ));
  }
  const total = cumulative.at(-1);
  if (!(total > 0)) return [];

  const sampleCount = closed ? count : count - 1;
  const result = [];
  let segment = 1;
  for (let index = 0; index <= sampleCount; index += 1) {
    if (closed && index === count) break;
    const distance = total * index / sampleCount;
    while (segment < cumulative.length - 1 && cumulative[segment] < distance) segment += 1;
    const startDistance = cumulative[segment - 1];
    const span = cumulative[segment] - startDistance;
    const progress = span ? (distance - startDistance) / span : 0;
    result.push([
      wrapLongitude(path[segment - 1][0] + (path[segment][0] - path[segment - 1][0]) * progress),
      path[segment - 1][1] + (path[segment][1] - path[segment - 1][1]) * progress,
    ]);
  }
  if (closed) result.push([...result[0]]);
  return result;
}

export function resampleLine(points, count = 48) {
  return samplePath(points, count, false);
}

export function resampleRing(points, count = 64) {
  return samplePath(points, count, true);
}

function lessCertain(left, right) {
  return (PRECISION_RANK.get(left) ?? -1) >= (PRECISION_RANK.get(right) ?? -1) ? left : right;
}

function interpolatePoint(left, right, progress) {
  let rightLongitude = right[0];
  while (rightLongitude - left[0] > 180) rightLongitude -= 360;
  while (rightLongitude - left[0] < -180) rightLongitude += 360;
  return [
    wrapLongitude(left[0] + (rightLongitude - left[0]) * progress),
    left[1] + (right[1] - left[1]) * progress,
  ];
}

const correspondenceCost = (left, right) => left.reduce(
  (total, point, index) =>
    total + deltaLongitude(point[0], right[index][0]) ** 2 + (point[1] - right[index][1]) ** 2,
  0,
);

function alignLine(from, to) {
  const reversed = [...to].reverse();
  return correspondenceCost(from, reversed) < correspondenceCost(from, to) ? reversed : to;
}

function alignRing(from, to) {
  const unique = to.slice(0, -1);
  let best = unique;
  let bestCost = Infinity;
  for (const direction of [unique, [...unique].reverse()]) {
    for (let offset = 0; offset < direction.length; offset += 1) {
      const candidate = direction.slice(offset).concat(direction.slice(0, offset));
      const cost = correspondenceCost(from.slice(0, -1), candidate);
      if (cost < bestCost) {
        best = candidate;
        bestCost = cost;
      }
    }
  }
  return best.concat([[...best[0]]]);
}

const metadata = (fromSnapshot, toSnapshot, fromItem, toItem) => ({
  precision: lessCertain(
    fromItem.precision ?? fromSnapshot.precision,
    toItem.precision ?? toSnapshot.precision,
  ),
  confidence: Math.min(
    fromItem.confidence ?? fromSnapshot.confidence,
    toItem.confidence ?? toSnapshot.confidence,
  ),
});

function interpolateLines(fromSnapshot, toSnapshot, progress, output) {
  const from = fromSnapshot.front_lines ?? [];
  const to = toSnapshot.front_lines ?? [];
  const toById = new Map(to.map((item) => [item.id, item]));
  const matched = new Set();
  for (const oldLine of from) {
    const newLine = toById.get(oldLine.id);
    const oldPoints = oldLine.geometry?.type === "LineString"
      ? resampleLine(oldLine.geometry.coordinates)
      : [];
    const newPoints = newLine?.geometry?.type === "LineString"
      ? resampleLine(newLine.geometry.coordinates)
      : [];
    if (!newLine || !oldPoints.length || !newPoints.length) {
      output.exitingLines.push(oldLine);
      continue;
    }
    matched.add(oldLine.id);
    const alignedNewPoints = alignLine(oldPoints, newPoints);
    output.interpolatedLines.push({
      id: oldLine.id,
      geometry: {
        type: "LineString",
        coordinates: oldPoints.map((point, index) => interpolatePoint(point, alignedNewPoints[index], progress)),
      },
      ...metadata(fromSnapshot, toSnapshot, oldLine, newLine),
    });
  }
  for (const newLine of to) {
    if (!matched.has(newLine.id)) output.enteringLines.push(newLine);
  }
}

function interpolateAreas(fromSnapshot, toSnapshot, progress, output) {
  const from = fromSnapshot.control_areas ?? [];
  const to = toSnapshot.control_areas ?? [];
  const toById = new Map(to.map((item) => [item.id, item]));
  const matched = new Set();
  for (const oldArea of from) {
    const newArea = toById.get(oldArea.id);
    const oldRings = oldArea.geometry?.type === "Polygon" ? oldArea.geometry.coordinates : [];
    const newRings = newArea?.geometry?.type === "Polygon" ? newArea.geometry.coordinates : [];
    const oldRing = oldRings.length === 1 ? resampleRing(oldRings[0]) : [];
    const newRing = newRings.length === 1 ? resampleRing(newRings[0]) : [];
    if (!newArea || oldRings.length !== newRings.length || !oldRing.length || !newRing.length) {
      output.exitingAreas.push(oldArea);
      continue;
    }
    matched.add(oldArea.id);
    const alignedNewRing = alignRing(oldRing, newRing);
    output.interpolatedAreas.push({
      id: oldArea.id,
      sideId: oldArea.side_id,
      geometry: {
        type: "Polygon",
        coordinates: [oldRing.map((point, index) => interpolatePoint(point, alignedNewRing[index], progress))],
      },
      ...metadata(fromSnapshot, toSnapshot, oldArea, newArea),
    });
  }
  for (const newArea of to) {
    if (!matched.has(newArea.id)) output.enteringAreas.push(newArea);
  }
}

export function interpolateFrontlineSnapshots(fromSnapshot, toSnapshot, progress) {
  const output = {
    interpolatedLines: [],
    interpolatedAreas: [],
    enteringLines: [],
    exitingLines: [],
    enteringAreas: [],
    exitingAreas: [],
  };
  interpolateLines(fromSnapshot ?? {}, toSnapshot ?? {}, Math.max(0, Math.min(1, progress)), output);
  interpolateAreas(fromSnapshot ?? {}, toSnapshot ?? {}, Math.max(0, Math.min(1, progress)), output);
  return output;
}

function deltaLongitude(left, right) {
  let delta = right - left;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

export function isClosedFrontline(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4 || !coordinates.every(isPoint)) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return Math.abs(deltaLongitude(first[0], last[0])) <= 1e-6 &&
    Math.abs(first[1] - last[1]) <= 1e-6;
}

export function enclosureLineIds(beforeSnapshot, afterSnapshot) {
  const before = Array.isArray(beforeSnapshot?.front_lines) ? beforeSnapshot.front_lines : [];
  const after = Array.isArray(afterSnapshot?.front_lines) ? afterSnapshot.front_lines : [];
  const afterById = new Map(after.map((line) => [line?.id, line]));
  return before.flatMap((line) => {
    const next = afterById.get(line?.id);
    return typeof line?.id === "string" &&
      line.geometry?.type === "LineString" &&
      next?.geometry?.type === "LineString" &&
      Array.isArray(line.geometry.coordinates) &&
      line.geometry.coordinates.length >= 2 &&
      line.geometry.coordinates.every(isPoint) &&
      !isClosedFrontline(line.geometry.coordinates) &&
      isClosedFrontline(next.geometry.coordinates)
      ? [line.id]
      : [];
  });
}

const distance = (left, right) =>
  Math.hypot(deltaLongitude(left[0], right[0]), right[1] - left[1]);

function midpoint(left, right) {
  return [
    wrapLongitude(left[0] + deltaLongitude(left[0], right[0]) / 2),
    (left[1] + right[1]) / 2,
  ];
}

export function deriveFrontlineFallback({ actors = [], positions = new Map(), maxPairDistance = Infinity } = {}) {
  const influences = actors
    .filter(({ kind, id, side_id: sideId }) =>
      LAND_KINDS.has(kind) && typeof sideId === "string" && isPoint(positions.get(id)))
    .map(({ id: actorId, side_id: sideId }) => ({
      actorId,
      sideId,
      position: [...positions.get(actorId)],
    }))
    .sort((left, right) => left.actorId < right.actorId ? -1 : left.actorId > right.actorId ? 1 : 0);

  const nearest = new Map();
  for (const influence of influences) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of influences) {
      if (candidate.sideId === influence.sideId) continue;
      const candidateDistance = distance(influence.position, candidate.position);
      if (candidateDistance < bestDistance ||
          (candidateDistance === bestDistance && candidate.actorId < best?.actorId)) {
        best = candidate;
        bestDistance = candidateDistance;
      }
    }
    if (best) nearest.set(influence.actorId, { influence: best, distance: bestDistance });
  }

  const pairs = [];
  const seen = new Set();
  for (const influence of influences) {
    const match = nearest.get(influence.actorId);
    if (!match || match.distance > maxPairDistance ||
        nearest.get(match.influence.actorId)?.influence.actorId !== influence.actorId) continue;
    const key = [influence.actorId, match.influence.actorId].sort().join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      actorIds: [influence.actorId, match.influence.actorId],
      positions: [influence.position, match.influence.position],
      midpoint: midpoint(influence.position, match.influence.position),
      distance: match.distance,
    });
  }

  let contactLine = null;
  if (pairs.length > 1) {
    const anchor = pairs[0].midpoint[0];
    const midpoints = pairs.map((pair) => {
      const point = [...pair.midpoint];
      while (point[0] - anchor > 180) point[0] -= 360;
      while (point[0] - anchor < -180) point[0] += 360;
      return point;
    });
    const longitudeSpan = Math.max(...midpoints.map(([value]) => value)) - Math.min(...midpoints.map(([value]) => value));
    const latitudeSpan = Math.max(...midpoints.map(([, value]) => value)) - Math.min(...midpoints.map(([, value]) => value));
    const axis = longitudeSpan >= latitudeSpan ? 0 : 1;
    contactLine = midpoints.sort((left, right) => left[axis] - right[axis]).map((point) => [...point]);
  } else if (pairs.length === 1 && pairs[0].distance > 0) {
    const pair = pairs[0];
    const [left, right] = pair.positions;
    const dx = deltaLongitude(left[0], right[0]);
    const dy = right[1] - left[1];
    const halfLength = Math.max(0.1, pair.distance / 4);
    const perpendicular = [-dy / pair.distance * halfLength, dx / pair.distance * halfLength];
    contactLine = [
      [wrapLongitude(pair.midpoint[0] - perpendicular[0]), pair.midpoint[1] - perpendicular[1]],
      [wrapLongitude(pair.midpoint[0] + perpendicular[0]), pair.midpoint[1] + perpendicular[1]],
    ];
  }

  return {
    influences,
    pairs,
    contactLine,
    precision: "inferred",
    confidence: 0.35,
    label: "DERIVED FROM UNIT POSITIONS",
  };
}

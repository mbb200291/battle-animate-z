const LAND_KINDS = new Set(["army", "corps", "division", "brigade", "regiment"]);
const PRECISION_RANK = new Map([
  ["exact", 0],
  ["approximate", 1],
  ["inferred", 2],
  ["disputed", 3],
  ["unknown", 4],
]);

function denseEvery(array, predicate) {
  if (!Array.isArray(array)) return false;
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index) || !predicate(array[index], index)) return false;
  }
  return true;
}

const isPoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  Object.hasOwn(point, 0) &&
  Object.hasOwn(point, 1) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]);

function normalizeLongitudeDelta(delta) {
  if (!Number.isFinite(delta)) return delta;
  const normalized = ((delta + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && delta > 0 ? 180 : normalized;
}

function localLongitude(longitude, reference) {
  const delta = normalizeLongitudeDelta(longitude - reference);
  if (!Number.isFinite(delta)) return null;
  const adjusted = reference + delta;
  return Number.isFinite(adjusted) && Math.abs(adjusted) <= Number.MAX_SAFE_INTEGER ? adjusted : null;
}

function unwrap(points) {
  if (!denseEvery(points, isPoint)) return null;
  if (points.some(([longitude]) => Math.abs(longitude) > Number.MAX_SAFE_INTEGER)) return null;
  const result = points.map(([longitude, latitude]) => [longitude, latitude]);
  for (let index = 1; index < result.length; index += 1) {
    const longitude = localLongitude(result[index][0], result[index - 1][0]);
    if (longitude === null) return null;
    result[index][0] = longitude;
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
    closing[0] = localLongitude(closing[0], path.at(-1)[0]);
    if (closing[0] === null) return [];
    path.push(closing);
  }

  const cumulative = [0];
  for (let index = 1; index < path.length; index += 1) {
    const segmentLength = Math.hypot(
      path[index][0] - path[index - 1][0],
      path[index][1] - path[index - 1][1],
    );
    const length = cumulative.at(-1) + segmentLength;
    if (!Number.isFinite(segmentLength) || !Number.isFinite(length)) return [];
    cumulative.push(length);
  }
  const total = cumulative.at(-1);
  if (!Number.isFinite(total) || !(total > 0)) return [];

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
    const sample = [
      wrapLongitude(path[segment - 1][0] + (path[segment][0] - path[segment - 1][0]) * progress),
      path[segment - 1][1] + (path[segment][1] - path[segment - 1][1]) * progress,
    ];
    if (!sample.every(Number.isFinite)) return [];
    result.push(sample);
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
  return normalizeLongitudeDelta(right - left);
}

export function isClosedFrontline(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4 || !denseEvery(coordinates, isPoint)) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return Math.abs(deltaLongitude(first[0], last[0])) <= 1e-6 &&
    Math.abs(first[1] - last[1]) <= 1e-6;
}

function sampleLineCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !denseEvery(coordinates, isPoint)) return null;
  const closes = Math.abs(deltaLongitude(coordinates[0][0], coordinates.at(-1)[0])) <= 1e-6 &&
    Math.abs(coordinates[0][1] - coordinates.at(-1)[1]) <= 1e-6;
  if (closes && !isClosedFrontline(coordinates)) return null;
  const sampled = closes ? resampleRing(coordinates) : resampleLine(coordinates);
  return sampled.length > 0 && denseEvery(sampled, isPoint) ? { closed: closes, coordinates: sampled } : null;
}

function sampleCentroid(sample) {
  const points = sample.closed ? sample.coordinates.slice(0, -1) : sample.coordinates;
  const local = unwrap(points);
  if (!local?.length) return null;
  return local.reduce(
    ([sumX, sumY], [x, y]) => [sumX + x / local.length, sumY + y / local.length],
    [0, 0],
  );
}

function nonCrossingLineAssignment(derivedSamples, sourceSamples, sourceLines) {
  const assignment = Array(derivedSamples.length);
  const usedSource = new Set();
  for (const closed of [false, true]) {
    const derived = derivedSamples
      .map((sample, index) => ({ centroid: sample && sample.closed === closed ? sampleCentroid(sample) : null, index }))
      .filter(({ centroid }) => centroid);
    const source = sourceSamples
      .map((sample, index) => ({
        centroid: sample && sample.closed === closed ? sampleCentroid(sample) : null,
        id: sourceLines[index]?.id ?? "",
        index,
      }))
      .filter(({ centroid }) => centroid);
    const anchor = derived[0]?.centroid[0] ?? source
      .toSorted((left, right) => left.id.localeCompare(right.id) || left.index - right.index)[0]?.centroid[0];
    for (const entry of [...derived, ...source]) {
      entry.centroid[0] = localLongitude(entry.centroid[0], anchor);
    }
    const centroids = [...derived, ...source].map(({ centroid }) => centroid);
    if (!centroids.length) continue;
    const spanX = Math.max(...centroids.map(([x]) => x)) - Math.min(...centroids.map(([x]) => x));
    const spanY = Math.max(...centroids.map(([, y]) => y)) - Math.min(...centroids.map(([, y]) => y));
    const primary = spanX >= spanY ? 0 : 1;
    const compare = (left, right) =>
      left.centroid[primary] - right.centroid[primary] ||
      left.centroid[1 - primary] - right.centroid[1 - primary] ||
      (left.id ?? "").localeCompare(right.id ?? "") ||
      left.index - right.index;
    derived.sort(compare);
    source.sort(compare);
    for (let index = 0; index < Math.min(derived.length, source.length); index += 1) {
      assignment[derived[index].index] = source[index].index;
      usedSource.add(source[index].index);
    }
  }
  const remainingSources = sourceLines
    .map((sourceLine, sourceIndex) => ({ sourceId: sourceLine?.id ?? "", sourceIndex }))
    .filter(({ sourceIndex }) => !usedSource.has(sourceIndex))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.sourceIndex - right.sourceIndex);
  let remainingIndex = 0;
  for (let derivedIndex = 0; derivedIndex < assignment.length; derivedIndex += 1) {
    if (assignment[derivedIndex] !== undefined) continue;
    assignment[derivedIndex] = remainingSources[remainingIndex].sourceIndex;
    remainingIndex += 1;
  }
  return assignment;
}

const hybridLine = (sourceLine, coordinates) => ({
  id: `hybrid:${sourceLine.id}`,
  geometry: { type: "LineString", coordinates },
  precision: "inferred",
  confidence: 0.35,
});

const copyLine = (coordinates) => Array.isArray(coordinates)
  ? coordinates.map((point) => Array.isArray(point) ? [...point] : point)
  : coordinates;

const globalCrossfade = (derivedLines, sourceLines, sourceWeight) => ({
  derivedLines,
  front_lines: sourceLines,
  lineTransitions: [],
  transition: "crossfade",
  sourceWeight,
});

export function convergeDerivedFrontlines(derivedLines, sourceSnapshot, sourceWeight) {
  const numericWeight = typeof sourceWeight === "number" && !Number.isNaN(sourceWeight) ? sourceWeight : 0;
  const weight = Math.max(0, Math.min(1, numericWeight));
  const sourceLines = Array.isArray(sourceSnapshot?.front_lines) ? sourceSnapshot.front_lines : [];
  const sourceCollectionUsable = sourceLines.length > 0 && denseEvery(sourceLines, () => true);
  const sourceSamples = sourceCollectionUsable ? sourceLines.map((line) =>
    typeof line?.id === "string" && line.geometry?.type === "LineString"
      ? sampleLineCoordinates(line.geometry.coordinates)
      : null) : [];
  const usableSource = sourceCollectionUsable && sourceSamples.every(Boolean);

  if (weight === 1 && usableSource) {
    return { front_lines: sourceLines, transition: "source", sourceWeight: 1 };
  }

  if (!Array.isArray(derivedLines) ||
    derivedLines.length !== sourceLines.length ||
    derivedLines.length === 0 ||
    !denseEvery(derivedLines, () => true) ||
    !sourceCollectionUsable) {
    return globalCrossfade(derivedLines, sourceLines, weight);
  }

  const derivedSamples = derivedLines.map(sampleLineCoordinates);
  const sourceAssignment = nonCrossingLineAssignment(derivedSamples, sourceSamples, sourceLines);
  const lineTransitions = derivedLines.map((coordinates, index) => {
    const sourceIndex = sourceAssignment[index];
    const sourceLine = sourceLines[sourceIndex];
    const from = derivedSamples[index];
    const to = sourceSamples[sourceIndex];
    if (from && to && (weight === 0 || from.closed === to.closed)) {
      let morphed;
      if (weight === 0) {
        morphed = copyLine(coordinates);
      } else {
        const aligned = from.closed
          ? alignRing(from.coordinates, to.coordinates)
          : alignLine(from.coordinates, to.coordinates);
        morphed = from.coordinates.map((point, pointIndex) =>
          interpolatePoint(point, aligned[pointIndex], weight));
        if (from.closed) morphed[morphed.length - 1] = [...morphed[0]];
      }
      if (denseEvery(morphed, isPoint)) {
        return { transition: "hybrid", front_line: hybridLine(sourceLine, morphed) };
      }
    }
    return { transition: "crossfade", derivedLine: copyLine(coordinates), front_line: sourceLine };
  });
  const hybridCount = lineTransitions.filter(({ transition }) => transition === "hybrid").length;
  const transition = hybridCount === lineTransitions.length
    ? (weight === 0 ? "derived" : "hybrid")
    : hybridCount === 0 ? "crossfade" : "mixed";
  const result = {
    front_lines: lineTransitions.map(({ front_line: frontLine }) => frontLine),
    lineTransitions,
    transition,
    sourceWeight: weight,
  };
  if (transition === "crossfade") result.derivedLines = derivedLines;
  return result;
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

function nearestDistance(point, influences) {
  let nearest = Infinity;
  for (const { position } of influences) nearest = Math.min(nearest, distance(point, position));
  return nearest;
}

function unwrapInfluences(influences) {
  const anchor = influences[0]?.position[0] ?? 0;
  return influences.map((influence) => {
    let longitude = influence.position[0];
    while (longitude - anchor > 180) longitude -= 360;
    while (longitude - anchor < -180) longitude += 360;
    return { ...influence, position: [longitude, influence.position[1]] };
  });
}

function canonicalBounds([minX, minY, maxX, maxY]) {
  const shift = Math.floor(((minX + maxX) / 2 + 180) / 360) * 360;
  return [minX - shift, minY, maxX - shift, maxY];
}

function normalizeBounds(bounds, influences) {
  if (Array.isArray(bounds) && bounds.length === 2 && bounds.every(isPoint)) {
    let right = bounds[1][0];
    while (right - bounds[0][0] > 180) right -= 360;
    while (right - bounds[0][0] < -180) right += 360;
    const normalized = [
      Math.min(bounds[0][0], right),
      Math.min(bounds[0][1], bounds[1][1]),
      Math.max(bounds[0][0], right),
      Math.max(bounds[0][1], bounds[1][1]),
    ];
    if (normalized[2] > normalized[0] && normalized[3] > normalized[1]) {
      return canonicalBounds(normalized);
    }
  }

  const longitudes = influences.map(({ position }) => position[0]);
  const latitudes = influences.map(({ position }) => position[1]);
  const minX = Math.min(...longitudes);
  const maxX = Math.max(...longitudes);
  const minY = Math.min(...latitudes);
  const maxY = Math.max(...latitudes);
  const padding = Math.max(maxX - minX, maxY - minY, 1) * 0.2;
  return canonicalBounds([minX - padding, minY - padding, maxX + padding, maxY + padding]);
}

function zeroCrossing(left, right, leftValue, rightValue) {
  const progress = leftValue === rightValue ? 0.5 : leftValue / (leftValue - rightValue);
  return {
    point: [
      left[0] + (right[0] - left[0]) * progress,
      left[1] + (right[1] - left[1]) * progress,
    ],
    progress,
  };
}

const POINT_EPSILON = 1e-9;

const sameCoordinate = (left, right) =>
  Math.abs(deltaLongitude(left[0], right[0])) <= POINT_EPSILON &&
  Math.abs(left[1] - right[1]) <= POINT_EPSILON;

export function ambiguousEdgePairs(values) {
  const determinant = values[0] * values[2] - values[1] * values[3];
  return determinant >= 0 ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
}

function marchingSegments(field, xs, ys, sideA, sideB, maxPairDistance) {
  const segments = [];
  const addSegment = (left, right) => {
    if (sameCoordinate(left.point, right.point)) return;
    if (Number.isFinite(maxPairDistance)) {
      const threshold = maxPairDistance / 2;
      const beyondContact = ({ point }) =>
        nearestDistance(point, sideA) > threshold && nearestDistance(point, sideB) > threshold;
      if (beyondContact(left) && beyondContact(right)) return;
    }
    segments.push({ id: segments.length, left, right });
  };

  for (let y = 0; y < ys.length - 1; y += 1) {
    for (let x = 0; x < xs.length - 1; x += 1) {
      const points = [
        [xs[x], ys[y]], [xs[x + 1], ys[y]],
        [xs[x + 1], ys[y + 1]], [xs[x], ys[y + 1]],
      ];
      const values = [field[y][x], field[y][x + 1], field[y + 1][x + 1], field[y + 1][x]];
      const vertexKeys = [
        `v:${y}:${x}`, `v:${y}:${x + 1}`,
        `v:${y + 1}:${x + 1}`, `v:${y + 1}:${x}`,
      ];
      const edges = [
        { key: `e:h:${y}:${x}`, from: 0, to: 1 },
        { key: `e:v:${y}:${x + 1}`, from: 1, to: 2 },
        { key: `e:h:${y + 1}:${x}`, from: 3, to: 2 },
        { key: `e:v:${y}:${x}`, from: 0, to: 3 },
      ];
      const crossings = edges.flatMap((edge, edgeIndex) => {
        const fromValue = values[edge.from];
        const toValue = values[edge.to];
        if ((fromValue < 0) === (toValue < 0)) return [];
        const crossing = zeroCrossing(points[edge.from], points[edge.to], fromValue, toValue);
        return [{
          edgeIndex,
          key: crossing.progress <= POINT_EPSILON
            ? vertexKeys[edge.from]
            : crossing.progress >= 1 - POINT_EPSILON
              ? vertexKeys[edge.to]
              : edge.key,
          point: crossing.point,
        }];
      });
      if (crossings.length === 2) {
        addSegment(crossings[0], crossings[1]);
      } else if (crossings.length === 4) {
        const byEdge = new Map(crossings.map((crossing) => [crossing.edgeIndex, crossing]));
        for (const [left, right] of ambiguousEdgePairs(values)) {
          addSegment(byEdge.get(left), byEdge.get(right));
        }
      }
    }
  }
  return segments;
}

function stitchSegments(segments) {
  const adjacency = new Map();
  const points = new Map();
  const add = (endpoint, segment) => {
    points.set(endpoint.key, endpoint.point);
    if (!adjacency.has(endpoint.key)) adjacency.set(endpoint.key, []);
    adjacency.get(endpoint.key).push(segment);
  };
  for (const segment of segments) {
    add(segment.left, segment);
    add(segment.right, segment);
  }
  for (const connected of adjacency.values()) {
    connected.sort((left, right) => left.id - right.id);
  }

  const unused = new Set(segments.map(({ id }) => id));
  const lines = [];
  const unusedAt = (key) => (adjacency.get(key) ?? []).filter(({ id }) => unused.has(id));
  while (unused.size) {
    const endpoints = [...adjacency.keys()]
      .filter((key) => unusedAt(key).length === 1)
      .sort();
    const firstUnused = segments.find(({ id }) => unused.has(id));
    const start = endpoints[0] ?? [firstUnused.left.key, firstUnused.right.key].sort()[0];
    const keys = [start];
    let previous = null;
    let current = start;

    while (true) {
      const candidates = unusedAt(current);
      if (!candidates.length) break;
      candidates.sort((left, right) => {
        if (previous === null || candidates.length === 1) return left.id - right.id;
        const other = (segment) => segment.left.key === current ? segment.right.key : segment.left.key;
        const incoming = [
          points.get(current)[0] - points.get(previous)[0],
          points.get(current)[1] - points.get(previous)[1],
        ];
        const turn = (segment) => {
          const target = points.get(other(segment));
          const outgoing = [target[0] - points.get(current)[0], target[1] - points.get(current)[1]];
          return Math.abs(Math.atan2(
            incoming[0] * outgoing[1] - incoming[1] * outgoing[0],
            incoming[0] * outgoing[0] + incoming[1] * outgoing[1],
          ));
        };
        return turn(left) - turn(right) || other(left).localeCompare(other(right));
      });
      const segment = candidates[0];
      unused.delete(segment.id);
      const next = segment.left.key === current ? segment.right.key : segment.left.key;
      keys.push(next);
      previous = current;
      current = next;
      if (current === start) break;
    }
    if (keys.length >= 2) lines.push(keys.map((key) => [...points.get(key)]));
  }
  return lines;
}

function smoothLine(line) {
  if (line.length < 4) return line.map(([x, y]) => [wrapLongitude(x), y]);
  const closed = line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];
  const source = closed ? line.slice(0, -1) : line;
  const smoothed = closed ? [] : [[...source[0]]];
  const limit = closed ? source.length : source.length - 1;
  for (let index = 0; index < limit; index += 1) {
    const left = source[index];
    const right = source[(index + 1) % source.length];
    smoothed.push(
      [left[0] * 0.75 + right[0] * 0.25, left[1] * 0.75 + right[1] * 0.25],
      [left[0] * 0.25 + right[0] * 0.75, left[1] * 0.25 + right[1] * 0.75],
    );
  }
  if (!closed) smoothed.push([...source.at(-1)]);
  const wrapped = smoothed.map(([x, y]) => [wrapLongitude(x), y]);
  if (closed) wrapped.push([...wrapped[0]]);
  return wrapped;
}

function cleanLine(line) {
  const closed = line.length > 2 && sameCoordinate(line[0], line.at(-1));
  const source = closed ? line.slice(0, -1) : line;
  const coordinates = [];
  for (const point of source) {
    if (!coordinates.length || !sameCoordinate(point, coordinates.at(-1))) coordinates.push([...point]);
  }
  if (closed && coordinates.length > 1 && sameCoordinate(coordinates[0], coordinates.at(-1))) {
    coordinates.pop();
  }
  const distinct = coordinates.filter((point, index) =>
    coordinates.findIndex((candidate) => sameCoordinate(point, candidate)) === index);
  if (distinct.length < (closed ? 3 : 2)) return null;
  if (closed) coordinates.push([...coordinates[0]]);
  return coordinates;
}

function comparePoints(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return 0;
}

function compareLines(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = comparePoints(left[index], right[index]);
    if (comparison) return comparison;
  }
  return left.length - right.length;
}

function canonicalizeLine(line) {
  const closed = line.length > 2 && sameCoordinate(line[0], line.at(-1));
  if (!closed) {
    const coordinates = line.map((point) => [...point]);
    return comparePoints(coordinates[0], coordinates.at(-1)) <= 0 ? coordinates : coordinates.reverse();
  }

  const unique = line.slice(0, -1);
  const minimum = unique.reduce((best, point) => comparePoints(point, best) < 0 ? point : best);
  const candidates = [];
  for (let start = 0; start < unique.length; start += 1) {
    if (comparePoints(unique[start], minimum)) continue;
    for (const direction of [1, -1]) {
      candidates.push(Array.from(
        { length: unique.length },
        (_, offset) => [...unique[(start + direction * offset + unique.length) % unique.length]],
      ));
    }
  }
  candidates.sort(compareLines);
  const canonical = candidates[0];
  canonical.push([...canonical[0]]);
  return canonical;
}

export function canonicalizeContactLines(lines) {
  return lines.map(canonicalizeLine).sort(compareLines);
}

function deriveContactLines(influences, bounds, gridSize, maxPairDistance) {
  const unwrapped = unwrapInfluences(influences);
  const sideIds = [...new Set(unwrapped.map(({ sideId }) => sideId))].sort();
  const sideA = unwrapped.filter(({ sideId }) => sideId === sideIds[0]);
  const sideB = unwrapped.filter(({ sideId }) => sideId === sideIds[1]);
  const [minX, minY, maxX, maxY] = normalizeBounds(bounds, unwrapped);
  const size = Number.isInteger(gridSize) && gridSize >= 2 ? Math.min(gridSize, 256) : 32;
  const xs = Array.from({ length: size }, (_, index) => minX + (maxX - minX) * index / (size - 1));
  const ys = Array.from({ length: size }, (_, index) => minY + (maxY - minY) * index / (size - 1));
  const field = ys.map((y) => xs.map((x) =>
    nearestDistance([x, y], sideA) - nearestDistance([x, y], sideB)));
  const lines = stitchSegments(marchingSegments(field, xs, ys, sideA, sideB, maxPairDistance))
    .map(smoothLine)
    .map(cleanLine)
    .filter(Boolean);
  return canonicalizeContactLines(lines);
}

export function selectFrontlineInfluences(actors = [], positions = new Map()) {
  const eligible = actors.filter(({ kind, id, side_id: sideId }) =>
    typeof id === "string" &&
    LAND_KINDS.has(kind) &&
    typeof sideId === "string" &&
    isPoint(positions.get(id)));
  const positionedParents = new Set(
    eligible.map(({ parent_id: parentId }) => parentId).filter((parentId) => typeof parentId === "string"),
  );
  return eligible
    .filter(({ id }) => !positionedParents.has(id))
    .map(({ id: actorId, side_id: sideId }) => ({
      actorId,
      sideId,
      position: [...positions.get(actorId)],
    }))
    .sort((left, right) => left.actorId < right.actorId ? -1 : left.actorId > right.actorId ? 1 : 0);
}

export function deriveFrontlineFallback({
  actors = [],
  positions = new Map(),
  bounds,
  gridSize = 32,
  maxPairDistance = Infinity,
} = {}) {
  const influences = selectFrontlineInfluences(actors, positions);
  const sideCount = new Set(influences.map(({ sideId }) => sideId)).size;
  if (sideCount !== 2) {
    return {
      available: false,
      reason: "requires-two-sides",
      influences,
      pairs: [],
      contactLine: null,
      contactLines: [],
      precision: "inferred",
      confidence: 0.35,
      label: "DERIVED FROM UNIT POSITIONS",
    };
  }

  const contactLines = deriveContactLines(influences, bounds, gridSize, maxPairDistance);
  const contactLine = contactLines[0] ?? null;

  return {
    available: contactLines.length > 0,
    reason: contactLine ? null : "no-contact-line",
    influences,
    pairs: [],
    contactLine,
    contactLines,
    precision: "inferred",
    confidence: 0.35,
    label: "DERIVED FROM UNIT POSITIONS",
  };
}

const BATTLE_TIME_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))?)?)?)?$/;

const DEFAULT_EVENT_DURATION_MS = 1800;
const DEFAULT_SCALE = 60;
const DEFAULT_IDLE_THRESHOLD_SECONDS = 900;
const DEFAULT_COMPRESSED_DURATION_MS = 1200;
const DESTRUCTIVE_RESULTS = Object.freeze(["sunk", "disabled", "captured"]);
const COARSE_DATE_PRECISIONS = Object.freeze(["year", "month", "day"]);

function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseBattleTime(value) {
  if (typeof value !== "string") return null;
  const match = BATTLE_TIME_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const microseconds = match[7] ? Number(match[7].slice(0, 6).padEnd(6, "0")) : 0;
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    return null;
  }

  // setUTCFullYear avoids Date.UTC's special handling of years 00 through 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  let epochSeconds = date.getTime() / 1000;
  if (match[9]) {
    const offsetSeconds = (offsetHour * 60 + offsetMinute) * 60;
    epochSeconds += match[9] === "+" ? -offsetSeconds : offsetSeconds;
  }
  epochSeconds += microseconds / 1_000_000;
  const milliseconds = epochSeconds * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function positive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegative(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parsedRange(value) {
  if (!value || typeof value !== "object") return { startMs: null, endMs: null };
  return {
    startMs: parseBattleTime(value.start),
    endMs: parseBattleTime(value.end),
  };
}

function classifiedRange(value) {
  const range = parsedRange(value);
  const coarse = Boolean(
    value
      && typeof value === "object"
      && COARSE_DATE_PRECISIONS.includes(value.precision)
      && typeof value.start === "string"
      && !value.start.includes("T")
      && (value.end === undefined || (typeof value.end === "string" && !value.end.includes("T")))
      && range.startMs !== null,
  );
  return {
    ...range,
    coarse,
    bounded: range.startMs !== null && range.endMs !== null && range.endMs >= range.startMs,
  };
}

function orderedEvents(battle) {
  const events = array(battle?.historical_events);
  const byId = new Map(events.map((item) => [item?.id, item]));
  const result = [];
  const seen = new Set();
  for (const id of array(battle?.animation_hints?.timeline?.ordered_event_ids)) {
    if (byId.has(id) && !seen.has(id)) {
      result.push(byId.get(id));
      seen.add(id);
    }
  }
  for (const item of events) {
    if (!seen.has(item?.id)) {
      result.push(item);
      seen.add(item?.id);
    }
  }
  return result;
}

function completeRange(range, fallbackDurationMs) {
  let { startMs, endMs } = range;
  if (startMs !== null && endMs !== null && endMs < startMs) endMs = null;
  if (startMs !== null && endMs === null) endMs = startMs + fallbackDurationMs;
  if (startMs === null && endMs !== null) startMs = endMs - fallbackDurationMs;
  return { startMs, endMs };
}

function compileEventWindows(battle, fallbackDurationMs) {
  const events = orderedEvents(battle);
  const partial = events.map((item, sourceIndex) => {
    const classified = classifiedRange(item?.time);
    const range = classified.coarse
      ? { startMs: classified.startMs, endMs: classified.bounded ? classified.endMs : null }
      : completeRange(classified, fallbackDurationMs);
    return {
      id: item?.id,
      event: item,
      sourceIndex,
      ...range,
      synthetic: classified.coarse,
      needsFallback: classified.coarse && !classified.bounded,
    };
  });
  let cursor = null;
  for (let index = 0; index < partial.length;) {
    const current = partial[index];
    if (current.needsFallback) {
      current.startMs = Math.max(current.startMs, cursor ?? current.startMs);
      current.endMs = current.startMs + fallbackDurationMs;
      cursor = current.endMs;
      index += 1;
      continue;
    }
    if (current.startMs !== null) {
      cursor = cursor === null ? current.endMs : Math.max(cursor, current.endMs);
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < partial.length && partial[index].startMs === null) index += 1;
    const runLength = index - runStart;
    const next = index < partial.length ? partial[index] : null;
    let durationMs = fallbackDurationMs;
    if (cursor !== null) {
      if (next && next.startMs > cursor) {
        durationMs = Math.min(durationMs, (next.startMs - cursor) / runLength);
      }
    } else {
      cursor = next ? next.startMs - durationMs * runLength : 0;
    }
    for (let offset = 0; offset < runLength; offset += 1) {
      const window = partial[runStart + offset];
      window.startMs = cursor;
      window.endMs = cursor + durationMs;
      window.synthetic = true;
      cursor = window.endMs;
    }
  }
  return partial.map(({ needsFallback: _needsFallback, ...window }) => window);
}

function movementRange(movement, eventWindow, fallbackDurationMs) {
  const own = classifiedRange(movement?.time);
  if (own.coarse) {
    return {
      startMs: own.startMs,
      endMs: own.bounded ? own.endMs : own.startMs + fallbackDurationMs,
      synthetic: true,
    };
  }
  let startMs = own.startMs ?? eventWindow?.startMs ?? null;
  let endMs = own.endMs ?? eventWindow?.endMs ?? null;
  if (startMs !== null && endMs !== null && endMs < startMs) {
    if (own.startMs !== null && own.endMs === null) endMs = startMs + fallbackDurationMs;
    else if (own.endMs !== null && own.startMs === null) startMs = endMs - fallbackDurationMs;
    else endMs = startMs + fallbackDurationMs;
  }
  if (startMs !== null && endMs === null) endMs = startMs + fallbackDurationMs;
  if (startMs === null && endMs !== null) startMs = endMs - fallbackDurationMs;
  return {
    startMs,
    endMs,
    synthetic: own.startMs === null && own.endMs === null && Boolean(eventWindow?.synthetic),
  };
}

function validCoordinates(movement) {
  const coordinates = movement?.path?.type === "LineString" ? movement.path.coordinates : null;
  return array(coordinates)
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]]);
}

function cumulativeLengths(coordinates) {
  const lengths = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const meanLatitude = (previous[1] + current[1]) * Math.PI / 360;
    const deltaLongitude = (current[0] - previous[0]) * Math.cos(meanLatitude);
    const deltaLatitude = current[1] - previous[1];
    lengths.push(lengths[index - 1] + Math.hypot(deltaLongitude, deltaLatitude));
  }
  return lengths;
}

function waypointMilliseconds(movement, coordinateCount) {
  const values = array(movement?.waypoint_times);
  if (values.length !== coordinateCount) return null;
  const parsed = values.map(parseBattleTime);
  if (parsed.some((value) => value === null)) return null;
  if (parsed.some((value, index) => index > 0 && value <= parsed[index - 1])) return null;
  return parsed;
}

function compileTracks(battle, eventById, fallbackDurationMs) {
  const pending = [];
  for (const [sourceIndex, movement] of array(battle?.movements).entries()) {
    const coordinates = validCoordinates(movement);
    if (!coordinates.length) continue;
    const eventWindow = eventById.get(movement?.event_id);
    const range = movementRange(movement, eventWindow, fallbackDurationMs);
    pending.push({
      id: movement?.id,
      actorId: movement?.actor_id,
      eventId: movement?.event_id,
      coordinates,
      cumulativeLengths: cumulativeLengths(coordinates),
      waypointTimes: waypointMilliseconds(movement, coordinates.length),
      sourceIndex,
      ...range,
    });
  }

  const knownEnds = pending.filter(({ endMs }) => endMs !== null).map(({ endMs }) => endMs);
  let cursor = knownEnds.length ? Math.max(...knownEnds) : 0;
  for (const track of pending) {
    if (track.startMs !== null) continue;
    track.startMs = cursor;
    track.endMs = cursor + fallbackDurationMs;
    track.synthetic = true;
    cursor = track.endMs;
  }
  return pending;
}

function compileEngagementWindows(battle, eventById, fallbackDurationMs) {
  const windows = [];
  let cursor = Math.max(0, ...[...eventById.values()].map(({ endMs }) => endMs));
  for (const [sourceIndex, engagement] of array(battle?.engagements).entries()) {
    const classified = classifiedRange(engagement?.time);
    const own = classified.coarse
      ? {
        startMs: classified.startMs,
        endMs: classified.bounded ? classified.endMs : classified.startMs + fallbackDurationMs,
      }
      : completeRange(classified, fallbackDurationMs);
    const linked = eventById.get(engagement?.event_id);
    let startMs = own.startMs ?? linked?.startMs ?? null;
    let endMs = own.endMs ?? linked?.endMs ?? null;
    let synthetic = classified.coarse;
    if (startMs !== null && endMs !== null && endMs < startMs) endMs = startMs + fallbackDurationMs;
    if (startMs !== null && endMs === null) endMs = startMs + fallbackDurationMs;
    if (startMs === null && endMs !== null) startMs = endMs - fallbackDurationMs;
    if (startMs === null) {
      startMs = cursor;
      endMs = cursor + fallbackDurationMs;
      synthetic = true;
      cursor = endMs;
    } else if (!classified.coarse) {
      synthetic = Boolean(linked?.synthetic) && own.startMs === null && own.endMs === null;
    }
    windows.push({
      id: engagement?.id,
      engagement,
      eventId: engagement?.event_id,
      startMs,
      endMs,
      synthetic,
      sourceIndex,
    });
  }
  return windows;
}

function geometryPoint(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  let coordinates = geometry.coordinates;
  while (Array.isArray(coordinates) && Array.isArray(coordinates[0])) coordinates = coordinates[0];
  return Array.isArray(coordinates) && coordinates.length >= 2
    && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])
    ? [coordinates[0], coordinates[1]]
    : null;
}

function startingPositions(battle, tracks) {
  const places = array(battle?.places);
  const placesById = new Map(places.map((place) => [place?.id, place]));
  const firstPlace = places.map((place) => geometryPoint(place?.geometry)).find(Boolean) ?? null;
  const positions = new Map();
  for (const actor of array(battle?.actors)) {
    const actorId = actor?.id;
    const track = tracks
      .filter((candidate) => candidate.actorId === actorId)
      .reduce((earliest, candidate) => {
        if (!earliest || candidate.startMs < earliest.startMs) return candidate;
        if (candidate.startMs === earliest.startMs && candidate.sourceIndex < earliest.sourceIndex) return candidate;
        return earliest;
      }, null);
    let point = track?.coordinates[0] ?? null;
    if (!point) {
      const actorEvent = array(battle?.historical_events).find((item) =>
        array(item?.actor_ids).includes(actorId) || array(item?.target_actor_ids).includes(actorId));
      point = array(actorEvent?.place_ids)
        .map((id) => geometryPoint(placesById.get(id)?.geometry))
        .find(Boolean) ?? firstPlace;
    }
    if (point) positions.set(actorId, [...point]);
  }
  return positions;
}

function mergeActiveIntervals(windows) {
  const sorted = windows
    .filter(({ startMs, endMs }) => Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs)
    .map(({ startMs, endMs }) => ({ startMs, endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startMs > previous.endMs) merged.push({ ...interval });
    else previous.endMs = Math.max(previous.endMs, interval.endMs);
  }
  return merged;
}

function buildTimeWarp(historicalStartMs, historicalEndMs, activeIntervals, scale, thresholdMs, compressedDurationMs) {
  const segments = [];
  const compressedGaps = [];
  let historicalCursor = historicalStartMs;
  let presentationCursor = 0;

  const append = (historicalSegmentEnd, active) => {
    if (historicalSegmentEnd <= historicalCursor) return;
    const historicalDurationMs = historicalSegmentEnd - historicalCursor;
    const compressed = !active && historicalDurationMs > thresholdMs;
    const presentationDurationMs = compressed ? compressedDurationMs : historicalDurationMs / scale;
    const segment = {
      historicalStartMs: historicalCursor,
      historicalEndMs: historicalSegmentEnd,
      presentationStartMs: presentationCursor,
      presentationEndMs: presentationCursor + presentationDurationMs,
      historicalDurationMs,
      presentationDurationMs,
      compressed,
    };
    segments.push(segment);
    if (compressed) compressedGaps.push(segment);
    historicalCursor = historicalSegmentEnd;
    presentationCursor = segment.presentationEndMs;
  };

  for (const interval of activeIntervals) {
    append(Math.max(historicalCursor, interval.startMs), false);
    append(Math.min(historicalEndMs, interval.endMs), true);
  }
  append(historicalEndMs, false);
  return { segments, compressedGaps, presentationDurationMs: presentationCursor };
}

export function compileTimeline(battle = {}) {
  const hints = battle?.animation_hints?.timeline ?? {};
  const scale = positive(hints.historical_seconds_per_playback_second, DEFAULT_SCALE);
  const fallbackPresentationDurationMs = positive(hints.default_event_duration_ms, DEFAULT_EVENT_DURATION_MS);
  const fallbackDurationMs = fallbackPresentationDurationMs * scale;
  const thresholdMs = nonnegative(hints.idle_compression_threshold_seconds, DEFAULT_IDLE_THRESHOLD_SECONDS) * 1000;
  const compressedDurationMs = positive(hints.idle_compressed_duration_ms, DEFAULT_COMPRESSED_DURATION_MS);
  const eventWindows = compileEventWindows(battle, fallbackDurationMs);
  const eventById = new Map(eventWindows.map((window) => [window.id, window]));
  const tracks = compileTracks(battle, eventById, fallbackDurationMs);
  const engagementWindows = compileEngagementWindows(battle, eventById, fallbackDurationMs);
  const allWindows = [...eventWindows, ...tracks, ...engagementWindows];
  const starts = allWindows.map(({ startMs }) => startMs).filter(Number.isFinite);
  const ends = allWindows.map(({ endMs }) => endMs).filter(Number.isFinite);
  const historicalStartMs = starts.length ? Math.min(...starts) : 0;
  const historicalEndMs = ends.length ? Math.max(...ends) : fallbackDurationMs;
  const activeIntervals = mergeActiveIntervals(allWindows);
  const timeWarp = buildTimeWarp(
    historicalStartMs,
    historicalEndMs,
    activeIntervals,
    scale,
    thresholdMs,
    compressedDurationMs,
  );
  const compiled = {
    tracks,
    eventWindows,
    engagementWindows,
    historicalStartMs,
    historicalEndMs,
    presentationDurationMs: timeWarp.presentationDurationMs || fallbackPresentationDurationMs,
    timeWarp: timeWarp.segments,
    compressedGaps: timeWarp.compressedGaps,
    scale,
    startingPositions: startingPositions(battle, tracks),
    actorIds: array(battle?.actors).map((actor) => actor?.id),
    synthetic: allWindows.length === 0 || allWindows.every(({ synthetic }) => synthetic),
  };
  compiled.toPresentationTime = (historicalMs) => toPresentationTime(compiled, historicalMs);
  return compiled;
}

function segmentForHistorical(timeline, historicalMs) {
  const segments = array(timeline?.timeWarp);
  return segments.find((segment) => historicalMs <= segment.historicalEndMs) ?? segments.at(-1);
}

function segmentForPresentation(timeline, presentationMs) {
  const segments = array(timeline?.timeWarp);
  return segments.find((segment) => presentationMs <= segment.presentationEndMs) ?? segments.at(-1);
}

export function toPresentationTime(timeline, historicalMs) {
  const start = Number.isFinite(timeline?.historicalStartMs) ? timeline.historicalStartMs : 0;
  const end = Number.isFinite(timeline?.historicalEndMs) ? timeline.historicalEndMs : start;
  const value = Math.min(end, Math.max(start, Number.isFinite(historicalMs) ? historicalMs : start));
  const segment = segmentForHistorical(timeline, value);
  if (!segment) return 0;
  if (segment.historicalDurationMs === 0) return segment.presentationStartMs;
  const ratio = (value - segment.historicalStartMs) / segment.historicalDurationMs;
  return segment.presentationStartMs + ratio * segment.presentationDurationMs;
}

export function toHistoricalTime(timeline, presentationMs) {
  const duration = Number.isFinite(timeline?.presentationDurationMs) ? timeline.presentationDurationMs : 0;
  const value = Math.min(duration, Math.max(0, Number.isFinite(presentationMs) ? presentationMs : 0));
  const segment = segmentForPresentation(timeline, value);
  if (!segment) return Number.isFinite(timeline?.historicalStartMs) ? timeline.historicalStartMs : 0;
  if (segment.presentationDurationMs === 0) return segment.historicalEndMs;
  const ratio = (value - segment.presentationStartMs) / segment.presentationDurationMs;
  return segment.historicalStartMs + ratio * segment.historicalDurationMs;
}

function segmentHeading(from, to) {
  return Math.atan2(-(to[1] - from[1]), to[0] - from[0]);
}

function latestHeading(coordinates, segmentIndex) {
  for (let index = segmentIndex; index >= 0; index -= 1) {
    const from = coordinates[index];
    const to = coordinates[index + 1];
    if (from[0] !== to[0] || from[1] !== to[1]) return segmentHeading(from, to);
  }
  return 0;
}

function interpolateSegment(coordinates, index, ratio) {
  const from = coordinates[index];
  const to = coordinates[index + 1];
  return {
    position: [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio],
    heading: latestHeading(coordinates, index),
  };
}

function sampleTrack(track, historicalMs) {
  const coordinates = track.coordinates;
  if (coordinates.length === 1) return { position: [...coordinates[0]], heading: 0 };
  if (historicalMs <= track.startMs) return { position: [...coordinates[0]], heading: latestHeading(coordinates, 0) };
  if (historicalMs >= track.endMs) {
    return { position: [...coordinates.at(-1)], heading: latestHeading(coordinates, coordinates.length - 2) };
  }

  if (track.waypointTimes) {
    let index = 0;
    while (index < track.waypointTimes.length - 2 && historicalMs >= track.waypointTimes[index + 1]) index += 1;
    const start = track.waypointTimes[index];
    const end = track.waypointTimes[index + 1];
    const ratio = Math.min(1, Math.max(0, (historicalMs - start) / (end - start)));
    return interpolateSegment(coordinates, index, ratio);
  }

  const duration = track.endMs - track.startMs;
  const totalLength = track.cumulativeLengths.at(-1);
  if (duration <= 0 || totalLength <= 0) return { position: [...coordinates[0]], heading: 0 };
  const targetLength = ((historicalMs - track.startMs) / duration) * totalLength;
  let index = 0;
  while (index < track.cumulativeLengths.length - 2 && targetLength >= track.cumulativeLengths[index + 1]) index += 1;
  const segmentLength = track.cumulativeLengths[index + 1] - track.cumulativeLengths[index];
  const ratio = segmentLength > 0 ? (targetLength - track.cumulativeLengths[index]) / segmentLength : 0;
  return interpolateSegment(coordinates, index, ratio);
}

function latestTrackAt(tracks, historicalMs) {
  let selected = null;
  for (const track of tracks) {
    if (track.startMs > historicalMs) continue;
    if (!selected || track.startMs > selected.startMs || (track.startMs === selected.startMs && track.sourceIndex > selected.sourceIndex)) {
      selected = track;
    }
  }
  return selected;
}

export function sampleTimeline(timeline, presentationMs) {
  const historicalMs = toHistoricalTime(timeline, presentationMs);
  const actorPositions = new Map();
  const headings = new Map();
  const tracksByActor = new Map();
  for (const track of array(timeline?.tracks)) {
    if (!tracksByActor.has(track.actorId)) tracksByActor.set(track.actorId, []);
    tracksByActor.get(track.actorId).push(track);
  }

  for (const actorId of array(timeline?.actorIds)) {
    const track = latestTrackAt(tracksByActor.get(actorId) ?? [], historicalMs);
    if (track) {
      const sampled = sampleTrack(track, historicalMs);
      actorPositions.set(actorId, sampled.position);
      headings.set(actorId, sampled.heading);
    } else {
      const initial = timeline?.startingPositions?.get(actorId);
      if (initial) actorPositions.set(actorId, [...initial]);
      headings.set(actorId, 0);
    }
  }

  const activeEventIds = new Set(array(timeline?.eventWindows)
    .filter(({ startMs, endMs }) => historicalMs >= startMs && historicalMs <= endMs)
    .map(({ id }) => id));
  const activeEngagementIds = new Set(array(timeline?.engagementWindows)
    .filter(({ startMs, endMs }) => historicalMs >= startMs && historicalMs <= endMs)
    .map(({ id }) => id));
  const persistentOutcomeActorIds = new Set();
  for (const window of array(timeline?.engagementWindows)) {
    const engagement = window.engagement;
    if (historicalMs >= window.endMs && DESTRUCTIVE_RESULTS.includes(engagement?.result)) {
      persistentOutcomeActorIds.add(engagement?.result_actor_id ?? engagement?.target_actor_id);
    }
  }
  const compressedGap = array(timeline?.compressedGaps).find((gap) =>
    presentationMs >= gap.presentationStartMs && presentationMs < gap.presentationEndMs) ?? null;
  const synthetic = Boolean(timeline?.synthetic)
    || array(timeline?.eventWindows).some((window) => window.synthetic && historicalMs >= window.startMs && historicalMs <= window.endMs)
    || array(timeline?.engagementWindows).some((window) => window.synthetic && historicalMs >= window.startMs && historicalMs <= window.endMs)
    || [...tracksByActor.values()].flat().some((track) => track.synthetic && historicalMs >= track.startMs && historicalMs <= track.endMs);

  return {
    historicalMs,
    actorPositions,
    headings,
    activeEventIds,
    activeEngagementIds,
    persistentOutcomeActorIds,
    compressedGap,
    synthetic,
  };
}

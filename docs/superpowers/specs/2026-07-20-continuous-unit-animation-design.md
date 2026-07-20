# Continuous Unit-Level Battle Animation Design

**Date:** 2026-07-20
**Status:** Approved design
**Target schema version:** `0.3.0`

## Goal

Replace event-to-event jumps with a continuous, historically scaled animation that readers can follow. The same trajectory engine must support naval, land, air, amphibious, and static defensive operations. The first complete demonstration is the Battle of the Yalu River at individual-ship granularity; land battles target division or brigade granularity. Existing `0.1.0` and `0.2.0` documents remain loadable.

The project remains a historical visualization format, not a combat simulation. It records sourced or explicitly inferred positions and times without inventing firepower, morale, supply, or tactical outcomes.

## Confirmed Product Decisions

- Naval actors may be individual ships. Land actors target divisions or brigades.
- Playback preserves relative historical time while compressing inactive gaps.
- The user can change playback speed.
- Missing exact times may be inferred by an LLM only when marked `precision: "inferred"` with low confidence.
- The camera follows the active area smoothly and moves only when active units approach the viewport safe boundary.
- Unit graphics use built-in SVG symbols selected by controlled semantic tokens. Generated `0.3.0` data does not use emoji or embed SVG.
- Unknown icon tokens fall back to a generic built-in SVG for the actor kind and produce a warning.
- The first release upgrades the app, schema, validator, prompt, and the Yalu example. Other examples remain backward compatible rather than being rewritten.

## Architecture

The implementation has three bounded layers.

### Historical JSON

The LLM or author provides historical events, actors, movement paths, movement times, confidence metadata, engagements, and semantic icon tokens. Factual or inferred timing belongs in historical records. Playback configuration remains in `animation_hints`.

### Timeline Compiler

A pure timeline compiler parses historical times and produces a normalized presentation timeline. It:

- resolves each movement's effective time range;
- validates and normalizes waypoint timing;
- creates fallback time ranges for older documents;
- identifies intervals in which no actor moves and no engagement or event begins;
- maps historical time to presentation time with inactive-gap compression;
- builds deterministic actor state queries for arbitrary scrubber positions.

The compiler must not infer historical facts that are absent from the document. Its synthetic ranges are presentation fallbacks and must be labeled as such in the UI.

### Animation Engine

The renderer consumes the normalized timeline. It performs path interpolation, SVG heading rotation, engagement effects, state changes, labels, and camera movement. It never interprets raw historical dates or invents missing positions.

This separation makes the core trajectory engine domain-neutral. Naval, land, and air units share the same time and position interface; symbol sets and action effects vary by domain.

## Schema `0.3.0`

### Movement timing

`Movement` gains two optional fields:

```json
{
  "id": "mov_dingyuan_turn",
  "event_id": "evt_open_fire",
  "actor_id": "ship_dingyuan",
  "path": {
    "type": "LineString",
    "coordinates": [
      [123.510, 39.310],
      [123.525, 39.318],
      [123.548, 39.335]
    ]
  },
  "time": {
    "label": "約 12:50–13:05",
    "start": "1894-09-17T12:50:00",
    "end": "1894-09-17T13:05:00",
    "precision": "inferred",
    "confidence": 0.45
  },
  "waypoint_times": [
    "1894-09-17T12:50:00",
    "1894-09-17T12:56:00",
    "1894-09-17T13:05:00"
  ],
  "precision": "inferred",
  "confidence": 0.45
}
```

- `time` reuses `DateValue` and represents the historical range of the movement.
- `waypoint_times` is an array of ISO date-time strings. When present, its length equals `path.coordinates.length`; values are monotonically increasing and lie within `time.start` and `time.end`.
- With `time` but no `waypoint_times`, distance along the complete polyline is interpolated uniformly over the time range. Interpolation is based on cumulative projected segment length rather than coordinate-array index, avoiding speed changes caused only by uneven point spacing.
- With no movement `time`, the compiler uses the linked event's start and end.
- If the event has only one usable time, the compiler assigns the legacy presentation duration beginning at that time.
- If neither movement nor event provides a parseable time range, the compiler assigns a synthetic range after the preceding ordered event. The UI labels that range as animation timing rather than historical timing.
- If an LLM estimates movement timing or intermediate positions, both movement precision and time precision are `inferred`, and confidence is at most `0.6`.

All ISO date-time values within one document must use a consistent interpretation. Offset-bearing values are preferred. Offset-free historical values are treated as local battle time, never as the viewer's device timezone.

### Playback hints

`animation_hints.timeline` gains these optional presentation-only fields:

```json
{
  "historical_seconds_per_playback_second": 120,
  "idle_compression_threshold_seconds": 900,
  "idle_compressed_duration_ms": 1200
}
```

- `historical_seconds_per_playback_second` defines the base `1×` conversion during active intervals.
- An inactive interval longer than `idle_compression_threshold_seconds` is presented in `idle_compressed_duration_ms`.
- App defaults apply when fields are absent. Playback controls multiply presentation speed by `0.5`, `1`, `2`, or `4`; they do not modify the JSON or historical timestamps.
- Existing `default_event_duration_ms` remains the legacy fallback duration.

### Engagement timing

The existing optional `engagement.time` controls when its tracer and target effect are active. If it lacks a usable range, the compiler uses the linked event's effective range. Destructive results (`sunk`, `disabled`, or `captured`) take effect at `engagement.time.end`, or at the effective event end when engagement timing is absent, and persist thereafter.

## Controlled SVG Symbol System

`animation_hints.style.actor_icons` continues to map actor IDs to strings, but the `0.3.0` prompt directs the LLM to emit only controlled semantic tokens. It never emits SVG markup or emoji. Keeping the schema value as a string preserves compatibility with old documents; validators warn about unknown `0.3.0` tokens, and the app always has a defensive fallback.

The initial vocabulary is:

- Naval: `warship_generic`, `warship_ironclad`, `warship_battleship`, `warship_armored_cruiser`, `warship_protected_cruiser`, `warship_destroyer`, `warship_torpedo_boat`, `naval_transport`, `fleet_generic`.
- Land: `infantry`, `cavalry`, `artillery`, `armor`, `engineer`, `logistics`, `headquarters`, `fortress`.
- Air: `aircraft`, `aircraft_fighter`, `aircraft_bomber`.
- Neutral fallback: `unit_generic`.

The token describes branch or platform; `actor.kind` describes echelon or entity type. For example, an infantry division uses `actor_icons[id]: "infantry"` and `kind: "division"`. This avoids a combinatorial token list.

Fallback order is:

1. Known token in `actor_icons[actor.id]`.
2. Generic SVG selected by `actor.kind`: ship to `warship_generic`, fleet to `fleet_generic`, army through regiment to the appropriate land echelon frame, person to `headquarters`, and unit or other to `unit_generic`.
3. `unit_generic` when the kind is also unknown.

Naval and air SVGs rotate to the trajectory tangent. Land symbols remain upright so text and echelon marks stay readable; their attack arrows show movement direction. The symbol catalog is data-driven so adding a token does not change timeline code.

### Zoom-dependent labels

- Near view: symbol, unit name, platform or branch, and side.
- Middle view: symbol and unit name.
- Far view: side-colored symbol silhouette only; children with a shared `parent_id` may aggregate into the parent actor.

Label collision handling hides secondary labels before primary unit names. It never offsets the historical position of an actor merely to make room for text.

## Domain Rendering

- Naval: individual top-down ship silhouettes, heading rotation, wakes or movement paths, gunfire and torpedo tracers, and persistent sunk or disabled state.
- Land: upright military unit frames, echelon marks from `actor.kind`, branch token inside the frame, advance arrows, defensive lines, and representative-position paths. A division or brigade point is explicitly approximate unless the source supports an exact headquarters position.
- Air: heading-oriented silhouettes and flight paths, with interception or bombardment engagement effects.
- Amphibious: naval trajectories terminate at a landing place; linked land actors continue on land paths in later or overlapping movements.
- Static defense or siege: an actor may have no movement and change only through events and engagements.

Future front-line or control-area polygons are outside this first implementation. The renderer continues to support existing place polygons, but actor trajectories remain point-based.

## Playback and Camera Experience

The event-index scrubber becomes a continuous historical-time scrubber. Querying any scrubber value recomputes all actor positions and persistent states deterministically, so backward scrubbing is correct.

- Controls provide play, pause, `0.5×`, `1×`, `2×`, `4×`, and follow-camera toggle.
- The current historical time remains visible. During synthetic legacy timing, the label says `動畫時間`; it must not display a fabricated clock time.
- When an inactive interval is compressed, the UI states how much historical time was compressed.
- An event card appears when an event begins and shows time, precision, and confidence. Cards remain in a short fading stack for at least three presentation seconds so rapid events remain readable without delaying the current historical clock. Hovering or clicking the stack pauses playback.
- Engagement effects are visible only for their effective time range. Persistent outcomes are applied at the effective end time.
- The camera defines an inner safe viewport. It pans or zooms smoothly only when the bounds of currently active actors and engagements leave that viewport. Camera animation duration is derived from distance and clamped to avoid abrupt jumps.
- User map interaction immediately suspends automatic following. The user explicitly re-enables it with the follow control.

The animation loop uses `requestAnimationFrame` and computes state from the presentation clock rather than chaining CSS transitions or timers. This prevents timer drift and makes pause, speed changes, and scrubbing deterministic.

## Validation and Error Handling

Fatal validation errors prevent playback:

- malformed movement or engagement time values;
- an end time earlier than its start;
- a `waypoint_times` count that differs from the coordinate count;
- non-monotonic waypoint times or waypoint times outside the movement range;
- unresolved actor, event, place, side, commander, or source references;
- irreconcilable overlapping movements for one actor. Overlap is irreconcilable when two ranges overlap and neither starts exactly where the other ends spatially.

Recoverable conditions produce visible warnings:

- unknown icon token, followed by kind-based SVG fallback;
- absent timing, followed by event-time or synthetic-range fallback;
- `inferred` timing with confidence above `0.6`;
- a boundary overlap in which the later movement begins at the previous movement's final position; the later movement owns the shared instant;
- label collision, followed by secondary-label suppression.

The Python validator and browser validator use the same field rules, reference checks, and semantic timing checks. The CLI may print warnings and still finish with `valid:`; fatal issues preserve the existing nonzero invalid result.

## Prompt Contract

The README prompt is updated for `0.3.0` with:

- instructions to split naval actions into ships and land actions into divisions or brigades when sources permit;
- `movement.time` and optional `waypoint_times` examples;
- a rule that inferred intermediate times and positions use `precision: "inferred"` and confidence at most `0.6`;
- the complete controlled icon vocabulary and a short selection table;
- an explicit prohibition on emoji, arbitrary icon names, data URLs, and SVG markup in `actor_icons`;
- guidance to use the generic token when a specific platform is uncertain;
- a reminder that land-unit coordinates are representative positions, not exact occupied footprints;
- instructions to provide engagement time ranges when the source supports them.

The Yalu example is revised to demonstrate individual ships, staged trajectories, timestamped waypoints, semantic ship tokens, timed engagements, and persistent outcomes. Inferred geometry and timing retain low confidence and remain distinguishable from sourced facts.

## Testing

### Contract tests

Python tests keep the JSON Schema, TypedDict definitions, hand-written validator, browser validator, README prompt, and examples synchronized. They cover new `0.3.0` fields and all cross-references while retaining `0.1.0` and `0.2.0` fixtures.

### Timeline compiler tests

The compiler is extracted as pure JavaScript and tested without a map for:

- ISO and offset-free local battle-time parsing;
- effective-time fallback precedence;
- waypoint validation and distance-based interpolation;
- inactive-gap compression and inverse mapping for scrubbing;
- speed changes without historical-time discontinuity;
- deterministic forward and backward state queries;
- engagement activation and persistent outcome timing;
- overlapping movement handling;
- legacy event-duration fallback.

### Symbol tests

Every prompt token resolves to an SVG definition. Tests verify kind-based fallback, heading rotation rules, upright land symbols, and the absence of emoji in the `0.3.0` Yalu example.

### Browser integration tests

The Yalu demonstration is exercised from start to finish: play, pause, speed controls, continuous scrub, inactive-gap notice, event-card pause, camera follow and suspension, engagement effects, and sunk state. A legacy example is also loaded to verify fallback playback. Visual checks cover label hierarchy and symbol clarity at near, middle, and far zoom levels.

## Completion Criteria

- Units move continuously along their complete paths; event changes never teleport a unit.
- Scrubbing to any presentation time reconstructs every actor position and persistent state.
- Inactive-gap compression and inferred or synthetic data are clearly disclosed.
- The Yalu example renders at individual-ship granularity with distinct top-down ship classes.
- A land document can use the same engine at division or brigade granularity.
- All existing `0.1.0` and `0.2.0` examples still validate and play.
- The README prompt emits controlled icon tokens rather than emoji or SVG.
- All automated contract, compiler, symbol, and browser integration tests pass.

## Out of Scope

- Combat outcome simulation, firepower, supply, morale, or AI tactical decisions.
- Exact land-unit footprints, continuously changing front lines, or control-area simulation.
- Reconstructing precise timing or geography without marking it as inferred.
- Rewriting every existing example at the new granularity in the first release.

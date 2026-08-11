# Source-First Frontline Transitions Design

## Goal

Make historical frontline animation readable and source-honest when unit positions are sparse, mixed in scale, or interleaved. Source-backed frontline geometry remains authoritative. Runtime unit-derived geometry is a low-confidence fallback only where no source-backed timeline coverage exists.

This design does not add combat simulation, territorial control inference, or AI-generated historical geometry.

## Product Meaning

A frontline represents the main continuous source-backed contact boundary, not a partition that must place every actor point on one side. Actor points may represent headquarters, approximate formation centers, reserves, isolated forces, or differently sized formations.

Consequently:

- Actor positions never distort a source-covered frontline interval.
- A unit appearing beyond a main line does not automatically create a salient, pocket, or encirclement.
- A salient, pocket, encirclement, or control area is rendered as historical geometry only when a cited source map supplies that geometry.
- Text stating that an encirclement or breakthrough occurred may create a historical event marker, but cannot create a boundary shape.

## Data Contract

Schema version remains `0.4.0`.

`frontline_snapshots[]` continues to contain only source-backed historical geometry with `source_ids`, `precision`, and `confidence`. Reusing the same `front_lines[].id` in adjacent snapshots identifies the same continuing frontline track. Different identifiers mean that continuity is not asserted.

No runtime-derived line is serialized into `frontline_snapshots`, movements, events, or any other historical field. No new operational-status, reserve, penetration, or encirclement classification is required from data curators or an LLM.

The README generation prompt is upgraded from version `1.2.0` to `1.3.0` and must state:

- Preserve a stable frontline `id` across snapshots only when the sources support continuity.
- Do not infer a pocket, salient, encirclement, or control area from actor positions.
- Do not convert runtime-derived geometry into a source snapshot.
- A textual account without mapped geometry supports an event, not an invented boundary.

## Runtime Selection Rules

For Hybrid mode, source coverage is selected before derived fallback:

1. Before the first source snapshot, there is no source coverage. The app may attempt a low-confidence derived fallback.
2. At a source snapshot, render its exact geometry.
3. Between two source snapshots, render only the source temporal transition. Actor positions have zero influence on that interval.
4. After the final source snapshot, preserve the final known source geometry.
5. If no source snapshots exist, attempt the derived fallback throughout the available timeline.

Display modes retain distinct purposes:

- `hybrid`: source temporal geometry where covered; derived fallback only before the first source snapshot or when the document has no source snapshots.
- `source`: source snapshots and their temporal transitions only; show no line before the first snapshot and preserve the final snapshot afterward.
- `derived`: independent diagnostic display of runtime unit-derived geometry.
- `off`: no frontline display.

Derived mode does not imply historical truth and never feeds geometry back into Hybrid during a source-covered interval.

## Source Geometry Transitions

All transition geometry is display-only and deterministic. Exact source geometry is preserved at every source anchor.

### Same topology

- Open line to open line: align direction, resample deterministically, and interpolate.
- Closed ring to closed ring: align winding and start point, resample deterministically, and interpolate.

### Open line to closed ring

Use endpoint-extension closure only when all of these are true:

- The before and after snapshots each contain exactly one relevant shape for the track.
- Both shapes use the same stable `front_lines[].id`.
- The before shape is open and the after shape is closed.
- Both geometries are structurally valid.

The renderer aligns the old line with the target ring, identifies deterministic target positions nearest the old endpoints, morphs the shared body toward the target, and extends both ends along the remaining target ring until they meet. The line becomes fully closed only at the later source anchor.

The intermediate shape is labeled as source interpolation and does not claim an observed historical boundary.

### Unsafe topology changes

Use a crossfade instead of geometry morphing when any of the following applies:

- One line splits into multiple lines.
- Multiple lines merge.
- Shape counts differ.
- Stable identifiers do not establish continuity.
- Open/closed topology changes other than the supported one-open-to-one-closed case.
- Geometry is malformed or deterministic correspondence cannot be established.

Scrubbing displays the sampled state immediately without replaying transition effects. Reduced-motion mode suppresses endpoint-growth animation and transient crossfade motion while still displaying the correct sampled geometry.

## Derived Fallback Safety Gate

Derived fallback is deliberately conservative. It is available only when every condition below is satisfied:

- Exactly two sides have eligible positioned land actors.
- Each side has at least two eligible actors.
- The two sides are cleanly separated along the axis joining their position centroids: their projected position ranges must not overlap.
- The influence-field result contains exactly one open contact line.
- The result is finite, deterministic, and within the stable battle-data bounds.

If any condition fails, return `unavailable` with a stable reason code and render no derived frontline. In particular, the runtime must reject interleaved formations, closed contours, multiple isolated contours, and ambiguous pockets rather than interpreting them as historical salients or encirclements.

The derived result remains `precision: "inferred"` with `confidence <= 0.35`.

## Provenance and UI

The inspector must distinguish four states without presenting animation output as evidence:

- `SOURCE SNAPSHOT`
- `SOURCE INTERPOLATION · animation between historical anchors`
- `DERIVED FROM UNIT POSITIONS · <=35% confidence`
- `INSUFFICIENT EVIDENCE · frontline unavailable`

Map labels remain concise; detailed source, confidence, and transition explanation stays in the inspector. Derived diagnostic mode remains visibly distinct from source-backed geometry.

## Failure Handling

- Missing or invalid source geometry never causes the renderer to throw; it falls through to the next safe source state or reports unavailable.
- A malformed stable-id pair crossfades or remains discrete; it never attempts a partial morph.
- Failure of the derived safety gate does not alter source mode or source-covered Hybrid intervals.
- Mode changes, backward seeks, replacement documents, and destroy operations clear owned transition timers and transient elements.

## Verification

Automated contracts must cover:

- Source-covered Hybrid geometry remains identical when actor positions change.
- The midpoint between two source anchors is source interpolation, not derived geometry.
- Before the first source anchor, Hybrid uses derived fallback only when its safety gate passes.
- After the final source anchor, Hybrid retains the last source geometry.
- Interleaved sides fail the derived safety gate.
- Fewer than two eligible actors per side fail the safety gate.
- Multiple or closed derived contours fail the safety gate.
- Stable open-to-open and closed-to-closed tracks interpolate deterministically.
- A stable one-open-to-one-closed track grows endpoints and closes exactly at the target anchor.
- Split, merge, missing-id, malformed, and unsupported topology transitions crossfade.
- Scrubbing, reduced motion, mode switching, replacement, and destroy leave no stale transitions.
- Source/derived provenance text and confidence remain exact.
- Prompt version `1.3.0`, existing schema versions, and examples remain valid.

Real-browser verification should inspect at least one open-to-closed transition at normal and reduced motion, plus backward scrubbing and rapid mode changes. If a browser backend is unavailable, this limitation must be reported rather than represented as a passed check.

## Standards Alignment and Non-Goals

The snapshot-plus-time model is conceptually compatible with OGC Moving Features temporal geometry, while source provenance and historical uncertainty remain project-specific. APP-6 or MIL-STD-2525 symbol identifiers may be supported independently in the future.

This change does not:

- Adopt MSDL, C-BML, JC3IEDM/MIM, or another simulation/C2 data model.
- Add an MF-JSON import/export implementation.
- Infer unit roles, control areas, supply corridors, combat strength, or territory ownership.
- Generate historical geometry from text-only accounts.
- Modify schema version `0.4.0`.

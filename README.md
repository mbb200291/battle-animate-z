# Battle Animation Schema

A small, source-oriented JSON format for turning historical battle data into timeline-based map animations.

The project focuses on **structured historical facts with explicit uncertainty**. It is intentionally lighter than military simulation standards such as MSDL or C-BML: the schema records what sources say about actors, places, events, movements, engagements, outcomes, and dated frontline snapshots without modeling command logic, firepower, logistics, or tactical rules.

## What this repository contains

- `schemas/battle-animation-schema.json` — schema definitions for versions `0.1.0` through `0.4.0`.
- `battle_animation/types.py` — Python `TypedDict` definitions matching the schema.
- `battle_animation/validator.py` — schema and reference validation.
- `examples/` — example battle documents, including timed ship-level and frontline-snapshot examples.
- `app/` — a browser-based renderer for inspecting and animating battle JSON documents.
- `tests/` — contract tests for schema and application behavior.

## Design principles

The format separates historical claims from presentation hints:

- `historical_events`, `movements`, `engagements`, `frontline_snapshots`, and `outcome` represent source-backed historical data.
- `animation_hints` contains renderer guidance such as colors, icon tokens, timeline ordering, and camera suggestions.

Uncertainty is represented explicitly with fields such as `precision` and `confidence`. Approximate or inferred information should remain visibly approximate instead of being converted into false precision.

The format is designed for **extraction and visualization, not simulation**.

## Schema 0.4.0 at a glance

A document contains these required top-level keys:

```text
schema_version
metadata
battle
sides
commanders
actors
places
historical_events
movements
outcome
sources
animation_hints
```

Optional top-level keys:

```text
engagements
frontline_snapshots
```

### Event types

`historical_events[].type` uses a controlled enum:

- `advance`
- `retreat`
- `attack`
- `defend`
- `capture`
- `surrender`
- `reinforcement`
- `bombardment`
- `landing`
- `other`

### Geographic data

Geographic fields use a small GeoJSON subset:

- `Point`
- `LineString`
- `Polygon`

Coordinates always use `[longitude, latitude]` order.

Representative coordinates do not imply exact formation footprints or historical borders.

## Generate battle JSON with AI

The prompt below is intended for use with an AI model that can read source material from Wikipedia, Wikidata, or other public references. It emphasizes schema correctness, source traceability, and conservative handling of uncertain data.

### Battle JSON Prompt 1.3.2

````text
You are a historical-data normalization assistant. Based only on Wikipedia, Wikidata, or other Wiki/public-source material that I provide and that you can actually read, generate one JSON document that fully conforms to battle-animation-schema 0.4.0 for use by a battle animation application.

This is Battle JSON Prompt 1.3.2. The prompt version and schema version are separate concepts:
- `schema_version` must be the string `"0.4.0"`.
- `metadata.source_system` must be the string `"battle_json_prompt_1.3.2"`.
- Do not add a `prompt_version` field; it is not part of the schema.
- Versions 0.1.0, 0.2.0, and 0.3.0 are supported only for reading legacy documents. This prompt generates 0.4.0 documents only.

===== OUTPUT RULES =====
1. When the available source material is sufficient, output exactly one Markdown code block labeled `json`. The code block must contain only the final JSON object, with no explanation before or after it.
   Exception: if you cannot read the source material, or required source metadata is missing, ask the user for the missing information in one short sentence and do not generate JSON yet.
2. The top-level object must contain these required keys in this order:
   `schema_version`, `metadata`, `battle`, `sides`, `commanders`, `actors`, `places`, `historical_events`, `movements`, `outcome`, `sources`, `animation_hints`.
3. Optional top-level keys are `engagements` and `frontline_snapshots`. Do not add any other top-level keys.
4. Never wrap the result in objects such as `problems`, `suggested_fixes`, `corrected_json`, or any other quality-check envelope. Output the final JSON object directly.
5. Every object in the schema uses `additionalProperties: false`. Use only fields explicitly allowed by the schema.

===== CORE GENERATION PRINCIPLES =====
1. Record only facts supported by sources and clearly evidence-based inferences. Before producing JSON, internally verify which actors, events, times, places, engagements, outcomes, and frontline snapshots are actually supported. Do not output this internal review.
2. Use the finest granularity that the source material genuinely supports. If sources identify individual ships, divisions, brigades, phases, waypoint timing, engagements, or dated frontline maps, preserve that detail instead of collapsing it to a coarser representation.
3. Low confidence is not permission to invent data. A speculative statement cannot be made valid merely by assigning a low `confidence` value.
4. Do not fabricate actors, events, timestamps, path bends, engagements, classifications, or frontline geometry merely to make the animation smoother.
5. Inferred movement is allowed only when sources confirm that a unit moved from one location or phase to another. Such geometry must use `precision: "inferred"` and `confidence <= 0.5`.
6. A representative coordinate is not an exact footprint, frontage, occupied polygon, or historical boundary.

===== REQUIRED SOURCE DISCIPLINE =====
- Every `historical_events[].source_ids` must be a non-empty array.
- `outcome.source_ids` must be a non-empty array.
- Every engagement generated by this prompt must include a non-empty `source_ids` array, even though the schema treats it as optional.
- `movements` do not contain `source_ids`. Each movement must instead be supported by the `source_ids` of the `historical_event` referenced by its `event_id`.
- Source identifiers must point only to sources that directly support the corresponding claim.

===== LEGAL FIELDS =====
`metadata`:
- required: `id`, `title`, `created_at`, `updated_at`, `license`, `source_system`
- optional: `wikidata_qid`
- `created_at` and `updated_at` must use the actual document dates in `YYYY-MM-DD` format.

`battle`:
- required: `id`, `name`, `part_of`, `date`, `summary`, `confidence`
- optional: `also_known_as`
- `date` requires `label`, `precision`, `confidence`; optional `start`, `end`
- do not use `start_date` or `end_date`

`sides[]`:
- required: `id`, `name`, `color`, `belligerents`
- each `belligerents[]` item requires `id`, `name`; optional `wikidata_qid`
- use clearly distinguishable hexadecimal colors for opposing sides

`commanders[]`:
- required: `id`, `name`, `side_id`, `confidence`
- optional: `rank_or_role`, `wikidata_qid`
- use `rank_or_role`, not `role`

`actors[]`:
- required: `id`, `name`, `side_id`, `kind`, `confidence`
- optional: `parent_id`, `commander_ids`, `strength`
- `kind` must be one of: `army`, `corps`, `division`, `brigade`, `regiment`, `fleet`, `ship`, `unit`, `person`, `other`
- `strength` may contain `label`, `min`, `max`, `confidence`; do not use `value` or `unit`

`places[]`:
- required: `id`, `name`, `geometry`, `precision`, `confidence`
- optional: `wikidata_qid`
- geometry must be GeoJSON `Point`, `LineString`, or `Polygon`
- coordinates must use `[longitude, latitude]`

`historical_events[]`:
- required: `id`, `type`, `title`, `time`, `description`, `actor_ids`, `place_ids`, `precision`, `confidence`, `source_ids`
- optional: `target_actor_ids`
- `type` must be one of: `advance`, `retreat`, `attack`, `defend`, `capture`, `surrender`, `reinforcement`, `bombardment`, `landing`, `other`
- `time` requires `label`, `precision`, `confidence`; optional `start`, `end`
- if the historical time is unknown, use a truthful label such as `"time unknown"`, `precision: "unknown"`, and suitably low confidence instead of inventing a date

`movements[]`:
- required: `id`, `event_id`, `actor_id`, `path`, `precision`, `confidence`
- optional: `from_place_id`, `to_place_id`, `time`, `waypoint_times`
- every movement must reference an existing `historical_events[].id`
- `path` must be a GeoJSON `LineString` with at least two coordinates
- if `waypoint_times` is present, its length must exactly match `path.coordinates`, timestamps must be strictly increasing, and every timestamp must fall within the movement time range
- omit an entire movement if the path has neither direct source support nor a defensible inferred A-to-B basis

`engagements[]` (optional):
- required: `id`, `event_id`, `attacker_actor_id`, `target_actor_id`, `type`, `confidence`
- optional: `result`, `result_actor_id`, `at_place_id`, `time`, `source_ids`
- `type` must be one of: `fire`, `bombardment`, `ram`, `torpedo`, `charge`, `melee`, `other`
- `result` must be one of: `hit`, `miss`, `damaged`, `disabled`, `sunk`, `repelled`, `captured`, `none`
- create an engagement only when attacker, target, and engagement type are directly supported by sources
- include `result` only when the result itself is directly supported
- this prompt requires every engagement to include non-empty `source_ids`

`frontline_snapshots[]` (optional):
- required: `id`, `time`, `precision`, `confidence`, `source_ids`
- optional: `event_id`, `front_lines`, `control_areas`
- every snapshot must contain at least one `front_lines` or `control_areas` entry
- `front_lines[].geometry` must be a `LineString`
- `control_areas[].geometry` must be a `Polygon`
- use frontline snapshots only when a source directly supports a frontline or control area at a specific date/time
- a dated source map may be traced into geometry; such tracing may use `precision: "inferred"` and `confidence <= 0.5`, while `source_ids` must cite the map
- never derive `frontline_snapshots` from unit positions, casualties, strength, outcome, or generic narrative descriptions
- never invent intermediate snapshots merely to smooth animation
- reuse the same frontline/control-area ID across snapshots only when source evidence supports continuity
- interpolation between dated source anchors is a renderer behavior and must not be serialized as new historical evidence

`outcome`:
- required: `summary`, `winner_side_ids`, `confidence`, `source_ids`
- optional: `casualties`
- `winner_side_ids` is always an array
- each casualty entry requires `side_id`, `label`, `confidence`; optional `min`, `max`

`sources[]`:
- required: `id`, `title`, `url`, `retrieved_at`, `license`
- optional: `note`
- use `retrieved_at`, not `accessed_at`
- `retrieved_at` must be the actual retrieval date in `YYYY-MM-DD`
- never invent a source title, URL, or license
- do not assume every source is CC BY-SA 4.0

`animation_hints`:
- required: `map`, `style`, `timeline`
- optional: `camera`
- `map` requires `initial_center`, `initial_zoom`; optional `bounds_padding`
- `style` may contain `side_colors`, `actor_icons`, `event_icons`, `movement_line_width`
- `timeline` may contain `default_event_duration_ms`, `ordered_event_ids`, `historical_seconds_per_playback_second`, `idle_compression_threshold_seconds`, `idle_compressed_duration_ms`
- `camera[]` entries require `event_id` and `center`; optional `zoom`
- `animation_hints` are presentation hints only and must not contain historical claims or source citations

===== CONTROLLED ACTOR ICON TOKENS =====
Use only these actor icon names:
`warship_generic`, `warship_ironclad`, `warship_battleship`, `warship_armored_cruiser`, `warship_protected_cruiser`, `warship_destroyer`, `warship_torpedo_boat`, `naval_transport`, `fleet_generic`, `infantry`, `cavalry`, `artillery`, `armor`, `engineer`, `logistics`, `headquarters`, `fortress`, `aircraft`, `aircraft_fighter`, `aircraft_bomber`, `unit_generic`.

Do not output Emoji, SVG markup, data URLs, or unrecognized icon names. When the source does not support a more specific classification, use the appropriate generic token.

===== GRANULARITY GUIDANCE =====
1. Naval battles may use ship-level actors when important vessels are explicitly identified by sources.
2. Land battles may use division- or brigade-level actors when sources support that level of detail.
3. Keep the same actor ID across phases for the same historical unit.
4. Use engagements only for source-supported attacker-to-target relationships.
5. Representative movement paths and positions may be inferred only from source-supported actions and ordering, and must be marked as inferred with low confidence.
6. Do not create unsupported tactical detail simply because the schema has fields available for it.

===== INTERNAL QUALITY CHECK BEFORE OUTPUT =====
Before emitting the final JSON, verify internally that:
- `schema_version` is exactly `"0.4.0"`
- `metadata.source_system` is exactly `"battle_json_prompt_1.3.2"`
- required fields and controlled enums are valid
- all IDs resolve correctly
- GeoJSON coordinates use `[longitude, latitude]`
- no object contains extra fields forbidden by `additionalProperties: false`
- required source arrays are non-empty and point to directly supporting sources
- movements are supported through their referenced historical events
- engagement attacker, target, and type are directly supported
- engagement results are included only when directly supported
- frontline snapshots are based on dated source evidence rather than runtime unit-position inference
- no exact-looking geometry or timing has been invented from vague narrative evidence

===== SOURCE INPUT =====
[Paste Wikipedia / Wikidata / Wiki text, tables, URLs, or source summaries here]

If readable page text, tables, or summaries have already been provided, you may generate the JSON using only that material.

If the only input is a URL that you cannot actually access, stop and ask the user to paste the relevant page text, table, or summary. Never pretend that you read a URL you could not access.

Every generated source entry must contain the real source `title`, `url`, and `license`. If any required source metadata is unavailable, ask the user for it before generating JSON.

Replace every `created_at`, `updated_at`, and `retrieved_at` value with the actual date. Never leave placeholder values such as `YYYY-MM-DD` in the final JSON.

===== TARGET BATTLE =====
[Example: Battle of Waterloo]

Generate only the final JSON object for the specified battle.
````

After generation, validate the document before loading it into the renderer:

```bash
python3 -m battle_animation.validator path/to/your-battle.json
```

Fix schema, field-name, or reference errors until the validator prints `valid:`.

## Validate bundled examples

```bash
python3 -m battle_animation.validator examples/battle-of-waterloo.json
python3 -m battle_animation.validator examples/battle-of-甲午.json
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
python3 -m battle_animation.validator examples/battle-of-stalingrad-frontlines.json
```

Run the contract tests:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
```

## Run locally

Serve the repository root with any static file server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/app/
```

The browser application validates a document before rendering it, so schema and reference errors can be corrected before animation.

## Format boundaries and unit granularity

Across schema versions `0.1.0` through `0.4.0`:

- naval battles can use ship-level actors when sources support individual vessels;
- land battles can use division- or brigade-level actors and representative positions when sources support that granularity;
- coordinates represent locations, not exact formation footprints or frontage;
- movement paths may be inferred only from source-supported movement and should carry appropriately low confidence;
- strengths and casualties may use ranges and text labels;
- sources should point back to the public references that support historical claims;
- rendering hints should remain separate from historical evidence.

## License

MIT License. See [`LICENSE`](LICENSE).

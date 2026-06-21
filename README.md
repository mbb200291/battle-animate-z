# Battle Animation Schema MVP

This project defines a small, stable JSON format for battle data that can be extracted from Wikipedia, Wikidata, and similar public sources, then used by downstream apps to generate map animations.

The first version intentionally avoids military simulation standards such as MSDL or C-BML. It records source-backed historical facts and lightweight rendering hints without modeling command logic, firepower, supply, or tactical rules.

## Files

- `schemas/battle-animation-schema.json` defines `battle-animation-schema` version `0.1.0`.
- `battle_animation/types.py` provides Python `TypedDict` definitions matching the schema.
- `examples/battle-of-waterloo.json` is a hand-built MVP example.
- `battle_animation/validator.py` validates documents with the schema subset used by this project and checks internal references.
- `app/index.html` is a static "auto generate animate" app for the example JSON.

## Schema Principles

The schema has two separate layers:

- `historical_events`: source-backed historical facts. Events include `type`, `time`, `actor_ids`, `place_ids`, `precision`, `confidence`, and `source_ids`.
- `animation_hints`: rendering guidance for an animation app. This includes map center, colors, event ordering, camera hints, and line width. These fields do not assert historical facts.

This split keeps extraction simple. Wikipedia often gives approximate times, disputed strengths, and inferred movement paths. The schema stores those uncertainties directly with `precision` and `confidence` instead of pretending the data is exact.

## Event Types

Timeline events use a fixed enum:

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

## GeoJSON Subset

Geographic fields use a small GeoJSON subset:

- `Point`
- `LineString`
- `Polygon`

Coordinates are `[longitude, latitude]`. Places can be approximate, inferred, disputed, or unknown through `precision` and `confidence`.

## Validate Data

Run the validator against the example:

```bash
python3 -m battle_animation.validator examples/battle-of-waterloo.json
```

Expected output:

```text
valid: examples/battle-of-waterloo.json
```

Run the tests:

```bash
python3 -m unittest tests/test_mvp_contract.py -v
```

## Run the Animation App

Serve the repository root with any static file server:

```bash
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000/app/
```

The app loads `examples/battle-of-waterloo.json`, projects GeoJSON coordinates onto an SVG map plane, renders places, units, movement paths, event markers, and plays the ordered timeline.

## MVP Boundaries

This format is designed for extraction and animation, not simulation. In version `0.1.0`:

- actors are coarse units such as armies, corps, divisions, or named units;
- movement paths may be inferred and should carry low confidence where appropriate;
- strengths and casualties may use ranges and text labels;
- source records point back to Wikipedia, Wikidata, or other public references;
- animation hints are optional guidance for renderers and should never replace source-backed historical data.

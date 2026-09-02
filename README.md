# Battle Animation Schema

A small, source-oriented JSON format for turning historical battle data into timeline-based map animations.

The project focuses on **structured historical facts with explicit uncertainty**. It records what sources say about actors, places, events, movements, engagements, outcomes, and dated frontline snapshots without modeling command logic, firepower, logistics, or tactical rules.

## Versions

| Component | Current version | Notes |
| --- | --- | --- |
| Battle JSON Schema | `0.4.0` | Current format generated for new battle documents |
| AI Generation Prompt | `1.3.2` | Prompt rules for producing schema `0.4.0` JSON |
| Legacy schema support | `0.1.0`–`0.3.0` | Supported for reading older documents |

The schema version and prompt version are separate version lines. A newly generated document should use:

```json
{
  "schema_version": "0.4.0",
  "metadata": {
    "source_system": "battle_json_prompt_1.3.2"
  }
}
```

## Quick start

1. Prepare or generate a battle JSON document.
2. Validate it:

   ```bash
   python3 -m battle_animation.validator path/to/your-battle.json
   ```

3. Start a local static server from the repository root:

   ```bash
   python3 -m http.server 8000
   ```

4. Open `http://localhost:8000/app/` and load the JSON document.

The browser application validates documents before rendering them, so schema and reference errors can be corrected before animation.

## What this repository contains

- `schemas/battle-animation-schema.json` — schema definitions for versions `0.1.0` through `0.4.0`.
- `battle_animation/types.py` — Python `TypedDict` definitions matching the schema.
- `battle_animation/validator.py` — schema and reference validation.
- `examples/` — example battle documents, including timed ship-level and frontline-snapshot examples.
- `docs/battle-json-prompt.md` — the maintained AI generation prompt.
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

Coordinates always use `[longitude, latitude]` order. Representative coordinates do not imply exact formation footprints or historical borders.

## Simplified JSON example

The following excerpt shows the relationship between the main data sections. It is intentionally abbreviated and is **not** a complete schema-valid document.

```json
{
  "schema_version": "0.4.0",
  "metadata": {
    "id": "battle_waterloo",
    "title": "Battle of Waterloo",
    "source_system": "battle_json_prompt_1.3.2"
  },
  "battle": {
    "id": "battle_waterloo",
    "name": "Battle of Waterloo"
  },
  "actors": [
    {
      "id": "actor_example_unit",
      "name": "Example Unit",
      "side_id": "side_a",
      "kind": "division"
    }
  ],
  "historical_events": [
    {
      "id": "evt_advance",
      "type": "advance",
      "actor_ids": ["actor_example_unit"],
      "source_ids": ["src_1"]
    }
  ],
  "movements": [
    {
      "id": "mov_advance",
      "event_id": "evt_advance",
      "actor_id": "actor_example_unit",
      "path": {
        "type": "LineString",
        "coordinates": [[4.3, 50.7], [4.4, 50.7]]
      }
    }
  ],
  "sources": [
    {
      "id": "src_1",
      "title": "Source title",
      "url": "https://example.com/source"
    }
  ]
}
```

See [`examples/`](examples/) for complete documents that can be validated and rendered.

## Generate battle JSON with AI

Use [**Battle JSON Prompt 1.3.2**](docs/battle-json-prompt.md) to ask an AI model to generate a new battle document.

The prompt is maintained separately from this README so the repository landing page can stay focused on the project itself. It emphasizes schema correctness, source traceability, conservative inference, and the distinction between source-backed frontline snapshots and runtime-derived visualization.

After generation, validate the result:

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This project defines `battle-animation-schema` v0.1.0 — a small, stable JSON format for source-backed battle history (extracted from Wikipedia/Wikidata) plus lightweight rendering hints. It deliberately avoids military-simulation standards (MSDL, C-BML): no firepower, supply, morale, or damage modeling. Three parts ship together: the JSON Schema, a pure-Python validator, and a static SVG animation app.

## Commands

```bash
# One-time setup (optional): create venv and install editable
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

# Validate a document against the schema (also checks internal id references)
python3 -m battle_animation.validator examples/battle-of-waterloo.json
battle-animation-validate examples/battle-of-waterloo.json   # console script (after pip install -e .)

# Run all tests
python3 -m unittest tests/test_mvp_contract.py -v

# Run a single test
python3 -m unittest tests.test_mvp_contract.BattleAnimationMvpContractTest.test_waterloo_example_validates_with_cli

# Serve the animation app (open http://localhost:8000/app/)
python3 -m http.server 8000
```

No external dependencies — standard library Python 3 (≥3.10) only; the app is vanilla ES modules with no build step. Project metadata and the `battle-animation-validate` console script are declared in [pyproject.toml](pyproject.toml).

## Architecture

The schema enforces a strict two-layer split that the rest of the system depends on:

- **`historical_events`** — source-backed facts only. Every uncertainty is recorded explicitly via `precision` (exact/approximate/inferred/disputed/unknown) and `confidence` (0–1), never by faking exact data. Events reference sources through `source_ids`.
- **`animation_hints`** — rendering guidance only (map center/zoom, colors, event ordering, camera, line width). These fields must **never** assert historical facts. Tests in [tests/test_mvp_contract.py](tests/test_mvp_contract.py) actively guard against the two layers leaking into each other.

Three representations of the same contract must stay in sync when the schema changes:

1. [schemas/battle-animation-schema.json](schemas/battle-animation-schema.json) — the source of truth (JSON Schema draft 2020-12, `$defs` + local `$ref`s).
2. [battle_animation/types.py](battle_animation/types.py) — Python `TypedDict` mirror of the schema.
3. [battle_animation/validator.py](battle_animation/validator.py) — hand-rolled validator implementing the **subset** of JSON Schema this project uses.

### Validator

[battle_animation/validator.py](battle_animation/validator.py) is not a general JSON Schema validator. It implements only the keywords used here (`$ref`, `oneOf`, `const`, `enum`, `type`, object/array/number/string constraints, `pattern`). Beyond structural validation it runs `_validate_references`: every `*_id`/`*_ids` field (commander→side, actor→side/commanders, event→actor/place/source, movement→event/actor/place, outcome→side/source) must resolve to a real `id` in the document. If you add a new id-linked field to the schema, add the corresponding reference check here too.

### Animation app

[app/animate.js](app/animate.js) is a standalone ES module (imported by [app/index.html](app/index.html)). It loads battle JSON (the default example, or a user-supplied file via picker / drag-drop / paste) and renders it over a **Leaflet + OpenStreetMap** basemap. Leaflet is loaded from a CDN in [app/index.html](app/index.html), so the app needs network access for map tiles.

- Battle graphics are drawn in an **SVG overlay** appended to the Leaflet container. Coordinates are GeoJSON `[longitude, latitude]`; `project([lon,lat])` uses `map.latLngToContainerPoint([lat,lon])`, and a `redraw()` re-projects every element on each map `move`/`zoom`/`resize`. The `is-moving` class disables CSS transitions during map interaction so units track the map crisply.
- `validateBattle(battle)` is a browser-side port of [battle_animation/validator.py](battle_animation/validator.py)'s reference checks (required keys, schema version, event-type enum, all `*_id(s)` cross-references). [app/index.html](app/index.html) runs it before rendering and shows failures in an error banner — keep it in sync with the Python validator.
- `orderEvents` sequences the timeline via `animation_hints.timeline.ordered_event_ids`, appending unlisted events. `buildSnapshots` precomputes cumulative actor positions per event so scrubbing backward is correct.
- `animation_hints` is fully honored: `camera` drives per-event `flyTo`, `style.side_colors` overrides side colors (falling back to `SIDE_PALETTE` so opposing sides are always distinct even without colors), `style.event_icons` → glyphs via `resolveIcon`/`NAMED_ICONS`, and `style.actor_icons` (actor id → named icon or emoji) → unit glyphs via `resolveActorIcon`, defaulting per `actor.kind` (fleet→🚢, army→🪖, …).
- `renderBattle` returns a controller (`showEvent`/`next`/`prev`/`play`/`pause`/`toggle`/`destroy`); `play` clears its own interval (no stacked timers). `destroy()` tears down the Leaflet map so the container can be re-rendered with new JSON.

## Conventions

- Identifiers match `^[a-zA-Z][a-zA-Z0-9_-]*$` and are referenced by id across collections — never inline duplicate entities.
- GeoJSON is restricted to `Point`, `LineString`, `Polygon` with `[longitude, latitude]` positions.
- Event `type` is a closed enum (advance, retreat, attack, defend, capture, surrender, reinforcement, bombardment, landing, other). The same list is asserted in tests; update both schema and test together.
- Inferred movement paths should carry `precision: "inferred"` and low confidence (≤ 0.6).

## Generating data with AI

The README contains a long Chinese-language prompt template (under "Generate JSON With AI") for asking a model to produce schema-conformant battle JSON from a wiki page, including a draft → JSON → quality-check workflow. Reuse it rather than rewriting; always run the validator on AI-generated output.

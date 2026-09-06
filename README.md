# Battle Animation Schema

A small, source-oriented JSON format for turning historical battle data into timeline-based map animations.

The project focuses on **structured historical facts with explicit uncertainty**. It records what sources say about actors, places, events, movements, engagements, outcomes, and dated frontline snapshots without modeling command logic, firepower, logistics, or tactical rules.

## Versions

| Component | Current version | Notes |
| --- | --- | --- |
| Battle JSON Schema | `0.4.0` | Current format generated for new battle documents |
| Legacy schema support | `0.1.0`–`0.3.0` | Supported for reading older documents |

A newly generated document uses the current JSON schema version only:

```json
{
  "schema_version": "0.4.0",
  "metadata": {
    "source_system": "wikipedia"
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

## Map controls and overlays

「逐段導覽」預設開啟：每段以 1× 速度停留 3 秒交代情境、10 秒播放事件期間、3 秒閱讀結果，再切至下一段。各段使用固定事件視角；並行事件逐一介紹，歷史日期可能回跳。關閉即可回到連續時間播放。

導覽只在地圖呈現目前事件中有有效 movement 的非上級單位；其他參戰單位保留於清單，標示「當期位置資料不足」。這是保守的顯示規則，不代表沒有路徑的部隊不存在或沒有參戰。推估路徑仍不是精確部署。

Demo：載入 `examples/v0.4.0/busan.json` 後按 Play。九月攻勢分戰區介紹，另有永川反擊後向北追擊的低信心代表路徑。此例仍沒有可靠戰線快照，也沒有可核實的全軍撤退路線；介面明示缺口，不自動補造。新增資料依 [Great Naktong Offensive](https://en.wikipedia.org/wiki/Great_Naktong_Offensive) 的戰區敘述與 Yongch'on 節；永川追擊終點按「以北約 13 公里」推估，不是史料座標。

Use **Focus event** to center the map. When a single event has usable geography, a `camera` hint with both `center` and `zoom` takes priority. **Modern borders** are off by default, are not historical borders, and use the road-free World Hillshade / Natural Earth reference layer.

When a single event has usable geography, a camera hint with both `center` and `zoom` takes priority.

航跡預設關閉；關閉時不顯示 movement 路徑。開啟後只顯示當前 movement（只顯示當前 movement），完成後淡出。事件使用 active-only 脈衝信標，相近事件會合併顯示數量。

來源圖上的戰線幾何可在來源錨點之間沿目標輪廓延伸，但中間形狀不表示來源提供了中間合圍路徑，只在後一個錨點完全閉合；拖曳、反向跳轉與減少動態效果時不播放額外揭示效果。

The Natural Earth administrative-border asset is pinned to commit `ca96624a56bd078437bca8184e78163e5039ad19`:
`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_0_countries.geojson`

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
    "source_system": "wikipedia"
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

Use the [Battle JSON generation prompt](docs/battle-json-prompt.md) to ask an AI model to generate a new battle document.

The prompt is maintained separately from this README so the repository landing page can stay focused on the project itself. It emphasizes schema correctness, source traceability, conservative inference, and the distinction between source-backed frontline snapshots and runtime-derived visualization.

After generation, validate the result:

```bash
python3 -m battle_animation.validator path/to/your-battle.json
```

Fix schema, field-name, or reference errors until the validator prints `valid:`.

## Validate bundled examples

```bash
python3 -m battle_animation.validator examples/v0.1.0/battle-of-waterloo.json
python3 -m battle_animation.validator examples/v0.1.0/battle-of-甲午.json
python3 -m battle_animation.validator examples/v0.3.0/battle-of-甲午海戰.json
python3 -m battle_animation.validator examples/v0.4.0/battle-of-stalingrad-frontlines.json
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

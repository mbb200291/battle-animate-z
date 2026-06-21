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

## Generate JSON With AI

Copy this prompt when asking an AI model to generate a battle JSON from a Wiki page:

```text
你是一個歷史資料標準化助理。請根據我提供的 Wikipedia / Wikidata / Wiki 頁面內容，產生符合 battle-animation-schema v0.1.0 的 JSON。

任務目標：
把這場戰役整理成可供地圖動畫 app 使用的標準 JSON。

輸出要求：
1. 只輸出 JSON，不要 Markdown，不要解釋。
2. JSON 必須符合 battle-animation-schema v0.1.0。
3. 不要編造不存在於資料來源的細節。
4. 如果資料不精確，請使用：
   - precision: "approximate" / "inferred" / "disputed" / "unknown"
   - confidence: 0 到 1 的數字
5. historical_events 只放歷史事件資料。
6. animation_hints 只放動畫渲染提示，不要把它當作史實來源。
7. 地理資料使用 GeoJSON subset：
   - Point
   - LineString
   - Polygon
   coordinates 必須使用 [longitude, latitude]。
8. timeline event type 只能使用：
   - advance
   - retreat
   - attack
   - defend
   - capture
   - surrender
   - reinforcement
   - bombardment
   - landing
   - other
9. movement path 如果來源沒有明確路線，可以根據地點推估，但必須標記：
   - precision: "inferred"
   - confidence <= 0.6
10. 所有 source_ids 必須對應 sources 裡的 id。

請產生以下欄位：
- schema_version
- metadata
- battle
- sides
- commanders
- actors
- places
- historical_events
- movements
- outcome
- sources
- animation_hints

資料來源：
[貼上 Wikipedia / Wikidata / Wiki 頁面文字、表格、URL 或摘要]

指定戰役：
[例如：Battle of Waterloo]

補充限制：
- actors 優先使用 army / corps / division / unit 等粗粒度單位。
- 不要做完整軍事模擬。
- 不要推導火力、補給、士氣、傷害計算。
- 如果只能知道大概位置，就建立 approximate Point。
- 如果事件順序明確但時間不精確，time.precision 使用 "day" 或 "unknown"，並在 label 裡保留原文描述。

建議流程：
第一階段先請 AI 抽取草稿：

先不要輸出最終 JSON。請先列出你能從來源中確認的：
1. battle basic info
2. sides / belligerents
3. commanders
4. actors / units
5. places with coordinates
6. timeline events
7. possible movements
8. outcome
9. sources
並標記每一項的 precision 與 confidence。

第二階段再生成 JSON：

根據上一步抽取結果，產生完整 battle-animation-schema v0.1.0 JSON。
只輸出 JSON。

品質檢查：

請檢查這份 JSON 是否符合 battle-animation-schema v0.1.0：

檢查項目：
1. 是否是合法 JSON。
2. 是否缺少必要欄位。
3. event type 是否只使用允許 enum。
4. 所有 *_ids 是否能對應到實際 id。
5. coordinates 是否為 [longitude, latitude]。
6. historical_events 是否混入 animation hints。
7. animation_hints 是否混入史實斷言。
8. Wiki 不精確資料是否有 precision/confidence。
9. movements 是否把推估路線標為 inferred 且 confidence <= 0.6。

請輸出：
- problems: array
- suggested_fixes: array
- corrected_json: 如果沒有問題則原樣輸出
```

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

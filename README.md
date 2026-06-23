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

Use this prompt to ask an AI model to generate a battle JSON from a wiki page. It is written to avoid the most common mistakes (wrong field names, extra fields, missing side colors, movements with no `event_id`, and wrapping the output in a quality-check object).

````text
你是一個歷史資料標準化助理。請根據我提供的 Wikipedia / Wikidata / Wiki 頁面內容，產生「完全符合」 battle-animation-schema v0.1.0 的 JSON，供地圖動畫 app 使用。

===== 最重要的輸出規則（違反任何一條都算失敗）=====
1. 只輸出「一個 JSON 物件」，不要 Markdown、不要程式碼框、不要任何解說文字。
2. 最外層物件必須包含這 12 個必備 key（名稱與順序如下）：
   schema_version, metadata, battle, sides, commanders, actors, places,
   historical_events, movements, outcome, sources, animation_hints
   若提供逐單位交戰細節，可再加 1 個選填 key：engagements。除上述以外不要有其他 key。
3. 絕對不要輸出 problems / suggested_fixes / corrected_json 這種檢查用包裝物件。
   要直接輸出最終 JSON 本體。
4. schema_version：基本資料用字串 "0.1.0"；若使用 engagements 或 ship 等精細欄位，請用 "0.2.0"。
   （不要寫成 "v0.1.0" 或數字。）
5. 整份 schema 的每個物件都是 additionalProperties:false：
   「只能使用下方列出的欄位名稱，多出任何一個欄位都會驗證失敗。」
   不要自行新增 type / role / source_ids / precision / notes / language 等未列出的欄位。

===== 各物件的「合法欄位」（required 標 *，其餘為選填）=====
metadata: *id *title *created_at *updated_at *license *source_system, wikidata_qid
battle: *id *name *part_of *date *summary *confidence, also_known_as
  - date 是物件：*label *precision *confidence, start, end
  - 不要用 start_date / end_date；改用 date.start / date.end（字串），或只放 date.label。
sides[]: *id *name *color *belligerents
  - color 必填，且雙方要用「對比明顯」的十六進位顏色（例如 "#2f6fb5" 藍 與 "#c0392b" 紅）。
  - belligerents[] 每項：*id *name, wikidata_qid
commanders[]: *id *name *side_id *confidence, rank_or_role, wikidata_qid
  - 職稱請放 rank_or_role（不要用 role）。
actors[]: *id *name *side_id *kind *confidence, parent_id, commander_ids, strength
  - kind 只能是：army, corps, division, brigade, regiment, fleet, ship, unit, person, other（不要用 type）。
  - 精細到個別軍艦/單位時 kind 用 "ship" 等，並可用 parent_id 指向所屬上級 actor（例如某艦隊）。
  - strength 是物件：label, min, max, confidence（數字放 min/max，文字放 label；不要用 value/unit）。
places[]: *id *name *geometry *precision *confidence, wikidata_qid
  - geometry 用 GeoJSON 子集：Point / LineString / Polygon，coordinates 一律 [longitude, latitude]。
historical_events[]: *id *type *title *time *description *actor_ids *place_ids *precision *confidence *source_ids, target_actor_ids
  - type 只能是：advance, retreat, attack, defend, capture, surrender, reinforcement, bombardment, landing, other
  - title 是短標題；description 放完整敘述；time 是物件：*label *precision *confidence, start, end
movements[]: *id *event_id *actor_id *path *precision *confidence, from_place_id, to_place_id
  - 每個 movement 都「必須」有 event_id，對應到某個 historical_events.id（否則動畫不會顯示這段移動）。
  - path 是 LineString：{"type":"LineString","coordinates":[[lon,lat],...]}（至少 2 個點）。
  - 推估路線：precision 設 "inferred"，confidence <= 0.6。
engagements[]（選填，但強烈建議提供；用來表現「誰打誰、結果如何」）:
  *id *event_id *attacker_actor_id *target_actor_id *type *confidence, result, result_actor_id, at_place_id, time, source_ids
  - type 只能是：fire, bombardment, ram, torpedo, charge, melee, other
  - result 只能是：hit, miss, damaged, disabled, sunk, repelled, captured, none
  - event_id 對應某個 historical_events.id（交火會在該事件顯示）。
  - 當 result 為 sunk / disabled / captured，用 result_actor_id 指出「被擊沉／失能的是哪個 actor」（不填則預設為 target）。
outcome: *summary *winner_side_ids *confidence *source_ids, casualties
  - winner_side_ids 是陣列（不要用 winner_side_id 單數）。
  - casualties[] 每項：*side_id *label *confidence, min, max
sources[]: *id *title *url *retrieved_at *license, note
  - 用 retrieved_at（不要用 accessed_at）；不要放 type。
animation_hints: *map *style *timeline, camera
  - map: *initial_center *initial_zoom, bounds_padding（initial_center 為 [lon,lat]）
  - style: side_colors, actor_icons, event_icons, movement_line_width
  - timeline: default_event_duration_ms, ordered_event_ids（請依時間順序列出所有事件 id）
  - camera[] 每項：*event_id *center, zoom（center 為 [lon,lat]）
  - animation_hints 只放渲染提示，不要在裡面放任何史實斷言或 source。

===== 顏色與圖示（讓動畫更清楚）=====
- 為每個 side 指定對比明顯的 color，並在 animation_hints.style.side_colors 重複一份（key 用 side id）。
- 為每個 actor 在 animation_hints.style.actor_icons 指定一個適當圖示（key 用 actor id）。
  請依兵種推薦最貼切的 emoji，例如：
    艦隊 / 軍艦 / 水師 → 🚢，運輸船 → ⛵，陸軍 / 步兵 → 🪖，騎兵 → 🐎，
    砲兵 → 💥，裝甲 / 戰車旅 → 🛡️，航空 → ✈️，要塞 → 🏰，司令部 → 🚩
  也可以填入 ship / cavalry / artillery / tank 等英文名稱，app 會轉成圖示。
- 由你判斷每個單位最合適的圖示並主動指定，不要全部留空。

===== 精細度（資料越細，動畫越精緻）=====
動畫的細緻程度完全取決於你提供多少資料。請盡量做到：
1. 把關鍵單位拆細：海戰拆到主要軍艦、陸戰拆到師／旅／團級，各自當一個 actor
   （kind 用 ship / division / brigade…），需要時用 parent_id 歸到上級單位。
2. 給每個關鍵單位「分階段的位置與移動」：用多個 historical_events 切出戰役階段
   （遭遇、開火、包抄、混戰、追擊、撤退…）；每個階段為有移動的單位各補一條 movements
   （帶對應的 event_id）。單位起始位置可由它的第一條 movement 或事件地點推得。
3. 用 engagements 記錄對抗：哪個單位打哪個、用什麼方式、結果如何。app 會在對應事件
   畫出交火線，並讓被擊沉／失能的單位淡出。
4. 讓事件分散在不同 place：不要把所有事件都掛在同一個粗略地點，否則標記會疊在一起；
   可為不同階段建立各自的近似 Point（標 inferred + 低 confidence）。

資料來源不限於單一 wiki 條目 —— 可彙整其他百科、條目章節、戰役專文等；也允許你「合理推估」
相對位置與隊形。但凡屬推估，務必標 precision:"inferred" 且 confidence 偏低（例如 <= 0.5），
史實明確者才給高 confidence。寧可多給細節（多 actor／event／movement／engagement）再以
低 confidence 標記，也不要因為怕出錯而整段省略。

===== 資料正確性 =====
- 不要編造來源中沒有的細節。資料不精確時用 precision（approximate/inferred/disputed/unknown）與 confidence（0~1）標記。
- 所有 *_id / *_ids 必須對應到實際存在的 id。
- 地點若只能大概定位，就用 approximate 的 Point。

===== 輸出格式範本（請完全比照這個結構與欄位輸出，只替換內容）=====
{
  "schema_version": "0.1.0",
  "metadata": { "id": "battle_example", "title": "範例戰役", "created_at": "2026-06-22", "updated_at": "2026-06-22", "license": "CC BY-SA 4.0", "source_system": "ai_extraction_zhwiki" },
  "battle": { "id": "battle_example", "name": "範例戰役", "also_known_as": ["別名"], "part_of": "某場戰爭", "date": { "label": "1894-09-15", "start": "1894-09-15", "precision": "day", "confidence": 0.9 }, "summary": "一句話說明這場戰役。", "confidence": 0.85 },
  "sides": [
    { "id": "side_a", "name": "甲方", "color": "#2f6fb5", "belligerents": [{ "id": "bel_a", "name": "甲國" }] },
    { "id": "side_b", "name": "乙方", "color": "#c0392b", "belligerents": [{ "id": "bel_b", "name": "乙國" }] }
  ],
  "commanders": [ { "id": "cmd_a", "name": "甲方指揮官", "side_id": "side_a", "rank_or_role": "司令", "confidence": 0.8 } ],
  "actors": [
    { "id": "actor_a_fleet", "name": "甲方艦隊", "side_id": "side_a", "kind": "fleet", "commander_ids": ["cmd_a"], "strength": { "label": "12 艘軍艦", "min": 12, "max": 12, "confidence": 0.7 }, "confidence": 0.8 },
    { "id": "actor_b_army", "name": "乙方陸軍", "side_id": "side_b", "kind": "army", "confidence": 0.8 }
  ],
  "places": [
    { "id": "place_harbor", "name": "某港", "geometry": { "type": "Point", "coordinates": [122.1, 39.0] }, "precision": "approximate", "confidence": 0.7 },
    { "id": "place_ridge", "name": "某高地", "geometry": { "type": "Point", "coordinates": [123.4, 38.6] }, "precision": "approximate", "confidence": 0.7 }
  ],
  "historical_events": [
    { "id": "evt_attack", "type": "attack", "title": "海上交戰", "time": { "label": "1894-09-15 上午", "start": "1894-09-15", "precision": "day", "confidence": 0.9 }, "description": "甲方艦隊在某港外與乙方交戰。", "actor_ids": ["actor_a_fleet"], "place_ids": ["place_harbor"], "precision": "approximate", "confidence": 0.85, "source_ids": ["src_wiki"] },
    { "id": "evt_advance", "type": "advance", "title": "乙方陸軍推進", "time": { "label": "1894-09-16", "start": "1894-09-16", "precision": "day", "confidence": 0.8 }, "description": "乙方陸軍向某高地推進。", "actor_ids": ["actor_b_army"], "place_ids": ["place_ridge"], "precision": "inferred", "confidence": 0.6, "source_ids": ["src_wiki"] }
  ],
  "movements": [
    { "id": "mov_b_advance", "event_id": "evt_advance", "actor_id": "actor_b_army", "from_place_id": "place_harbor", "to_place_id": "place_ridge", "path": { "type": "LineString", "coordinates": [[122.1, 39.0], [123.4, 38.6]] }, "precision": "inferred", "confidence": 0.55 }
  ],
  "outcome": { "summary": "乙方獲勝。", "winner_side_ids": ["side_b"], "casualties": [{ "side_id": "side_a", "label": "約 500 人", "min": 400, "max": 600, "confidence": 0.6 }], "confidence": 0.85, "source_ids": ["src_wiki"] },
  "sources": [ { "id": "src_wiki", "title": "維基百科條目", "url": "https://zh.wikipedia.org/wiki/...", "retrieved_at": "2026-06-22", "license": "CC BY-SA 4.0" } ],
  "animation_hints": {
    "map": { "initial_center": [122.8, 38.8], "initial_zoom": 7, "bounds_padding": 0.05 },
    "style": {
      "side_colors": { "side_a": "#2f6fb5", "side_b": "#c0392b" },
      "actor_icons": { "actor_a_fleet": "🚢", "actor_b_army": "🪖" },
      "event_icons": { "attack": "burst", "advance": "arrow-up-right" },
      "movement_line_width": 4
    },
    "timeline": { "default_event_duration_ms": 1600, "ordered_event_ids": ["evt_attack", "evt_advance"] },
    "camera": [{ "event_id": "evt_advance", "center": [123.4, 38.6], "zoom": 9 }]
  }
}

===== 資料來源 =====
[貼上 Wikipedia / Wikidata / Wiki 頁面文字、表格、URL 或摘要]

===== 指定戰役 =====
[例如：Battle of Waterloo]

請依照上面的「輸出格式範本」結構，只替換成這場戰役的真實內容，直接輸出最終 JSON 物件。
````

After generating, validate the document before loading it into the app:

```bash
python3 -m battle_animation.validator path/to/your-battle.json
```

Fix any reported field-name or reference errors until it prints `valid:`.

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

The app renders battle data over a Leaflet + OpenStreetMap basemap (map tiles require network access). It draws places, units, movement paths, and event markers as an SVG overlay, then plays the ordered timeline with playback, scrubber, and keyboard (arrow keys / space) controls.

To animate your own data, load a different document with the **Load JSON file** button, the **Paste JSON…** dialog, or by dragging a `.json` file onto the map. The document is validated in the browser first; reference or schema errors are listed inline instead of rendering.

## MVP Boundaries

This format is designed for extraction and animation, not simulation. In version `0.1.0`:

- actors are coarse units such as armies, corps, divisions, or named units;
- movement paths may be inferred and should carry low confidence where appropriate;
- strengths and casualties may use ranges and text labels;
- source records point back to Wikipedia, Wikidata, or other public references;
- animation hints are optional guidance for renderers and should never replace source-backed historical data.

# Battle Animation Schema

This project defines a small, stable JSON format for battle data that can be extracted from Wikipedia, Wikidata, and similar public sources, then used by downstream apps to generate map animations.

The format intentionally avoids military simulation standards such as MSDL or C-BML. It records source-backed historical facts and lightweight rendering hints without modeling command logic, firepower, supply, or tactical rules.

## Files

- `schemas/battle-animation-schema.json` defines `battle-animation-schema` versions `0.1.0`, `0.2.0`, and `0.3.0`; `0.3.0` adds timed movement tracks and historical-time playback hints.
- `battle_animation/types.py` provides Python `TypedDict` definitions matching the schema.
- `examples/battle-of-waterloo.json` and `examples/battle-of-甲午.json` exercise legacy fallback; `examples/battle-of-甲午海戰.json` is the timed, ship-level `0.3.0` demonstration.
- `battle_animation/validator.py` validates schema fields, internal references, movement timing, controlled icon tokens, and recoverable warnings.
- `app/timeline.js` compiles historical timestamps, idle compression, and legacy synthetic timing into a deterministic presentation timeline.
- `app/symbols.js` owns the controlled SVG unit-symbol catalog and kind-based legacy fallback.
- `app/index.html` and `app/animate.js` provide continuous playback, scrubbing, speed controls, camera follow, and inline validation diagnostics.

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
你是一個歷史資料標準化助理。請根據我提供的 Wikipedia / Wikidata / Wiki 頁面內容，產生「完全符合」 battle-animation-schema v0.1.0／v0.2.0／v0.3.0 的 JSON，供地圖動畫 app 使用。

===== 最重要的輸出規則（違反任何一條都算失敗）=====
1. 只輸出「一個 JSON 物件」，不要 Markdown、不要程式碼框、不要任何解說文字。
2. 最外層物件必須包含這 12 個必備 key（名稱與順序如下）：
   schema_version, metadata, battle, sides, commanders, actors, places,
   historical_events, movements, outcome, sources, animation_hints
   若提供逐單位交戰細節，可再加 1 個選填 key：engagements。除上述以外不要有其他 key。
3. 絕對不要輸出 problems / suggested_fixes / corrected_json 這種檢查用包裝物件。
   要直接輸出最終 JSON 本體。
4. schema_version：基本資料使用 "0.1.0"；engagements／ship／parent_id 使用 "0.2.0"；
   使用 movement.time、waypoint_times 或歷史比例時間軌時請用字串 "0.3.0"。
   schema_version：使用精細時間軌時請用字串 "0.3.0"。（不要加 `v`，也不要寫成數字。）
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
  - 來源明確記載到個別軍艦/單位時 kind 才用 "ship" 等，並可用 parent_id 指向來源支持的所屬上級 actor（例如某艦隊）。
  - strength 是物件：label, min, max, confidence（數字放 min/max，文字放 label；不要用 value/unit）。
places[]: *id *name *geometry *precision *confidence, wikidata_qid
  - geometry 用 GeoJSON 子集：Point / LineString / Polygon，coordinates 一律 [longitude, latitude]。
historical_events[]: *id *type *title *time *description *actor_ids *place_ids *precision *confidence *source_ids, target_actor_ids
  - type 只能是：advance, retreat, attack, defend, capture, surrender, reinforcement, bombardment, landing, other
  - title 是短標題；description 放完整敘述；time 是物件：*label *precision *confidence, start, end
movements[]: *id *event_id *actor_id *path *precision *confidence, from_place_id, to_place_id, time, waypoint_times
  - 每個 movement 都「必須」有 event_id，對應到某個 historical_events.id（否則動畫不會顯示這段移動）。
  - path 是 LineString：{"type":"LineString","coordinates":[[lon,lat],...]}（至少 2 個點）。
  - time 使用與 historical_events.time 相同結構。
  - waypoint_times 的數量必須與 path.coordinates 完全相同，且時間嚴格遞增；每個時間必須落在 movement.time 範圍內。
  - 只有在來源已確認事件確實發生及先後順序時，才能推估代表性路徑或時間；movement 必須標 precision:"inferred"，time.precision 使用 hour／range 等時間粒度，且 time.confidence <= 0.6。
engagements[]（選填；只有來源明確支持「誰打誰、結果如何」時才提供）:
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
  - timeline: default_event_duration_ms, ordered_event_ids, historical_seconds_per_playback_second, idle_compression_threshold_seconds, idle_compressed_duration_ms（請依時間順序列出所有事件 id）
  - camera[] 每項：*event_id *center, zoom（center 為 [lon,lat]）
  - animation_hints 只放渲染提示，不要在裡面放任何史實斷言或 source。

===== 顏色與圖示（讓動畫更清楚）=====
- 為每個 side 指定對比明顯的 color，並在 animation_hints.style.side_colors 重複一份（key 用 side id）。
- 為每個 actor 在 animation_hints.style.actor_icons 指定一個適當的受控名稱（key 用 actor id）。
- actor_icons 只能使用以下 21 個受控名稱：
  warship_generic, warship_ironclad, warship_battleship,
  warship_armored_cruiser, warship_protected_cruiser, warship_destroyer,
  warship_torpedo_boat, naval_transport, fleet_generic, infantry, cavalry,
  artillery, armor, engineer, logistics, headquarters, fortress, aircraft,
  aircraft_fighter, aircraft_bomber, unit_generic。
- 不要輸出 Emoji、SVG、data URL 或詞彙表以外的名稱；不確定時使用同類 generic token（船艦用 warship_generic、艦隊用 fleet_generic、其他用 unit_generic）。
- 依來源記載為每個單位選擇受控名稱。例如來源明載 protected cruiser 時可用 warship_protected_cruiser；來源未支持細分類時使用同類 generic token，不要只因外形相近就套用。

===== 精細度（以來源支持為上限）=====
動畫細緻度取決於來源可支持的粒度，而不是欄位數量。請做到：
1. 只把來源明確記載的關鍵單位拆細：海戰可採船艦級，陸戰在來源允許時採師／旅級（必要時到團級），各自當一個 actor
   （kind 用 ship / division / brigade…），需要時用 parent_id 歸到上級單位。
2. 針對來源明確記載的戰役階段，給關鍵單位分階段的位置與移動；每個已記載階段為有移動的單位
   補一條 movements（帶對應的 event_id）。不要為了讓動畫連續而新增來源未記載的階段或行動。
3. 來源明確記載對抗雙方與結果時，才用 engagements 記錄哪個單位打哪個、用什麼方式、結果如何。app 會在對應事件
   畫出交火線，並讓被擊沉／失能的單位淡出。
4. 對來源已確認發生及先後順序的事件，可為不同階段建立代表性近似 Point 以避免標記重疊，
   但必須標 inferred + 低 confidence；不得為了畫面效果新增事件。
5. 陸上師／旅的 Point 或 movement 座標是該時刻的代表位置，不是該單位的精確空間範圍；
   不要把單一座標解讀成整個陣地、正面寬度或精確 footprint。

資料來源不限於單一 wiki 條目，可彙整其他百科、條目章節與戰役專文。推估僅限於代表性幾何與時間，
而且來源已確認事件確實發生及先後順序；凡屬推估，務必標 precision:"inferred" 且 confidence 偏低
（例如 <= 0.5）。沒有來源支持的 actor、engagement、result 或艦種／兵種分類必須省略，
不得用低 confidence 包裝臆測內容。

===== 資料正確性 =====
- 不要編造來源中沒有的細節。資料不精確時用 precision（approximate/inferred/disputed/unknown）與 confidence（0~1）標記。
- `inferred` 只表達來源支持事件之代表性位置、路徑或時間，不代表可以推造未記載的單位、交戰、結果或分類。
- 所有 *_id / *_ids 必須對應到實際存在的 id。
- 地點若只能大概定位，就用 approximate 的 Point。

===== 輸出格式範本（請完全比照這個結構與欄位輸出，只替換內容）=====
{
  "schema_version": "0.3.0",
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
    { "id": "evt_advance", "type": "advance", "title": "乙方陸軍推進", "time": { "label": "1894-09-16 08:00–09:00", "start": "1894-09-16T08:00:00", "end": "1894-09-16T09:00:00", "precision": "range", "confidence": 0.5 }, "description": "乙方陸軍向某高地推進；座標是師級單位的代表位置，不代表精確部署範圍。", "actor_ids": ["actor_b_army"], "place_ids": ["place_ridge"], "precision": "inferred", "confidence": 0.5, "source_ids": ["src_wiki"] }
  ],
  "movements": [
    { "id": "mov_b_advance", "event_id": "evt_advance", "actor_id": "actor_b_army", "from_place_id": "place_harbor", "to_place_id": "place_ridge", "path": { "type": "LineString", "coordinates": [[122.1, 39.0], [122.7, 38.8], [123.4, 38.6]] }, "precision": "inferred", "confidence": 0.5, "time": { "label": "1894-09-16 08:00–09:00", "start": "1894-09-16T08:00:00", "end": "1894-09-16T09:00:00", "precision": "range", "confidence": 0.5 }, "waypoint_times": ["1894-09-16T08:00:00", "1894-09-16T08:30:00", "1894-09-16T09:00:00"] }
  ],
  "outcome": { "summary": "乙方獲勝。", "winner_side_ids": ["side_b"], "casualties": [{ "side_id": "side_a", "label": "約 500 人", "min": 400, "max": 600, "confidence": 0.6 }], "confidence": 0.85, "source_ids": ["src_wiki"] },
  "sources": [ { "id": "src_wiki", "title": "維基百科條目", "url": "https://zh.wikipedia.org/wiki/...", "retrieved_at": "2026-06-22", "license": "CC BY-SA 4.0" } ],
  "animation_hints": {
    "map": { "initial_center": [122.8, 38.8], "initial_zoom": 7, "bounds_padding": 0.05 },
    "style": {
      "side_colors": { "side_a": "#2f6fb5", "side_b": "#c0392b" },
      "actor_icons": { "actor_a_fleet": "fleet_generic", "actor_b_army": "infantry" },
      "event_icons": { "attack": "burst", "advance": "arrow-up-right" },
      "movement_line_width": 4
    },
    "timeline": { "default_event_duration_ms": 1600, "ordered_event_ids": ["evt_attack", "evt_advance"], "historical_seconds_per_playback_second": 120, "idle_compression_threshold_seconds": 900, "idle_compressed_duration_ms": 1200 },
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

Run the validator against all bundled examples:

```bash
python3 -m battle_animation.validator examples/battle-of-waterloo.json
python3 -m battle_animation.validator examples/battle-of-甲午.json
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
```

Each command should print `valid:`. The canonical timed Yalu example should produce no warnings.

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

The app renders battle data over a Leaflet + OpenStreetMap basemap (map tiles require network access). Version `0.3.0` uses continuous historical-time playback（連續歷史時間播放）to interpolate each actor along timed waypoints instead of jumping between events. Long inactive gaps use idle compression（閒置時間壓縮）without changing the historical clock. The transport provides play/pause, a continuous scrubber, `0.5×`/`1×`/`2×`/`4×` speed controls, follow-camera control, and keyboard controls (arrow keys / space).

地圖疊加效果保持短暫且可控：航跡預設關閉；關閉時只顯示當前 movement，開啟後才會逐步揭示並淡出已完成航跡。事件使用 active-only 脈衝信標，相近事件會合併顯示數量。系統偏好減少動態效果時，完成的航跡與結束的信標會立即移除。

Actor icons are controlled SVG tokens rendered as clear, top-down naval silhouettes or standard land/air symbols. A `0.3.0` document should provide only catalog tokens. Legacy `0.1.0` and `0.2.0` documents remain supported: missing historical timing receives a deterministic synthetic animation timeline, while missing or legacy icon values fall back by actor kind to a controlled SVG symbol.

To animate your own data, load a different document with the **Load JSON file** button, the **Paste JSON…** dialog, or by dragging a `.json` file onto the map. The document is validated in the browser first; reference or schema errors are listed inline instead of rendering.

## Format Boundaries and Unit Granularity

This format is designed for extraction and animation, not simulation. Across versions `0.1.0`, `0.2.0`, and `0.3.0`:

- naval battles should use ship-level actors（船艦級）for important vessels where sources permit;
- land battles should use division- or brigade-level actors（師／旅級）and representative positions where sources permit, rather than being restricted to coarse army-level markers;
- a land coordinate is a representative position, not the formation's exact footprint, frontage, or occupied polygon;
- movement paths may be inferred and should carry low confidence where appropriate;
- strengths and casualties may use ranges and text labels;
- source records point back to Wikipedia, Wikidata, or other public references;
- animation hints are optional guidance for renderers and should never replace source-backed historical data.

# 戰線與控制區動畫設計

日期：2026-07-24

## 目標

在陸戰與登陸戰動畫中呈現戰線推進、後退、突出、斷裂、合圍，以及雙方控制區域的擴張與收縮。

正式呈現以來源支持的完整時間快照為主。資料不足時，renderer 可以依陸上作戰單位位置產生低信心的視覺 fallback，但不得把推算結果寫回歷史 JSON，也不得將其呈現為來源支持的史實。

本功能不建立兵力、火力、補給、士氣、地形通行或作戰結果模型。

## 適用範圍

- 支援陸戰。
- 支援登陸戰中的灘頭堡與上陸後陸上戰線。
- 海岸線本身不是戰線；只有實際接敵的灘頭內陸邊界才畫為戰線。
- 純海戰與空戰不產生連續戰線或控制區。
- 舊 `0.1.0`、`0.2.0`、`0.3.0` 文件保持可讀，沒有戰線資料時仍可正常播放。

## 方案選擇

### 採用：完整快照為主

每個關鍵時間點提供完整戰線與控制區。相鄰快照幾何相容時平滑插值；分裂、合併或無法安全配對時淡出／淡入。

優點是資料可獨立引用來源、容易驗證，也不需要 renderer 維護局部線段更新的複雜拓撲。

### Fallback：單位影響區

只有在當下沒有任何可用的正式快照時，renderer 才依陸上單位位置產生低信心影響區及推定接觸線。此結果只存在於畫面，不進入 JSON。

### 不採用：局部線段事件

不讓事件逐段改寫既有戰線。此方案需要處理線段接合、斷裂、包圍圈、事件順序與拓撲修復，第一版成本高且容易產生不一致狀態。

## Schema 0.4.0

新增選填的頂層 `frontline_snapshots[]`。`schema_version` 新增 `"0.4.0"`；舊版本不允許此欄位。

### FrontlineSnapshot

```json
{
  "id": "front_1942_11_19",
  "time": {
    "label": "1942-11-19",
    "start": "1942-11-19",
    "precision": "day",
    "confidence": 0.85
  },
  "event_id": "event_operation_start",
  "front_lines": [
    {
      "id": "front_main",
      "geometry": {
        "type": "LineString",
        "coordinates": [[43.1, 49.2], [44.0, 48.9]]
      }
    }
  ],
  "control_areas": [
    {
      "id": "area_side_a_main",
      "side_id": "side_a",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[42.5, 49.8], [44.0, 49.5], [44.0, 48.9], [42.5, 49.0], [42.5, 49.8]]]
      }
    }
  ],
  "precision": "approximate",
  "confidence": 0.8,
  "source_ids": ["source_operational_map"]
}
```

合法欄位：

- `id`：required，沿用專案 Identifier。
- `time`：required，沿用既有 BattleTime。
- `event_id`：optional，對應造成或描述該戰線狀態的 historical event。
- `front_lines`：optional array，至少一項；每項只有 `id` 與 required `geometry: LineString`。
- `control_areas`：optional array，至少一項；每項只有 `id`、`side_id` 與 required `geometry: Polygon`。
- `precision`：required，沿用既有 Precision。
- `confidence`：required，沿用既有 Confidence。
- `source_ids`：required，至少一個 source。

`front_lines` 與 `control_areas` 至少一者存在。所有物件維持 `additionalProperties: false`。

### 穩定 ID 與配對

- 相鄰快照中相同的 line `id` 代表同一條戰線。
- 相鄰快照中相同的 area `id` 代表同一個連續控制區。
- 戰線分裂後使用新的 line IDs；合併後也使用新的 ID。
- 不連續控制區以多個 area objects 表達，不新增 MultiPolygon。
- 多個獨立戰區以多個 line objects 表達，不新增 MultiLineString。

### Reference validation

- `event_id` 必須解析至 `historical_events[].id`。
- `control_areas[].side_id` 必須解析至 `sides[].id`。
- `source_ids[]` 必須解析至 `sources[].id`。
- snapshot、line 與 area IDs 在各自集合內不得重複。

### 時間規則

- `frontline_snapshots[]` 依有效 historical start time 排序。
- 可播放 snapshot 必須具有可解析的 `time.start`；只有 label 而無可解析時間的 snapshot 不能參與連續插值。
- 每個 snapshot 是該時間點的完整戰線集合；snapshot historical start times 必須嚴格遞增，不接受同時刻的多筆 patch。

## Prompt 1.1.0

README 的生成提示升為 `Battle JSON Prompt 1.1.0`：

- `schema_version` 固定使用 `"0.4.0"`。
- `metadata.source_system` 固定使用 `"battle_json_prompt_1.1.0"`。
- `frontline_snapshots` 是選填，不能為了讓動畫更豐富而虛構。
- 來源提供作戰地圖、逐日戰線、控制區或清楚的空間敘述時，應產生來源支持的快照。
- 來源只確認大致形勢與先後關係時，可以產生 `precision: "inferred"` 的概略快照，但 confidence 必須 `<= 0.5`。
- 不可只根據「突破、包圍、撤退、占領」等文字，自行畫出精細邊界或完整包圍圈。
- 不可從 casualties、strength 或 outcome 推算控制區。
- `source_ids` 必須直接支持該 snapshot；不能只引用整場戰役的泛用來源。
- 若無足夠資料，省略 `frontline_snapshots`，交由 app fallback。
- Prompt 必須解釋 stable line/area IDs 如何跨快照配對。

## Renderer 資料流程

### Timeline integration

timeline compiler 將合法 snapshot 時間編譯成 chronological frontline keyframes。每次 sample 回傳：

- 當下前後兩組 snapshot。
- 兩組之間的 normalized progress。
- 當下是否使用正式 snapshot、來源標示的 inferred snapshot，或 renderer fallback。

有一個 snapshot 時，該狀態持續顯示至戰役結束。相鄰 snapshot 之間依 historical time 插值；閒置時間壓縮只改變 presentation time，不改變 historical progress。

### 幾何相容與插值

- 只配對相同 stable ID。
- LineString 以累積地理線長重新取樣為固定點數。
- Polygon 外環以累積環長重新取樣為固定點數，保持閉合。
- 經度先做局部 unwrap，避免跨越 ±180° 時繞行整張世界地圖。
- 對應點以 historical progress 做線性經緯度插值。
- 第一版只渲染 Polygon 外環；schema 仍保留合法內環，控制區插值若含內環則使用淡入／淡出，不強行配對洞。

預設取樣數屬 renderer 常數，不進 schema。只有實際觀察到曲線品質不足時才提高。

### 拓撲變化

以下情況不做形變：

- stable ID 新增或消失。
- 戰線分裂或合併而更換 ID。
- geometry type 不一致。
- Polygon 環數不一致。
- 幾何無法安全重新取樣。

正常播放時，舊 geometry 在約 500ms 內淡出，新 geometry 同時淡入。scrub、上一／下一事件、reset 與程式化 seek 直接顯示目標時間狀態，不補播轉場。`prefers-reduced-motion: reduce` 時也直接切換。

## 視覺設計

圖層由下至上：

1. 無道路底圖
2. 選填現代國界
3. 戰線控制區
4. 戰線
5. 航跡、事件信標、作戰單位與交戰效果
6. UI controls

### 來源支持的快照

- control area 使用 `side.color` 的低透明度填色。
- frontline 使用相鄰陣營之間可辨識的深色實線及細外框。
- 地圖不重複顯示長來源名稱；完整時間、precision、confidence、sources 放在 inspector。

### 來源標示的 inferred snapshot

- frontline 使用粗虛線。
- 控制區透明度低於來源支持資料。
- 線旁顯示 `推定 · NN%`。
- inspector 顯示來源、推定依據與 confidence。

### Renderer fallback

- 使用更淡的陣營影響區。
- 接觸線使用虛線。
- 顯示 `DERIVED FROM UNIT POSITIONS · ≤35%`。
- 不使用模糊濾鏡作為主要不確定性語意。
- 完整 fallback 說明放入 inspector。

### 控制

- 新增 `Fronts: on/off` 按鈕，使用 `aria-pressed`。
- 有正式快照或可建立 fallback 的陸戰／登陸戰預設開啟。
- 純海戰、純空戰或沒有足夠陸上座標時按鈕停用。
- 關閉戰線不影響播放、Follow、Focus event、Trails、Modern borders、事件信標或單位位置。
- 載入新文件時重新依文件能力決定預設狀態，不持久化前一份文件的選擇。

## Renderer fallback 演算法

### 可用 actors

納入：

- `army`
- `corps`
- `division`
- `brigade`
- `regiment`
- 明確可判定為陸上單位的 `unit`

排除：

- `fleet`
- `ship`
- `person`
- 空中單位
- 只有海上位置的上陸前單位

若 generic `unit` 無法從現有資料可靠判斷為陸上單位，第一版排除，不以名稱文字猜測。

### 影響區

- 每個可用 actor 位置畫固定螢幕半徑的低透明度陣營影響圈。
- 半徑只表示視覺關聯，不表示射程、控制半徑或戰力。
- 同側影響圈不需要執行昂貴的 polygon union；重疊透明圖形自然形成視覺區域。

### 推定接觸線

- 找出不同 side actors 間的 mutual-nearest pairs。
- 排除超過畫面尺度門檻的 pair，避免隔著整個戰區建立假戰線。
- 取各 pair 的地理中點。
- 有至少兩個中點時，依主軸排序後連成虛線。
- 只有一個中點時，畫一條短且垂直於雙方連線的接觸段。
- 沒有有效 pair、只有一方或座標不足時，不畫接觸線，只顯示影響圈。

此演算法不讀 strength、casualties、commander、outcome 或 engagement result。fallback confidence 固定不高於 `0.35`。

## Inspector

事件 inspector 增加當下戰線狀態：

- snapshot time。
- precision 與 confidence。
- 直接 source links。
- 是否由 historical event 連結而來。
- transition 類型：interpolated 或 crossfade。
- fallback 時顯示演算法說明及「非來源支持戰線」警告。

不新增獨立大型浮動卡片，避免遮住地圖。

## 錯誤處理

- 結構、幾何、額外欄位與 reference 錯誤在 Python 與 browser validator 中阻止渲染。
- 結構合法但只有 `time.label`、沒有可解析 `time.start` 的 snapshot 產生 warning 並排除於 animation sampling；非法時間格式仍阻止渲染。
- 個別 geometry 在 runtime 無法重新取樣時，該 geometry 退回 crossfade，不中止整場播放。
- fallback 建立失敗時隱藏 fallback 並停用 Fronts，不影響單位與事件動畫。
- destroy、文件替換與 invalid document 必須清除 frontline SVG、transition state、timeouts、RAF 與 control listeners。

## 元件邊界

### Schema 與 types

- JSON Schema 是 `frontline_snapshots` 結構來源。
- Python `TypedDict` 同步新增 FrontlineSnapshot、FrontLine、ControlArea。
- Python validator 與 browser validator 同步結構及 references。

### Timeline module

負責編譯 snapshot keyframes、時間映射及選出前後狀態，不處理 SVG。

### Frontline geometry module

新增純函式模組，負責：

- geometry validation 後的重新取樣。
- longitude unwrap。
- compatible geometry interpolation。
- fallback mutual-nearest pair 與接觸線計算。

不讀 DOM 或 Leaflet，方便 Node 測試。

### Renderer

負責把 timeline sample 與純幾何結果投影到 SVG、管理 crossfade、layer order、controls 與 inspector。

## 測試與驗收

### Schema 與 validator

- `0.4.0` 接受合法 snapshots。
- 舊版本維持有效且不接受新欄位。
- front_lines／control_areas 至少一者存在。
- duplicate IDs、unknown side/event/source、非法 geometry、額外欄位與無效時間被拒絕或診斷。
- Python、browser validator、types 與 README prompt 保持一致。

### Timeline 與 geometry

- snapshot chronological sampling 與 idle compression mapping 正確。
- stable IDs 正確配對。
- LineString／Polygon 重新取樣與插值可重現。
- dateline unwrap 不繞行世界。
- 新增、消失、分裂、合併及 Polygon holes 退回 crossfade。
- backward seek deterministic。

### Renderer

- 來源支持戰線為實線，inferred／fallback 為虛線與明確標籤。
- control area 在 units 下方且不遮蔽事件互動。
- 正常播放相容 geometry 平滑形變，不相容 geometry crossfade 約 500ms。
- scrub、reset、上一／下一事件不補播轉場。
- reduced motion 無形變或 crossfade。
- Fronts control 預設、停用、切換、文件替換與 teardown 正確。
- 關閉 Fronts 不改變其他 renderer state。

### Fallback

- 只使用允許的陸上 actor kinds。
- 海戰與只有一方時不產生假接觸線。
- mutual-nearest pairs、距離門檻、多中點排序及單中點短線正確。
- 不讀 strength、casualties 或 outcomes。
- confidence 與 `DERIVED FROM UNIT POSITIONS` 標示固定存在。

### 範例與視覺驗收

- 新增一份 `0.4.0` 陸戰或登陸戰範例，至少包含三個快照、一次相容插值及一次分裂／合併 crossfade。
- 既有 Waterloo、甲午舊版範例繼續通過。
- 桌面與手機檢查控制列、inspector、單位可讀性與圖層遮擋。
- 真實瀏覽器檢查 playback、scrub、reduced motion、文件替換與 destroy。

## 不在第一版範圍

- 歷史國界自動生成。
- 地形、河流、道路、補給或工事對戰線的影響。
- 依兵力或傷亡計算控制力。
- 自動判定突破、包圍或戰線崩潰。
- 編輯器或地圖上手繪戰線。
- MultiLineString／MultiPolygon。
- 局部事件線段 patch 語言。
- 將 renderer fallback 寫回 JSON。

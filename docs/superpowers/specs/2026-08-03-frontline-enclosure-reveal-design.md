# 包圍圈揭示過渡設計

日期：2026-08-03

## 問題

目前一般戰線位移會在具有相同 stable ID 的快照間進行幾何插值。這適合同為開放線的推進或後退，但「開放的單邊戰線變成首尾閉合的包圍圈」時，兩個端點會被強行接合，形成明顯不連續的跳轉或扭曲。

JSON 通常只提供包圍前後快照，沒有足夠來源支持中間每一步的實際合圍路徑。因此 renderer 不應自行推導戰線兩端如何包抄。

## 目標

- 一般相容戰線繼續使用直接幾何形變。
- 開放戰線變成閉合包圍圈時，不再強行逐點形變。
- 用視覺揭示表達「新的包圍狀態已建立」，不聲稱中間幾何是史實。
- 時間軸拖曳、跳轉與減少動態效果保持可預測。

## 採用方案

### 一般形變

當前後快照的同 ID LineString 都是開放線，且現有幾何相容檢查通過時，維持現行逐點插值。不增加舊線殘影、方向光點或其他地圖元素。

### 包圍圈揭示

當同 ID LineString 由開放轉為閉合時，使用專用 transition：

1. 舊開放戰線在 350ms 內淡出。
2. 新閉合戰線從其 GeoJSON 第一個點開始，用 SVG `stroke-dasharray` 與 `stroke-dashoffset` 沿整條路徑揭示。
3. 輪廓揭示時間為 900ms，使用 ease-out，結束後移除過渡 class 與內嵌樣式。
4. 若目標快照同時有控制區，控制區在輪廓動畫約 60% 進度後才開始淡入，不在動畫開始時瞬間顯示完整色塊。

該動畫不產生任何中間戰線座標，不修改 JSON，也不把揭示方向解釋為實際合圍方向。

### 其他拓撲變化

戰線分裂、合併、stable ID 更換、閉合轉開放，或幾何無法安全重取樣時，維持現有 500ms crossfade。第一版不為「包圍圈解體」新增反向擦除動畫。

## 閉合判定

- LineString 至少有四個座標，以便表達閉合後的最小非退化輪廓。
- 第一與最後座標經度使用換日線安全差值；經緯差均在小容差內時視為閉合。
- 容差只用於檢測，不改寫來源幾何。
- 後端 schema 與 validators 無需新增欄位；這是 renderer 由現有 LineString 幾何可確定得出的顯示模式。

## Renderer 狀態與生命週期

- `renderAt(presentationMs, { mode })` 繼續是唯一的戰線過渡擁有者。
- 只有 `mode === "playback"` 、從開放線跨至閉合線，且未啟用 reduced motion 時播放揭示。
- seek、scrub、reset、previous/next、初始渲染與 reduced motion 直接顯示目標閉合線，不產生 timer 或過渡 class。
- 關閉 Fronts、取代文件、地圖重投影與 `destroy()` 會取消 timer，移除暫存舊線，並直接收旂到當前目標狀態。
- 同一播放幀若跨過多個 keyframe，以實際上一個已渲染狀態與最後目標狀態判斷；不依賴中間每個動畫必須播放。

## 視覺與可及性

- 沿用當前 source-backed、inferred 與 derived 戰線的顏色、粗細與虛線語意。
- 揭示只改變路徑可見長度與 opacity，不加入光點、模糊或額外地圖標記。
- `prefers-reduced-motion: reduce` 下禁用揭示與控制區延遲。
- 動畫不改變 Inspector 的 precision、confidence、source 或 transition 來源資訊。Inspector 可將此顯示模式簡述為 `Enclosure reveal`。

## 測試與驗收

- 開放→開放：維持同一 keyed SVG 節點並連續形變。
- 開放→閉合：舊線淡出；新線在 900ms 內由不可見到完整輪廓，不進行幾何插值。
- 目標控制區：延遲至輪廓約 60% 後淡入。
- 閉合→開放、分裂、合併：仍為 crossfade。
- seek、倒退、reduced motion：目標幾何立即完整顯示，沒有 timer、dash offset 或過渡 class。
- 連續跨界、地圖 move/zoom、Fronts off、文件取代與 destroy：沒有殘留節點、class 或 timer。
- 閉合檢測覆蓋一般座標、換日線與近似閉合容差。

## 不在範圍

- 不新增 schema 欄位或動畫 hint。
- 不產生歷史中間快照。
- 不計算包抄方向、推進速度、戰力或完成合圍的單位。
- 不為包圍圈加入循環脈衝、粒子或持續閃爍。

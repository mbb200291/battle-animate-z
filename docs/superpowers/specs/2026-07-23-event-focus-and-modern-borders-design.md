# 事件聚焦、無道路底圖與現代國界設計

日期：2026-07-23

## 目標

讓使用者能以一次操作回到當下正在進行的作戰範圍，同時降低現代道路對歷史動畫的干擾。現代國界保留為可選的空間參考，但預設不顯示，避免讓現代政治邊界被誤認為戰役當時的疆界。

本次只改變地圖呈現與鏡頭控制，不修改 `battle-animation-schema`，也不要求資料提供者補充新欄位。

## 控制列

在既有 Follow 與 Trails 控制附近加入兩個按鈕：

- `Focus event`：立即將地圖調整到當下正在進行的事件與相關作戰單位。
- `Modern borders: off/on`：切換現代國界覆蓋層，預設為 `off`。

兩個按鈕都不得改變播放／暫停狀態、時間軸位置、航跡開關、Follow 狀態或單位位置。國界按鈕使用 `aria-pressed`；Focus 在沒有任何可用地理座標時停用。

每次載入或替換戰役文件時，現代國界重設為關閉。本次不持久化使用者偏好。

## Focus event 的取景規則

### 聚焦對象

按下按鈕時，以當下 timeline sample 為準：

1. 收集所有 active historical events 的事件地點。
2. 收集 active events 所引用 actors 的當下插值位置。
3. 收集 active movements 與 engagements 的有效端點。
4. 去除無效座標與重複點。

同時進行的事件全部納入，不只取第一個事件，避免鏡頭把仍在作戰的單位排除在畫面外。

若當下沒有 active event，退回目前選取的 timeline event；仍無有效座標時停用按鈕並保持原視圖。

### 鏡頭優先順序

- 若只有一個 active event，且 `animation_hints.camera[]` 有相同 `event_id` 的有效提示，使用其 `center` 與 `zoom`。
- 其他情況由所有聚焦點計算 bounds，加入約 30% 畫面 padding，再以 `fitBounds` 取景。
- 自動計算的鏡頭設定最大 zoom，避免單點或極短距離造成過度放大；單點無 camera hint 時使用適合區域作戰的預設 zoom。
- 取景只在按下 Focus 時執行，不會取代既有 Follow 的持續追蹤語意。

一般模式使用短暫 `flyTo`／`flyToBounds` 動畫；`prefers-reduced-motion: reduce` 時改用無動畫的 `setView`／`fitBounds`。

聚焦點收集與取景決策應抽成純函式，使 Node 測試不依賴 Leaflet DOM。

## 無道路底圖

移除目前 OpenStreetMap Standard 圖磚，改用低彩度的純地形／陰影地貌底圖：

- 不包含現代道路、鐵路、建築物、商家或地名標籤。
- 保留地形明暗、陸地、海洋與海岸線，讓陸戰與海戰都有基本方位感。
- 戰役 SVG、事件信標、航跡與單位標籤維持在底圖上方。
- 保留資料來源要求的 attribution。

實作採 Leaflet 原生 tile layer，不新增地圖框架或建置依賴。底圖服務失敗時沿用 Leaflet 的空白背景與既有戰役圖層，不自動切回含道路的 OSM Standard。

底圖來源在實作階段選用仍受支援、允許公開網頁使用且可直接供 Leaflet 載入的無道路地形圖磚；不要採用已標示 mature support 或即將淘汰的服務。

## 現代國界覆蓋層

### 資料

使用 Natural Earth 1:50m Admin 0 Countries 的簡化邊界，轉成專案內的 GeoJSON 靜態資產。Natural Earth 資料為 public domain；專案仍在地圖 attribution 中標示來源。

只保留繪製邊界所需的 geometry，不攜帶國名、統計欄位或其他不使用的 properties。這能避免不必要的檔案體積與現代國名標示。

資料表達的是 Natural Earth 發布版本中的現代、de facto 國界；它不是歷史疆界。控制按鈕必須明確使用 `Modern borders`，不可只寫容易誤解的 `Borders`。

### 顯示

- 預設不建立可見國界。
- 開啟時，以單一非互動 Leaflet GeoJSON layer 顯示細、低對比邊界線。
- 不填色、不顯示國名、不接收滑鼠或鍵盤事件。
- layer 位於底圖上方、戰役 SVG 下方。
- 關閉時從 map 移除 layer；再次開啟可重用已載入的 GeoJSON，不重複請求。
- 切換不重新渲染戰役文件，也不重設地圖中心或 zoom。

若 GeoJSON 載入失敗，保持按鈕為關閉並顯示既有的非阻斷式錯誤訊息；播放功能繼續可用。

## 元件與資料流

### `renderBattle`

controller 新增明確的聚焦方法，例如 `focusActiveEvents()`。它使用目前 sample 與既有 actor position 計算結果，不另外建立一套時間模型。

國界圖層屬於 map renderer 的生命週期。controller 提供切換入口或由 app shell 持有切換函式；文件替換與 `destroy()` 時必須移除 layer 與相關 listener。

### App shell

控制列 wiring 沿用既有 Follow／Trails 的 listener 管理方式。重新載入文件時：

- Focus 連到新的 controller。
- Modern borders 回到 off。
- 不累積 click listener。

### 圖層順序

由下至上：

1. 無道路地形底圖
2. 可選的現代國界 GeoJSON
3. 戰役 SVG overlay（航跡、事件、單位與交戰效果）
4. Leaflet 與 app UI controls

## 無障礙與文案

- `Focus event` 具備清楚的 accessible name，停用時使用原生 `disabled`。
- `Modern borders` 使用可見文字與 `aria-pressed` 同步表示狀態。
- 國界線不應降低單位與航跡的色彩對比。
- reduced-motion 模式不播放聚焦飛行動畫。
- 手機窄螢幕下按鈕可換行，不覆蓋時間軸主要操作。

## 測試與驗收

- 新文件載入後 Modern borders 預設關閉，按鈕文字與 `aria-pressed` 一致。
- 開啟／關閉國界只 add/remove 同一圖層，不改變播放時間、單位位置或鏡頭。
- 國界不含 fill、label 與互動事件，並位於戰役 SVG 下方。
- GeoJSON 載入失敗不阻止播放。
- Focus 收集所有 active events、actors、movements 與 engagements 的有效座標。
- 單一事件優先採用 matching camera hint。
- 多事件或無 hint 時使用 padded bounds，且不超過最大自動 zoom。
- 無 active event 時退回目前 timeline event；完全無座標時停用且不移動地圖。
- Focus 不切換 Follow 或播放狀態。
- reduced-motion 下使用無動畫鏡頭切換。
- 文件替換及 `destroy()` 不遺留 layer 或 listener。
- 新底圖不含道路、鐵路、建築、商家或地名，attribution 正確顯示。
- 桌面與手機寬度下控制列仍可操作。

## 不在此次範圍

- 歷史疆界資料與依年代切換的國界。
- 國界爭議區域的立場選擇器。
- 現代國名、城市、道路或行政區標籤。
- 離線圖磚下載或自架圖磚伺服器。
- 新的 schema camera 欄位或自動生成 camera hints。
- 將 Focus 變成持續自動追蹤；持續追蹤仍由 Follow 負責。

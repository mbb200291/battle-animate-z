# Battle JSON Prompt 1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous multi-version README generation prompt with a versioned Prompt `1.0.0` that always emits schema `0.3.0`, records its provenance, maximizes source-supported detail, and refuses unsupported invention.

**Architecture:** Keep the prompt and its example in `README.md`; do not change the JSON schema or runtime. Extend the existing README contract test so prompt-version provenance, evidence boundaries, retrieval safeguards, and the absence of the former contradictory instructions remain executable documentation.

**Tech Stack:** Markdown, Python `unittest`, existing battle document validators.

---

## File Map

- Modify `README.md` — label and revise the complete LLM generation prompt.
- Modify `tests/test_mvp_contract.py` — lock Prompt `1.0.0`, schema `0.3.0`, provenance, source safeguards, and retained controlled vocabularies.

### Task 1: Publish and Verify Battle JSON Prompt 1.0.0

**Files:**
- Modify: `README.md:51-199`
- Modify: `tests/test_mvp_contract.py:394-431`

- [ ] **Step 1: Rewrite the README prompt contract test first**

Replace `test_readme_prompt_teaches_v030_timing_and_tokens()` with:

```python
def test_readme_prompt_v1_teaches_v030_provenance_evidence_and_tokens(self):
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    for required in (
        "Battle JSON Prompt 1.0.0",
        'schema_version 固定使用字串 "0.3.0"',
        '"source_system": "battle_json_prompt_1.0.0"',
        "無法實際讀取 URL",
        "請使用者貼上頁面文字",
        "retrieved_at 必須填寫實際取得資料的日期",
        "confidence <= 0.5",
        "waypoint_times 的數量必須與 path.coordinates 完全相同，且時間嚴格遞增",
        "不要輸出 Emoji、SVG、data URL 或詞彙表以外的名稱",
        "沒有來源支持的 actor、engagement、result 或艦種／兵種分類必須省略",
        '"historical_seconds_per_playback_second": 120',
        '"idle_compression_threshold_seconds": 900',
        '"idle_compressed_duration_ms": 1200',
    ):
        self.assertIn(required, readme)

    for obsolete in (
        "battle-animation-schema v0.1.0／v0.2.0／v0.3.0",
        '基本資料使用 "0.1.0"',
        "confidence <= 0.6",
        '"retrieved_at": "2026-06-22"',
    ):
        self.assertNotIn(obsolete, readme)

    token_paragraph = re.search(
        r"actor_icons 只能使用以下 21 個受控名稱：\n(?P<tokens>.*?unit_generic。)",
        readme,
        re.DOTALL,
    )
    self.assertIsNotNone(token_paragraph)
    documented_token_list = re.findall(
        r"\b[a-z][a-z0-9_]*\b", token_paragraph.group("tokens")
    )
    self.assertEqual(len(documented_token_list), len(ACTOR_ICON_TOKENS))
    self.assertEqual(set(documented_token_list), ACTOR_ICON_TOKENS)
    for stale_emoji in ("🚢", "⛵", "🪖", "🐎", "💥", "🛡️", "✈️", "🏰", "🚩"):
        self.assertNotIn(stale_emoji, readme)
```

Keep `test_readme_embedded_v030_sample_validates_in_python_and_browser()` unchanged so the edited JSON template must still parse and validate in both implementations.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
python3 -m unittest \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v1_teaches_v030_provenance_evidence_and_tokens \
  -v
```

Expected: FAIL because README does not yet contain Prompt `1.0.0`, the provenance marker, or the URL/retrieval safeguards.

- [ ] **Step 3: Revise the prompt header and version rules**

In `README.md`, rename the section:

```markdown
## Generate JSON With AI — Battle JSON Prompt 1.0.0
```

Replace the prompt opening and version-selection rules with:

```text
你是一個歷史資料標準化助理。請根據我提供且你實際可讀取的 Wikipedia、Wikidata 或其他 Wiki 頁面內容，產生一個完全符合 battle-animation-schema 0.3.0 的 JSON，供地圖動畫 app 使用。

本提示詞版本是 Battle JSON Prompt 1.0.0。Prompt 版本與 schema 版本是兩件事：
- schema_version 固定使用字串 "0.3.0"（不要加 v，也不要寫成數字）。
- metadata.source_system 固定使用字串 "battle_json_prompt_1.0.0"，讓文件保留生成規則的版本。
- 0.1.0 與 0.2.0 只供 app 讀取舊文件，不是本提示詞的輸出選項。
```

Keep the single-JSON and legal-field rules, but remove the old conditional rules that selected `0.1.0`, `0.2.0`, or `0.3.0` based on used fields.

- [ ] **Step 4: Make evidence depth and source access explicit**

Before the legal-field section, add:

```text
===== 生成原則：資料充分時做深，資料不足時不要猜 =====
1. 先在內部核對來源涵蓋的單位、事件、時間、位置、交戰與結果，再產生 JSON；不要輸出這份內部核對。
2. 來源若支持個別軍艦或師／旅等單位、分段時間、代表位置與交戰結果，應使用 schema 0.3.0 的 actors、movements、waypoint_times、engagements 完整表達，不要無故降回粗略層級。
3. 精細度以來源為上限。缺少依據的 actor、艦種／兵種、路徑、時間、attacker／target 或 result 必須省略；低 confidence 不能把臆測變成合法資料。
4. inferred 只能用於來源已確認發生及先後順序的事件之代表性幾何或時間，相關 confidence <= 0.5。
```

At the source-input section, add:

```text
若你無法實際讀取 URL，請停止生成並請使用者貼上頁面文字、表格或摘要；不得假裝已讀取 URL，也不得依 URL 標題補寫內容。
retrieved_at 必須填寫實際取得資料的日期（YYYY-MM-DD），不得照抄範例日期。
```

Remove the `<= 0.6` rule so every inferred-confidence instruction uses `<= 0.5`.

- [ ] **Step 5: Update provenance and retrieval date in the JSON template**

Change the template metadata to:

```json
"metadata": { "id": "battle_example", "title": "範例戰役", "created_at": "2026-07-23", "updated_at": "2026-07-23", "license": "CC BY-SA 4.0", "source_system": "battle_json_prompt_1.0.0" }
```

Change the template source date to a visible replacement instruction that remains valid JSON:

```json
"retrieved_at": "YYYY-MM-DD"
```

The prompt text must explicitly tell the generator to replace that value with the actual retrieval date. Do not add `prompt_version` or any other schema property.

- [ ] **Step 6: Run the focused Prompt and embedded-sample tests**

Run:

```bash
python3 -m unittest \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_prompt_v1_teaches_v030_provenance_evidence_and_tokens \
  tests.test_mvp_contract.BattleAnimationMvpContractTest.test_readme_embedded_v030_sample_validates_in_python_and_browser \
  -v
```

Expected: both tests PASS. `retrieved_at` is a schema string, so the visible
`"YYYY-MM-DD"` replacement instruction remains valid in the embedded sample.

- [ ] **Step 7: Run full verification**

Run:

```bash
node --test tests/*.mjs
python3 -m unittest discover -s tests -v
python3 -m battle_animation.validator examples/battle-of-waterloo.json
python3 -m battle_animation.validator examples/battle-of-甲午.json
python3 -m battle_animation.validator examples/battle-of-甲午海戰.json
git diff --check
```

Expected: 126 Node tests pass; at least 41 Python tests pass including the new Prompt contract; all three examples print `valid:`; diff check is clean.

- [ ] **Step 8: Commit**

```bash
git add README.md tests/test_mvp_contract.py
git commit -m "docs: publish battle JSON prompt 1.0.0"
```

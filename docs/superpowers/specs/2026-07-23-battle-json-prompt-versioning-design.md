# Battle JSON Prompt Versioning Design

**Date:** 2026-07-23  
**Status:** Approved design, pending implementation

## Goal

Revise the README generation prompt so a capable LLM or well-informed data
editor can produce the most precise and complete JSON supported by the
available evidence, while every result remains valid
`battle-animation-schema 0.3.0` and records which prompt rules produced it.

## Version Model

Prompt and schema versions are independent:

- The generated document always uses `"schema_version": "0.3.0"`.
- This revision of the generation prompt is `1.0.0`.
- Generated documents record the prompt version through the existing,
  schema-valid metadata field:

  ```json
  "source_system": "battle_json_prompt_1.0.0"
  ```

No `prompt_version` property will be added because every schema object uses
`additionalProperties: false`. Adding such a property would require a new
schema version and is outside this change.

Prompt versions follow semantic versioning:

- Patch: wording or corrections that do not change expected output behavior.
- Minor: backward-compatible generation rules or guidance.
- Major: incompatible generation strategy or provenance convention.

## Generation Strategy

The prompt will target only schema `0.3.0`; `0.1.0` and `0.2.0` remain app
compatibility formats and will not be offered as generation choices.

The model should maximize useful detail only to the level supported by the
provided evidence:

1. Prefer source-supported individual ships or land/air units when available.
2. Add timed movements and waypoint timing when sources support chronology and
   representative positions.
3. Add engagements only when attacker, target, action, and result have source
   support.
4. Use approximate or inferred geometry/time only for an event whose
   occurrence and ordering are supported.
5. Omit unsupported actors, classifications, engagements, results, routes, or
   times instead of disguising speculation with low confidence.

The confidence guidance will be consistent: inferred representative geometry
or timing should use confidence no greater than `0.5`.

## Source Handling

The prompt accepts page text, tables, summaries, and URLs. A model may use a URL
only when it can actually retrieve its contents. If it cannot access a URL, it
must request pasted source content rather than inventing details or pretending
the URL was read.

`retrieved_at` must be the actual retrieval date in `YYYY-MM-DD` form. The
example must use a visible placeholder rather than a historical date that a
model could copy unchanged.

## Output Contract

The final response remains exactly one JSON object with no Markdown, prose, or
quality-check wrapper. The model may reason internally about:

- evidence coverage;
- identifier uniqueness and references;
- chronological ordering;
- waypoint count and bounds;
- controlled icon tokens;
- schema-required fields.

That internal review must not appear as extra output properties or surrounding
text.

The existing legal-field lists, controlled vocabularies, icon catalog, source
limits, and complete JSON template remain in the prompt, corrected where they
conflict with this design.

## Documentation Changes

README will:

- label the prompt as `Battle JSON Prompt 1.0.0`;
- explain that prompt version and schema version are separate;
- fix `schema_version` to `"0.3.0"`;
- fix `metadata.source_system` to
  `"battle_json_prompt_1.0.0"`;
- remove the old conditional version-selection instructions;
- unify inferred confidence guidance at `<= 0.5`;
- prohibit pretending inaccessible URLs were read;
- require an actual retrieval date;
- preserve the schema field and icon-token guidance.

## Verification

Contract tests will assert that README:

- names Prompt `1.0.0`;
- fixes schema version to `0.3.0`;
- includes the exact `source_system` provenance marker;
- no longer asks for simultaneous conformance to all three schema versions;
- includes the inaccessible-URL and actual retrieval-date safeguards;
- uses a single inferred-confidence ceiling of `0.5`;
- retains the existing v0.3 timing and controlled-token instructions.

The full Node and Python test suites and all bundled example validators must
remain green.

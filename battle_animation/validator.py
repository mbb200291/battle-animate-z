from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"


class ValidationError(ValueError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def validate_document(document: Any, schema: dict[str, Any] | None = None) -> list[ValidationError]:
    schema = schema or load_json(DEFAULT_SCHEMA)
    errors: list[ValidationError] = []
    _validate(document, schema, schema, "$", errors)
    _validate_references(document, errors)
    return errors


def _resolve_ref(ref: str, root_schema: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError(f"Only local refs are supported: {ref}")
    target: Any = root_schema
    for part in ref[2:].split("/"):
        target = target[part]
    return target


def _validate(value: Any, schema: dict[str, Any], root_schema: dict[str, Any], path: str, errors: list[ValidationError]) -> None:
    if "$ref" in schema:
        _validate(value, _resolve_ref(schema["$ref"], root_schema), root_schema, path, errors)
        return

    if "oneOf" in schema:
        branch_errors: list[list[ValidationError]] = []
        matches = 0
        for branch in schema["oneOf"]:
            local_errors: list[ValidationError] = []
            _validate(value, branch, root_schema, path, local_errors)
            if not local_errors:
                matches += 1
            branch_errors.append(local_errors)
        if matches != 1:
            errors.append(ValidationError(path, f"expected exactly one matching schema, got {matches}"))
        return

    if "const" in schema and value != schema["const"]:
        errors.append(ValidationError(path, f"expected {schema['const']!r}, got {value!r}"))

    if "enum" in schema and value not in schema["enum"]:
        errors.append(ValidationError(path, f"expected one of {schema['enum']!r}, got {value!r}"))

    expected_type = schema.get("type")
    if expected_type and not _matches_type(value, expected_type):
        errors.append(ValidationError(path, f"expected {expected_type}, got {type(value).__name__}"))
        return

    if expected_type == "object":
        _validate_object(value, schema, root_schema, path, errors)
    elif expected_type == "array":
        _validate_array(value, schema, root_schema, path, errors)
    elif expected_type == "number":
        _validate_number(value, schema, path, errors)
    elif expected_type == "string":
        pattern = schema.get("pattern")
        if pattern and re.match(pattern, value) is None:
            errors.append(ValidationError(path, f"does not match pattern {pattern!r}"))


def _matches_type(value: Any, expected_type: str) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    return True


def _validate_object(value: dict[str, Any], schema: dict[str, Any], root_schema: dict[str, Any], path: str, errors: list[ValidationError]) -> None:
    required = schema.get("required", [])
    properties = schema.get("properties", {})
    for key in required:
        if key not in value:
            errors.append(ValidationError(path, f"missing required property {key!r}"))

    additional = schema.get("additionalProperties", True)
    for key, child in value.items():
        child_path = f"{path}.{key}"
        if key in properties:
            _validate(child, properties[key], root_schema, child_path, errors)
        elif isinstance(additional, dict):
            _validate(child, additional, root_schema, child_path, errors)
        elif additional is False:
            errors.append(ValidationError(child_path, "additional property is not allowed"))


def _validate_array(value: list[Any], schema: dict[str, Any], root_schema: dict[str, Any], path: str, errors: list[ValidationError]) -> None:
    min_items = schema.get("minItems")
    max_items = schema.get("maxItems")
    if min_items is not None and len(value) < min_items:
        errors.append(ValidationError(path, f"expected at least {min_items} items"))
    if max_items is not None and len(value) > max_items:
        errors.append(ValidationError(path, f"expected at most {max_items} items"))

    item_schema = schema.get("items")
    if item_schema:
        for index, item in enumerate(value):
            _validate(item, item_schema, root_schema, f"{path}[{index}]", errors)


def _validate_number(value: int | float, schema: dict[str, Any], path: str, errors: list[ValidationError]) -> None:
    minimum = schema.get("minimum")
    exclusive_minimum = schema.get("exclusiveMinimum")
    maximum = schema.get("maximum")
    if minimum is not None and value < minimum:
        errors.append(ValidationError(path, f"expected value >= {minimum}"))
    if exclusive_minimum is not None and value <= exclusive_minimum:
        errors.append(ValidationError(path, f"expected value > {exclusive_minimum}"))
    if maximum is not None and value > maximum:
        errors.append(ValidationError(path, f"expected value <= {maximum}"))


def _validate_references(document: Any, errors: list[ValidationError]) -> None:
    if not isinstance(document, dict):
        return

    side_ids = {item.get("id") for item in document.get("sides", []) if isinstance(item, dict)}
    commander_ids = {item.get("id") for item in document.get("commanders", []) if isinstance(item, dict)}
    actor_ids = {item.get("id") for item in document.get("actors", []) if isinstance(item, dict)}
    place_ids = {item.get("id") for item in document.get("places", []) if isinstance(item, dict)}
    event_ids = {item.get("id") for item in document.get("historical_events", []) if isinstance(item, dict)}
    source_ids = {item.get("id") for item in document.get("sources", []) if isinstance(item, dict)}

    for index, commander in enumerate(document.get("commanders", [])):
        _check_ref(commander, "side_id", side_ids, f"$.commanders[{index}]", errors)

    for index, actor in enumerate(document.get("actors", [])):
        _check_ref(actor, "side_id", side_ids, f"$.actors[{index}]", errors)
        _check_optional_ref(actor, "parent_id", actor_ids, f"$.actors[{index}]", errors)
        for commander_id in actor.get("commander_ids", []):
            if commander_id not in commander_ids:
                errors.append(ValidationError(f"$.actors[{index}].commander_ids", f"unknown commander id {commander_id!r}"))

    for index, event in enumerate(document.get("historical_events", [])):
        for actor_id in event.get("actor_ids", []):
            if actor_id not in actor_ids:
                errors.append(ValidationError(f"$.historical_events[{index}].actor_ids", f"unknown actor id {actor_id!r}"))
        for actor_id in event.get("target_actor_ids", []):
            if actor_id not in actor_ids:
                errors.append(ValidationError(f"$.historical_events[{index}].target_actor_ids", f"unknown actor id {actor_id!r}"))
        for place_id in event.get("place_ids", []):
            if place_id not in place_ids:
                errors.append(ValidationError(f"$.historical_events[{index}].place_ids", f"unknown place id {place_id!r}"))
        for source_id in event.get("source_ids", []):
            if source_id not in source_ids:
                errors.append(ValidationError(f"$.historical_events[{index}].source_ids", f"unknown source id {source_id!r}"))

    for index, movement in enumerate(document.get("movements", [])):
        _check_ref(movement, "event_id", event_ids, f"$.movements[{index}]", errors)
        _check_ref(movement, "actor_id", actor_ids, f"$.movements[{index}]", errors)
        _check_optional_ref(movement, "from_place_id", place_ids, f"$.movements[{index}]", errors)
        _check_optional_ref(movement, "to_place_id", place_ids, f"$.movements[{index}]", errors)

    for index, engagement in enumerate(document.get("engagements", [])):
        path = f"$.engagements[{index}]"
        _check_ref(engagement, "event_id", event_ids, path, errors)
        _check_ref(engagement, "attacker_actor_id", actor_ids, path, errors)
        _check_ref(engagement, "target_actor_id", actor_ids, path, errors)
        _check_optional_ref(engagement, "result_actor_id", actor_ids, path, errors)
        _check_optional_ref(engagement, "at_place_id", place_ids, path, errors)
        for source_id in engagement.get("source_ids", []):
            if source_id not in source_ids:
                errors.append(ValidationError(f"{path}.source_ids", f"unknown source id {source_id!r}"))

    outcome = document.get("outcome", {})
    if isinstance(outcome, dict):
        for side_id in outcome.get("winner_side_ids", []):
            if side_id not in side_ids:
                errors.append(ValidationError("$.outcome.winner_side_ids", f"unknown side id {side_id!r}"))
        for source_id in outcome.get("source_ids", []):
            if source_id not in source_ids:
                errors.append(ValidationError("$.outcome.source_ids", f"unknown source id {source_id!r}"))


def _check_ref(parent: dict[str, Any], key: str, allowed: set[Any], path: str, errors: list[ValidationError]) -> None:
    if parent.get(key) not in allowed:
        errors.append(ValidationError(f"{path}.{key}", f"unknown id {parent.get(key)!r}"))


def _check_optional_ref(parent: dict[str, Any], key: str, allowed: set[Any], path: str, errors: list[ValidationError]) -> None:
    if key in parent and parent.get(key) not in allowed:
        errors.append(ValidationError(f"{path}.{key}", f"unknown id {parent.get(key)!r}"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a battle-animation-schema JSON document.")
    parser.add_argument("document", type=Path)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    args = parser.parse_args(argv)

    try:
        document = load_json(args.document)
        schema = load_json(args.schema)
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return 2

    errors = validate_document(document, schema)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"valid: {args.document}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

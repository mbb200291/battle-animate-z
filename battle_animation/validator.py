from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = ROOT / "schemas" / "battle-animation-schema.json"
BATTLE_TIME_PATTERN = re.compile(
    r"^(?:"
    r"\d{4}|"
    r"\d{4}-\d{2}|"
    r"\d{4}-\d{2}-\d{2}|"
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"
    r"(?::\d{2}(?:\.\d+)?)?"
    r"(?:Z|[+-]\d{2}:\d{2})?"
    r")$"
)

ACTOR_ICON_TOKENS = {
    "warship_generic",
    "warship_ironclad",
    "warship_battleship",
    "warship_armored_cruiser",
    "warship_protected_cruiser",
    "warship_destroyer",
    "warship_torpedo_boat",
    "naval_transport",
    "fleet_generic",
    "infantry",
    "cavalry",
    "artillery",
    "armor",
    "engineer",
    "logistics",
    "headquarters",
    "fortress",
    "aircraft",
    "aircraft_fighter",
    "aircraft_bomber",
    "unit_generic",
}


class ValidationError(ValueError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


class ValidationWarning(ValueError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def validate_document(document: Any, schema: dict[str, Any] | None = None) -> list[ValidationError]:
    errors, _warnings = validate_document_with_warnings(document, schema)
    return errors


def validate_document_with_warnings(
    document: Any, schema: dict[str, Any] | None = None
) -> tuple[list[ValidationError], list[ValidationWarning]]:
    schema = schema or load_json(DEFAULT_SCHEMA)
    errors: list[ValidationError] = []
    warnings: list[ValidationWarning] = []
    _validate(document, schema, schema, "$", errors)
    _validate_references(document, errors)
    _validate_timing(document, errors, warnings)
    _validate_movement_overlaps(document, errors, warnings)
    _validate_icon_tokens(document, warnings)
    return errors, warnings


def _parse_battle_time(value: str) -> float:
    if not isinstance(value, str) or BATTLE_TIME_PATTERN.fullmatch(value) is None:
        raise ValueError("battle time must be a string")
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    if re.fullmatch(r"\d{4}", normalized):
        normalized = f"{normalized}-01-01"
    elif re.fullmatch(r"\d{4}-\d{2}", normalized):
        normalized = f"{normalized}-01"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("invalid ISO battle time") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


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


def _validate_timing(
    document: Any, errors: list[ValidationError], warnings: list[ValidationWarning]
) -> None:
    if not isinstance(document, dict):
        return
    _validate_datetime_offset_styles(document, errors)

    for collection_name in ("historical_events", "engagements"):
        collection = document.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for index, item in enumerate(collection):
            if isinstance(item, dict) and "time" in item:
                _validate_date_value_time(item["time"], f"$.{collection_name}[{index}].time", errors)

    movements = document.get("movements", [])
    if not isinstance(movements, list):
        return
    for index, movement in enumerate(movements):
        if not isinstance(movement, dict):
            continue
        path = f"$.movements[{index}]"
        start = end = None
        time_value = movement.get("time")
        if "time" in movement:
            start, end = _validate_date_value_time(time_value, f"{path}.time", errors)
        if (
            movement.get("precision") == "inferred"
            and isinstance(time_value, dict)
            and isinstance(time_value.get("confidence"), (int, float))
            and not isinstance(time_value.get("confidence"), bool)
            and time_value["confidence"] > 0.6
        ):
            warnings.append(
                ValidationWarning(f"{path}.time.confidence", "inferred time confidence must be <= 0.6")
            )

        waypoint_values = movement.get("waypoint_times")
        if not isinstance(waypoint_values, list):
            continue
        coordinates = movement.get("path", {}).get("coordinates") if isinstance(movement.get("path"), dict) else None
        if isinstance(coordinates, list) and len(waypoint_values) != len(coordinates):
            errors.append(
                ValidationError(f"{path}.waypoint_times", "count must match path coordinate count")
            )

        waypoint_times: list[float | None] = []
        for waypoint_index, value in enumerate(waypoint_values):
            if not isinstance(value, str):
                waypoint_times.append(None)
                continue
            try:
                waypoint_times.append(_parse_battle_time(value))
            except ValueError:
                errors.append(
                    ValidationError(
                        f"{path}.waypoint_times[{waypoint_index}]", "invalid ISO battle time"
                    )
                )
                waypoint_times.append(None)

        if any(
            earlier is not None and later is not None and later <= earlier
            for earlier, later in zip(waypoint_times, waypoint_times[1:])
        ):
            errors.append(ValidationError(f"{path}.waypoint_times", "values must be strictly increasing"))
        if waypoint_times and waypoint_times[0] is not None and start is not None and waypoint_times[0] < start:
            errors.append(ValidationError(f"{path}.waypoint_times[0]", "value is before movement start"))
        if waypoint_times and waypoint_times[-1] is not None and end is not None and waypoint_times[-1] > end:
            errors.append(
                ValidationError(
                    f"{path}.waypoint_times[{len(waypoint_times) - 1}]", "value is after movement end"
                )
            )


def _validate_date_value_time(
    value: Any, path: str, errors: list[ValidationError]
) -> tuple[float | None, float | None]:
    if not isinstance(value, dict):
        return None, None
    parsed: dict[str, float | None] = {"start": None, "end": None}
    for field in parsed:
        if field not in value:
            continue
        if not isinstance(value[field], str):
            continue
        try:
            parsed[field] = _parse_battle_time(value[field])
        except ValueError:
            errors.append(ValidationError(f"{path}.{field}", "invalid ISO battle time"))
    start, end = parsed["start"], parsed["end"]
    if start is not None and end is not None and end < start:
        errors.append(ValidationError(path, "end must not be before start"))
    return start, end


def _validate_datetime_offset_styles(document: dict[str, Any], errors: list[ValidationError]) -> None:
    expected_offset_style: bool | None = None
    for path, value in _iter_timing_values(document):
        if (
            not isinstance(value, str)
            or "T" not in value
            or BATTLE_TIME_PATTERN.fullmatch(value) is None
        ):
            continue
        try:
            _parse_battle_time(value)
        except ValueError:
            continue
        is_offset_bearing = value.endswith("Z") or re.search(r"[+-]\d{2}:\d{2}$", value) is not None
        if expected_offset_style is None:
            expected_offset_style = is_offset_bearing
        elif is_offset_bearing != expected_offset_style:
            errors.append(
                ValidationError(
                    path,
                    "mixed offset-bearing and battle-local date-times are not allowed",
                )
            )


def _iter_timing_values(document: dict[str, Any]):
    for collection_name in ("historical_events", "movements", "engagements"):
        collection = document.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for index, item in enumerate(collection):
            if not isinstance(item, dict):
                continue
            time_value = item.get("time")
            if isinstance(time_value, dict):
                for field in ("start", "end"):
                    if field in time_value:
                        yield f"$.{collection_name}[{index}].time.{field}", time_value[field]
            if collection_name == "movements" and isinstance(item.get("waypoint_times"), list):
                for waypoint_index, value in enumerate(item["waypoint_times"]):
                    yield f"$.movements[{index}].waypoint_times[{waypoint_index}]", value


def _validate_movement_overlaps(
    document: Any, errors: list[ValidationError], warnings: list[ValidationWarning]
) -> None:
    if not isinstance(document, dict) or not isinstance(document.get("movements", []), list):
        return
    by_actor: dict[Any, list[tuple[float, float, int, dict[str, Any]]]] = {}
    for index, movement in enumerate(document.get("movements", [])):
        if not isinstance(movement, dict) or not isinstance(movement.get("time"), dict):
            continue
        time_value = movement["time"]
        if "start" not in time_value or "end" not in time_value:
            continue
        try:
            start = _parse_battle_time(time_value["start"])
            end = _parse_battle_time(time_value["end"])
        except ValueError:
            continue
        if end < start:
            continue
        by_actor.setdefault(movement.get("actor_id"), []).append((start, end, index, movement))

    for actor_id, timed_movements in by_actor.items():
        timed_movements.sort(key=lambda item: (item[0], item[1], item[2]))
        for later_position, later in enumerate(timed_movements[1:], start=1):
            overlapping_previous = [
                previous
                for previous in timed_movements[:later_position]
                if later[0] < previous[1]
            ]
            if not overlapping_previous:
                continue
            later_coordinates = _movement_coordinates(later[3])
            path = f"$.movements[{later[2]}]"
            connects_to_all = bool(later_coordinates) and all(
                (previous_coordinates := _movement_coordinates(previous[3]))
                and previous_coordinates[-1] == later_coordinates[0]
                for previous in overlapping_previous
            )
            if connects_to_all:
                warnings.append(
                    ValidationWarning(path, "overlap resolved in favor of later movement")
                )
            else:
                errors.append(
                    ValidationError(path, f"conflicting overlapping movements for actor {actor_id!r}")
                )


def _movement_coordinates(movement: dict[str, Any]) -> list[Any] | None:
    path = movement.get("path")
    if not isinstance(path, dict) or not isinstance(path.get("coordinates"), list):
        return None
    return path["coordinates"]


def _validate_icon_tokens(document: Any, warnings: list[ValidationWarning]) -> None:
    if not isinstance(document, dict) or document.get("schema_version") != "0.3.0":
        return
    animation_hints = document.get("animation_hints")
    style = animation_hints.get("style") if isinstance(animation_hints, dict) else None
    actor_icons = style.get("actor_icons") if isinstance(style, dict) else None
    if not isinstance(actor_icons, dict):
        return
    for actor_id, token in actor_icons.items():
        if not isinstance(token, str) or token not in ACTOR_ICON_TOKENS:
            warnings.append(
                ValidationWarning(
                    f"$.animation_hints.style.actor_icons.{actor_id}",
                    f"unknown actor icon token {token!r}",
                )
            )


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

    errors, warnings = validate_document_with_warnings(document, schema)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"valid: {args.document}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

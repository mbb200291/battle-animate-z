from typing import Literal, NotRequired, TypedDict


Identifier = str
Confidence = float
Precision = Literal["exact", "approximate", "inferred", "disputed", "unknown"]
DatePrecision = Literal["year", "month", "day", "hour", "range", "unknown"]
EventType = Literal[
    "advance",
    "retreat",
    "attack",
    "defend",
    "capture",
    "surrender",
    "reinforcement",
    "bombardment",
    "landing",
    "other",
]


class DateValue(TypedDict):
    label: str
    precision: DatePrecision
    confidence: Confidence
    start: NotRequired[str]
    end: NotRequired[str]


class Metadata(TypedDict):
    id: Identifier
    title: str
    created_at: str
    updated_at: str
    license: str
    source_system: str
    wikidata_qid: NotRequired[str]


class Battle(TypedDict):
    id: Identifier
    name: str
    part_of: str
    date: DateValue
    summary: str
    confidence: Confidence
    also_known_as: NotRequired[list[str]]


class Belligerent(TypedDict):
    id: Identifier
    name: str
    wikidata_qid: NotRequired[str]


class Side(TypedDict):
    id: Identifier
    name: str
    color: str
    belligerents: list[Belligerent]


class Commander(TypedDict):
    id: Identifier
    name: str
    side_id: Identifier
    confidence: Confidence
    rank_or_role: NotRequired[str]
    wikidata_qid: NotRequired[str]


class Strength(TypedDict, total=False):
    label: str
    min: float
    max: float
    confidence: Confidence


class Actor(TypedDict):
    id: Identifier
    name: str
    side_id: Identifier
    kind: Literal["army", "corps", "division", "brigade", "regiment", "fleet", "ship", "unit", "person", "other"]
    confidence: Confidence
    parent_id: NotRequired[Identifier]
    commander_ids: NotRequired[list[Identifier]]
    strength: NotRequired[Strength]


class Point(TypedDict):
    type: Literal["Point"]
    coordinates: tuple[float, float]


class LineString(TypedDict):
    type: Literal["LineString"]
    coordinates: list[tuple[float, float]]


class Polygon(TypedDict):
    type: Literal["Polygon"]
    coordinates: list[list[tuple[float, float]]]


Geometry = Point | LineString | Polygon


class FrontLine(TypedDict):
    id: Identifier
    geometry: LineString


class ControlArea(TypedDict):
    id: Identifier
    side_id: Identifier
    geometry: Polygon


class FrontlineSnapshot(TypedDict):
    id: Identifier
    time: DateValue
    precision: Precision
    confidence: Confidence
    source_ids: list[Identifier]
    event_id: NotRequired[Identifier]
    front_lines: NotRequired[list[FrontLine]]
    control_areas: NotRequired[list[ControlArea]]


class Place(TypedDict):
    id: Identifier
    name: str
    geometry: Geometry
    precision: Precision
    confidence: Confidence
    wikidata_qid: NotRequired[str]


class HistoricalEvent(TypedDict):
    id: Identifier
    type: EventType
    title: str
    time: DateValue
    description: str
    actor_ids: list[Identifier]
    place_ids: list[Identifier]
    precision: Precision
    confidence: Confidence
    source_ids: list[Identifier]
    target_actor_ids: NotRequired[list[Identifier]]


class Movement(TypedDict):
    id: Identifier
    event_id: Identifier
    actor_id: Identifier
    path: LineString
    precision: Precision
    confidence: Confidence
    from_place_id: NotRequired[Identifier]
    to_place_id: NotRequired[Identifier]
    time: NotRequired[DateValue]
    waypoint_times: NotRequired[list[str]]


class Casualty(TypedDict):
    side_id: Identifier
    label: str
    confidence: Confidence
    min: NotRequired[float]
    max: NotRequired[float]


EngagementType = Literal["fire", "bombardment", "ram", "torpedo", "charge", "melee", "other"]
EngagementResult = Literal["hit", "miss", "damaged", "disabled", "sunk", "repelled", "captured", "none"]


class Engagement(TypedDict):
    id: Identifier
    event_id: Identifier
    attacker_actor_id: Identifier
    target_actor_id: Identifier
    type: EngagementType
    confidence: Confidence
    result: NotRequired[EngagementResult]
    result_actor_id: NotRequired[Identifier]
    at_place_id: NotRequired[Identifier]
    time: NotRequired[DateValue]
    source_ids: NotRequired[list[Identifier]]


class Outcome(TypedDict):
    summary: str
    winner_side_ids: list[Identifier]
    confidence: Confidence
    source_ids: list[Identifier]
    casualties: NotRequired[list[Casualty]]


class Source(TypedDict):
    id: Identifier
    title: str
    url: str
    retrieved_at: str
    license: str
    note: NotRequired[str]


class AnimationMapHints(TypedDict):
    initial_center: tuple[float, float]
    initial_zoom: float
    bounds_padding: NotRequired[float]


class AnimationStyleHints(TypedDict, total=False):
    side_colors: dict[str, str]
    actor_icons: dict[str, str]
    event_icons: dict[str, str]
    movement_line_width: float


class AnimationTimelineHints(TypedDict, total=False):
    default_event_duration_ms: float
    historical_seconds_per_playback_second: float
    idle_compression_threshold_seconds: float
    idle_compressed_duration_ms: float
    ordered_event_ids: list[Identifier]


class CameraHint(TypedDict):
    event_id: Identifier
    center: tuple[float, float]
    zoom: NotRequired[float]


class AnimationHints(TypedDict):
    map: AnimationMapHints
    style: AnimationStyleHints
    timeline: AnimationTimelineHints
    camera: NotRequired[list[CameraHint]]


class BattleAnimationDocument(TypedDict):
    schema_version: Literal["0.1.0", "0.2.0", "0.3.0", "0.4.0"]
    metadata: Metadata
    battle: Battle
    sides: list[Side]
    commanders: list[Commander]
    actors: list[Actor]
    places: list[Place]
    historical_events: list[HistoricalEvent]
    movements: list[Movement]
    outcome: Outcome
    sources: list[Source]
    animation_hints: AnimationHints
    engagements: NotRequired[list[Engagement]]
    frontline_snapshots: NotRequired[list[FrontlineSnapshot]]

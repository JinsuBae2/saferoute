"""Executable scenario validation, kept outside the controller."""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from backend.contracts.building import Building
from backend.contracts.common import BuildingIdentity, Identifier, NonnegativeInt, PositiveInt, WireModel, unique
from backend.routing import validate_default_routes


class InitialObservation(WireModel):
    source_id: Identifier
    event_kind: Literal["OBSERVATION", "ALARM"]
    hazard_type: Literal["SMOKE", "SPRINKLER"] | None


class SmokePoint(WireModel):
    time_ms: NonnegativeInt
    zone_id: Identifier
    smoke: Annotated[float, Field(ge=0, le=1)]


class ObservationRule(WireModel):
    source_id: Identifier
    threshold: Annotated[float, Field(gt=0, le=1)]
    interval_ms: PositiveInt
    delay_ms: NonnegativeInt


class Fault(WireModel):
    source_id: Identifier
    kind: Literal["DROP", "DELAY", "UNAVAILABLE"]
    start_ms: NonnegativeInt
    end_ms: PositiveInt
    delay_ms: NonnegativeInt

    @model_validator(mode="after")
    def interval(self):
        if self.end_ms <= self.start_ms or (self.kind == "DELAY") != (self.delay_ms > 0):
            raise ValueError("fault needs a positive interval and delay only for DELAY")
        return self


class Scenario(BuildingIdentity):
    scenario_id: Identifier
    seed: NonnegativeInt
    duration_ms: PositiveInt
    start_trigger: Literal["ARM"]
    initial_observations: list[InitialObservation]
    smoke_timeline: list[SmokePoint]
    observation_rules: Annotated[list[ObservationRule], Field(min_length=1)]
    faults: list[Fault]

    def smoke_at(self, time_ms):
        smoke = {}
        for point in sorted(self.smoke_timeline, key=lambda p: (p.time_ms, p.zone_id)):
            if point.time_ms <= time_ms: smoke[point.zone_id] = point.smoke
        return smoke

    def validate_for(self, building):
        if (self.building_id, self.building_version) != (building.building_id, building.building_version):
            raise ValueError("scenario building/version mismatch")
        unique([r.source_id for r in self.observation_rules], "rule source")
        unique([o.source_id for o in self.initial_observations], "initial source")
        unique([(p.zone_id, p.time_ms) for p in self.smoke_timeline], "smoke point")
        rules = {r.source_id: r for r in self.observation_rules}
        if set(rules) != {o.source_id for o in self.initial_observations}:
            raise ValueError("initial observations must cover exactly the rule sources")
        zones = {z.zone_id for z in building.zones}
        initial = self.smoke_at(0)
        for point in self.smoke_timeline:
            if point.zone_id not in zones or point.time_ms > self.duration_ms or point.zone_id not in initial:
                raise ValueError("smoke needs known zones, a time-zero value, and bounded times")
        sources = {s.source_id: s for s in building.sources}
        # 필수 모의 감지기를 실행기가 소유하지 않으면 arm 조건을 채울 주체가 없다.
        missing = sorted(s.source_id for s in building.sources if s.required and s.source_id not in rules
                         and s.source_type in {"SIM_SMOKE_DETECTOR", "SIM_SPRINKLER"})
        if missing:
            raise ValueError(f"scenario must own every required simulated sensor; missing {missing}")
        for observation in self.initial_observations:
            source = sources.get(observation.source_id)
            if source is None or source.source_type not in {"SIM_SMOKE_DETECTOR", "SIM_SPRINKLER"}:
                raise ValueError("scenario rules can only own registered simulated sensors")
            if source.zone_id not in initial:
                raise ValueError("each simulated sensor zone needs an explicit initial smoke value")
            hazard = "SMOKE" if source.source_type == "SIM_SMOKE_DETECTOR" else "SPRINKLER"
            alarm = initial[source.zone_id] >= rules[source.source_id].threshold
            if observation.event_kind != ("ALARM" if alarm else "OBSERVATION") or observation.hazard_type != (hazard if alarm else None):
                raise ValueError("initial observations must agree with explicit initial truth and threshold")
            if hazard not in source.allowed_hazard_types:
                raise ValueError("simulated hazard is not allowed by source configuration")
        for fault in self.faults:
            if fault.source_id not in rules or fault.end_ms > self.duration_ms:
                raise ValueError("fault source or duration is invalid")
        for source_id in rules:
            intervals = sorted((f.start_ms, f.end_ms) for f in self.faults if f.source_id == source_id)
            if any(a[1] > b[0] for a, b in zip(intervals, intervals[1:])):
                raise ValueError("fault intervals for one source must not overlap")
        return self


def load_building(path):
    building = Building.model_validate_json(Path(path).read_text(encoding="utf-8"))
    validate_default_routes(building)
    return building


def load_scenario(path, building):
    return Scenario.model_validate_json(Path(path).read_text(encoding="utf-8")).validate_for(building)

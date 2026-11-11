"""Strict JSON wire primitives; values stay serializable without coercion."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

MAX_SAFE_INTEGER = 2**53 - 1
Text = Annotated[str, Field(min_length=1, pattern=r"^\S(?:[\s\S]*\S)?$")]
Identifier = Annotated[str, Field(min_length=1, pattern=r"^\S+$")]
UUIDString = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
PositiveInt = Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER)]
NonnegativeInt = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
SchemaVersion = Annotated[int, Field(ge=1, le=1)]
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]
PositiveNumber = Annotated[float, Field(gt=0, allow_inf_nan=False)]
NonnegativeNumber = Annotated[float, Field(ge=0, allow_inf_nan=False)]


def valid_utc(value: str) -> str:
    datetime.fromisoformat(value)
    return value


UTCString = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"), AfterValidator(valid_utc)]
SourceType = Literal["VIDEO_AI", "SIM_SMOKE_DETECTOR", "SIM_SPRINKLER", "MANUAL_TEST"]
HazardType = Literal["FIRE", "SMOKE", "SPRINKLER"]
Display = Literal["LEFT", "RIGHT", "FORWARD", "BACK", "STAIRS_UP", "STAIRS_DOWN", "EXIT"]
FaceMode = Literal["DEFAULT", "DYNAMIC", "NO_ROUTE", "UNKNOWN"]
ControllerMode = Literal["INITIALIZING", "NORMAL", "EMERGENCY", "DEGRADED"]
ReasonCode = Literal[
    "INITIALIZING", "ORIGIN_BLOCKED", "NO_REACHABLE_EXIT", "REQUIRED_OBSERVATION_UNKNOWN",
    "EXIT_UNAVAILABLE", "UNSUPPORTED_DISPLAY", "CONTROLLER_UNAVAILABLE", "COMMAND_EXPIRED", "VERSION_MISMATCH",
]
SOURCE_HAZARDS = {
    "VIDEO_AI": {"FIRE", "SMOKE"}, "SIM_SMOKE_DETECTOR": {"SMOKE"},
    "SIM_SPRINKLER": {"SPRINKLER"}, "MANUAL_TEST": {"FIRE", "SMOKE", "SPRINKLER"},
}


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class BuildingIdentity(WireModel):
    schema_version: SchemaVersion
    building_id: Identifier
    building_version: PositiveInt


class RunIdentity(BuildingIdentity):
    run_id: UUIDString


def unique(values, label):
    if len(values) != len(set(values)):
        raise ValueError(f"duplicate {label}")


class Position(WireModel):
    x: FiniteNumber
    y: FiniteNumber
    z: FiniteNumber


class PlanPoint(WireModel):
    x: FiniteNumber
    z: FiniteNumber

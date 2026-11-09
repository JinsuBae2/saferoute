"""C02 wire messages. No HTTP server or mutable controller state lives here."""

from typing import Annotated, Literal

from pydantic import Field, model_validator
from pydantic_core import PydanticCustomError

from .common import (
    BuildingIdentity, ControllerMode, Display, FaceMode, HazardType, Identifier, NonnegativeInt,
    NonnegativeNumber, PositiveInt, ReasonCode, RunIdentity, SOURCE_HAZARDS,
    SchemaVersion, SourceType, Text, UTCString, UUIDString, WireModel, unique,
)


class Session(RunIdentity):
    controller_mode: ControllerMode


class ZoneSmoke(WireModel):
    zone_id: Identifier
    smoke: Annotated[float, Field(ge=0, le=1)]


class SimulationState(BuildingIdentity):
    scenario_id: Identifier
    run_id: UUIDString
    simulation_time_ms: NonnegativeInt
    simulation_sequence: NonnegativeInt
    status: Literal["WAITING_FOR_ARM", "RUNNING", "COMPLETED", "FAILED", "STOPPED"]
    zones: list[ZoneSmoke]
    error_code: Identifier | None


class ObservationEvent(RunIdentity):
    event_id: UUIDString
    source_id: Identifier
    source_type: SourceType
    source_sequence: PositiveInt
    event_kind: Literal["OBSERVATION", "ALARM", "HEARTBEAT", "UNAVAILABLE"]
    hazard_type: HazardType | None
    validity: Literal["VALID", "UNAVAILABLE"]
    observed_at: UTCString
    media_time_ms: NonnegativeInt | None
    confidence: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)] | None
    reason_code: Text | None

    @model_validator(mode="after")
    def combination(self):
        def require(condition, message):
            if not condition:
                raise PydanticCustomError("invalid_event_combination", message)

        alarm = self.event_kind == "ALARM"
        unavailable = self.event_kind == "UNAVAILABLE"
        require(alarm == (self.hazard_type is not None), "hazard_type is required only for ALARM")
        require(self.validity == ("UNAVAILABLE" if unavailable else "VALID"), "event_kind and validity disagree")
        require(unavailable == (self.reason_code is not None), "reason_code is required only for UNAVAILABLE")
        if alarm:
            require(self.hazard_type in SOURCE_HAZARDS[self.source_type], "source cannot report this hazard type")
        if self.source_type == "VIDEO_AI":
            if alarm: require(self.confidence is not None, "video alarm needs confidence")
            if self.event_kind in {"OBSERVATION", "ALARM"}:
                require(self.media_time_ms is not None, "analyzed frame needs media_time_ms")
        else:
            require(self.confidence is None and self.media_time_ms is None, "non-video sources have no confidence or media time")
        return self


class FaceResult(WireModel):
    face_id: Identifier
    mode: FaceMode
    display: Display | None
    next_node_id: Identifier | None
    exit_id: Identifier | None
    reason_codes: list[ReasonCode]

    @model_validator(mode="after")
    def display_state(self):
        unique(self.reason_codes, "reason code")
        if self.mode in {"NO_ROUTE", "UNKNOWN"}:
            if any(v is not None for v in (self.display, self.next_node_id, self.exit_id)) or not self.reason_codes:
                raise ValueError("unavailable guidance must remove the arrow and provide reasons")
        else:
            if self.display is None or self.exit_id is None or self.reason_codes:
                raise ValueError("available guidance needs a display, exit, and no failure reasons")
            if (self.display == "EXIT") != (self.next_node_id is None):
                raise ValueError("only EXIT display has no next node")
        return self


class SignCommand(RunIdentity):
    guidance_version: NonnegativeInt
    sign_id: Identifier
    command_id: UUIDString
    command_sequence: PositiveInt
    issued_at: UTCString
    valid_for_ms: PositiveInt
    faces: Annotated[list[FaceResult], Field(min_length=1)]

    @model_validator(mode="after")
    def face_ids(self):
        unique([f.face_id for f in self.faces], "command face")
        return self


class AckFace(WireModel):
    face_id: Identifier
    mode: FaceMode
    display: Display | None

    @model_validator(mode="after")
    def display_state(self):
        if (self.mode in {"NO_ROUTE", "UNKNOWN"}) != (self.display is None):
            raise ValueError("ACK mode and display disagree")
        return self


class SignAck(WireModel):
    schema_version: SchemaVersion
    run_id: UUIDString
    sign_id: Identifier
    terminal_instance_id: UUIDString
    command_id: UUIDString
    command_sequence: PositiveInt
    guidance_version: NonnegativeInt
    status: Literal["APPLIED", "REJECTED"]
    faces: list[AckFace]
    client_apply_duration_ms: NonnegativeNumber | None
    error_code: Identifier | None

    @model_validator(mode="after")
    def application_state(self):
        unique([f.face_id for f in self.faces], "ACK face")
        if self.status == "APPLIED":
            if not self.faces or self.client_apply_duration_ms is None or self.error_code is not None:
                raise ValueError("APPLIED needs faces, duration, and no error")
        elif self.error_code is None:
            raise ValueError("REJECTED needs error_code")
        return self


class ControlRequest(WireModel):
    schema_version: SchemaVersion
    run_id: UUIDString
    reason: Text


class ClearRequest(ControlRequest):
    source_id: Identifier
    hazard_type: HazardType


class EventReceipt(WireModel):
    accepted: bool
    duplicate: bool
    event_id: UUIDString
    run_id: UUIDString
    guidance_version: NonnegativeInt

    @model_validator(mode="after")
    def accepted_only(self):
        if not self.accepted: raise ValueError("use ErrorResponse for rejected events")
        return self


class ArmReceipt(WireModel):
    run_id: UUIDString
    controller_mode: Literal["NORMAL", "EMERGENCY"]
    armed: bool

    @model_validator(mode="after")
    def armed_only(self):
        if not self.armed: raise ValueError("successful arm requires armed=true")
        return self


class ClearReceipt(WireModel):
    run_id: UUIDString
    source_id: Identifier
    hazard_type: HazardType
    cleared: bool
    guidance_version: NonnegativeInt

    @model_validator(mode="after")
    def cleared_only(self):
        if not self.cleared: raise ValueError("successful clear requires cleared=true")
        return self


class ResetReceipt(WireModel):
    previous_run_id: UUIDString
    run_id: UUIDString
    controller_mode: Literal["INITIALIZING"]

    @model_validator(mode="after")
    def new_run(self):
        if self.run_id == self.previous_run_id: raise ValueError("reset must create a new run")
        return self


class ErrorDetail(WireModel):
    code: Literal[
        "INVALID_EVENT_COMBINATION", "UNKNOWN_SOURCE", "UNKNOWN_SIGN", "RUN_MISMATCH", "BUILDING_MISMATCH",
        "STALE_SEQUENCE", "EVENT_ID_CONFLICT", "STALE_OBSERVATION", "CLOCK_INVALID", "SOURCE_CAUSE_INACTIVE",
        "SCHEMA_VALIDATION_FAILED", "CONTROLLER_NOT_READY", "COMMAND_MISMATCH", "COMMAND_EXPIRED",
        "PREVIEW_FRAME_UNAVAILABLE", "PREVIEW_UPDATE_REJECTED",
    ]
    message: Text
    field: Text | None


class ErrorResponse(WireModel):
    error: ErrorDetail


class Route(WireModel):
    node_id: Identifier
    next_node_id: Identifier | None
    exit_id: Identifier | None
    path_node_ids: list[Identifier]
    cost: NonnegativeNumber | None
    reason_codes: list[ReasonCode]

    @model_validator(mode="after")
    def path_shape(self):
        unique(self.reason_codes, "route reason")
        if self.reason_codes:
            if self.path_node_ids or any(v is not None for v in (self.next_node_id, self.exit_id, self.cost)):
                raise ValueError("unavailable route must contain only reasons")
        else:
            if not self.path_node_ids or self.path_node_ids[0] != self.node_id or self.exit_id is None or self.cost is None:
                raise ValueError("route needs an origin, path, exit, and cost")
            unique(self.path_node_ids, "path node")
            if len(self.path_node_ids) == 1:
                if self.next_node_id is not None or self.cost != 0:
                    raise ValueError("exit-node route has no next node and costs zero")
            elif self.next_node_id != self.path_node_ids[1] or self.cost <= 0:
                raise ValueError("next node and positive path cost must match the route")
        return self


class SourceState(WireModel):
    source_id: Identifier
    validity: Literal["INITIALIZING", "VALID", "UNAVAILABLE", "STALE"]
    last_event_id: UUIDString | None
    last_observed_at: UTCString | None
    last_source_sequence: PositiveInt | None


class ActiveCause(WireModel):
    source_id: Identifier
    hazard_type: HazardType
    first_event_id: UUIDString
    last_event_id: UUIDString
    activated_at: UTCString


class BlockedNode(WireModel):
    node_id: Identifier
    source_ids: list[Identifier]
    reason_codes: Annotated[list[Literal["ACTIVE_ALARM", "REQUIRED_OBSERVATION_UNKNOWN"]], Field(min_length=1)]


class BlockedEdge(WireModel):
    edge_id: Identifier
    source_ids: list[Identifier]
    reason_codes: Annotated[list[Literal["ACTIVE_ALARM", "REQUIRED_OBSERVATION_UNKNOWN", "NOT_TRAVERSABLE"]], Field(min_length=1)]


class TerminalState(WireModel):
    terminal_instance_id: UUIDString
    last_ack: SignAck
    received_at: UTCString
    verified: bool


class SignState(WireModel):
    sign_id: Identifier
    faces: Annotated[list[FaceResult], Field(min_length=1)]
    latest_command: SignCommand | None
    application_status: Literal["NOT_ISSUED", "PENDING", "APPLIED", "REJECTED", "EXPIRED", "DUPLICATE_TERMINAL"]
    terminals: list[TerminalState]


class StateSnapshot(RunIdentity):
    guidance_version: NonnegativeInt
    generated_at: UTCString
    controller_mode: ControllerMode
    sources: list[SourceState]
    active_causes: list[ActiveCause]
    blocked_nodes: list[BlockedNode]
    blocked_edges: list[BlockedEdge]
    routes: list[Route]
    signs: list[SignState]

    @model_validator(mode="after")
    def snapshot_identity(self):
        for items, key in [(self.sources,"source_id"),(self.routes,"node_id"),(self.signs,"sign_id"),
                           (self.blocked_nodes,"node_id"),(self.blocked_edges,"edge_id")]:
            unique([getattr(item,key) for item in items], key)
        unique([(c.source_id,c.hazard_type) for c in self.active_causes], "active cause")
        for sign in self.signs:
            unique([f.face_id for f in sign.faces], "state face")
            unique([t.terminal_instance_id for t in sign.terminals], "terminal instance")
            command = sign.latest_command
            if command:
                if (command.run_id,command.building_id,command.building_version,command.sign_id) != (self.run_id,self.building_id,self.building_version,sign.sign_id):
                    raise ValueError("latest command belongs to another run, building, or sign")
                if command.guidance_version > self.guidance_version:
                    raise ValueError("command cannot be newer than snapshot")
            elif sign.application_status != "NOT_ISSUED":
                raise ValueError("unissued sign must be NOT_ISSUED")
            for terminal in sign.terminals:
                ack = terminal.last_ack
                if (ack.terminal_instance_id,ack.run_id,ack.sign_id) != (terminal.terminal_instance_id,self.run_id,sign.sign_id):
                    raise ValueError("terminal ACK identity mismatch")
            if sign.application_status == "APPLIED":
                if command is None or command.guidance_version != self.guidance_version or len(sign.terminals) != 1:
                    raise ValueError("APPLIED needs the current command and exactly one terminal")
                terminal = sign.terminals[0]
                ack = terminal.last_ack
                if not terminal.verified or ack.status != "APPLIED":
                    raise ValueError("APPLIED needs a verified application ACK")
                if (ack.command_id,ack.command_sequence,ack.guidance_version) != (command.command_id,command.command_sequence,command.guidance_version):
                    raise ValueError("old ACK cannot confirm current command")
                faces = {f.face_id:(f.mode,f.display) for f in ack.faces}
                if faces != {f.face_id:(f.mode,f.display) for f in command.faces} or sign.faces != command.faces:
                    raise ValueError("applied faces must match current command and guidance")
        return self

"""Pure contract checks. B01/B03 own serialized history updates and persistence."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from math import isfinite
from typing import Mapping

from pydantic import ValidationError

from .building import Building
from .messages import (
    ArmReceipt, ClearReceipt, ClearRequest, ControlRequest, ErrorDetail, ErrorResponse,
    EventReceipt, ObservationEvent, ResetReceipt, Route, Session, SignAck, SignCommand, SimulationState, StateSnapshot,
)

MODEL_TYPES = {model.__name__: model for model in (
    Building, Session, ObservationEvent, SignCommand, SignAck, ControlRequest, ClearRequest,
    EventReceipt, ArmReceipt, ClearReceipt, ResetReceipt, ErrorResponse, Route, StateSnapshot, SimulationState,
)}

ERROR_STATUS = {
    "INVALID_EVENT_COMBINATION": 400, "UNKNOWN_SOURCE": 404, "UNKNOWN_SIGN": 404,
    "RUN_MISMATCH": 409, "BUILDING_MISMATCH": 409, "STALE_SEQUENCE": 409,
    "EVENT_ID_CONFLICT": 409, "STALE_OBSERVATION": 409, "CLOCK_INVALID": 409,
    "SOURCE_CAUSE_INACTIVE": 409, "SCHEMA_VALIDATION_FAILED": 422,
    "CONTROLLER_NOT_READY": 503, "COMMAND_MISMATCH": 409, "COMMAND_EXPIRED": 409,
}


class ContractError(ValueError):
    def __init__(self, code: str, message: str, field: str | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = ERROR_STATUS[code]
        self.field = field

    def to_response(self) -> ErrorResponse:
        return ErrorResponse(error=ErrorDetail(code=self.code, message=str(self), field=self.field))


def parse_contract(model_name: str, payload):
    """Parse decoded JSON. Unknown model names are programmer errors, not API input."""
    try:
        return MODEL_TYPES[model_name].model_validate(payload)
    except ValidationError as error:
        errors = error.errors(include_input=False, include_url=False)
        structural = [e for e in errors if e["type"] != "invalid_event_combination"]
        first = (structural or errors)[0]
        code = "SCHEMA_VALIDATION_FAILED" if structural else "INVALID_EVENT_COMBINATION"
        field = ".".join(map(str, first["loc"])) or None
        raise ContractError(code, first["msg"], field) from error


@dataclass(frozen=True)
class EventContext:
    building: Building
    session: Session
    now: datetime
    last_sequences: Mapping[str, int]
    seen_events: Mapping[str, ObservationEvent]
    future_tolerance_ms: int = 0


@dataclass(frozen=True)
class EventCheck:
    duplicate: bool
    remaining_valid_for_ms: int


def check_identity(message, session: Session, building: Building):
    if message.run_id != session.run_id:
        raise ContractError("RUN_MISMATCH", "실행이 변경되었습니다", "run_id")
    expected = (building.building_id, building.building_version)
    if (session.building_id, session.building_version) != expected or (message.building_id, message.building_version) != expected:
        raise ContractError("BUILDING_MISMATCH", "건물 또는 자료 버전이 일치하지 않습니다", "building_version")


def check_event(event: ObservationEvent, context: EventContext) -> EventCheck:
    check_identity(event, context.session, context.building)
    source = next((s for s in context.building.sources if s.source_id == event.source_id), None)
    if source is None:
        raise ContractError("UNKNOWN_SOURCE", "등록되지 않은 관측원입니다", "source_id")
    if source.source_type != event.source_type or (event.hazard_type and event.hazard_type not in source.allowed_hazard_types):
        raise ContractError("INVALID_EVENT_COMBINATION", "관측원 설정과 입력 유형이 다릅니다", "source_type")
    previous = context.seen_events.get(event.event_id)
    if previous is not None:
        if previous != event:
            raise ContractError("EVENT_ID_CONFLICT", "같은 이벤트 ID에 다른 내용이 있습니다", "event_id")
        return EventCheck(duplicate=True, remaining_valid_for_ms=0)
    if event.source_sequence <= context.last_sequences.get(event.source_id, 0):
        raise ContractError("STALE_SEQUENCE", "관측 순번이 증가하지 않았습니다", "source_sequence")
    if context.now.tzinfo is None or context.now.utcoffset() != timedelta(0):
        raise ValueError("context.now must be aware UTC")
    if type(context.future_tolerance_ms) is not int or context.future_tolerance_ms < 0:
        raise ValueError("future_tolerance_ms must be a nonnegative integer")
    age_ms = (context.now - datetime.fromisoformat(event.observed_at)).total_seconds() * 1000
    if age_ms < -context.future_tolerance_ms:
        raise ContractError("CLOCK_INVALID", "허용하지 않는 미래 관측입니다", "observed_at")
    if age_ms >= source.freshness_ms:
        raise ContractError("STALE_OBSERVATION", "관측 유효기간이 지났습니다", "observed_at")
    return EventCheck(duplicate=False, remaining_valid_for_ms=int(source.freshness_ms - max(0, age_ms)))


def check_command(command: SignCommand, session: Session, building: Building, sign_id: str, last_sequence: int):
    check_identity(command, session, building)
    sign = next((s for s in building.signs if s.sign_id == sign_id), None)
    if sign is None or command.sign_id != sign_id:
        raise ContractError("UNKNOWN_SIGN", "명령 대상 유도등이 다릅니다", "sign_id")
    if command.command_sequence <= last_sequence:
        raise ContractError("STALE_SEQUENCE", "명령 순번이 증가하지 않았습니다", "command_sequence")
    if {f.face_id for f in command.faces} != {f.face_id for f in sign.faces}:
        raise ContractError("COMMAND_MISMATCH", "표시면 구성이 다릅니다", "faces")
    exits = {e.exit_id: e for e in building.exits}
    definitions = {f.face_id: f for f in sign.faces}
    for face in command.faces:
        if face.mode in {"NO_ROUTE", "UNKNOWN"}: continue
        definition = definitions[face.face_id]
        exit = exits.get(face.exit_id)
        if exit is None or not exit.enabled:
            raise ContractError("COMMAND_MISMATCH", "출구가 없거나 사용할 수 없습니다", "faces.exit_id")
        if face.display == "EXIT":
            valid = exit.node_id == sign.node_id and definition.next_node_to_display.get(sign.node_id) == "EXIT"
        else:
            valid = definition.next_node_to_display.get(face.next_node_id) == face.display
        if face.mode == "DEFAULT":
            valid = valid and definition.default_next_node_id == (face.next_node_id or sign.node_id)
        if not valid:
            raise ContractError("COMMAND_MISMATCH", "표시면 방향 매핑이 일치하지 않습니다", "faces.display")


def check_ack(ack: SignAck, command: SignCommand, *, now_monotonic_ms: float, expires_at_monotonic_ms: float) -> bool:
    if not all(isfinite(value) for value in (now_monotonic_ms, expires_at_monotonic_ms)):
        raise ValueError("ACK monotonic times must be finite")
    if ack.run_id != command.run_id:
        raise ContractError("RUN_MISMATCH", "다른 실행의 응답입니다", "run_id")
    for field in ("sign_id", "command_id", "command_sequence", "guidance_version"):
        if getattr(ack, field) != getattr(command, field):
            raise ContractError("COMMAND_MISMATCH", "발행한 명령과 응답이 다릅니다", field)
    if now_monotonic_ms >= expires_at_monotonic_ms:
        raise ContractError("COMMAND_EXPIRED", "만료된 명령의 응답입니다", "command_id")
    if ack.status == "REJECTED": return False
    expected = {f.face_id: (f.mode, f.display) for f in command.faces}
    actual = {f.face_id: (f.mode, f.display) for f in ack.faces}
    if actual != expected:
        raise ContractError("COMMAND_MISMATCH", "적용 표시면 결과가 명령과 다릅니다", "faces")
    return True

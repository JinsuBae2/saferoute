"""One-process observation state. All transitions and expiry share one lock."""

from datetime import datetime, timezone
from threading import RLock
import time
from uuid import uuid4

from .audit import AuditLog
from .contracts import ContractError, EventContext, check_event, parse_contract
from .contracts.messages import (
    ActiveCause, ArmReceipt, ClearReceipt, EventReceipt, ResetReceipt, Session,
    SourceState, StateSnapshot,
)


class Clock:
    def utcnow(self): return datetime.now(timezone.utc)
    def monotonic_ms(self): return time.monotonic() * 1000


def utc_text(value):
    return value.isoformat().replace("+00:00", "Z")


class Controller:
    def __init__(self, building, runs_dir, *, clock=None, operator_id="local-operator"):
        self.building = building.model_copy(deep=True)
        self.clock = clock or Clock()
        self.operator_id = operator_id
        self.lock = RLock()
        self.audit = AuditLog(runs_dir)
        self.audit_failed = False
        self.source_config = {s.source_id: s for s in self.building.sources}
        self.zones = {z.zone_id: z for z in self.building.zones}
        self._start_run(str(uuid4()))

    def _start_run(self, run_id):
        self.audit.begin(run_id, self.building, utc_text(self.clock.utcnow()))
        self.run_id = run_id
        self.armed = False
        self.guidance_version = 0
        self.sources = {s.source_id: SourceState(source_id=s.source_id, validity="INITIALIZING",
                        last_event_id=None, last_observed_at=None, last_source_sequence=None)
                        for s in self.building.sources}
        self.deadlines = {}
        self.active_causes = {}
        self.seen_events = {}
        self.last_sequences = {}
        self._write("decisions", operation="start", actor=self.operator_id, reason="new run")
        self._snapshot = self._build_snapshot()

    def _ensure_ready(self):
        if self.audit_failed:
            raise ContractError("CONTROLLER_NOT_READY", "실행 기록 오류로 제어를 중단했습니다")

    def _write(self, category, **record):
        self._ensure_ready()
        record.update(run_id=self.run_id, recorded_at=utc_text(self.clock.utcnow()),
                      server_monotonic_ms=self.clock.monotonic_ms())
        try:
            self.audit.write(self.run_id, category, record)
        except (OSError, ValueError) as error:
            self.audit_failed = True
            raise ContractError("CONTROLLER_NOT_READY", "실행 기록을 저장하지 못했습니다") from error

    def _mode(self):
        if not self.armed: return "INITIALIZING"
        if self.active_causes: return "EMERGENCY"
        if any(s.required and self.sources[s.source_id].validity != "VALID" for s in self.building.sources):
            return "DEGRADED"
        return "NORMAL"

    def _session(self):
        return Session(schema_version=1, run_id=self.run_id, building_id=self.building.building_id,
                       building_version=self.building.building_version, controller_mode=self._mode())

    def _decision_key(self):
        return (self._mode(), tuple(sorted(self.active_causes)),
                tuple((s.source_id, self.sources[s.source_id].validity == "VALID")
                      for s in self.building.sources if s.required))

    def _publish(self, before, operation, **evidence):
        if before != self._decision_key(): self.guidance_version += 1
        snapshot = self._build_snapshot()
        self._write("decisions", operation=operation, guidance_version=self.guidance_version,
                    controller_mode=snapshot.controller_mode,
                    active_causes=[c.model_dump(mode="json") for c in snapshot.active_causes],
                    sources=[s.model_dump(mode="json") for s in snapshot.sources],
                    blocked_nodes=[n.model_dump(mode="json") for n in snapshot.blocked_nodes],
                    blocked_edges=[e.model_dump(mode="json") for e in snapshot.blocked_edges], **evidence)
        self._snapshot = snapshot

    def _build_snapshot(self):
        blocked_nodes, blocked_edges = {}, {}

        def block(targets, ids, reason, source_id=None):
            for item_id in ids:
                entry = targets.setdefault(item_id, {"source_ids": set(), "reason_codes": set()})
                if source_id: entry["source_ids"].add(source_id)
                entry["reason_codes"].add(reason)

        for source in self.building.sources:
            zone = self.zones[source.zone_id]
            reasons = []
            if any(key[0] == source.source_id for key in self.active_causes): reasons.append("ACTIVE_ALARM")
            if source.required and self.sources[source.source_id].validity != "VALID":
                reasons.append("REQUIRED_OBSERVATION_UNKNOWN")
            for reason in reasons:
                block(blocked_nodes, zone.blocked_node_ids, reason, source.source_id)
                block(blocked_edges, zone.blocked_edge_ids, reason, source.source_id)
        block(blocked_edges, [e.edge_id for e in self.building.edges if not e.traversable], "NOT_TRAVERSABLE")

        def blocked_list(items, key):
            return [{key: item_id, "source_ids": sorted(value["source_ids"]), "reason_codes": sorted(value["reason_codes"])}
                    for item_id, value in sorted(items.items())]

        # B02/B03 will supply routes and commands. B01 must not invent usable arrows.
        reason = "INITIALIZING" if not self.armed else "CONTROLLER_UNAVAILABLE"
        return StateSnapshot(**self._session().model_dump(), guidance_version=self.guidance_version,
            generated_at=utc_text(self.clock.utcnow()),
            sources=[s.model_copy(deep=True) for s in self.sources.values()],
            active_causes=[self.active_causes[key].model_copy(deep=True) for key in sorted(self.active_causes)],
            blocked_nodes=blocked_list(blocked_nodes,"node_id"), blocked_edges=blocked_list(blocked_edges,"edge_id"),
            routes=[dict(node_id=n.node_id,next_node_id=None,exit_id=None,path_node_ids=[],cost=None,reason_codes=[reason]) for n in self.building.nodes],
            signs=[dict(sign_id=s.sign_id,faces=[dict(face_id=f.face_id,mode="UNKNOWN",display=None,next_node_id=None,exit_id=None,reason_codes=[reason]) for f in s.faces],latest_command=None,application_status="NOT_ISSUED",terminals=[]) for s in self.building.signs])

    def _expire_locked(self):
        self._ensure_ready()
        expired = [source for source, deadline in self.deadlines.items() if self.clock.monotonic_ms() >= deadline]
        if not expired: return
        before = self._decision_key()
        for source in expired:
            self.sources[source].validity = "STALE"
            del self.deadlines[source]
        self._publish(before, "expire", source_ids=sorted(expired))

    def expire(self):
        with self.lock: self._expire_locked()

    def session(self):
        with self.lock:
            self._expire_locked()
            return self._session()

    def snapshot(self):
        with self.lock:
            self._expire_locked()
            return self._snapshot.model_copy(deep=True)

    def record_rejection(self, payload, error, operation="event"):
        with self.lock:
            self._write("events", operation=operation, outcome="rejected", payload=payload,
                        error_code=error.code, field=error.field)

    def receive(self, payload):
        with self.lock:
            self._expire_locked()
            try:
                event = parse_contract("ObservationEvent", payload)
                received_monotonic = self.clock.monotonic_ms()
                result = check_event(event, EventContext(self.building, self._session(), self.clock.utcnow(),
                                                        self.last_sequences, self.seen_events))
            except ContractError as error:
                self.record_rejection(payload,error)
                raise
            self._write("events", operation="event", outcome="duplicate" if result.duplicate else "accepted",
                        payload=event.model_dump(mode="json"), error_code=None)
            if not result.duplicate:
                before = self._decision_key()
                self.seen_events[event.event_id] = event.model_copy(deep=True)
                self.last_sequences[event.source_id] = event.source_sequence
                source = self.sources[event.source_id]
                source.last_event_id, source.last_source_sequence = event.event_id, event.source_sequence
                if event.event_kind == "UNAVAILABLE":
                    source.validity = "UNAVAILABLE"
                    source.last_observed_at = event.observed_at
                    self.deadlines.pop(event.source_id,None)
                elif not (event.source_type == "VIDEO_AI" and event.event_kind == "HEARTBEAT"):
                    source.validity = "VALID"
                    source.last_observed_at = event.observed_at
                    self.deadlines[event.source_id] = received_monotonic + result.remaining_valid_for_ms
                if event.event_kind == "ALARM":
                    key = (event.source_id,event.hazard_type)
                    if key in self.active_causes:
                        self.active_causes[key].last_event_id = event.event_id
                    else:
                        self.active_causes[key] = ActiveCause(source_id=event.source_id,hazard_type=event.hazard_type,
                            first_event_id=event.event_id,last_event_id=event.event_id,activated_at=utc_text(self.clock.utcnow()))
                self._publish(before,"event",event_id=event.event_id)
            return EventReceipt(accepted=True,duplicate=result.duplicate,event_id=event.event_id,
                                run_id=self.run_id,guidance_version=self.guidance_version)

    def _control(self, operation, payload):
        request = parse_contract("ClearRequest" if operation == "clear" else "ControlRequest",payload)
        if request.run_id != self.run_id:
            raise ContractError("RUN_MISMATCH", "실행이 변경되었습니다", "run_id")
        if operation == "arm":
            if any(s.required and self.sources[s.source_id].validity != "VALID" for s in self.building.sources):
                raise ContractError("CONTROLLER_NOT_READY", "필수 관측을 먼저 확인해야 합니다")
        elif operation == "clear":
            source = self.source_config.get(request.source_id)
            if source is None: raise ContractError("UNKNOWN_SOURCE", "등록되지 않은 관측원입니다", "source_id")
            if request.hazard_type not in source.allowed_hazard_types:
                raise ContractError("INVALID_EVENT_COMBINATION", "허용하지 않는 경보 원인입니다", "hazard_type")
            if (request.source_id,request.hazard_type) not in self.active_causes:
                raise ContractError("SOURCE_CAUSE_INACTIVE", "활성화되지 않은 경보 원인입니다", "hazard_type")
        return request

    def _apply_control(self, operation, payload):
        with self.lock:
            self._expire_locked()
            try: request = self._control(operation,payload)
            except ContractError as error:
                self.record_rejection(payload,error,operation)
                raise
            evidence = dict(actor=self.operator_id,reason=request.reason)
            self._write("events",operation=operation,outcome="accepted",payload=request.model_dump(mode="json"),**evidence)
            before = self._decision_key()
            if operation == "reset":
                previous, new = self.run_id, str(uuid4())
                self._write("decisions",operation="reset",next_run_id=new,**evidence)
                try: self._start_run(new)
                except OSError as error:
                    self.audit_failed = True
                    raise ContractError("CONTROLLER_NOT_READY", "새 실행 기록을 만들지 못했습니다") from error
                return ResetReceipt(previous_run_id=previous,run_id=new,controller_mode="INITIALIZING")
            if operation == "arm":
                self.armed = True
            else:
                del self.active_causes[(request.source_id,request.hazard_type)]
                evidence.update(source_id=request.source_id,hazard_type=request.hazard_type)
            self._publish(before,operation,**evidence)
            if operation == "arm": return ArmReceipt(run_id=self.run_id,controller_mode=self._mode(),armed=True)
            return ClearReceipt(run_id=self.run_id,source_id=request.source_id,hazard_type=request.hazard_type,
                                cleared=True,guidance_version=self.guidance_version)

    def arm(self, payload): return self._apply_control("arm",payload)
    def clear(self, payload): return self._apply_control("clear",payload)
    def reset(self, payload): return self._apply_control("reset",payload)

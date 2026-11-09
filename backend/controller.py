"""One-process observation state. All transitions and expiry share one lock."""

from datetime import datetime, timezone
from threading import RLock
import time
from uuid import uuid4

from .audit import AuditLog
from .contracts import ContractError, EventContext, check_ack, check_command, check_event, parse_contract
from .contracts.messages import (
    ActiveCause, ArmReceipt, BlockedEdge, BlockedNode, ClearReceipt, EventReceipt, ResetReceipt, Session,
    SignCommand, SignState, SourceState, StateSnapshot, TerminalState,
)
from .guidance import sign_faces
from .routing import calculate_routes, unavailable_routes, validate_default_routes


class Clock:
    def utcnow(self): return datetime.now(timezone.utc)
    def monotonic_ms(self): return time.monotonic() * 1000


def utc_text(value):
    return value.isoformat().replace("+00:00", "Z")


class Controller:
    def __init__(self, building, runs_dir, *, clock=None, operator_id="local-operator"):
        self.building = building.model_copy(deep=True)
        self.normal_routes = validate_default_routes(self.building)
        self.clock = clock or Clock()
        self.operator_id = operator_id
        self.lock = RLock()
        self.audit = AuditLog(runs_dir)
        self.audit_failed = False
        self.closed = False
        self.source_config = {s.source_id: s for s in self.building.sources}
        self.zones = {z.zone_id: z for z in self.building.zones}
        self.sign_config = {s.sign_id: s for s in self.building.signs}
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
        self.commands = {}
        self.latest_commands = {}
        self.command_sequences = {}
        self.terminals = {sign_id: {} for sign_id in self.sign_config}
        self.seen_acks = {}
        self._route_key = None
        self._routes = []
        self._write("decisions", operation="start", actor=self.operator_id, reason="new run")
        self._snapshot = self._build_snapshot()

    def _ensure_ready(self):
        if self.audit_failed or self.closed:
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
                    blocked_edges=[e.model_dump(mode="json") for e in snapshot.blocked_edges],
                    routes=[r.model_dump(mode="json") for r in snapshot.routes],
                    signs=[s.model_dump(mode="json") for s in snapshot.signs], **evidence)
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

        node_blocks = [BlockedNode(**item) for item in blocked_list(blocked_nodes,"node_id")]
        edge_blocks = [BlockedEdge(**item) for item in blocked_list(blocked_edges,"edge_id")]
        key = self._decision_key()
        if key != self._route_key:
            mode = self._mode()
            if mode == "NORMAL": self._routes = self.normal_routes
            elif mode in {"EMERGENCY", "DEGRADED"}: self._routes = calculate_routes(self.building,node_blocks,edge_blocks)
            else:
                self._routes = unavailable_routes(self.building, "INITIALIZING")
            self._route_key = key
        return StateSnapshot(**self._session().model_dump(), guidance_version=self.guidance_version,
            generated_at=utc_text(self.clock.utcnow()),
            sources=[s.model_copy(deep=True) for s in self.sources.values()],
            active_causes=[self.active_causes[key].model_copy(deep=True) for key in sorted(self.active_causes)],
            blocked_nodes=node_blocks, blocked_edges=edge_blocks,
            routes=self._routes,
            signs=self._sign_states())

    def _sign_states(self):
        routes = {r.node_id: r for r in self._routes}
        result = []
        now = self.clock.monotonic_ms()
        for sign in self.building.signs:
            faces = sign_faces(sign, routes[sign.node_id], self._mode())
            command = self.latest_commands.get(sign.sign_id)
            terminals = list(self.terminals[sign.sign_id].values())
            status = "NOT_ISSUED"
            if command:
                status = "PENDING"
                if len(terminals) > 1:
                    status = "DUPLICATE_TERMINAL"
                elif now >= self.commands[command.command_id][2]:
                    status = "EXPIRED"
                elif terminals and command.guidance_version == self.guidance_version and command.faces == faces:
                    terminal = terminals[0]
                    if terminal.last_ack.command_id == command.command_id:
                        status = "APPLIED" if terminal.verified else "REJECTED"
            result.append(SignState(sign_id=sign.sign_id, faces=faces, latest_command=command,
                                    application_status=status, terminals=terminals))
        return result

    def _expire_locked(self):
        self._ensure_ready()
        while True:
            expired = [source for source, deadline in self.deadlines.items() if self.clock.monotonic_ms() >= deadline]
            if expired:
                before = self._decision_key()
                for source in expired:
                    self.sources[source].validity = "STALE"
                    del self.deadlines[source]
                self._publish(before, "expire", source_ids=sorted(expired))
                continue
            snapshot = self._build_snapshot()
            if [s.application_status for s in snapshot.signs] != [s.application_status for s in self._snapshot.signs]:
                self._write("decisions", operation="command_expire", guidance_version=self.guidance_version,
                            signs=[s.model_dump(mode="json") for s in snapshot.signs])
                self._snapshot = snapshot
                continue
            self._snapshot = snapshot
            return

    def expire(self):
        with self.lock: self._expire_locked()

    def _finish_run(self, reason):
        try:
            self.audit.finish(self.run_id, utc_text(self.clock.utcnow()), reason)
        except (OSError, ValueError) as error:
            self.audit_failed = True
            raise ContractError("CONTROLLER_NOT_READY", "실행 종료 기록을 저장하지 못했습니다") from error

    def close(self):
        with self.lock:
            if self.closed: return
            self._write("decisions", operation="stop", actor=self.operator_id, reason="controller shutdown")
            self._finish_run("shutdown")
            self.closed = True

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
            category = "acks" if operation == "ack" or operation.endswith("/ack") else "commands" if operation == "command" else "events"
            self._write(category, operation=operation, outcome="rejected", payload=payload,
                        error_code=error.code, field=error.field)

    def _sign(self, sign_id):
        if sign_id not in self.sign_config:
            raise ContractError("UNKNOWN_SIGN", "등록되지 않은 유도등입니다", "sign_id")
        return next(s for s in self._snapshot.signs if s.sign_id == sign_id)

    def issue_command(self, sign_id):
        with self.lock:
            self._expire_locked()
            try:
                sign = self._sign(sign_id)
            except ContractError as error:
                self.record_rejection({"sign_id": sign_id}, error, "command")
                raise
            sequence = self.command_sequences.get(sign_id, 0)
            issued = self.clock.monotonic_ms()
            command = SignCommand(schema_version=1, run_id=self.run_id,
                building_id=self.building.building_id, building_version=self.building.building_version,
                guidance_version=self.guidance_version, sign_id=sign_id, command_id=str(uuid4()),
                command_sequence=sequence + 1, issued_at=utc_text(self.clock.utcnow()),
                valid_for_ms=3000, faces=sign.faces)
            check_command(command, self._session(), self.building, sign_id, sequence)
            expires = issued + command.valid_for_ms
            self._write("commands", operation="issue", command=command.model_dump(mode="json"),
                        issued_monotonic_ms=issued, expires_at_monotonic_ms=expires)
            self.commands[command.command_id] = (command, issued, expires)
            self.latest_commands[sign_id] = command
            self.command_sequences[sign_id] = command.command_sequence
            self._snapshot = self._build_snapshot()
            # Audit I/O holds the lock; the expiry task cannot update us during it.
            self._expire_locked()
            error = None
            if self.clock.monotonic_ms() >= expires:
                error = ContractError("COMMAND_EXPIRED", "발행 중 명령 기한이 지났습니다", "command_id")
            elif command.guidance_version != self.guidance_version:
                error = ContractError("COMMAND_MISMATCH", "발행 중 안내가 변경됐습니다. 새 명령을 조회하세요", "guidance_version")
            if error:
                self._write("commands", operation="discard", outcome="discarded", command_id=command.command_id,
                            error_code=error.code)
                raise error
            return command.model_copy(deep=True)

    def acknowledge(self, sign_id, payload):
        with self.lock:
            self._expire_locked()
            try:
                ack = parse_contract("SignAck", payload)
                self._sign(sign_id)
                if ack.run_id != self.run_id:
                    raise ContractError("RUN_MISMATCH", "실행이 변경되었습니다", "run_id")
                if ack.sign_id != sign_id:
                    raise ContractError("COMMAND_MISMATCH", "요청 경로와 응답 대상이 다릅니다", "sign_id")
                entry = self.commands.get(ack.command_id)
                if entry is None:
                    raise ContractError("COMMAND_MISMATCH", "발행하지 않은 명령의 응답입니다", "command_id")
                command, issued, expires = entry
                received = self.clock.monotonic_ms()
                verified = check_ack(ack, command, now_monotonic_ms=received, expires_at_monotonic_ms=expires)
                key = (ack.command_id, ack.terminal_instance_id)
                previous = self.seen_acks.get(key)
                if previous is not None and previous != ack:
                    raise ContractError("COMMAND_MISMATCH", "같은 단말·명령에 다른 응답이 있습니다", "command_id")
            except ContractError as error:
                self.record_rejection(payload, error, "ack")
                raise
            latest = self.latest_commands[sign_id]
            current = latest.command_id == command.command_id and command.guidance_version == self.guidance_version
            self._write("acks", operation="ack", outcome="duplicate" if previous else "accepted",
                        payload=ack.model_dump(mode="json"), verified=verified, confirms_current=current and verified,
                        server_ack_elapsed_ms=received - issued, received_monotonic_ms=received, error_code=None)
            if previous is None:
                self.seen_acks[key] = ack
                terminal = self.terminals[sign_id].get(ack.terminal_instance_id)
                if terminal is None or terminal.last_ack.command_sequence < ack.command_sequence:
                    self.terminals[sign_id][ack.terminal_instance_id] = TerminalState(
                        terminal_instance_id=ack.terminal_instance_id, last_ack=ack,
                        received_at=utc_text(self.clock.utcnow()), verified=verified)
            self._snapshot = self._build_snapshot()
            self._expire_locked()
            return self._sign(sign_id).model_copy(deep=True)

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
                self._finish_run("reset")
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

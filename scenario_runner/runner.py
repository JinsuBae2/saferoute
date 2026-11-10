"""Independent truth clock and delayed simulated-sensor producer, never a route planner."""

from datetime import datetime, timedelta, timezone
import hashlib
import heapq
import json
import os
from pathlib import Path
from threading import RLock
import time
from uuid import uuid4

import httpx

from backend.contracts import parse_contract
from backend.contracts.messages import SimulationState


class Clock:
    def utcnow(self): return datetime.now(timezone.utc)
    def monotonic_ms(self): return time.monotonic() * 1000


class Runner:
    def __init__(self, building, scenario, client, runs_dir, *, clock=None):
        self.building, self.scenario = building, scenario.validate_for(building)
        self.client, self.runs_dir, self.clock = client, Path(runs_dir), clock or Clock()
        self.lock = RLock()
        self.sources = {s.source_id: s for s in building.sources}
        self._fresh()

    def _fresh(self):
        self.run_id = None
        self.status, self.error_code = "WAITING_FOR_ARM", None
        self.time_ms, self.sequence = 0, 0
        self.source_sequences = {r.source_id: 0 for r in self.scenario.observation_rules}
        self.next_sample = dict.fromkeys(self.source_sequences, 0)
        self.queue, self.queue_order = [], 0
        self.log_path = None
        self.auto_arm = False

    def restart(self):
        """Explicit request only: reset the controller, rebind to the new run, then arm once observations are valid."""
        with self.lock:
            session = self._get("/api/session", "Session")
            self.client.post("/api/control/reset", json=dict(schema_version=1, run_id=session.run_id,
                                                             reason="simulation restart")).raise_for_status()
            self.close()
            self._fresh()
            self.auto_arm = True
            self._bind()

    def _get(self, path, model):
        response = self.client.get(path)
        response.raise_for_status()
        return parse_contract(model, response.json())

    def _bind(self):
        state = self._get("/api/state", "StateSnapshot")
        remote = self._get("/api/building", "Building")
        if remote != self.building: raise ValueError("controller building content does not match scenario building")
        if state.controller_mode != "INITIALIZING": raise ValueError("scenario needs an INITIALIZING controller")
        if any(s.last_source_sequence is not None for s in state.sources if s.source_id in self.source_sequences):
            raise ValueError("scenario needs fresh owned sources; reset the controller first")
        self.run_id = state.run_id
        self.initial_due = dict.fromkeys(self.source_sequences, self.clock.monotonic_ms())
        directory = self.runs_dir / self.run_id / "simulations" / str(uuid4())
        directory.mkdir(parents=True, exist_ok=False)
        self.log_path = directory / "scenario.jsonl"
        self.log_path.touch(exist_ok=False)
        config = self.scenario.model_dump_json().encode("utf-8")
        (directory / "scenario.json").write_bytes(config)
        manifest = dict(schema_version=1,run_id=self.run_id,scenario_id=self.scenario.scenario_id,
            building_id=self.building.building_id,building_version=self.building.building_version,
            building_sha256=hashlib.sha256(self.building.model_dump_json().encode("utf-8")).hexdigest(),
            scenario_sha256=hashlib.sha256(config).hexdigest(),seed=self.scenario.seed,
            source="SIMULATED_SENSORS",clock_origin="first observed armed session",interpolation="step")
        (directory / "manifest.json").write_text(json.dumps(manifest,ensure_ascii=False)+"\n",encoding="utf-8")
        self._log("start")

    def _log(self, operation, **values):
        record = dict(operation=operation,run_id=self.run_id,simulation_time_ms=self.time_ms,
            simulation_sequence=self.sequence,recorded_at=self.clock.utcnow().isoformat(),**values)
        with self.log_path.open("a",encoding="utf-8") as stream:
            stream.write(json.dumps(record,ensure_ascii=False,allow_nan=False)+"\n")
            stream.flush()
            os.fsync(stream.fileno())

    def _event(self, source_id, observed_at, kind, hazard=None):
        self.source_sequences[source_id] += 1
        source = self.sources[source_id]
        return dict(schema_version=1,run_id=self.run_id,building_id=self.building.building_id,
            building_version=self.building.building_version,event_id=str(uuid4()),source_id=source_id,
            source_type=source.source_type,source_sequence=self.source_sequences[source_id],event_kind=kind,
            hazard_type=hazard,validity="UNAVAILABLE" if kind=="UNAVAILABLE" else "VALID",
            observed_at=observed_at.isoformat().replace("+00:00","Z"),media_time_ms=None,confidence=None,
            reason_code="SIM_FAULT" if kind=="UNAVAILABLE" else None)

    def _send(self, event):
        response = self.client.post("/api/events",json=event)
        if response.is_success:
            receipt = parse_contract("EventReceipt",response.json())
            if receipt.run_id != self.run_id or receipt.event_id != event["event_id"]:
                raise ValueError("event receipt does not match producer")
            self._log("send",event=event,outcome="accepted",error_code=None)
        else:
            error = parse_contract("ErrorResponse",response.json()).error.code
            self._log("send",event=event,outcome="rejected",error_code=error)
            if self.status == "WAITING_FOR_ARM" and error == "STALE_SEQUENCE":
                self._fail("SOURCE_CONFLICT")
            elif error not in {"STALE_OBSERVATION", "STALE_SEQUENCE"}:
                self._fail(error)

    def _fail(self, code):
        self.status, self.error_code = "FAILED", code
        try:
            self._log("failed",error_code=code,discarded_events=len(self.queue))
        except OSError:
            self.error_code = "LOG_WRITE_FAILED"
        finally:
            self.queue.clear()

    def _schedule(self, rule, sample_ms):
        source = self.sources[rule.source_id]
        alarm = self.scenario.smoke_at(sample_ms)[source.zone_id] >= rule.threshold
        hazard = "SMOKE" if source.source_type == "SIM_SMOKE_DETECTOR" else "SPRINKLER"
        kind, hazard = ("ALARM",hazard) if alarm else ("OBSERVATION",None)
        fault = next((f for f in self.scenario.faults if f.source_id == rule.source_id and
                      f.start_ms <= sample_ms < f.end_ms),None)
        if fault and fault.kind == "UNAVAILABLE": kind, hazard = "UNAVAILABLE", None
        event = self._event(rule.source_id,self.epoch_utc + timedelta(milliseconds=sample_ms),kind,hazard)
        if fault and fault.kind == "DROP":
            self._log("drop",sample_time_ms=sample_ms,event=event)
            return
        due = sample_ms + rule.delay_ms + (fault.delay_ms if fault and fault.kind=="DELAY" else 0)
        self.queue_order += 1
        heapq.heappush(self.queue,(due,self.queue_order,event))
        self._log("sample",sample_time_ms=sample_ms,delivery_time_ms=due,event=event)

    def tick(self):
        with self.lock:
            if self.run_id is None: self._bind()
            if self.status in {"FAILED", "COMPLETED", "STOPPED"}: return
            try:
                session = self._get("/api/session","Session")
                if session.run_id != self.run_id:
                    self._fail("RUN_MISMATCH")
                    return
                if (session.building_id,session.building_version) != (self.building.building_id,self.building.building_version):
                    self._fail("BUILDING_MISMATCH")
                    return
                now = self.clock.monotonic_ms()
                if self.status == "WAITING_FOR_ARM":
                    if session.controller_mode == "INITIALIZING":
                        initial = {o.source_id:o for o in self.scenario.initial_observations}
                        for rule in self.scenario.observation_rules:
                            if now >= self.initial_due[rule.source_id]:
                                item = initial[rule.source_id]
                                self._send(self._event(rule.source_id,self.clock.utcnow(),item.event_kind,item.hazard_type))
                                if self.status == "FAILED": return
                                self.initial_due[rule.source_id] = now + rule.interval_ms
                        if self.auto_arm:
                            # 필수 관측이 아직 유효하지 않으면 제어기가 거부한다. 다음 틱에 다시 요청한다.
                            self.client.post("/api/control/arm", json=dict(schema_version=1, run_id=self.run_id,
                                                                           reason="simulation restart"))
                        return
                    self.status = "RUNNING"
                    self.epoch_ms, self.epoch_utc = now, self.clock.utcnow()
                    self._log("armed")
                self.time_ms = min(int(now-self.epoch_ms),self.scenario.duration_ms)
                self.sequence += 1
                for rule in self.scenario.observation_rules:
                    while self.next_sample[rule.source_id] <= self.time_ms and self.next_sample[rule.source_id] < self.scenario.duration_ms:
                        self._schedule(rule,self.next_sample[rule.source_id])
                        self.next_sample[rule.source_id] += rule.interval_ms
                while self.queue and self.queue[0][0] <= self.time_ms:
                    _, _, event = heapq.heappop(self.queue)
                    self._send(event)
                    if self.status == "FAILED": return
                if self.time_ms >= self.scenario.duration_ms:
                    self.status = "COMPLETED"
                    self._log("completed",discarded_events=len(self.queue))
                    self.queue.clear()
            except (httpx.HTTPError,ValueError) as error:
                self._fail("CONTROLLER_UNAVAILABLE" if isinstance(error,httpx.HTTPError) else "INVALID_RESPONSE")
            except OSError:
                self.status, self.error_code = "FAILED", "LOG_WRITE_FAILED"
                self.queue.clear()

    def state(self):
        with self.lock:
            return SimulationState(schema_version=1,building_id=self.building.building_id,
                building_version=self.building.building_version,scenario_id=self.scenario.scenario_id,
                run_id=self.run_id,simulation_time_ms=self.time_ms,simulation_sequence=self.sequence,
                status=self.status,zones=[dict(zone_id=zone,smoke=value) for zone,value in
                    sorted(self.scenario.smoke_at(self.time_ms).items())],error_code=self.error_code)

    def close(self):
        with self.lock:
            if self.run_id is not None and self.status in {"WAITING_FOR_ARM", "RUNNING"}:
                self.status = "STOPPED"
                self._log("stop",discarded_events=len(self.queue))
                self.queue.clear()

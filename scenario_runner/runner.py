"""Independent truth clock and delayed simulated-sensor producer, never a route planner."""

from datetime import datetime, timedelta, timezone
import hashlib
import heapq
import json
import math
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
        self.centers = {z.zone_id: (sum(p.x for p in z.polygon)/len(z.polygon), sum(p.z for p in z.polygon)/len(z.polygon), z.floor_id)
                        for z in building.zones}
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
        self.fires, self.next_fire_poll = {}, 0
        self.unreachable_since, self.retry_at = None, 0

    def _smoke(self, time_ms):
        """시간표 연기에, 화재 경보 구역에서 번지는 연기를 더한다. 가까운 곳이 먼저, 다른 층은 늦게·옅게 찬다."""
        smoke = self.scenario.smoke_at(time_ms)
        spread = self.scenario.spread
        if spread is None: return smoke
        # shortcut: 구역 중심 사이 직선거리라 벽·계단 종류를 보지 않는다, 확산 경로가 필요하면 통로 그래프 거리로 바꾼다.
        for zone_id, (x, z, floor) in self.centers.items():
            value = smoke.get(zone_id, 0)
            for fire_zone, started_ms in self.fires.items():
                fx, fz, fire_floor = self.centers[fire_zone]
                metres = math.hypot(x-fx, z-fz)
                begins = metres*spread.ms_per_m + (0 if floor == fire_floor else spread.floor_delay_ms)
                ceiling = 1 if floor == fire_floor else spread.other_floor_cap
                progress = (time_ms-started_ms-begins) / (spread.rise_ms*(1+metres/25))
                value = max(value, min(ceiling, max(0, progress)*ceiling))
            smoke[zone_id] = round(value, 2)
        return smoke

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
        alarm = self._smoke(sample_ms)[source.zone_id] >= rule.threshold
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
            if self.clock.monotonic_ms() < self.retry_at: return
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
                        self._recovered()
                        return
                    self.status = "RUNNING"
                    self.epoch_ms, self.epoch_utc = now, self.clock.utcnow()
                    self._log("armed")
                self.time_ms = min(int(now-self.epoch_ms),self.scenario.duration_ms)
                self.sequence += 1
                if self.scenario.spread is not None and now >= self.next_fire_poll:
                    # 제어기가 확정한 FIRE 원인만 불로 본다. 실행기 자신의 연기 경보를 불로 세면 스스로 번진다.
                    burning = {self.sources[c.source_id].zone_id for c in self._get("/api/state","StateSnapshot").active_causes
                               if c.hazard_type == "FIRE"}
                    self.fires = {zone: self.fires.get(zone, self.time_ms) for zone in burning}
                    self.next_fire_poll = now + 1000
                for rule in self.scenario.observation_rules:
                    while self.next_sample[rule.source_id] <= self.time_ms and self.next_sample[rule.source_id] < self.scenario.duration_ms:
                        self._schedule(rule,self.next_sample[rule.source_id])
                        self.next_sample[rule.source_id] += rule.interval_ms
                while self.queue and self.queue[0][0] <= self.time_ms:
                    # 보낸 뒤에 꺼낸다. 전송이 끊기면 그대로 남겨 다시 보내고, 이미 닿았던 것이면 제어기가 중복으로 걸러 낸다.
                    self._send(self.queue[0][2])
                    if self.status == "FAILED": return
                    heapq.heappop(self.queue)
                if self.time_ms >= self.scenario.duration_ms:
                    self.status = "COMPLETED"
                    self._log("completed",discarded_events=len(self.queue))
                    self.queue.clear()
                self._recovered()
            except httpx.TransportError as error:
                # 연결 실패·시간 초과는 일시적일 수 있다. 실행을 끝내지 않고 1초 뒤 다시 시도한다.
                # 그동안 제어기는 관측이 끊겨 스스로 안내를 멈추고, 늦게 닿은 옛 관측은 STALE_OBSERVATION으로 거부한다.
                now = self.clock.monotonic_ms()
                self.retry_at = now + 1000
                if self.unreachable_since is None:
                    self.unreachable_since, self.error_code = now, "CONTROLLER_UNAVAILABLE"
                    try: self._log("controller_unreachable",error=type(error).__name__,pending_events=len(self.queue))
                    except OSError:
                        self.status, self.error_code = "FAILED", "LOG_WRITE_FAILED"
                        self.queue.clear()
            except (httpx.HTTPError,ValueError) as error:
                self._fail("CONTROLLER_UNAVAILABLE" if isinstance(error,httpx.HTTPError) else "INVALID_RESPONSE")
            except OSError:
                self.status, self.error_code = "FAILED", "LOG_WRITE_FAILED"
                self.queue.clear()

    def _recovered(self):
        # 조회와 전송이 모두 끝까지 된 틱에서만 복구로 본다. 조회만 되고 전송이 막힌 상태를 복구로 적지 않는다.
        if self.unreachable_since is None: return
        self._log("controller_recovered",outage_ms=round(self.clock.monotonic_ms()-self.unreachable_since))
        self.unreachable_since, self.error_code = None, None

    def state(self):
        with self.lock:
            return SimulationState(schema_version=1,building_id=self.building.building_id,
                building_version=self.building.building_version,scenario_id=self.scenario.scenario_id,
                run_id=self.run_id,simulation_time_ms=self.time_ms,simulation_sequence=self.sequence,
                status=self.status,zones=[dict(zone_id=zone,smoke=value) for zone,value in
                    sorted(self._smoke(self.time_ms).items())],error_code=self.error_code)

    def close(self):
        with self.lock:
            if self.run_id is not None and self.status in {"WAITING_FOR_ARM", "RUNNING"}:
                self.status = "STOPPED"
                self._log("stop",discarded_events=len(self.queue))
                self.queue.clear()

"""Personal demo rooms: up to N isolated controller+simulation pairs inside this one process.

Each room owns its own Controller and scenario Runner (the existing classes, unchanged), so
alarms, routes, sign acks, simulation time and run evidence never cross rooms. The building
is shared read-only. Rooms are not restored after a server restart.
"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import logging
import secrets
from pathlib import Path
from threading import Condition, RLock
import time
from uuid import uuid4

import httpx

from scenario_runner.runner import Runner

from .contracts import ContractError
from .contracts.messages import DemoIgnition
from .contracts.validation import check_ignition_position
from .controller import Controller, utc_text

LOGGER = logging.getLogger(__name__)
COOKIE = "saferoute_room"
ROOM_HEADER, INTERNAL_HEADER = "X-Saferoute-Room", "X-Saferoute-Internal"


class RoomError(Exception):
    """Room-level refusal. Not part of the C02 contract error list, so it has its own response."""
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code

    def body(self):
        return {"error": {"code": self.code, "message": str(self), "field": None}}


class _Reply:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    @property
    def is_success(self): return 200 <= self.status_code < 300
    def json(self): return self._body

    def raise_for_status(self):
        if not self.is_success: raise httpx.HTTPError(f"controller refused: {self.status_code}")
        return self


class LocalClient:
    """The Runner's controller client without HTTP: same paths, same JSON, direct calls."""
    def __init__(self, controller):
        self.controller = controller

    def _call(self, function, *args):
        try:
            value = function(*args)
        except ContractError as error:
            return _Reply(error.status_code, error.to_response().model_dump(mode="json"))
        return _Reply(200, value.model_dump(mode="json"))

    def get(self, path):
        controller = self.controller
        calls = {"/api/session": controller.session, "/api/state": controller.snapshot,
                 "/api/building": lambda: controller.building}
        return self._call(calls[path])

    def post(self, path, json):
        controller = self.controller
        calls = {"/api/events": controller.receive, "/api/control/arm": controller.arm,
                 "/api/control/reset": controller.reset, "/api/control/clear": controller.clear}
        return self._call(calls[path], json)


class Room:
    def __init__(self, room_id, token, controller, runner, now):
        self.room_id, self.controller, self.runner = room_id, controller, runner
        self.token_hash = hashlib.sha256(token.encode()).hexdigest()
        self.last_seen = now
        self.error = None
        self.closed = False
        # True while the server is running this room's step, so steps never overlap or queue up.
        self.busy = False
        self.close_finished = False
        # Per-room extras created on demand by the HTTP layer (preview store, explanation service).
        self.extras_lock = RLock()
        self.extras = {}
        self.demo_ignition = None
        self.detect_at_ms = 0

    def simulation(self):
        view = self.runner.state()
        ignition = self.demo_ignition
        if ignition and ignition.run_id == view.run_id:
            view.demo_ignition = ignition
        return view

    def ignite(self, request):
        c = self.controller
        with c.lock:
            if self.closed or request.run_id != c.run_id:
                raise RoomError(409, "RUN_MISMATCH", "현재 체험 실행을 다시 확인하세요")
            if self.error or not c.armed or self.runner.status != "RUNNING":
                raise RoomError(409, "SIMULATION_NOT_RUNNING", "실행 중인 시연에서 화재를 시작할 수 있습니다")
            old = self.demo_ignition
            if old and old.run_id == c.run_id and old.event_id == request.event_id:
                if old.zone_id != request.zone_id or old.position != request.position:
                    raise RoomError(409, "EVENT_ID_CONFLICT", "같은 요청에 다른 화재 위치가 있습니다")
                return old
            if old and old.run_id == c.run_id and old.phase == "WAITING":
                raise RoomError(409, "DETECTION_PENDING", "이전 발화 지점의 감지를 기다리고 있습니다")
            devices = [s for s in c.building.sources if s.zone_id == request.zone_id]
            manual = next((s for s in devices if s.source_type == "MANUAL_TEST" and not s.required
                           and "FIRE" in s.allowed_hazard_types), None)
            if not manual:
                raise RoomError(400, "INVALID_FIRE_ZONE", "이 구역에는 시연 화재를 설정할 수 없습니다")
            check_ignition_position(c.building, request.zone_id, request.position)
            if request.event_id in c.seen_events or any(c.source_config[sid].zone_id == request.zone_id
                    and hazard in {"FIRE", "SPRINKLER"} for sid, hazard in c.active_causes):
                raise RoomError(409, "FIRE_ALREADY_REPORTED", "이미 이 화재 요청이나 구역의 경보를 처리했습니다")
            camera = next((s for s in devices if s.source_type == "VIDEO_AI" and "FIRE" in s.allowed_hazard_types), None)
            sprinkler = next((s for s in devices if s.source_type == "SIM_SPRINKLER"), None)
            device = "CCTV" if camera else "SPRINKLER" if sprinkler else "MANUAL"
            source = camera or sprinkler or manual
            staged = DemoIgnition(**request.model_dump(), device=device, source_id=source.source_id, phase="WAITING")
            c._write("events", operation="demo_ignition", outcome="staged", payload=staged.model_dump(mode="json"))
            self.demo_ignition = staged
            # Zone coverage and dwell time simulate seeing flames / a sprinkler head operating.
            self.detect_at_ms = c.clock.monotonic_ms() + {"CCTV": 2000, "SPRINKLER": 3000, "MANUAL": 0}[device]
            self._detect_fire()
            return self.demo_ignition

    def _detect_fire(self):
        c = self.controller
        with c.lock:
            fire = self.demo_ignition
            if not fire or fire.phase != "WAITING" or fire.run_id != c.run_id or self.closed:
                return
            if self.runner.status != "RUNNING":
                self.demo_ignition = fire.model_copy(update={"phase": "FAILED"})
                return
            if c.clock.monotonic_ms() < self.detect_at_ms:
                return
            # A simulated camera never publishes a VIDEO_AI event or fabricated model confidence.
            source = c.source_config[fire.source_id]
            # A scenario with its own periodic sprinkler producer owns its sequences and fault rules.
            # Route the separate staged demonstration via the zone's test source in that configuration.
            if fire.device == "CCTV" or source.source_id in self.runner.source_sequences:
                source = next(s for s in c.building.sources if s.zone_id == fire.zone_id
                              and s.source_type == "MANUAL_TEST" and not s.required and "FIRE" in s.allowed_hazard_types)
            hazard = "SPRINKLER" if source.source_type == "SIM_SPRINKLER" else "FIRE"
            event = dict(schema_version=1, run_id=fire.run_id, building_id=c.building.building_id,
                         building_version=c.building.building_version, event_id=fire.event_id,
                         source_id=source.source_id, source_type=source.source_type,
                         source_sequence=c.last_sequences.get(source.source_id, 0) + 1,
                         event_kind="ALARM", hazard_type=hazard, validity="VALID", observed_at=utc_text(c.clock.utcnow()),
                         media_time_ms=None, confidence=None, reason_code=None, ignition_position=fire.position)
            try:
                if (source.source_id, hazard) in c.active_causes:
                    self.demo_ignition = fire.model_copy(update={"phase": "FAILED"})
                    return
                c.receive(event, demo_detector_id=fire.source_id if fire.device != "MANUAL" else None)
            except ContractError:
                self.demo_ignition = fire.model_copy(update={"phase": "FAILED"})
                return
            self.demo_ignition = fire.model_copy(update={"phase": "ACCEPTED"})

    def step(self):
        """One simulation tick and observation expiry. Called only by the server, never extends the room."""
        if self.closed or self.error: return
        try:
            self.runner.tick()
            self._detect_fire()
            self.controller.expire()
        except Exception as error:  # one room's failure must stay in that room
            LOGGER.exception("Room %s stopped", self.room_id)
            self.error = type(error).__name__

    def info(self, manager):
        state = self.runner.state()
        return {"room_id": self.room_id, "run_id": state.run_id,
                "status": "FAILED" if self.error else "READY", "simulation_status": state.status,
                "idle_seconds": manager.idle_seconds, **manager.availability()}


class AiQueue:
    """Video AI analysis for all rooms, one job at a time; the rest wait in order.

    A job belongs to one room and one run. Ending or resetting the room removes its waiting job and
    stops its running one, and a job whose run is no longer current is never started. Results that
    still arrive late carry the old run_id and are refused by that room's controller.
    """
    KILL_AFTER_SECONDS = 5
    REAP_AFTER_SECONDS = 1

    def __init__(self, launch=None):
        # launch(room, run_id) -> handle with poll() -> None | exit code, terminate() and kill(). None: no model/video here.
        self.launch = launch
        self.lock = RLock()
        self.jobs = []      # waiting and running, in order; at most one has a handle
        self.finished = {}  # room_id -> (run_id, "DONE" | "FAILED")
        # A job told to stop still holds the single slot until its process has really exited.
        self.stopping = None  # {"handle", "kill_at", "killed"}
        self.now = time.monotonic
        self.closed = False

    def status(self, room):
        run_id = room.runner.run_id
        with self.lock:
            waiting = [job for job in self.jobs if job["handle"] is None]
            for job in self.jobs:
                if job["room_id"] == room.room_id and job["run_id"] == run_id:
                    running = job["handle"] is not None
                    return {"state": "RUNNING" if running else "QUEUED",
                            "position": None if running else waiting.index(job) + 1, "run_id": run_id}
            done = self.finished.get(room.room_id)
            if done is not None and done[0] == run_id:
                return {"state": done[1], "position": None, "run_id": run_id}
            return {"state": "IDLE" if self.launch is not None else "UNAVAILABLE", "position": None, "run_id": None}

    def request(self, room, rooms):
        if self.launch is None:
            raise RoomError(503, "AI_UNAVAILABLE", "이 서버에는 영상 AI 분석이 연결되어 있지 않습니다")
        run_id = room.runner.run_id
        with self.lock:
            if self.closed:
                raise RoomError(503, "AI_SHUTTING_DOWN", "영상 AI 분석을 종료하고 있습니다")
            # One job per room and run: repeated requests cannot grow the queue.
            if not any(job["room_id"] == room.room_id and job["run_id"] == run_id for job in self.jobs):
                self.finished.pop(room.room_id, None)
                self.jobs.append({"room_id": room.room_id, "run_id": run_id, "handle": None})
        self.step(rooms)
        return self.status(room)

    def drop(self, room, reason=None):
        """The room ended or was reset: forget its work."""
        with self.lock:
            mine = [job for job in self.jobs if job["room_id"] == room.room_id]
            self.jobs = [job for job in self.jobs if job["room_id"] != room.room_id]
            self.finished.pop(room.room_id, None)
            for job in mine:
                if job["handle"] is None: continue
                # Ask it to stop, but keep the slot: terminate() returning is not the process being gone.
                self._stop(job["handle"])

    def _stop(self, handle):
        self.stopping = {"handle": handle, "kill_at": self.now() + self.KILL_AFTER_SECONDS, "killed": False}
        try: handle.terminate()
        except Exception: LOGGER.exception("AI job did not accept the stop request")

    def _wait_for_stop(self, seconds):
        deadline = time.monotonic() + seconds
        while True:
            with self.lock:
                if self.stopping is None: return True
                if self.stopping["handle"].poll() is not None:
                    self.stopping = None
                    return True
            remaining = deadline - time.monotonic()
            if remaining <= 0: return False
            time.sleep(min(.02, remaining))

    def shutdown(self):
        with self.lock:
            self.closed = True
            running = next((job for job in self.jobs if job["handle"] is not None), None)
            self.jobs.clear()
            self.finished.clear()
            if running is not None: self._stop(running["handle"])
            killed = self.stopping is not None and self.stopping["killed"]
        if self._wait_for_stop(0 if killed else self.KILL_AFTER_SECONDS): return
        with self.lock:
            if self.stopping is None: return
            if not self.stopping["killed"]:
                try: self.stopping["handle"].kill()
                except Exception as error:
                    raise RuntimeError("AI process could not be killed during shutdown") from error
                self.stopping["killed"] = True
        if not self._wait_for_stop(self.REAP_AFTER_SECONDS):
            raise RuntimeError("AI process did not exit during shutdown")

    def step(self, rooms):
        """Collect a finished job, then start the next one that is still valid. rooms: live rooms by id."""
        with self.lock:
            if self.stopping is not None:
                # Never blocks: each call only looks. The slot stays taken until poll() reports the exit.
                handle = self.stopping["handle"]
                if handle.poll() is None:
                    if not self.stopping["killed"] and self.now() >= self.stopping["kill_at"]:
                        self.stopping["killed"] = True
                        LOGGER.warning("AI job ignored the stop request; killing it")
                        try: handle.kill()
                        except Exception: LOGGER.exception("AI job could not be killed; the AI slot stays taken")
                    return
                self.stopping = None  # exited and reaped
            if self.closed: return
            running = next((job for job in self.jobs if job["handle"] is not None), None)
            if running is not None:
                code = running["handle"].poll()
                if code is None: return
                self.jobs.remove(running)
                self.finished[running["room_id"]] = (running["run_id"], "DONE" if code == 0 else "FAILED")
            while self.jobs:
                job = self.jobs[0]
                room = rooms.get(job["room_id"])
                if room is None or room.closed or room.runner.run_id != job["run_id"]:
                    self.jobs.pop(0)  # its room or run is gone; never start it
                    continue
                try:
                    job["handle"] = self.launch(room, job["run_id"])
                    return
                except Exception:
                    LOGGER.exception("AI job for room %s could not start", job["room_id"])
                    self.jobs.pop(0)
                    self.finished[job["room_id"]] = (job["run_id"], "FAILED")


class RoomManager:
    def __init__(self, building, scenario, runs_dir, *, capacity=5, idle_seconds=600, clock=None, now=None,
                 ai_launch=None, explainer=None):
        self.building, self.scenario, self.runs_dir = building, scenario, Path(runs_dir) / "rooms"
        self.capacity, self.idle_seconds = capacity, idle_seconds
        self.clock, self.now = clock, now or time.monotonic
        self.lock = RLock()
        self.changed = Condition(self.lock)
        self.rooms = {}
        self.closing = {}
        self.preparing = 0
        self.shutting_down = False
        self.ai = AiQueue(ai_launch)
        # explainer(room) -> explanation Service for that room, or None when explanations are not configured here.
        self.explainer = explainer
        self.listeners = [self.ai.drop, self._forget_run]  # called with (room, reason) when a room is closed or reset
        # Internal callers (AI worker) prove themselves with this, never with a browser cookie.
        self.internal_token = secrets.token_urlsafe(32)
        # room_id -> what could not be closed cleanly. Such a room's evidence is incomplete, not "ended normally".
        self.close_failures = {}
        # Reservations include closing rooms, so old cleanup cannot accumulate and consume all workers.
        self.pool = ThreadPoolExecutor(max_workers=capacity * 3, thread_name_prefix="room")

    def availability(self):
        with self.lock:
            return {"capacity": self.capacity, "in_use": len(self.rooms) + self.preparing + len(self.closing)}

    def _build(self):
        """A fully prepared room, or an exception with nothing left running."""
        room_id, token = uuid4().hex, secrets.token_urlsafe(32)
        directory = self.runs_dir / room_id
        controller = Controller(self.building, directory, clock=self.clock, operator_id=f"room-{room_id[:8]}")
        runner = None
        try:
            runner = Runner(self.building, self.scenario, LocalClient(controller), directory, clock=self.clock)
            runner.auto_arm = True
            for _ in range(200):
                runner.tick()
                if runner.status != "WAITING_FOR_ARM": break
                time.sleep(.02)
            if runner.status != "RUNNING":
                raise RuntimeError(f"room simulation did not start: {runner.status} {runner.error_code}")
        except BaseException:
            if runner is not None: runner.close()
            controller.close()
            raise
        return Room(room_id, token, controller, runner, self.now()), token

    def create(self):
        with self.lock:
            if self.shutting_down:
                raise RoomError(503, "ROOMS_SHUTTING_DOWN", "개인 체험방을 종료하고 있습니다")
            if len(self.rooms) + self.preparing + len(self.closing) >= self.capacity:
                raise RoomError(409, "ROOM_FULL", "현재 체험방이 모두 사용 중입니다")
            self.preparing += 1  # a room being prepared already holds a seat
        room = None
        try:
            room, token = self._build()
        except Exception as error:
            LOGGER.exception("Room creation failed")
            raise RoomError(503, "ROOM_CREATE_FAILED", "체험방을 준비하지 못했습니다") from error
        finally:
            with self.changed:
                self.preparing -= 1
                if room is not None: self.rooms[room.room_id] = room
                stopping = self.shutting_down
                self.changed.notify_all()
        if stopping:
            raise RoomError(503, "ROOMS_SHUTTING_DOWN", "개인 체험방을 종료하고 있습니다")
        return room, token

    def by_token(self, token):
        """The caller's own room. This is a user request, so it keeps the room alive."""
        digest = hashlib.sha256((token or "").encode()).hexdigest()
        with self.lock:
            room = next((r for r in self.rooms.values() if hmac.compare_digest(r.token_hash, digest)), None)
            if room is None:
                raise RoomError(401, "ROOM_NOT_FOUND", "체험이 종료되었습니다. 새 체험을 시작해 주세요")
            room.last_seen = self.now()
            return room

    def internal(self, room_id, credential):
        """Server-side workers only. Does not extend the room."""
        with self.lock:
            room = self.rooms.get(room_id or "")
            if room is None or not hmac.compare_digest(credential or "", self.internal_token):
                raise RoomError(403, "INTERNAL_ACCESS_DENIED", "내부 접근 권한이 없습니다")
            return room

    def _detach(self, room):
        """Take the room out of service at once. From here no request can find, extend or revive it, and no step is scheduled."""
        with self.lock:
            if self.rooms.pop(room.room_id, None) is None: return False
            room.closed = True
            self.closing[room.room_id] = room
            return True

    def _finish(self, room, reason):
        """Release what a detached room held. May be slow (log writes); never called while holding the manager lock."""
        self._notify(room, reason)
        failures = []

        def finish_component(name, close):
            if close is None: return
            try: close()
            except Exception as error:
                LOGGER.exception("Room %s: %s did not close; its evidence is incomplete", room.room_id, name)
                failures.append(f"{name}: {type(error).__name__}")

        with room.extras_lock:
            for name, extra in room.extras.items():
                finish_component(name, getattr(extra, "close", None))
        # The controller is closed even if the runner could not write its last record, and the other way round.
        for name, close in [("runner", room.runner.close), ("controller", room.controller.close)]:
            finish_component(name, close)
        with self.changed:
            if failures: self.close_failures[room.room_id] = failures
            room.close_finished = True
            if not room.busy: self.closing.pop(room.room_id, None)
            self.changed.notify_all()

    def close(self, room, reason):
        """End a room. Safe to repeat: only the first call does anything."""
        if self._detach(room): self._finish(room, reason)

    def restart(self, room):
        """New run in the same room. Work bound to the previous run is dropped first."""
        self._notify(room, "reset")
        room.runner.restart()
        room.error = None

    @staticmethod
    def _forget_run(room, reason):
        # Preview frames and detections belong to the run that produced them.
        if reason == "reset":
            with room.extras_lock:
                room.extras.pop("preview", None)
                room.extras.pop("ai_demo", None)
                room.extras.pop("ai_result", None)

    def _notify(self, room, reason):
        for listener in self.listeners:
            try: listener(room, reason)
            except Exception: LOGGER.exception("Room listener failed")

    def _step(self, room):
        try: room.step()
        finally:
            with self.changed:
                room.busy = False
                if room.close_finished: self.closing.pop(room.room_id, None)
                self.changed.notify_all()

    def step_all(self, wait=True):
        """Advance every room once. The server calls this with wait=False so that a slow room,
        or a room that is slow to close, never delays the others. Work for one room never overlaps
        and never queues up: a room still busy with its previous step is simply skipped this time."""
        now = self.now()
        started = []
        with self.lock:
            rooms = list(self.rooms.values())
        for room in rooms:
            if now - room.last_seen >= self.idle_seconds:
                # Access ends now; the reservation stays until cleanup and any old step finish.
                if self._detach(room): started.append(self.pool.submit(self._finish, room, "expired"))
                continue
            with self.lock:
                if room.closed or room.busy: continue
                room.busy = True
            started.append(self.pool.submit(self._step, room))
        if wait:
            for future in started: future.result()
        with self.lock:
            live = dict(self.rooms)
        self.ai.step(live)

    def shutdown(self):
        with self.lock:
            self.shutting_down = True
        try:
            self.ai.shutdown()
        finally:
            try:
                with self.changed:
                    self.changed.wait_for(lambda: self.preparing == 0)
                    rooms = list(self.rooms.values())
                for room in rooms:
                    self.close(room, "shutdown")
                with self.changed:
                    self.changed.wait_for(lambda: not self.closing)
            finally:
                self.pool.shutdown(wait=True)

"""Local/internal control API. Run a single worker; deployment access is separate."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4
from weakref import WeakValueDictionary
import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from .contracts import ContractError, parse_contract
from .contracts.messages import (
    ArmReceipt, ClearReceipt, ClearRequest, ControlRequest, EventReceipt,
    ObservationEvent, ResetReceipt, Session, SignAck, SignCommand, SignState, StateSnapshot,
)
from .contracts.building import Building
from .contracts.messages import SimulationState
from .controller import Controller
from .reader import SnapshotReader
from .rooms import COOKIE, INTERNAL_HEADER, ROOM_HEADER, RoomError, RoomManager
from scenario_runner.runner import SimulationUnavailable

ROOT = Path(__file__).resolve().parents[1]
LOGGER = logging.getLogger(__name__)


async def expire_periodically(controller, interval_seconds=.1):
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await asyncio.to_thread(controller.expire)
        except ContractError:
            LOGGER.exception("Observation expiry stopped; controller is unavailable")
            return


async def step_rooms_periodically(manager, interval_seconds=.1):
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            # Schedules each room's step and returns: one slow room must not delay the next round for the others.
            await asyncio.to_thread(manager.step_all, False)
        except Exception:
            LOGGER.exception("Room step failed; rooms keep their last state")


def ai_launcher(manager, runs_root):
    """Start the existing AI worker for one room, or None when no model/video is configured on this server."""
    config, video = os.environ.get("SAFEROUTE_AI_CONFIG_FILE"), os.environ.get("SAFEROUTE_AI_VIDEO_FILE")
    if not config or not video or not Path(config).is_file() or not Path(video).is_file():
        return None
    origin = os.environ.get("SAFEROUTE_SELF_ORIGIN", "http://127.0.0.1:8000")

    def launch(room, run_id):
        # The worker names its room with the internal credential; it never holds a browser cookie.
        source = json.loads(Path(config).read_text(encoding="utf-8"))["source_id"]
        attempt = str(uuid4())
        with room.extras_lock:
            room.extras["ai_demo"] = (run_id, attempt, source)
            room.extras.pop("preview", None)
        environment = os.environ | {"SAFEROUTE_ROOM_ID": room.room_id, "SAFEROUTE_INTERNAL_TOKEN": manager.internal_token,
                                    "SAFEROUTE_DEMO_ATTEMPT": attempt}
        python = os.environ.get("SAFEROUTE_AI_PYTHON", sys.executable)
        return subprocess.Popen([python, "-m", "ai_worker", "--config", config, "--video", video,
                                 "--controller", origin, "--preview-url", origin, "--preview-only",
                                 "--runs-dir", str(Path(runs_root) / "rooms" / room.room_id)],
                                cwd=ROOT, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return launch


def room_explainer(runs_root):
    """One explanation service per room from the existing worker's parts, or None when not configured."""
    path = os.environ.get("SAFEROUTE_EXPLANATION_CONFIG")
    if not path: return None
    from explanation_worker.bedrock import Bedrock
    from explanation_worker.config import ExplanationConfig
    from explanation_worker.journal import Journal
    from explanation_worker.service import Service
    config = ExplanationConfig.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))
    model = []

    def invoke(basis):
        if not model: model.append(Bedrock(config))
        return model[0](basis)

    return lambda room: Service(config, invoke, Journal(Path(runs_root) / "rooms" / room.room_id / "explanations"))


def control_routes(controller_of, read_snapshot):
    """The controller API once, for whichever controller the request belongs to (shared demo or a room)."""
    router = APIRouter()

    @router.get("/session", response_model=Session)
    async def session(request: Request):
        snapshot = await read_snapshot(await asyncio.to_thread(controller_of, request))
        return Session(**snapshot.model_dump(include=set(Session.model_fields)))

    @router.get("/building", response_model=Building)
    def get_building(request: Request): return controller_of(request).building.model_copy(deep=True)

    @router.get("/state", response_model=StateSnapshot)
    async def state(request: Request): return await read_snapshot(await asyncio.to_thread(controller_of, request))

    @router.post("/events", response_model=EventReceipt)
    def events(request: Request, payload: ObservationEvent):
        return controller_of(request).receive(payload.model_dump(mode="json"))

    @router.get("/signs/{sign_id}/command", response_model=SignCommand)
    def command(request: Request, sign_id: str): return controller_of(request).issue_command(sign_id)

    @router.post("/signs/{sign_id}/ack", response_model=SignState)
    def acknowledge(request: Request, sign_id: str, payload: SignAck):
        return controller_of(request).acknowledge(sign_id, payload.model_dump(mode="json"))

    @router.post("/control/arm", response_model=ArmReceipt)
    def arm(request: Request, payload: ControlRequest): return controller_of(request).arm(payload.model_dump(mode="json"))

    @router.post("/control/clear", response_model=ClearReceipt)
    def clear(request: Request, payload: ClearRequest): return controller_of(request).clear(payload.model_dump(mode="json"))

    @router.post("/control/reset", response_model=ResetReceipt)
    def reset(request: Request, payload: ControlRequest): return controller_of(request).reset(payload.model_dump(mode="json"))

    return router


def create_app(*, building=None, runs_dir=None, clock=None, operator_id=None, rooms=None, room_autotick=True):
    @asynccontextmanager
    async def lifespan(app):
        configured_building = building
        if configured_building is None:
            path = Path(os.environ.get("SAFEROUTE_BUILDING_FILE", str(ROOT / "data/fixtures/two-route-v1.json")))
            configured_building = parse_contract("Building",json.loads(path.read_text(encoding="utf-8")))
        root = runs_dir or Path(os.environ.get("SAFEROUTE_RUNS_DIR",str(ROOT / "runs")))
        app.state.controller = Controller(configured_building, root, clock=clock,
            operator_id=operator_id or os.environ.get("SAFEROUTE_OPERATOR_ID","local-operator"))
        app.state.readers = WeakValueDictionary()
        # Personal rooms are opt-in: they need a scenario that can start by itself on this building.
        app.state.rooms = rooms
        scenario_file = os.environ.get("SAFEROUTE_ROOM_SCENARIO_FILE")
        if rooms is None and scenario_file:
            from scenario_runner.config import load_scenario
            app.state.rooms = RoomManager(configured_building, load_scenario(Path(scenario_file), configured_building), root)
            app.state.rooms.ai.launch = ai_launcher(app.state.rooms, root)
            app.state.rooms.explainer = room_explainer(root)
        tasks = [asyncio.create_task(expire_periodically(app.state.controller))]
        if app.state.rooms is not None and room_autotick:
            tasks.append(asyncio.create_task(step_rooms_periodically(app.state.rooms)))
        try: yield
        finally:
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError): await task
            await asyncio.gather(*(reader.close() for reader in list(app.state.readers.values())))
            try:
                if app.state.rooms is not None:
                    await asyncio.to_thread(app.state.rooms.shutdown)
            finally:
                try:
                    await asyncio.to_thread(app.state.controller.close)
                except ContractError:
                    LOGGER.exception("Run could not be finalized; logs remain incomplete")

    app = FastAPI(title="saferoute observation API", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ContractError)
    async def contract_error(request, error):
        headers = {"Retry-After": "1"} if error.code == "CONTROLLER_BUSY" else None
        return JSONResponse(status_code=error.status_code,content=error.to_response().model_dump(mode="json"),headers=headers)

    @app.exception_handler(SimulationUnavailable)
    async def simulation_unavailable(request, error):
        return JSONResponse(status_code=503, headers={"Retry-After": "1"},
            content={"error":{"code":"CONTROLLER_UNAVAILABLE","message":str(error),"field":None}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        errors = error.errors()
        structural = [item for item in errors if item["type"] != "invalid_event_combination"]
        first = (structural or errors)[0]
        code = "SCHEMA_VALIDATION_FAILED" if structural else "INVALID_EVENT_COMBINATION"
        field = ".".join(str(part) for part in first["loc"] if part != "body") or None
        contract = ContractError(code,first["msg"],field)
        try:
            # A rejected request is evidence of the controller it was sent to, not of the shared demo.
            target = own_room(request).controller if request.url.path.startswith("/api/room/") else shared_or_internal(request)
            await asyncio.to_thread(target.record_rejection,error.body,contract,request.url.path)
        except RoomError as room_error:
            return await room_error_response(request,room_error)
        except ContractError as audit_error:
            contract = audit_error
        return await contract_error(request,contract)

    @app.exception_handler(RoomError)
    async def room_error_response(request, error):
        return JSONResponse(status_code=error.status,content=error.body())

    def manager():
        if app.state.rooms is None:
            raise RoomError(503, "ROOMS_UNAVAILABLE", "이 서버는 개인 체험방을 제공하지 않습니다")
        return app.state.rooms

    def own_room(request):
        """The browser's own room, proven only by the server-issued cookie. Nothing the client names is trusted."""
        return manager().by_token(request.cookies.get(COOKIE))

    def shared_or_internal(request):
        """/api/* is the shared demo, except for server-side workers that name a room with the internal credential."""
        if ROOM_HEADER in request.headers:
            return manager().internal(request.headers[ROOM_HEADER], request.headers.get(INTERNAL_HEADER)).controller
        return app.state.controller

    async def read_snapshot(controller):
        # Active reads keep their reader alive; idle readers must not retain ended rooms.
        reader = app.state.readers.get(controller)
        if reader is None:
            reader = app.state.readers[controller] = SnapshotReader(controller)
        return await reader.read()

    def set_cookie(request, response, token):
        secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        response.set_cookie(COOKIE, token, max_age=86400, httponly=True, samesite="strict", secure=secure, path="/api")

    @app.get("/api/rooms/availability")
    def availability(): return manager().availability()

    @app.post("/api/rooms")
    def enter(request: Request):
        rooms = manager()
        try:
            # Same browser, any tab: back to its own room instead of taking another seat.
            return JSONResponse(rooms.by_token(request.cookies.get(COOKIE)).info(rooms))
        except RoomError:
            pass
        room, token = rooms.create()
        response = JSONResponse(room.info(rooms), status_code=201)
        set_cookie(request, response, token)
        return response

    @app.get("/api/room")
    def room_info(request: Request): return own_room(request).info(manager())

    @app.delete("/api/room")
    def leave(request: Request):
        manager().close(own_room(request), "ended")
        response = Response(status_code=204)
        response.delete_cookie(COOKIE, path="/api")
        return response

    @app.get("/api/room/sim/state", response_model=SimulationState)
    def room_simulation(request: Request): return own_room(request).runner.state()

    @app.post("/api/room/sim/restart", response_model=SimulationState)
    def room_restart(request: Request):
        room = own_room(request)
        # 공동 시연(/sim/restart)과 같게, 화면이 다시 시도할 수 있는 503으로 알린다.
        try: manager().restart(room)
        except (httpx.HTTPError,ValueError,OSError) as error:
            return JSONResponse(status_code=503,content={"error":{"code":"CONTROLLER_UNAVAILABLE","message":str(error),"field":None}})
        return room.runner.state()

    def demo_status(room, status):
        with room.extras_lock:
            demo = room.extras.get("ai_demo")
            if demo and demo[0] == status["run_id"] and status["state"] == "RUNNING":
                return {**status, "source_id": demo[2]}
        return status

    @app.get("/api/room/ai")
    def room_ai(request: Request):
        room = own_room(request)
        return demo_status(room, manager().ai.status(room))

    @app.post("/api/room/ai")
    def room_ai_request(request: Request):
        rooms = manager()
        with rooms.lock:
            live = dict(rooms.rooms)
        room = own_room(request)
        return demo_status(room, rooms.ai.request(room, live))

    # Preview frames: written only by the room's AI worker (internal credential), read only by that room's browser.
    def preview_store(room):
        from preview_worker.store import Store
        with room.extras_lock:
            if room.closed:
                raise RoomError(401, "ROOM_NOT_FOUND", "체험이 종료되었습니다. 새 체험을 시작해 주세요")
            clock_now = rooms_clock()
            return room.extras.setdefault("preview", Store(clock_now) if clock_now else Store())

    def rooms_clock():
        clock_of_rooms = manager().clock
        return clock_of_rooms.utcnow if clock_of_rooms is not None else None

    def preview_call(function, *args):
        from preview_worker.store import PreviewError
        try: return function(*args)
        except PreviewError as error:
            raise RoomError(error.status, error.code, error.code) from None

    @app.post("/internal/preview")
    async def room_preview_update(request: Request):
        from pydantic import ValidationError
        from preview_worker.store import MAX_BODY, Update
        # This handler runs on the shared event loop. Anything that may wait on a room's lock or its log
        # goes to a worker thread, or one slow room would stall every other request, even /api/health.
        room = await asyncio.to_thread(manager().internal, request.headers.get(ROOM_HEADER), request.headers.get(INTERNAL_HEADER))
        body = await request.body()
        if len(body) > MAX_BODY: raise RoomError(413, "SCHEMA_VALIDATION_FAILED", "preview update too large")
        try: update = Update.model_validate(json.loads(body))
        except (ValidationError, ValueError, UnicodeError):
            raise RoomError(422, "SCHEMA_VALIDATION_FAILED", "invalid preview update") from None
        def accept():
            with room.extras_lock:
                demo = room.extras.get("ai_demo")
                attempt = request.headers.get("X-Saferoute-Demo-Attempt")
                if demo or attempt:
                    if not demo or (update.preview.run_id, attempt, update.preview.source_id) != demo:
                        raise RoomError(409, "PREVIEW_UPDATE_REJECTED", "다른 영상 분석의 프레임입니다")
                preview_call(preview_store(room).accept, update, room.controller.snapshot(), room.controller.building)
        await asyncio.to_thread(accept)
        return Response(status_code=204)

    @app.get("/api/room/previews/{source_id}")
    def room_preview(request: Request, source_id: str, run_id: str):
        room = own_room(request)
        with room.extras_lock:
            value = preview_call(preview_store(room).current, room.controller.snapshot(), room.controller.building, run_id, source_id)
        return value.model_dump(mode="json")

    @app.get("/api/room/preview-frames/{frame_id}.jpg")
    def room_preview_image(request: Request, frame_id: str, run_id: str, source_id: str):
        room = own_room(request)
        with room.extras_lock:
            jpeg = preview_call(preview_store(room).image, room.controller.snapshot(), room.controller.building, run_id, source_id, frame_id)
        return Response(jpeg, media_type="image/jpeg", headers={"X-Preview-Frame-Id": frame_id})

    @app.get("/api/room/explanations/current")
    def room_explanation(request: Request):
        rooms, room = manager(), own_room(request)
        if rooms.explainer is None:
            raise RoomError(503, "EXPLANATION_UNAVAILABLE", "이 서버에는 상황 설명이 연결되어 있지 않습니다")
        # Creation may write to disk. Serialize only this room, including its cleanup.
        with room.extras_lock:
            if room.closed:
                raise RoomError(401, "ROOM_NOT_FOUND", "체험이 종료되었습니다. 새 체험을 시작해 주세요")
            service = room.extras.get("explanation") or room.extras.setdefault("explanation", rooms.explainer(room))
            if room.closed:
                raise RoomError(401, "ROOM_NOT_FOUND", "체험이 종료되었습니다. 새 체험을 시작해 주세요")
            value = service.tick(room.controller.snapshot())
            # Same re-check as the standalone reader: READY must still match the state after journal I/O.
            if value.status == "READY": value = service.tick(room.controller.snapshot())
        return JSONResponse(value.model_dump(mode="json"), headers={
            "X-Explanation-Server-Time": service.utcnow().isoformat().replace("+00:00", "Z")})

    app.include_router(control_routes(lambda request: own_room(request).controller, read_snapshot), prefix="/api/room")
    app.include_router(control_routes(shared_or_internal, read_snapshot), prefix="/api")

    @app.get("/api/health")
    def health(): return {"status":"ok"}

    return app

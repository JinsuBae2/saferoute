"""Local/internal control API. Run a single worker; deployment access is separate."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import logging
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .contracts import ContractError, parse_contract
from .contracts.messages import (
    ArmReceipt, ClearReceipt, ClearRequest, ControlRequest, EventReceipt,
    ObservationEvent, ResetReceipt, Session, SignAck, SignCommand, SignState, StateSnapshot,
)
from .contracts.building import Building
from .controller import Controller

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


def create_app(*, building=None, runs_dir=None, clock=None, operator_id=None):
    @asynccontextmanager
    async def lifespan(app):
        configured_building = building
        if configured_building is None:
            path = Path(os.environ.get("SAFEROUTE_BUILDING_FILE", str(ROOT / "data/fixtures/two-route-v1.json")))
            configured_building = parse_contract("Building",json.loads(path.read_text(encoding="utf-8")))
        app.state.controller = Controller(configured_building,
            runs_dir or Path(os.environ.get("SAFEROUTE_RUNS_DIR",str(ROOT / "runs"))), clock=clock,
            operator_id=operator_id or os.environ.get("SAFEROUTE_OPERATOR_ID","local-operator"))
        task = asyncio.create_task(expire_periodically(app.state.controller))
        try: yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError): await task
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
        return JSONResponse(status_code=error.status_code,content=error.to_response().model_dump(mode="json"))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        errors = error.errors()
        structural = [item for item in errors if item["type"] != "invalid_event_combination"]
        first = (structural or errors)[0]
        code = "SCHEMA_VALIDATION_FAILED" if structural else "INVALID_EVENT_COMBINATION"
        field = ".".join(str(part) for part in first["loc"] if part != "body") or None
        contract = ContractError(code,first["msg"],field)
        try:
            await asyncio.to_thread(app.state.controller.record_rejection,error.body,contract,request.url.path)
        except ContractError as audit_error:
            contract = audit_error
        return await contract_error(request,contract)

    @app.get("/api/health")
    def health(): return {"status":"ok"}

    @app.get("/api/session", response_model=Session)
    def session(): return app.state.controller.session()

    @app.get("/api/building", response_model=Building)
    def get_building(): return app.state.controller.building.model_copy(deep=True)

    @app.get("/api/state", response_model=StateSnapshot)
    def state(): return app.state.controller.snapshot()

    @app.post("/api/events", response_model=EventReceipt)
    def events(payload: ObservationEvent): return app.state.controller.receive(payload.model_dump(mode="json"))

    @app.get("/api/signs/{sign_id}/command", response_model=SignCommand)
    def command(sign_id: str): return app.state.controller.issue_command(sign_id)

    @app.post("/api/signs/{sign_id}/ack", response_model=SignState)
    def acknowledge(sign_id: str, payload: SignAck):
        return app.state.controller.acknowledge(sign_id, payload.model_dump(mode="json"))

    @app.post("/api/control/arm", response_model=ArmReceipt)
    def arm(payload: ControlRequest): return app.state.controller.arm(payload.model_dump(mode="json"))

    @app.post("/api/control/clear", response_model=ClearReceipt)
    def clear(payload: ClearRequest): return app.state.controller.clear(payload.model_dump(mode="json"))

    @app.post("/api/control/reset", response_model=ResetReceipt)
    def reset(payload: ControlRequest): return app.state.controller.reset(payload.model_dump(mode="json"))

    return app

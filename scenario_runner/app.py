"""Current simulation state and an explicit restart; the clock runs without dashboard clients."""

import asyncio
from contextlib import asynccontextmanager, suppress
import logging

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from backend.contracts.messages import SimulationState
from .runner import Runner, SimulationUnavailable

LOGGER = logging.getLogger(__name__)


def create_app(building, scenario, *, controller_url, runs_dir, clock=None):
    @asynccontextmanager
    async def lifespan(app):
        with httpx.Client(base_url=controller_url,timeout=3,trust_env=False) as client:
            runner = Runner(building,scenario,client,runs_dir,clock=clock)
            await asyncio.to_thread(runner.tick)
            app.state.runner = runner

            async def advance():
                while True:
                    await asyncio.sleep(.1)
                    await asyncio.to_thread(runner.tick)

            task = asyncio.create_task(advance())
            try: yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError): await task
                try: await asyncio.to_thread(runner.close)
                except OSError: LOGGER.exception("Scenario log could not be finalized")

    app = FastAPI(title="saferoute simulation evidence",version="0.1.0",lifespan=lifespan)

    @app.exception_handler(SimulationUnavailable)
    async def unavailable(request, error):
        return JSONResponse(status_code=503, headers={"Retry-After": "1"},
            content={"error":{"code":"CONTROLLER_UNAVAILABLE","message":str(error),"field":None}})

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/sim/health")
    def health():
        return {"status":app.state.runner.state().status}

    @app.get("/sim/state",response_model=SimulationState)
    def state(): return app.state.runner.state()

    @app.post("/sim/restart",response_model=SimulationState)
    def restart():
        try: app.state.runner.restart()
        except (httpx.HTTPError,ValueError,OSError) as error:
            return JSONResponse(status_code=503,content={"error":{"code":"CONTROLLER_UNAVAILABLE","message":str(error),"field":None}})
        return app.state.runner.state()

    return app

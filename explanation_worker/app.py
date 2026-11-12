"""Separate read-only HTTP process; never imported by the controller."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import httpx

from backend.contracts.messages import StateSnapshot
from .bedrock import Bedrock
from .config import ExplanationConfig
from .journal import Journal
from .service import Service, utc_text


def create_app(*, config=None, provider=None, journal=None, read_state=None):
    if config is None:
        path = os.environ.get("SAFEROUTE_EXPLANATION_CONFIG", "configs/explanation.example.json")
        config = ExplanationConfig.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))

    @asynccontextmanager
    async def lifespan(app):
        owned_journal = journal or Journal(os.environ.get("SAFEROUTE_RUNS_DIR", "runs"))
        client = httpx.AsyncClient(timeout=1, follow_redirects=False, trust_env=False)
        model = provider

        def invoke(basis):
            nonlocal model
            if model is None:
                model = Bedrock(config)
            return model(basis)

        service = Service(config, invoke, owned_journal)
        lock = asyncio.Lock()

        async def snapshot():
            try:
                async with asyncio.timeout(1):
                    if read_state is not None:
                        return StateSnapshot.model_validate(await read_state())
                    response = await client.get(config.controller_url + "/api/state")
                    response.raise_for_status()
                    return StateSnapshot.model_validate(response.json())
            except (httpx.HTTPError, TimeoutError, ValueError):
                service.disconnected()
                raise HTTPException(503, "Current controller state unavailable") from None

        async def current():
            async with lock:
                result = service.tick(await snapshot())
                # Journal I/O may have taken time: re-read identity before publishing READY.
                return service.tick(await snapshot()) if result.status == "READY" else result

        async def poll():
            while True:
                with suppress(HTTPException):
                    await current()
                await asyncio.sleep(0.25)

        app.state.current = current
        app.state.service = service
        # Public demos can generate on browser polling alone, including after a period without viewers.
        task = None if os.environ.get("SAFEROUTE_EXPLANATION_ON_DEMAND") == "1" else asyncio.create_task(poll())
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            await client.aclose()
            await asyncio.to_thread(service.close)

    app = FastAPI(title="SafeRoute explanation reader", lifespan=lifespan)

    @app.middleware("http")
    async def no_store(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/explanations/current")
    async def explanation():
        value = await app.state.current()
        return JSONResponse(value.model_dump(mode="json"), headers={
            "X-Explanation-Server-Time": utc_text(app.state.service.utcnow()),
        })

    return app

"""Run on loopback with one worker. No controller write calls or video inference."""

import asyncio
from contextlib import asynccontextmanager
import json
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
import httpx
from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from backend.contracts.building import Building
from backend.contracts.messages import ErrorDetail, ErrorResponse, StateSnapshot
from .store import MAX_BODY, PreviewError, Store, Update, loopback_origin


def create_app(*, read_context=None, store=None):
    store = store or Store()
    controller = loopback_origin(os.environ.get('SAFEROUTE_PREVIEW_CONTROLLER', 'http://127.0.0.1:8000'))

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=0.5, trust_env=False, follow_redirects=False) as client:
            app.state.client = client
            yield

    app = FastAPI(title='SafeRoute local preview reader', lifespan=lifespan)

    async def context():
        try:
            async with asyncio.timeout(1):
                if read_context is not None:
                    state, building = await read_context()
                else:
                    building_response = await app.state.client.get(controller + '/api/building')
                    building_response.raise_for_status()
                    building = building_response.json()
                    state_response = await app.state.client.get(controller + '/api/state')
                    state_response.raise_for_status()
                    state = state_response.json()
                return StateSnapshot.model_validate(state), Building.model_validate(building)
        except (httpx.HTTPError, TimeoutError, ValueError):
            store.disconnected()
            raise PreviewError(503, 'CONTROLLER_NOT_READY') from None

    @app.middleware('http')
    async def no_store(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(PreviewError)
    async def error_response(request, error):
        body = ErrorResponse(error=ErrorDetail(code=error.code, message=error.code, field=None))
        return JSONResponse(body.model_dump(mode='json'), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        return await error_response(request, PreviewError(422, 'SCHEMA_VALIDATION_FAILED'))

    @app.post('/internal/preview')
    async def update(request: Request):
        body = bytearray()
        try:
            async with asyncio.timeout(1):
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_BODY:
                        raise PreviewError(413, 'SCHEMA_VALIDATION_FAILED')
                    body.extend(chunk)
        except ClientDisconnect:
            raise PreviewError(400, 'SCHEMA_VALIDATION_FAILED') from None
        except TimeoutError:
            raise PreviewError(408, 'SCHEMA_VALIDATION_FAILED') from None
        try:
            value = Update.model_validate(json.loads(body))
        except (ValidationError, ValueError, UnicodeError):
            raise PreviewError(422, 'SCHEMA_VALIDATION_FAILED') from None
        # No awaits between current-context check and store mutation/publication.
        state, building = await context()
        store.accept(value, state, building)
        return Response(status_code=204)

    @app.get('/api/previews/{source_id}')
    async def preview(source_id: str, run_id: str):
        state, building = await context()
        return store.current(state, building, run_id, source_id).model_dump(mode='json')

    @app.get('/api/preview-frames/{frame_id}.jpg')
    async def image(frame_id: str, run_id: str, source_id: str):
        state, building = await context()
        jpeg = store.image(state, building, run_id, source_id, frame_id)
        return Response(jpeg, media_type='image/jpeg', headers={'X-Preview-Frame-Id': frame_id})

    return app

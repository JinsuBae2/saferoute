import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field

from backend.contracts.common import PositiveInt, WireModel
from backend.contracts.previews import Preview

MAX_BODY = 3_000_000


def loopback_origin(value):
    url = urlsplit(value)
    if (url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or url.username or url.password or url.path not in {'', '/'} or url.query or url.fragment):
        raise ValueError('preview/controller origin must be local HTTP without credentials/path/query')
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError('invalid port')
    return value.rstrip('/')


class Update(WireModel):
    sequence: PositiveInt
    preview: Preview
    jpeg_base64: Annotated[str, Field(max_length=MAX_BODY)] | None


class PreviewError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def utcnow():
    return datetime.now(timezone.utc)


def identity(value):
    return value.run_id, value.building_id, value.building_version


@dataclass
class Entry:
    sequence: int
    preview: Preview
    jpeg: bytes | None
    last_index: int
    terminal: bool


class Store:
    def __init__(self, now=utcnow):
        self.now, self.run, self.entries = now, None, {}

    def disconnected(self):
        # Keep high-water marks: a delayed old upload cannot restore a cleared image.
        for entry in self.entries.values():
            if entry.preview.frame is not None:
                entry.preview = entry.preview.model_copy(update={'status': 'STALE', 'frame': None, 'error_code': None})
            entry.jpeg = None

    def context(self, state, building, run_id, source_id):
        current = identity(state)
        if (state.building_id, state.building_version) != (building.building_id, building.building_version):
            self.disconnected()
            raise PreviewError(503, 'CONTROLLER_NOT_READY')
        if self.run != current:
            self.entries.clear()
            self.run = current
        if run_id != state.run_id:
            raise PreviewError(409, 'RUN_MISMATCH')
        source = next((s for s in building.sources if s.source_id == source_id and s.source_type == 'VIDEO_AI'), None)
        if source is None:
            raise PreviewError(404, 'UNKNOWN_SOURCE')
        return source

    def accept(self, update, state, building):
        value = update.preview
        source = self.context(state, building, value.run_id, value.source_id)
        if identity(value) != identity(state):
            raise PreviewError(409, 'BUILDING_MISMATCH')
        old = self.entries.get(value.source_id)
        if (value.freshness_ms != source.freshness_ms or value.status == 'INITIALIZING'
                or datetime.fromisoformat(value.generated_at) > self.now()
                or (old and (update.sequence <= old.sequence or old.terminal))):
            raise PreviewError(409, 'PREVIEW_UPDATE_REJECTED')
        jpeg, index = None, old.last_index if old else -1
        if value.frame is not None:
            frame = value.frame
            if frame.frame_index <= index or (old and old.preview.frame and frame.frame_id == old.preview.frame.frame_id):
                raise PreviewError(409, 'PREVIEW_UPDATE_REJECTED')
            try:
                jpeg = base64.b64decode(update.jpeg_base64, validate=True)
            except (ValueError, TypeError):
                raise PreviewError(422, 'SCHEMA_VALIDATION_FAILED') from None
            if not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
                raise PreviewError(422, 'SCHEMA_VALIDATION_FAILED')
            index = frame.frame_index
            if self.now() >= datetime.fromisoformat(frame.expires_at):
                value = value.model_copy(update={'status': 'STALE', 'frame': None})
                jpeg = None
        elif update.jpeg_base64 is not None:
            raise PreviewError(422, 'SCHEMA_VALIDATION_FAILED')
        terminal = value.status == 'EOF' or (value.status == 'UNAVAILABLE' and value.error_code != 'PREVIEW_FAILED')
        self.entries[value.source_id] = Entry(update.sequence, value, jpeg, index, terminal)
        return value

    def current(self, state, building, run_id, source_id):
        source = self.context(state, building, run_id, source_id)
        now = self.now()
        entry = self.entries.get(source_id)
        if entry is None:
            return Preview(schema_version=1, run_id=state.run_id, building_id=state.building_id,
                           building_version=state.building_version, source_id=source_id,
                           generated_at=now.isoformat().replace('+00:00', 'Z'), freshness_ms=source.freshness_ms,
                           status='INITIALIZING', frame=None, error_code=None)
        value = entry.preview
        if value.frame and not (datetime.fromisoformat(value.frame.inference_completed_at) <= now
                                < datetime.fromisoformat(value.frame.expires_at)):
            value = value.model_copy(update={'status': 'STALE', 'frame': None, 'error_code': None})
            entry.preview, entry.jpeg = value, None
        return value.model_copy(update={'generated_at': now.isoformat().replace('+00:00', 'Z')})

    def image(self, state, building, run_id, source_id, frame_id):
        value = self.current(state, building, run_id, source_id)
        if value.frame is None or value.frame.frame_id != frame_id:
            raise PreviewError(404, 'PREVIEW_FRAME_UNAVAILABLE')
        return self.entries[source_id].jpeg

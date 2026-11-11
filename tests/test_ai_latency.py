import json

import httpx
import pytest

from ai_worker.events import WorkerError
from test_ai_worker import Video, building, execute, sender, setup


def busy():
    return httpx.Response(503, json={"error": {"code": "CONTROLLER_BUSY", "message": "busy", "field": None}})


def test_ai_retries_busy_session_with_original_observation(setup):
    reads, posts = [], []

    def handle(request):
        if request.method == "GET":
            reads.append(request)
            return busy() if len(reads) == 1 else setup.client.get(request.url.path)
        posts.append(request.content)
        return setup.client.post(request.url.path, content=request.content,
                                 headers={"Content-Type": "application/json"})

    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        assert sender(setup, client).send(event).accepted
    assert len(reads) == 2 and len(posts) == 1
    assert json.loads(posts[0]) == event


@pytest.mark.parametrize("status,code,attempts", [(503, "CONTROLLER_BUSY", 2), (401, "UNAUTHORIZED", 1)])
def test_ai_busy_retry_is_bounded_and_other_http_errors_remain_terminal(setup, status, code, attempts):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"code": code}})

    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        with pytest.raises(WorkerError if status == 503 else httpx.HTTPStatusError):
            sender(setup, client).send(event)
    assert len(calls) == attempts
    assert all(request.method == "GET" for request in calls)


def test_busy_wait_cannot_refresh_an_expired_ai_observation(setup):
    calls = []

    def handle(request):
        calls.append(request)
        setup.clock.advance(3000)
        return busy()

    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        with pytest.raises(WorkerError, match="STALE_OR_FUTURE_OBSERVATION"):
            sender(setup, client).send(event)
    assert len(calls) == 1


def test_ai_startup_retries_busy_reads_before_processing_video(setup, monkeypatch):
    original = setup.client.get
    counts = {}

    def delayed(path, **kwargs):
        counts[path] = counts.get(path, 0) + 1
        if path in {"/api/session", "/api/state"} and counts[path] == 1:
            response = busy()
            response.request = httpx.Request("GET", "http://testserver" + path)
            return response
        return original(path, **kwargs)

    monkeypatch.setattr(setup.client, "get", delayed)
    video = Video([0, 500])
    execute(setup, video, lambda frame: [])
    assert video.released
    assert counts["/api/state"] == 2

"""A02 contract/lifecycle tests; fake inference is not model accuracy evidence."""
import json
from datetime import datetime
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_worker.config import AIConfig
from ai_worker.events import EventBuilder, EventSender, WorkerError, get_contract
from ai_worker.worker import run
from backend.app import create_app
from test_observation_state import ROOT, FakeClock, building


class Clock(FakeClock):
    def monotonic(self): return self.mono / 1000
    def sleep(self, seconds): self.advance(seconds * 1000)


@pytest.fixture
def setup(building, tmp_path):
    clock = Clock()
    config = AIConfig.model_validate(json.loads((ROOT / "configs/ai.example.json").read_text(encoding="utf-8")))
    with TestClient(create_app(building=building, clock=clock, runs_dir=tmp_path / "backend")) as client:
        session = get_contract(client, "/api/session", "Session")
        yield SimpleNamespace(clock=clock, config=config, client=client, session=session,
                              builder=EventBuilder(config, session), directory=tmp_path)


def detection(hazard="FIRE", confidence=.9):
    return {"class": hazard, "confidence": confidence, "xyxy": [1, 2, 3, 4]}


def test_persistence_counts_frames_not_boxes_and_requires_current_hit(setup):
    b, now = setup.builder, setup.clock.utcnow()
    assert b.observation(0, now, [detection()] * 5)[0]["event_kind"] == "OBSERVATION"
    events = b.observation(500, now, [detection(), detection("SMOKE")])
    assert [e["hazard_type"] for e in events] == ["FIRE"]
    events = b.observation(1000, now, [detection("SMOKE", .8)])
    assert [e["hazard_type"] for e in events] == ["SMOKE"]
    assert events[0]["confidence"] == .8
    assert b.observation(1500, now, [])[0]["event_kind"] == "OBSERVATION"
    assert b.observation(2500, now, [detection("SMOKE")])[0]["event_kind"] == "OBSERVATION"


def test_two_hazards_have_unique_ids_sequences_and_unchanged_frame_time(setup):
    b, now = setup.builder, setup.clock.utcnow()
    boxes = [detection(), detection("SMOKE")]
    b.observation(0, now, boxes)
    events = b.observation(500, now, boxes)
    assert [e["source_sequence"] for e in events] == [2, 3]
    assert len({e["event_id"] for e in events}) == 2
    assert {e["observed_at"] for e in events} == {now.isoformat().replace("+00:00", "Z")}
    assert all(e["media_time_ms"] == 500 and "zone_id" not in e for e in events)
    with pytest.raises(WorkerError, match="INVALID_MEDIA_TIME"):
        b.observation(500, now, boxes)


@pytest.mark.parametrize("box", [detection("OTHER"), detection(confidence=float("nan")), detection(confidence=1.1)])
def test_invalid_predictions_cannot_become_observations(setup, box):
    with pytest.raises(WorkerError, match="INVALID_DETECTION"):
        setup.builder.observation(0, setup.clock.utcnow(), [box])


def sender(setup, client):
    return EventSender(client, setup.config, setup.session, 3000, lambda *a, **kw: None, setup.clock)


def test_lost_receipt_retries_identical_bytes_and_server_deduplicates(setup):
    bodies = []
    def handle(request):
        if request.method == "GET": return setup.client.get(request.url.path)
        bodies.append(request.content)
        response = setup.client.post(request.url.path, content=request.content,
                                     headers={"Content-Type": "application/json"})
        if len(bodies) == 1: raise httpx.ReadTimeout("lost response")
        return response
    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        receipt = sender(setup, client).send(event)
    assert receipt.duplicate and len(bodies) == 2 and bodies[0] == bodies[1]
    state = setup.client.get("/api/state").json()
    assert next(s for s in state["sources"] if s["source_id"] == "CAM-A")["last_source_sequence"] == 1


def test_reset_between_attempts_stops_old_run_without_rebinding(setup):
    posts = []
    def handle(request):
        if request.method == "GET": return setup.client.get(request.url.path)
        posts.append(request.content)
        setup.client.post("/api/control/reset", json=dict(schema_version=1,
                          run_id=setup.session.run_id, reason="test reset"))
        raise httpx.ReadTimeout("ambiguous failure")
    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        with pytest.raises(WorkerError, match="RUN_OR_BUILDING_CHANGED"):
            sender(setup, client).send(event)
    assert len(posts) == 1


@pytest.mark.parametrize("status,attempts", [(409, 1), (422, 1), (503, 2)])
def test_retry_is_bounded_and_semantic_rejections_are_terminal(setup, status, attempts):
    posts = []
    def handle(request):
        if request.method == "GET": return setup.client.get(request.url.path)
        posts.append(request.content)
        return httpx.Response(status)
    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        with pytest.raises(WorkerError): sender(setup, client).send(event)
    assert len(posts) == attempts and len(set(posts)) == 1


def test_stale_frame_cannot_refresh_time_for_delivery(setup):
    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    original = event.copy()
    setup.clock.advance(3000)
    with pytest.raises(WorkerError, match="STALE_OR_FUTURE"):
        sender(setup, setup.client).send(event)
    assert event == original
    assert next(s for s in setup.client.get("/api/state").json()["sources"]
                if s["source_id"] == "CAM-A")["last_source_sequence"] is None


def test_receipt_for_another_event_is_not_success(setup):
    def handle(request):
        if request.method == "GET": return setup.client.get(request.url.path)
        return httpx.Response(200, json=dict(accepted=True, duplicate=False, event_id=str(uuid4()),
                                           run_id=setup.session.run_id, guidance_version=0))
    event = setup.builder.observation(0, setup.clock.utcnow(), [])[0]
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        with pytest.raises(WorkerError, match="RECEIPT_MISMATCH"):
            sender(setup, client).send(event)


class Video:
    CAP_PROP_POS_MSEC = 0
    def __init__(self, timestamps):
        self.timestamps, self.index, self.released = timestamps, -1, False
    def VideoCapture(self, path): return self
    def isOpened(self): return True
    def read(self):
        self.index += 1
        return (True, self.index) if self.index < len(self.timestamps) else (False, None)
    def get(self, key): return self.timestamps[self.index]
    def release(self): self.released = True


def execute(setup, video, predict, *, video_probe=None):
    path = setup.directory / "fake-video"
    path.write_bytes(b"fixture, not actual inference evidence")
    return run(setup.config, path, setup.client, setup.directory / "ai",
               SimpleNamespace(predict=predict), clock=setup.clock, cv2_module=video,
               video_probe=video_probe or (lambda path: {"decoded_frames": len(video.timestamps),
                                                       "method": "test_fixture_only"}))


def test_pipeline_preserves_acquisition_time_and_end_does_not_clear_alarm(setup):
    video = Video([0, 500, 1000])
    def predict(frame):
        setup.clock.advance(100)
        return [detection()] if frame < 2 else []
    result = execute(setup, video, predict)
    assert result["accepted_events"] == 4 and result["termination"] == "EOF" and video.released
    assert result["processing_elapsed_ms"] == pytest.approx(1100)  # pacing plus three 100ms predictions
    state = setup.client.get("/api/state").json()
    assert [(c["source_id"], c["hazard_type"]) for c in state["active_causes"]] == [("CAM-A", "FIRE")]
    assert next(s for s in state["sources"] if s["source_id"] == "CAM-A")["validity"] == "UNAVAILABLE"
    records = [json.loads(line) for line in (setup.directory / "ai" / setup.session.run_id /
                                           "ai-predictions.jsonl").read_text(encoding="utf-8").splitlines()]
    frames = [r for r in records if r["operation"] == "prediction"]
    assert records[0]["runtime"] is None  # fake detector cannot claim actual hardware evidence
    assert records[-1]["result"]["processing_elapsed_ms"] == result["processing_elapsed_ms"]
    assert [r["media_time_ms"] for r in frames] == [0, 500, 1000]
    assert all(datetime.fromisoformat(r["observed_at"]) < datetime.fromisoformat(r["inference_completed_at"])
               for r in frames)
    assert all(e["observed_at"] == r["observed_at"] for r in frames for e in r["events"])
    with pytest.raises(WorkerError, match="SOURCE_ALREADY_USED"):
        execute(setup, Video([0]), predict)


def test_slow_inference_drops_late_frames_instead_of_queueing_them(setup):
    video = Video([0, 500, 1000, 1500, 2000, 2500, 3000])
    analyzed = []
    def predict(frame):
        analyzed.append(frame)
        setup.clock.advance(2000 if frame == 0 else 10)
        return []
    result = execute(setup, video, predict)
    assert result["skipped_late_frames"] == 2 and analyzed == [0, 3, 4, 5, 6]


def test_inference_exceeding_freshness_fails_without_fabricated_observation(setup):
    video = Video([0])
    def predict(frame):
        setup.clock.advance(3001)
        return []
    with pytest.raises(WorkerError, match="STALE_OR_FUTURE"):
        execute(setup, video, predict)
    assert video.released
    assert next(s for s in setup.client.get("/api/state").json()["sources"]
                if s["source_id"] == "CAM-A")["last_source_sequence"] is None


@pytest.mark.parametrize("changes", [{"expected_zone_id": "Z-B"}, {"building_version": 2},
                                    {"source_id": "DETECTOR-A"}])
def test_mapping_mismatch_fails_before_sending(setup, changes):
    setup.config = setup.config.model_copy(update=changes)
    with pytest.raises(ValueError): execute(setup, Video([0]), lambda frame: [])


def test_decreasing_media_time_reports_unavailable_and_stops(setup):
    video = Video([0, 500, 250])
    with pytest.raises(WorkerError, match="INVALID_MEDIA_TIME"):
        execute(setup, video, lambda frame: [])
    assert video.released
    assert next(s for s in setup.client.get("/api/state").json()["sources"]
                if s["source_id"] == "CAM-A")["validity"] == "UNAVAILABLE"

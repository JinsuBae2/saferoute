"""A03 fault injection, separate from actual video/model execution evidence."""
import json
import subprocess
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from ai_worker.events import WorkerError, utc_text
from ai_worker.video import inspect_video
from test_ai_worker import Video, detection, execute, sender, setup
from test_observation_state import building, prepare


def records(setup):
    path = setup.directory / "ai" / setup.session.run_id / "ai-predictions.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def source_state(setup):
    state = setup.client.get("/api/state").json()
    return next(s for s in state["sources"] if s["source_id"] == "CAM-A"), state["active_causes"]


def test_probe_uses_decoded_count_not_container_metadata(monkeypatch, tmp_path):
    def invoke(argv, **kwargs):
        assert "-count_frames" in argv and kwargs["timeout"] == 60
        assert kwargs["encoding"] == "utf-8" and "shell" not in kwargs
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({
            "program_version": {"version": "test-fixture"},
            "streams": [{"nb_read_frames": "217", "nb_frames": "99999"}]}))
    monkeypatch.setattr("ai_worker.video.subprocess.run", invoke)
    assert inspect_video(tmp_path / "file.webm")["decoded_frames"] == 217


@pytest.mark.parametrize("output,error,code", [
    ('{}', '', 0), ('not json', '', 0),
    ('{"streams": [{"nb_read_frames": "0"}]}', '', 0),
    ('{"streams": [{"nb_read_frames": "N/A"}]}', '', 0),
    ('{"streams": [{"nb_read_frames": "2"}]}', 'corrupt frame', 0),
    ('{}', '', 1),
])
def test_probe_never_claims_verified_eof_from_invalid_or_corrupt_input(monkeypatch, tmp_path, output, error, code):
    monkeypatch.setattr("ai_worker.video.subprocess.run", lambda *a, **kw:
                        SimpleNamespace(returncode=code, stderr=error, stdout=output))
    with pytest.raises(WorkerError, match="DECODE_FAILED"):
        inspect_video(tmp_path / "video")


@pytest.mark.parametrize("error", [FileNotFoundError(), subprocess.TimeoutExpired("ffprobe", 60)])
def test_missing_or_timed_out_probe_is_explicit_failure(monkeypatch, tmp_path, error):
    def fail(*a, **kw): raise error
    monkeypatch.setattr("ai_worker.video.subprocess.run", fail)
    with pytest.raises(WorkerError, match="VIDEO_PREFLIGHT_UNAVAILABLE"):
        inspect_video(tmp_path / "video")


def test_read_ending_before_verified_count_fails_and_keeps_alarm(setup):
    video = Video([0, 500])
    with pytest.raises(WorkerError, match="DECODE_FRAME_COUNT_MISMATCH"):
        execute(setup, video, lambda frame: [detection()],
                video_probe=lambda path: {"decoded_frames": 3})
    source, causes = source_state(setup)
    assert source["validity"] == "UNAVAILABLE" and causes[0]["hazard_type"] == "FIRE"
    sent = [r["event"] for r in records(setup) if r["operation"] == "send_attempt"]
    assert sent[-1]["reason_code"] == "DECODE_FAILED" and video.released
    assert not any(r["operation"] == "finished" for r in records(setup))


def test_clean_file_with_all_frames_late_reports_analysis_gap_not_decode_error(setup):
    class SlowVideo(Video):
        def read(self):
            value = super().read()
            if value[0]: setup.clock.advance(1000)
            return value
    video = SlowVideo([0])
    with pytest.raises(WorkerError, match="NO_ANALYZED_FRAMES"):
        execute(setup, video, lambda frame: pytest.fail("late frame must be skipped"))
    logged = records(setup)
    assert any(r["operation"] == "skip_late_frame" for r in logged)
    assert next(r for r in logged if r["operation"] == "failed")["reason_code"] == "NO_ANALYZED_FRAMES"
    assert next(r["event"] for r in logged if r["operation"] == "send_attempt")["reason_code"] == "NO_ANALYZED_FRAMES"
    assert video.released


@pytest.mark.parametrize("error,reason", [(RuntimeError("model failure"), "INFERENCE_FAILED"),
                                       (KeyboardInterrupt(), "OPERATOR_STOPPED")])
def test_inference_failure_or_operator_stop_reports_unavailable_without_clearing(setup, error, reason):
    video = Video([0, 500, 1000])
    def predict(frame):
        if frame == 2: raise error
        return [detection()]
    with pytest.raises(type(error)):
        execute(setup, video, predict)
    source, causes = source_state(setup)
    assert source["validity"] == "UNAVAILABLE" and causes[0]["hazard_type"] == "FIRE"
    assert video.released
    assert next(r for r in records(setup) if r["operation"] == "failed")["reason_code"] == reason
    assert [r["event"] for r in records(setup) if r["operation"] == "send_attempt"][-1]["reason_code"] == reason


def test_probe_failure_reports_unavailable_without_opening_video(setup):
    def fail(path): raise WorkerError("DECODE_FAILED: damaged input")
    video = Video([0])
    with pytest.raises(WorkerError, match="damaged input"):
        execute(setup, video, lambda frame: pytest.fail("inference must not run"), video_probe=fail)
    source, causes = source_state(setup)
    assert source["validity"] == "UNAVAILABLE" and not causes
    assert video.index == -1


def test_read_exception_reports_failure_and_releases_capture(setup):
    class BrokenVideo(Video):
        def read(self):
            if self.index == 1: raise RuntimeError("decoder stopped")
            return super().read()
    video = BrokenVideo([0, 500, 1000])
    with pytest.raises(RuntimeError, match="decoder stopped"):
        execute(setup, video, lambda frame: [detection()])
    source, causes = source_state(setup)
    assert source["validity"] == "UNAVAILABLE" and causes[0]["hazard_type"] == "FIRE"
    assert video.released


def test_unavailable_delivery_failure_preserves_original_inference_error(setup):
    original, posts = setup.client, []
    def handle(request):
        if request.method == "GET": return original.get(request.url.path)
        posts.append(request.content)
        return httpx.Response(503)
    def predict(frame): raise RuntimeError("original model error")
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        setup.client = client
        with pytest.raises(RuntimeError, match="original model error"):
            execute(setup, Video([0]), predict)
    setup.client = original
    assert len(posts) == 2 and posts[0] == posts[1]
    assert any(r["operation"] == "unavailable_delivery_failed" for r in records(setup))


@pytest.mark.parametrize("location", ["session", "post"])
def test_interrupt_in_delivery_keeps_stop_reason_without_second_send_loop(setup, location):
    original, posts, sessions = setup.client, [], []
    def handle(request):
        if request.url.path == "/api/session":
            sessions.append(1)
            if location == "session" and len(sessions) == 2: raise KeyboardInterrupt()
        if request.method == "GET": return original.get(request.url.path)
        posts.append(request.content)
        raise KeyboardInterrupt()
    video = Video([0])
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        setup.client = client
        with pytest.raises(KeyboardInterrupt): execute(setup, video, lambda frame: [])
    setup.client = original
    assert len(posts) == (1 if location == "post" else 0) and video.released
    assert next(r for r in records(setup) if r["operation"] == "failed")["reason_code"] == "OPERATOR_STOPPED"
    assert not any(json.loads(body)["event_kind"] == "UNAVAILABLE" for body in posts)


@pytest.mark.parametrize("cause", ["STALE_OR_FUTURE_OBSERVATION", "RUN_OR_BUILDING_CHANGED"])
def test_pre_send_refusal_keeps_exact_reason_and_never_rebinds(setup, cause):
    def predict(frame):
        if cause == "STALE_OR_FUTURE_OBSERVATION":
            setup.clock.advance(3001)
        else:
            response = setup.client.post("/api/control/reset", json=dict(schema_version=1,
                                         run_id=setup.session.run_id, reason="test operator reset"))
            assert response.status_code == 200
        return []
    with pytest.raises(WorkerError, match=cause): execute(setup, Video([0]), predict)
    logged = records(setup)
    assert next(r for r in logged if r["operation"] == "failed")["reason_code"] == cause
    assert not any(r["operation"] == "send_attempt" for r in logged)


def test_delivery_failure_is_bounded_then_expires_without_clearing(setup):
    original, bodies = setup.client, []
    def handle(request):
        if request.method == "GET": return original.get(request.url.path)
        bodies.append(request.content)
        if len(bodies) > 2: return httpx.Response(503)
        return original.post(request.url.path, content=request.content,
                             headers={"Content-Type": "application/json"})
    video = Video([0, 500, 1000])
    with httpx.Client(transport=httpx.MockTransport(handle), base_url="http://test") as client:
        setup.client = client
        with pytest.raises(WorkerError, match="DELIVERY_FAILED"):
            execute(setup, video, lambda frame: [detection()])
    setup.client = original
    assert len(bodies) == 4 and bodies[2] == bodies[3] and video.released
    setup.clock.advance(3001)
    source, causes = source_state(setup)
    assert source["validity"] == "STALE" and causes[0]["hazard_type"] == "FIRE"
    assert next(r for r in records(setup) if r["operation"] == "failed")["reason_code"] == "DELIVERY_FAILED"


def test_video_heartbeat_does_not_refresh_last_analyzed_frame(setup):
    b = setup.builder
    for media_ms in (0, 500):
        event = b.observation(media_ms, setup.clock.utcnow(), [detection()])[0]
        sender(setup, setup.client).send(event)
    setup.clock.advance(2500)
    heartbeat = event | dict(event_id=str(uuid4()), source_sequence=3, event_kind="HEARTBEAT",
                            hazard_type=None, confidence=None, media_time_ms=None,
                            observed_at=utc_text(setup.clock.utcnow()))
    sender(setup, setup.client).send(heartbeat)
    setup.clock.advance(501)
    source, causes = source_state(setup)
    assert source["validity"] == "STALE" and causes[0]["hazard_type"] == "FIRE"


def test_eof_preserves_emergency_routing_and_command_service(setup):
    controller = setup.client.app.state.controller
    prepare(controller, setup.clock)
    execute(setup, Video([0, 500, 1000]), lambda frame: [detection()] if frame < 2 else [])
    state = setup.client.get("/api/state").json()
    assert state["controller_mode"] == "EMERGENCY"
    assert next(r for r in state["routes"] if r["node_id"] == "S")["next_node_id"] == "B"
    response = setup.client.get("/api/signs/SIGN-S/command")
    assert response.status_code == 200 and response.json()["run_id"] == setup.session.run_id

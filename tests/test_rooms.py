"""개인 체험방: 생성·접근 확인·정원·종료·만료와 방 사이 상태 분리."""

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.rooms import COOKIE, RoomManager
from scenario_runner.config import load_building, load_scenario
from http_reads import current_read
from test_manual_fire import event
from test_observation_state import ROOT, clock  # noqa: F401  (fixture)
from test_sign_guidance import ack as sign_ack


@pytest.fixture
def wfi():
    return load_building(ROOT / "data/space/wfi-v1.json")


@pytest.fixture
def setup(wfi, clock, tmp_path):
    manager = RoomManager(wfi, load_scenario(ROOT / "data/scenarios/wfi-idle.json", wfi), tmp_path / "runs",
                          clock=clock, now=lambda: clock.mono / 1000)
    app = create_app(building=wfi, clock=clock, runs_dir=tmp_path / "shared", rooms=manager, room_autotick=False)
    with TestClient(app) as client:
        yield client, manager, clock


def enter(client):
    """새 브라우저 한 명이 입장한다. 그 브라우저의 쿠키 머리말을 돌려준다."""
    client.cookies.clear()
    response = client.post("/api/rooms")
    assert response.status_code == 201, response.text
    token = response.cookies[COOKIE]
    client.cookies.clear()
    assert "httponly" in response.headers["set-cookie"].lower()
    return {"Cookie": f"{COOKIE}={token}"}


def state(client, who):
    return current_read(client, "/api/room/state", headers=who)


def ignite(client, who, clock, source_id):
    run_id = state(client, who)["run_id"]
    response = client.post("/api/room/events", headers=who, json=event(clock, run_id, source_id))
    assert response.status_code == 200, response.text
    return run_id


def causes(client, who):
    return {cause["source_id"] for cause in state(client, who)["active_causes"]}


def test_two_rooms_change_only_their_own_state(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    assert state(client, a)["run_id"] != state(client, b)["run_id"]
    assert state(client, a)["controller_mode"] == state(client, b)["controller_mode"] == "NORMAL"
    ignite(client, a, clock, "MANUAL-F1-PASSAGE-N")
    ignite(client, b, clock, "MANUAL-F3-CORR-N")
    assert causes(client, a) == {"MANUAL-F1-PASSAGE-N"}
    assert causes(client, b) == {"MANUAL-F3-CORR-N"}
    assert state(client, a)["blocked_edges"] != state(client, b)["blocked_edges"]
    # 공동 시연은 어느 방의 화재도 보지 않는다.
    assert client.get("/api/state").json()["active_causes"] == []


def test_clear_reset_and_end_of_one_room_leave_the_other_running(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    run_a = ignite(client, a, clock, "MANUAL-F1-PASSAGE-N")
    run_b = ignite(client, b, clock, "MANUAL-F3-CORR-N")
    cleared = client.post("/api/room/control/clear", headers=a, json=dict(
        schema_version=1, run_id=run_a, source_id="MANUAL-F1-PASSAGE-N", hazard_type="FIRE", reason="시험 해제"))
    assert cleared.status_code == 200
    assert causes(client, a) == set() and causes(client, b) == {"MANUAL-F3-CORR-N"}
    # 초기화: 방은 그대로, 실행만 새로 발급된다.
    before = client.get("/api/room", headers=a).json()
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    after = client.get("/api/room", headers=a).json()
    assert after["room_id"] == before["room_id"] and after["run_id"] != run_a
    assert state(client, b)["run_id"] == run_b and causes(client, b) == {"MANUAL-F3-CORR-N"}
    # 종료.
    assert client.delete("/api/room", headers=a).status_code == 204
    assert client.get("/api/room/state", headers=a).status_code == 401
    for _ in range(5):
        clock.advance(500)
        manager.step_all()
    assert state(client, b)["run_id"] == run_b and causes(client, b) == {"MANUAL-F3-CORR-N"}
    assert client.get("/api/room/sim/state", headers=b).json()["status"] == "RUNNING"


def test_a_token_only_reaches_its_own_room(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room_b = client.get("/api/room", headers=b).json()
    run_b = room_b["run_id"]
    # 증표가 없거나 틀리면 조회·조작 모두 거부된다. 방 번호나 실행 번호를 아는 것은 소용없다.
    for who in ({}, {"Cookie": f"{COOKIE}=guess"}, {"Cookie": f"{COOKIE}={room_b['room_id']}"}):
        assert client.get("/api/room/state", headers=who).status_code == 401
        assert client.get("/api/room/sim/state", headers=who).status_code == 401
        assert client.post("/api/room/sim/restart", headers=who).status_code == 401
        assert client.post("/api/room/events", headers=who, json=event(clock, run_b, "MANUAL-F3-CORR-N")).status_code == 401
        assert client.delete("/api/room", headers=who).status_code == 401
    # A의 증표로 B의 실행 번호를 넣어 조작하면 A의 방에서 실행 불일치로 거부되고, B에는 아무 일도 없다.
    crossed = client.post("/api/room/events", headers=a, json=event(clock, run_b, "MANUAL-F3-CORR-N"))
    assert crossed.status_code == 409 and crossed.json()["error"]["code"] == "RUN_MISMATCH"
    assert causes(client, a) == set() and causes(client, b) == set()
    # 요청 본문이나 주소로 방을 고를 수 없다. 클라이언트가 보낸 번호는 믿지 않는다.
    assert client.get(f"/api/room/state?room_id={room_b['room_id']}", headers=a).json()["run_id"] != run_b
    # 내부 경로는 내부 증표 없이는 열리지 않는다.
    assert client.get("/api/state", headers={"X-Saferoute-Room": room_b["room_id"]}).status_code == 403


def test_sign_acks_count_only_in_their_own_room(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    sign_id = state(client, a)["signs"][0]["sign_id"]
    command = client.get(f"/api/room/signs/{sign_id}/command", headers=a).json()
    ack = sign_ack(command)
    # A의 응답을 B의 증표로 보내면 B의 방에서 거부되고 B의 집계에 들어가지 않는다.
    stolen = client.post(f"/api/room/signs/{sign_id}/ack", headers=b, json=ack)
    assert stolen.status_code == 409 and stolen.json()["error"]["code"] == "RUN_MISMATCH"
    applied = client.post(f"/api/room/signs/{sign_id}/ack", headers=a, json=ack)
    assert applied.status_code == 200, applied.text
    count = lambda who: sum(s["application_status"] == "APPLIED" for s in state(client, who)["signs"])
    assert count(a) == 1 and count(b) == 0
    assert all(s["application_status"] == "NOT_ISSUED" for s in client.get("/api/state").json()["signs"])


def test_requests_from_before_a_reset_do_not_reach_the_new_run(setup):
    client, manager, clock = setup
    a = enter(client)
    old_run = state(client, a)["run_id"]
    late_fire = event(clock, old_run, "MANUAL-F1-PASSAGE-N")
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    late = client.post("/api/room/events", headers=a, json=late_fire)
    assert late.status_code == 409 and late.json()["error"]["code"] == "RUN_MISMATCH"
    late_clear = client.post("/api/room/control/clear", headers=a, json=dict(
        schema_version=1, run_id=old_run, source_id="MANUAL-F1-PASSAGE-N", hazard_type="FIRE", reason="늦은 해제"))
    assert late_clear.status_code == 409
    for _ in range(3):
        clock.advance(100)
        manager.step_all()
    assert state(client, a)["run_id"] != old_run
    assert causes(client, a) == set() and state(client, a)["controller_mode"] == "NORMAL"


def test_capacity_holds_under_concurrent_entry_and_counts_rooms_being_prepared(setup):
    client, manager, clock = setup
    building_now, release = threading.Semaphore(0), threading.Event()
    original = manager._build

    def slow():
        building_now.release()
        release.wait(5)
        return original()

    manager._build = slow
    with ThreadPoolExecutor(12) as pool:
        futures = [pool.submit(manager.create) for _ in range(12)]
        for _ in range(5):
            assert building_now.acquire(timeout=5)
        # 다섯 방이 아직 준비 중일 때 이미 정원이 찼다. 여섯 번째는 준비를 시작하지도 못한다.
        assert not building_now.acquire(timeout=0.3)
        assert manager.availability() == {"capacity": 5, "in_use": 5}
        release.set()
        results = [future.exception() for future in futures]
    assert sum(error is None for error in results) == 5
    assert all(error.code == "ROOM_FULL" for error in results if error is not None)
    assert len(manager.rooms) == 5
    manager._build = original
    client.cookies.clear()
    full = client.post("/api/rooms")
    assert full.status_code == 409 and full.json()["error"]["code"] == "ROOM_FULL"


def test_same_browser_reenters_its_room_instead_of_taking_another_seat(setup):
    client, manager, clock = setup
    a = enter(client)
    room = client.get("/api/room", headers=a).json()
    again = client.post("/api/rooms", headers=a)
    assert again.status_code == 200 and again.json()["room_id"] == room["room_id"]
    assert manager.availability()["in_use"] == 1


def test_seat_returns_after_failed_creation_explicit_end_and_idle_expiry(setup):
    client, manager, clock = setup
    original = manager._build

    def broken():
        raise RuntimeError("runner could not start")

    manager._build = broken
    client.cookies.clear()
    failed = client.post("/api/rooms")
    assert failed.status_code == 503 and failed.json()["error"]["code"] == "ROOM_CREATE_FAILED"
    assert manager.availability()["in_use"] == 0
    manager._build = original
    a, b = enter(client), enter(client)
    assert client.delete("/api/room", headers=a).status_code == 204
    assert manager.availability()["in_use"] == 1
    # 종료된 방은 늦은 요청으로 되살아나지 않는다.
    assert client.get("/api/room/state", headers=a).status_code == 401
    assert client.post("/api/room/sim/restart", headers=a).status_code == 401
    assert manager.availability()["in_use"] == 1
    # 9분 59초에는 남아 있고, 마지막 사용자 접속 뒤 10분이 지나면 반환된다.
    clock.advance(599_000)
    manager.step_all()
    assert manager.availability()["in_use"] == 1
    clock.advance(2_000)
    manager.step_all()
    assert manager.availability()["in_use"] == 0
    assert client.get("/api/room/state", headers=b).status_code == 401


def test_only_user_requests_extend_the_room_not_the_runner_or_internal_calls(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room_b = client.get("/api/room", headers=b).json()["room_id"]
    internal = {"X-Saferoute-Room": room_b, "X-Saferoute-Internal": manager.internal_token}
    for _ in range(125):
        clock.advance(5_000)
        manager.step_all()
        if _ % 20 == 0:
            # A는 사용자가 화면을 보고 있고, B는 실행기와 내부(AI) 요청만 계속 들어온다.
            state(client, a)
            if room_b in manager.rooms:
                current_read(client, "/api/state", headers=internal)
    state(client, a)
    assert client.get("/api/room/state", headers=b).status_code == 401
    assert manager.availability()["in_use"] == 1


def test_internal_access_is_separate_from_browser_access(setup):
    client, manager, clock = setup
    a = enter(client)
    info = client.get("/api/room", headers=a).json()
    internal = {"X-Saferoute-Room": info["room_id"], "X-Saferoute-Internal": manager.internal_token}
    assert client.get("/api/session", headers=internal).json()["run_id"] == info["run_id"]
    # 내부 증표가 틀리거나, 없는 방이거나, 브라우저 쿠키만으로는 내부 경로에 닿지 못한다.
    assert client.get("/api/session", headers={**internal, "X-Saferoute-Internal": "wrong"}).status_code == 403
    assert client.get("/api/session", headers={**internal, "X-Saferoute-Room": "missing"}).status_code == 403
    assert client.get("/api/session", headers=a).json()["run_id"] != info["run_id"]
    # 브라우저 응답에 내부 증표나 접속 증표가 실리지 않는다.
    assert manager.internal_token not in client.get("/api/room", headers=a).text
    assert a["Cookie"].split("=", 1)[1] not in client.get("/api/room", headers=a).text


def test_one_broken_room_does_not_stop_the_others(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room_a = manager.rooms[client.get("/api/room", headers=a).json()["room_id"]]

    def explode():
        raise RuntimeError("room A broke")

    room_a.runner.tick = explode
    before = client.get("/api/room/sim/state", headers=b).json()["simulation_time_ms"]
    for _ in range(10):
        clock.advance(500)
        manager.step_all()
    assert client.get("/api/room/sim/state", headers=b).json()["simulation_time_ms"] >= before + 4000
    assert client.get("/api/room", headers=a).json()["status"] == "FAILED"
    assert state(client, b)["controller_mode"] == "NORMAL"


def test_shared_demo_reset_does_not_touch_rooms_and_rooms_are_optional(setup, wfi, clock, tmp_path):
    client, manager, _ = setup
    a = enter(client)
    run_a = ignite(client, a, clock, "MANUAL-F1-PASSAGE-N")
    shared = client.get("/api/session").json()["run_id"]
    assert client.post("/api/control/reset", json=dict(schema_version=1, run_id=shared, reason="공동 시연 초기화")).status_code == 200
    assert state(client, a)["run_id"] == run_a and causes(client, a) == {"MANUAL-F1-PASSAGE-N"}
    # 방 기능을 켜지 않은 서버에서는 방을 만들 수 없고, 공동 시연은 그대로 동작한다.
    with TestClient(create_app(building=wfi, clock=clock, runs_dir=tmp_path / "plain")) as plain:
        assert plain.post("/api/rooms").status_code == 503
        assert plain.get("/api/state").status_code == 200


def test_run_evidence_stays_on_disk_after_the_room_ends(setup, tmp_path):
    client, manager, clock = setup
    a = enter(client)
    info = client.get("/api/room", headers=a).json()
    ignite(client, a, clock, "MANUAL-F1-PASSAGE-N")
    assert client.delete("/api/room", headers=a).status_code == 204
    run_dir = tmp_path / "runs" / "rooms" / info["room_id"] / info["run_id"]
    assert (run_dir / "events.jsonl").read_text(encoding="utf-8").count("MANUAL-F1-PASSAGE-N") >= 1
    assert '"closed": true' in (run_dir / "manifest.json").read_text(encoding="utf-8")


# ---- 영상 AI 대기열 · 미리보기 · 상황 설명 ----

class FakeJob:
    """실제 AI 작업기 대신 쓰는 모형. 끝내거나 실패시키는 것은 시험이 정한다."""
    def __init__(self, room, run_id):
        self.room_id, self.run_id, self.code, self.terminated = room.room_id, run_id, None, False

    def poll(self): return self.code
    def terminate(self): self.terminated, self.code = True, -15


@pytest.fixture
def ai(setup):
    client, manager, clock = setup
    started = []

    def launch(room, run_id):
        started.append(FakeJob(room, run_id))
        return started[-1]

    manager.ai.launch = launch
    return client, manager, clock, started


def ai_state(client, who):
    response = client.get("/api/room/ai", headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def request_ai(client, who):
    return client.post("/api/room/ai", headers=who)


def test_ai_runs_one_job_at_a_time_and_the_next_valid_job_follows(ai):
    client, manager, clock, started = ai
    a, b, c = enter(client), enter(client), enter(client)
    assert ai_state(client, a)["state"] == "IDLE"
    assert request_ai(client, a).json()["state"] == "RUNNING"
    assert request_ai(client, b).json() | {"run_id": None} == {"state": "QUEUED", "position": 1, "run_id": None}
    assert request_ai(client, c).json()["position"] == 2
    for _ in range(5):
        manager.step_all()
    assert len(started) == 1 and sum(job.code is None for job in started) == 1
    # 한 방에서 거듭 요청해도 대기열은 늘지 않는다.
    for _ in range(5):
        assert request_ai(client, b).json()["position"] == 1
        assert request_ai(client, a).json()["state"] == "RUNNING"
    assert len(manager.ai.jobs) == 3
    # 대기 중인 방도 수동 화재와 대피 시뮬레이션은 그대로 쓴다.
    ignite(client, b, clock, "MANUAL-F1-PASSAGE-N")
    assert causes(client, b) == {"MANUAL-F1-PASSAGE-N"}
    # 실패해도 다음 작업이 이어진다.
    started[0].code = 1
    manager.step_all()
    assert ai_state(client, a)["state"] == "FAILED"
    assert ai_state(client, b)["state"] == "RUNNING" and ai_state(client, c)["position"] == 1
    started[1].code = 0
    manager.step_all()
    assert ai_state(client, b)["state"] == "DONE" and ai_state(client, c)["state"] == "RUNNING"
    assert len(started) == 3 and [job.terminated for job in started] == [False, False, False]


def test_ending_or_resetting_a_room_removes_its_waiting_job_and_stops_its_running_job(ai):
    client, manager, clock, started = ai
    a, b, c = enter(client), enter(client), enter(client)
    for who in (a, b, c):
        request_ai(client, who)
    # 대기 중이던 B가 종료한다: 대기열에서 빠지고 C가 앞으로 온다.
    assert client.delete("/api/room", headers=b).status_code == 204
    assert ai_state(client, c)["position"] == 1 and len(started) == 1
    # 실행 중이던 A가 초기화한다: 작업을 멈추고, 새 실행에는 이전 작업의 상태가 남지 않는다.
    old_run = ai_state(client, a)["run_id"]
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    assert started[0].terminated
    manager.step_all()
    assert ai_state(client, a) == {"state": "IDLE", "position": None, "run_id": None}
    assert ai_state(client, c)["state"] == "RUNNING" and started[1].room_id != started[0].room_id
    # 초기화한 방은 새 실행으로 다시 줄을 설 수 있다.
    again = request_ai(client, a).json()
    assert again["state"] == "QUEUED" and again["run_id"] != old_run


def test_a_job_waiting_for_a_run_that_was_reset_never_starts(ai):
    client, manager, clock, started = ai
    a, b = enter(client), enter(client)
    request_ai(client, a)
    request_ai(client, b)
    # B의 실행기가 직접 초기화된 것처럼, 알림 없이 실행만 바뀐 경우에도 옛 실행의 작업은 시작하지 않는다.
    room_b = manager.rooms[client.get("/api/room", headers=b).json()["room_id"]]
    room_b.runner.restart()
    started[0].code = 0
    manager.step_all()
    manager.step_all()
    assert len(started) == 1 and ai_state(client, b)["state"] == "IDLE"


def test_late_ai_results_from_before_a_reset_are_not_applied(ai):
    client, manager, clock, started = ai
    a = enter(client)
    info = client.get("/api/room", headers=a).json()
    internal = {"X-Saferoute-Room": info["room_id"], "X-Saferoute-Internal": manager.internal_token}
    # 초기화 전에 AI 작업기가 만들어 둔 감지 결과.
    late = event(clock, info["run_id"], "CAM-F2-CORR-W") | dict(source_type="VIDEO_AI", confidence=0.9, media_time_ms=1000)
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    response = client.post("/api/events", headers=internal, json=late)
    assert response.status_code == 409 and response.json()["error"]["code"] == "RUN_MISMATCH"
    assert causes(client, a) == set()


def test_ai_without_model_or_video_is_reported_as_unavailable_not_as_detecting(setup):
    client, manager, clock = setup
    a = enter(client)
    assert ai_state(client, a)["state"] == "UNAVAILABLE"
    refused = request_ai(client, a)
    assert refused.status_code == 503 and refused.json()["error"]["code"] == "AI_UNAVAILABLE"
    assert manager.ai.jobs == []


def test_a_job_that_cannot_start_fails_and_does_not_block_the_queue(ai):
    client, manager, clock, started = ai
    a, b = enter(client), enter(client)
    working = manager.ai.launch

    def broken(room, run_id):
        raise OSError("model file missing")

    manager.ai.launch = broken
    assert request_ai(client, a).json()["state"] == "FAILED"
    manager.ai.launch = working
    assert request_ai(client, b).json()["state"] == "RUNNING"


def preview_update(run_id, building, status="EOF"):
    source = next(s for s in building.sources if s.source_type == "VIDEO_AI")
    return source.source_id, dict(sequence=1, jpeg_base64=None, preview=dict(
        schema_version=1, run_id=run_id, building_id=building.building_id, building_version=building.building_version,
        source_id=source.source_id, generated_at="2026-11-10T01:00:00Z", freshness_ms=source.freshness_ms,
        status=status, frame=None, error_code=None))


def test_previews_belong_to_one_room_and_one_run(setup, wfi):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    info_a, info_b = client.get("/api/room", headers=a).json(), client.get("/api/room", headers=b).json()
    internal = lambda info: {"X-Saferoute-Room": info["room_id"], "X-Saferoute-Internal": manager.internal_token}
    source_id, update = preview_update(info_a["run_id"], wfi)
    read = lambda who, run: client.get(f"/api/room/previews/{source_id}?run_id={run}", headers=who)
    # 브라우저 증표로는 미리보기를 써넣을 수 없다.
    assert client.post("/internal/preview", headers=a, json=update).status_code == 403
    assert client.post("/internal/preview", headers=internal(info_a), json=update).status_code == 204
    assert read(a, info_a["run_id"]).json()["status"] == "EOF"
    # B는 A의 결과를 보지 못하고, A의 실행 번호를 넣어도 B의 방에서 거부된다.
    assert read(b, info_b["run_id"]).json()["status"] == "INITIALIZING"
    assert read(b, info_a["run_id"]).status_code == 409
    # A의 결과를 B의 방으로 보내면 실행 불일치로 거부된다.
    assert client.post("/internal/preview", headers=internal(info_b), json=update).status_code == 409
    # 초기화하면 이전 실행의 미리보기는 사라지고, 늦게 도착한 이전 실행의 결과도 들어오지 못한다.
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    new_run = client.get("/api/room", headers=a).json()["run_id"]
    assert read(a, new_run).json()["status"] == "INITIALIZING"
    assert client.post("/internal/preview", headers=internal(info_a), json=update | {"sequence": 2}).status_code == 409
    assert read(a, info_a["run_id"]).status_code == 409


def test_explanations_describe_only_the_callers_room_and_current_run(setup):
    from explanation_worker.config import ExplanationConfig
    from explanation_worker.service import Service
    from test_explanation_service import MemoryJournal, response
    client, manager, clock = setup
    calls = []

    def provider(basis):
        calls.append(basis["run_id"])
        return response()

    manager.explainer = lambda room: Service(ExplanationConfig(), provider, MemoryJournal(),
                                             utcnow=clock.utcnow, monotonic=lambda: clock.mono / 1000)
    a, b = enter(client), enter(client)
    run_a, run_b = state(client, a)["run_id"], state(client, b)["run_id"]

    def explain(who):
        for _ in range(20):
            value = client.get("/api/room/explanations/current", headers=who)
            assert value.status_code == 200, value.text
            if value.json()["status"] != "PENDING": break
            time.sleep(.01)
        return value.json()

    first = explain(a)
    assert first["run_id"] == run_a and first["status"] == "READY"
    assert explain(b)["run_id"] == run_b
    assert set(calls) == {run_a, run_b}
    # 초기화하면 이전 실행의 설명은 새 실행에 나오지 않는다.
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    for _ in range(3):
        clock.advance(100)
        manager.step_all()
    after = client.get("/api/room/explanations/current", headers=a).json()
    assert after["run_id"] != run_a and after["status"] != "READY"
    assert client.get("/api/room/explanations/current", headers={}).status_code == 401


def test_explanation_is_reported_unavailable_when_not_configured(setup):
    client, manager, clock = setup
    a = enter(client)
    missing = client.get("/api/room/explanations/current", headers=a)
    assert missing.status_code == 503 and missing.json()["error"]["code"] == "EXPLANATION_UNAVAILABLE"


# ---- 한 방의 지연·종료가 다른 방과 서버 전체를 막지 않는지 ----

def wait_until(condition, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition(): return True
        time.sleep(.01)
    return condition()


def sim_time(client, who):
    return client.get("/api/room/sim/state", headers=who).json()["simulation_time_ms"]


def test_a_slow_room_does_not_hold_back_the_others_and_its_work_does_not_pile_up(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room_a = manager.rooms[client.get("/api/room", headers=a).json()["room_id"]]
    room_b = manager.rooms[client.get("/api/room", headers=b).json()["room_id"]]
    release, calls, inside = threading.Event(), [], []
    original = room_a.runner.tick

    def stuck():
        calls.append(1)
        inside.append(len(inside))
        release.wait(10)  # A의 기록 저장·잠금 대기가 길어진 상황
        return original()

    room_a.runner.tick = stuck
    b_ticks, tick_b = [], room_b.runner.tick

    def count_b():
        b_ticks.append(1)
        return tick_b()

    room_b.runner.tick = count_b
    before = sim_time(client, b)
    observed = lambda: [s["last_observed_at"] for s in state(client, b)["sources"] if s["last_observed_at"]]
    first_observed = observed()
    try:
        started = time.monotonic()
        for _ in range(12):
            clock.advance(500)
            assert wait_until(lambda: not room_b.busy)  # 서버의 다음 주기는 B의 이전 작업이 끝난 뒤에 온다
            seen = len(b_ticks)
            manager.step_all(wait=False)
            assert wait_until(lambda: len(b_ticks) > seen), f"B가 A를 기다리느라 진행하지 못함 (B 진행 {len(b_ticks)}회, busy={room_b.busy}, error={room_b.error}, A busy={room_a.busy})"
        # A가 막혀 있는 동안에도 B는 매번 진행하고 관측을 새로 받는다.
        assert time.monotonic() - started < 5
        assert len(b_ticks) >= 12 and sim_time(client, b) >= before + 5000
        assert observed() != first_observed
        assert state(client, b)["controller_mode"] == "NORMAL"
        # A의 작업은 겹치지도, 쌓이지도 않는다. 막힌 한 번만 진행 중이다.
        assert len(calls) == 1
    finally:
        release.set()
    assert wait_until(lambda: not room_a.busy)
    clock.advance(500)
    manager.step_all(wait=False)
    assert wait_until(lambda: len(calls) == 2), "풀린 뒤 A가 다시 진행하지 않음"


def test_a_room_stuck_while_closing_does_not_hold_back_the_others_and_gets_no_new_work(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room_a = manager.rooms[client.get("/api/room", headers=a).json()["room_id"]]
    room_b = manager.rooms[client.get("/api/room", headers=b).json()["room_id"]]
    release, closing, ticks_after = threading.Event(), threading.Event(), []
    original_close = room_a.runner.close

    def stuck_close():
        closing.set()
        release.wait(10)
        return original_close()

    room_a.runner.close = stuck_close
    b_ticks, tick_b = [], room_b.runner.tick

    def count_b():
        b_ticks.append(1)
        return tick_b()

    room_b.runner.tick = count_b
    try:
        # A는 화면이 모두 닫힌 지 10분이 넘었고, B는 계속 사용 중이다.
        room_a.last_seen -= manager.idle_seconds
        began = time.monotonic()
        for _ in range(4):
            clock.advance(500)
            assert client.get("/api/room/state", headers=b).status_code == 200
            assert wait_until(lambda: not room_b.busy)  # 서버의 다음 주기는 B의 이전 작업이 끝난 뒤에 온다
            seen = len(b_ticks)
            manager.step_all(wait=False)
            assert wait_until(lambda: len(b_ticks) > seen), "B가 A의 종료를 기다림"
        assert closing.wait(3), "A의 만료 종료가 시작되지 않음"
        # 만료 종료가 막혀 있어도 주기 작업은 그것을 기다리지 않았다.
        assert time.monotonic() - began < 5, "주기 작업이 A의 종료 처리를 기다림"
        room_a.runner.tick = lambda: ticks_after.append(1)
        # 접근은 즉시 종료하지만 자원 정리가 끝날 때까지 자리는 예약해 둔다.
        assert manager.availability()["in_use"] == 2
        assert client.get("/api/room/state", headers=a).status_code == 401
        for _ in range(5):
            clock.advance(500)
            assert wait_until(lambda: not room_b.busy)  # 서버의 다음 주기는 B의 이전 작업이 끝난 뒤에 온다
            seen = len(b_ticks)
            manager.step_all(wait=False)
            assert wait_until(lambda: len(b_ticks) > seen)
        assert ticks_after == [], "종료 중인 방에 새 작업이 예약됨"
    finally:
        release.set()
    manager.shutdown()


def test_preview_update_does_not_block_other_requests_on_the_event_loop(setup, wfi):
    client, manager, clock = setup
    a = enter(client)
    info = client.get("/api/room", headers=a).json()
    room = manager.rooms[info["room_id"]]
    internal = {"X-Saferoute-Room": info["room_id"], "X-Saferoute-Internal": manager.internal_token}
    _, update = preview_update(info["run_id"], wfi)
    release, entered = threading.Event(), threading.Event()
    original = room.controller.snapshot

    def slow_snapshot():
        entered.set()
        release.wait(5)  # 상태 조회가 잠금·기록 저장을 기다리는 상황
        return original()

    room.controller.snapshot = slow_snapshot
    result = {}
    poster = threading.Thread(target=lambda: result.update(code=client.post("/internal/preview", headers=internal, json=update).status_code))
    poster.start()
    try:
        assert entered.wait(3)
        started = time.monotonic()
        health = client.get("/api/health")
        elapsed = time.monotonic() - started
        assert health.status_code == 200 and elapsed < 0.25, f"정상 확인 요청이 미리보기 처리를 {elapsed:.3f}초 기다림"
        assert "code" not in result
    finally:
        release.set()
        poster.join(5)
    # 풀린 뒤에는 기존 검증 그대로 처리된다.
    assert result["code"] == 204
    room.controller.snapshot = original
    assert client.post("/internal/preview", headers=a, json=update).status_code == 403
    assert client.post("/internal/preview", headers=internal, json=update | {"preview": update["preview"] | {"run_id": "99999999-9999-4999-8999-999999999999"}}).status_code == 409


class LingeringJob(FakeJob):
    """종료 요청을 받아도 바로 죽지 않는 프로세스. 실제 종료는 시험이 정한다."""
    def __init__(self, room, run_id):
        super().__init__(room, run_id)
        self.killed = False

    def terminate(self): self.terminated = True
    def kill(self): self.killed = True


@pytest.fixture
def lingering(setup):
    client, manager, clock = setup
    started = []

    def launch(room, run_id):
        started.append(LingeringJob(room, run_id))
        return started[-1]

    manager.ai.launch = launch
    manager.ai.now = lambda: clock.mono / 1000
    try:
        yield client, manager, clock, started
    finally:
        for job in started:
            job.code = -9


def test_next_ai_job_waits_until_the_stopped_one_has_really_exited(lingering):
    client, manager, clock, started = lingering
    a, b, c = enter(client), enter(client), enter(client)
    for who in (a, b, c):
        request_ai(client, who)
    # 실행 중이던 A가 종료한다. 종료 요청은 갔지만 프로세스는 아직 살아 있다.
    assert client.delete("/api/room", headers=a).status_code == 204
    assert started[0].terminated and started[0].poll() is None
    for _ in range(10):
        clock.advance(100)
        manager.step_all()
    assert len(started) == 1, "이전 AI가 살아 있는데 다음 AI가 시작됨"
    assert ai_state(client, b) | {"run_id": None} == {"state": "QUEUED", "position": 1, "run_id": None}
    # 기다리는 동안 다른 방의 일반 요청은 그대로 처리된다.
    ignite(client, b, clock, "MANUAL-F1-PASSAGE-N")
    assert causes(client, b) == {"MANUAL-F1-PASSAGE-N"}
    # 대기가 길어지면 강제 종료를 보내되, 실제로 끝난 것을 확인하기 전에는 여전히 시작하지 않는다.
    clock.advance(10_000)
    manager.step_all()
    assert started[0].killed and len(started) == 1
    for _ in range(5):
        clock.advance(1000)
        manager.step_all()
    assert len(started) == 1, "종료를 확인하지 못했는데 자리를 반환함"
    # 종료가 확인된 뒤에만 다음 유효한 작업이 시작된다.
    started[0].code = -9
    manager.step_all()
    assert len(started) == 2 and started[1].room_id != started[0].room_id
    assert ai_state(client, b)["state"] == "RUNNING" and ai_state(client, c)["position"] == 1


def test_reset_while_ai_is_running_keeps_one_at_a_time_and_rejects_the_old_run(lingering):
    client, manager, clock, started = lingering
    a, b = enter(client), enter(client)
    request_ai(client, a)
    request_ai(client, b)
    old_run = ai_state(client, a)["run_id"]
    assert client.post("/api/room/sim/restart", headers=a).status_code == 200
    # 초기화한 방이 곧바로 다시 요청해도, 이전 프로세스가 끝나기 전에는 아무 것도 시작하지 않는다.
    again = request_ai(client, a).json()
    assert again["state"] == "QUEUED" and again["run_id"] != old_run
    for _ in range(5):
        clock.advance(100)
        manager.step_all()
    assert len(started) == 1
    started[0].code = -15
    manager.step_all()
    assert len(started) == 2 and started[1].run_id != old_run
    assert sum(job.poll() is None for job in started) == 1


def test_controller_is_closed_even_when_the_runner_fails_to_close(setup):
    client, manager, clock = setup
    a, b = enter(client), enter(client)
    info = client.get("/api/room", headers=a).json()
    room = manager.rooms[info["room_id"]]
    controller_closed, original = [], room.controller.close

    def disk_full():
        raise OSError("scenario log could not be written")

    def spy():
        controller_closed.append(1)
        return original()

    room.runner.close, room.controller.close = disk_full, spy
    assert client.delete("/api/room", headers=a).status_code == 204
    assert controller_closed == [1], "실행기 종료 실패로 제어기 종료가 생략됨"
    # 실패는 기록에 남고, 정상 종료로 치지 않는다.
    assert manager.close_failures[info["room_id"]] == ["runner: OSError"]
    # 반복 종료에도 안전하고, 종료된 방은 되살아나지 않는다.
    manager.close(room, "ended")
    assert controller_closed == [1] and manager.availability()["in_use"] == 1
    assert client.get("/api/room/state", headers=a).status_code == 401
    assert state(client, b)["controller_mode"] == "NORMAL"

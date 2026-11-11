"""The bounded controller reader must preserve personal-room isolation."""

from concurrent.futures import ThreadPoolExecutor, wait
import gc
from threading import Event, Lock
import weakref

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.rooms import INTERNAL_HEADER, ROOM_HEADER
from test_rooms import clock, enter, setup, state, wait_until, wfi  # noqa: F401


@pytest.mark.parametrize("end_while_preparing", [False, True])
def test_slow_explanation_setup_is_isolated_and_closed_with_its_room(setup, end_while_preparing):
    from explanation_worker.config import ExplanationConfig
    from explanation_worker.service import Service
    from test_explanation_service import MemoryJournal, response

    client, manager, clock = setup
    a, b = enter(client), enter(client)
    room = manager.rooms[client.get("/api/room", headers=a).json()["room_id"]]
    entered, release, closed = Event(), Event(), Event()

    def factory(_room):
        entered.set()
        assert release.wait(5)
        service = Service(ExplanationConfig(), lambda basis: response(), MemoryJournal(),
                          utcnow=clock.utcnow, monotonic=lambda: clock.mono / 1000)
        original = service.close

        def close():
            original()
            closed.set()

        service.close = close
        return service

    manager.explainer = factory
    with ThreadPoolExecutor(max_workers=3) as pool:
        preparing = pool.submit(client.get, "/api/room/explanations/current", headers=a)
        try:
            assert entered.wait(2)
            other = pool.submit(client.get, "/api/room/state", headers=b)
            done, _ = wait([other], timeout=1)
            assert done, "one room's explanation setup blocked another room"
            assert other.result().status_code == 200
            if end_while_preparing:
                ending = pool.submit(manager.close, room, "ended")
                assert wait_until(lambda: room.closed)
                assert not ending.done()
                assert manager.availability()["in_use"] == 2
        finally:
            release.set()
        assert preparing.result().status_code == (401 if end_while_preparing else 200)
        if end_while_preparing:
            ending.result()
            assert closed.is_set()
            assert manager.availability()["in_use"] == 1


def test_room_shutdown_failure_still_finalizes_the_shared_controller(wfi, clock, tmp_path, monkeypatch):
    app = create_app(building=wfi, clock=clock, runs_dir=tmp_path)
    finalized = Event()

    class FailedRooms:
        def shutdown(self):
            raise RuntimeError("AI process did not exit")

    with pytest.raises(RuntimeError, match="AI process did not exit"):
        with TestClient(app):
            app.state.rooms = FailedRooms()
            original = app.state.controller.close

            def close():
                original()
                finalized.set()

            monkeypatch.setattr(app.state.controller, "close", close)
    assert finalized.is_set(), "room cleanup failure skipped shared controller cleanup"


@pytest.mark.parametrize("path", ["/api/room/state", "/api/room/session"])
def test_room_access_lock_cannot_block_the_http_event_loop(setup, monkeypatch, path):
    client, manager, _ = setup
    a = enter(client)
    original = manager.by_token
    entered = Event()

    def waiting_for_access(token):
        entered.set()
        return original(token)

    monkeypatch.setattr(manager, "by_token", waiting_for_access)
    with ThreadPoolExecutor(max_workers=2) as pool:
        with manager.lock:
            pending = pool.submit(client.get, path, headers=a)
            assert entered.wait(2)
            health = pool.submit(client.get, "/api/health")
            done, _ = wait([health], timeout=1)
            responded = bool(done)
        assert health.result().status_code == 200
        assert pending.result().status_code == 200
    assert responded, "room access lock blocked unrelated HTTP requests"


def test_room_browser_and_internal_reads_share_one_bounded_snapshot(setup, monkeypatch):
    client, manager, _ = setup
    a, b = enter(client), enter(client)
    room = manager.by_token(a["Cookie"].split("=", 1)[1])
    run_a, run_b = room.runner.run_id, state(client, b)["run_id"]
    shared_run = client.get("/api/session").json()["run_id"]
    internal = {ROOM_HEADER: room.room_id, INTERNAL_HEADER: manager.internal_token}
    entered, release, lock = Event(), Event(), Lock()
    original, calls = room.controller.snapshot, 0

    def blocked_snapshot():
        nonlocal calls
        with lock:
            calls += 1
        entered.set()
        assert release.wait(5)
        return original()

    monkeypatch.setattr(room.controller, "snapshot", blocked_snapshot)
    with ThreadPoolExecutor(max_workers=5) as pool:
        first = pool.submit(client.get, "/api/room/state", headers=a)
        try:
            assert entered.wait(2)
            reads = [first, *[pool.submit(client.get, path, headers=headers) for path, headers in (
                ("/api/room/session", a), ("/api/state", internal), ("/api/session", internal))]]
            done, _ = wait(reads, timeout=1.5)
            assert len(done) == 4, "a slow room held its HTTP reads instead of reporting busy"
            for pending in reads:
                response = pending.result()
                assert response.status_code == 503
                assert response.json()["error"]["code"] == "CONTROLLER_BUSY"
                assert response.headers["Retry-After"] == "1"
            assert calls == 1, "browser and worker reads queued duplicate snapshots"
            gc.collect()
            assert client.get("/api/room/state", headers=a).status_code == 503
            assert calls == 1, "timed-out reads lost their in-flight snapshot during collection"
            assert state(client, b)["run_id"] == run_b
            assert client.get("/api/session").json()["run_id"] == shared_run
            assert client.get("/api/health").status_code == 200
        finally:
            release.set()
    assert state(client, a)["run_id"] == run_a
    assert client.get("/api/session", headers=internal).json()["run_id"] == run_a
    assert client.get("/api/state", headers={ROOM_HEADER: room.room_id}).status_code == 403


@pytest.mark.parametrize("path", ["/api/room/sim/state", "/api/room", "/api/rooms"])
def test_room_restart_reports_temporary_unavailability_until_rebound(setup, monkeypatch, path):
    client, manager, _ = setup
    a, b = enter(client), enter(client)
    room = manager.by_token(a["Cookie"].split("=", 1)[1])
    run_a, run_b = room.runner.run_id, state(client, b)["run_id"]
    original = room.runner._bind
    entered, release = Event(), Event()

    def delayed_bind():
        entered.set()
        assert release.wait(5)
        return original()

    monkeypatch.setattr(room.runner, "_bind", delayed_bind)
    with ThreadPoolExecutor(max_workers=1) as pool:
        restart = pool.submit(client.post, "/api/room/sim/restart", headers=a)
        try:
            assert entered.wait(2)
            response = client.request("POST" if path == "/api/rooms" else "GET", path, headers=a)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "CONTROLLER_UNAVAILABLE"
            assert response.headers["Retry-After"] == "1"
            assert state(client, b)["run_id"] == run_b
        finally:
            release.set()
        assert restart.result().status_code == 200
    assert client.get("/api/room/sim/state", headers=a).json()["run_id"] != run_a


def test_ended_room_is_not_retained_by_http_reader_cache(setup):
    client, manager, _ = setup
    a = enter(client)
    controller = manager.by_token(a["Cookie"].split("=", 1)[1]).controller
    reference = weakref.ref(controller)
    state(client, a)
    assert client.delete("/api/room", headers=a).status_code == 204
    assert client.get("/api/room/state", headers=a).status_code == 401
    del controller
    gc.collect()
    assert reference() is None, "ended rooms accumulated in the HTTP reader cache"

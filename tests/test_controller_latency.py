"""Read backpressure must not publish stale state or spawn unbounded workers."""

from concurrent.futures import ThreadPoolExecutor, wait
from threading import Event, Lock

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from test_observation_state import building, clock, control, payload, prepare


@pytest.mark.parametrize("change", ["reset", "fire"])
def test_later_read_cannot_receive_state_captured_before_a_change(building, clock, tmp_path, monkeypatch, change):
    import asyncio
    from backend.reader import SnapshotReader

    app = create_app(building=building, clock=clock, runs_dir=tmp_path)
    entered, release = Event(), Event()
    with TestClient(app):
        controller = app.state.controller
        prepare(controller, clock)
        original = controller.snapshot
        old = original()
        calls = 0

        def captured_snapshot():
            nonlocal calls
            calls += 1
            result = original()
            if calls == 1:
                entered.set()
                assert release.wait(5)
            return result

        monkeypatch.setattr(controller, "snapshot", captured_snapshot)

        async def exercise():
            reader = SnapshotReader(controller)
            first = asyncio.create_task(reader.read())
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                if change == "reset":
                    controller.reset(control(controller))
                else:
                    controller.receive(payload(controller, clock))
                later = asyncio.create_task(reader.read())
                await asyncio.sleep(.01)
            finally:
                release.set()
            await first
            result = await later
            if change == "reset":
                assert result.run_id != old.run_id
            else:
                assert result.guidance_version > old.guidance_version
                assert result.active_causes
            await reader.close()

        asyncio.run(exercise())


def test_slow_audit_returns_busy_reads_then_current_expired_state(building, clock, tmp_path, monkeypatch):
    app = create_app(building=building, clock=clock, runs_dir=tmp_path)
    entered, release = Event(), Event()
    with TestClient(app) as client:
        controller = app.state.controller
        prepare(controller, clock)
        event = payload(controller, clock)
        original = controller.audit.write

        def slow_write(run_id, category, record):
            if category == "events" and record.get("payload", {}).get("event_id") == event["event_id"]:
                entered.set()
                assert release.wait(5)
            return original(run_id, category, record)

        monkeypatch.setattr(controller.audit, "write", slow_write)
        with ThreadPoolExecutor(max_workers=4) as pool:
            sending = pool.submit(client.post, "/api/events", json=event)
            try:
                assert entered.wait(2)
                reads = [pool.submit(client.get, path) for path in ("/api/state", "/api/session", "/api/health")]
                completed, _ = wait(reads, timeout=1.5)
                assert len(completed) == 3, "audit I/O blocked HTTP state reads"
                assert reads[2].result().status_code == 200
                for future in reads[:2]:
                    response = future.result()
                    assert response.status_code == 503
                    assert response.json()["error"]["code"] == "CONTROLLER_BUSY"
                    assert response.headers["cache-control"] == "no-store"
                    assert response.headers["retry-after"] == "1"
                clock.advance(4000)
            finally:
                release.set()
            assert sending.result().status_code == 200
        current = client.get("/api/state").json()
        assert current["controller_mode"] == "EMERGENCY"
        assert {c["source_id"] for c in current["active_causes"]} == {"CAM-A"}
        assert all(s["validity"] == "STALE" for s in current["sources"] if s["source_id"] in {"DETECTOR-A", "DETECTOR-B"})


def test_busy_readers_share_pending_work_but_not_completed_state(building, clock, tmp_path, monkeypatch):
    app = create_app(building=building, clock=clock, runs_dir=tmp_path)
    entered, release, finished = Event(), Event(), Event()
    count_lock = Lock()
    calls = 0
    with TestClient(app) as client:
        controller = app.state.controller
        original = controller.snapshot
        old_run = controller.run_id

        def blocked_snapshot():
            nonlocal calls
            with count_lock:
                calls += 1
            entered.set()
            assert release.wait(5)
            try:
                return original()
            finally:
                finished.set()

        monkeypatch.setattr(controller, "snapshot", blocked_snapshot)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(client.get, "/api/state") for _ in range(8)]
            try:
                assert entered.wait(2)
                completed, _ = wait(futures, timeout=1.5)
                assert len(completed) == 8, "pending reads do not have a bounded response"
                assert all(f.result().status_code == 503 for f in futures)
                assert calls == 1, "timed-out callers left multiple blocked snapshot workers"
            finally:
                release.set()
            for future in futures:
                future.result()
        assert finished.wait(2)
        controller.reset(control(controller))
        current = client.get("/api/state").json()
        assert current["run_id"] == controller.run_id != old_run
        assert current["controller_mode"] == "INITIALIZING"


def test_busy_reader_recovers_after_pending_work_fails(building, clock, tmp_path, monkeypatch):
    from backend.contracts import ContractError

    app = create_app(building=building, clock=clock, runs_dir=tmp_path)
    entered, release, finished = Event(), Event(), Event()
    with TestClient(app) as client:
        controller = app.state.controller
        original = controller.snapshot

        def failed_snapshot():
            entered.set()
            try:
                assert release.wait(5)
                raise ContractError("CONTROLLER_NOT_READY", "test persistence failure")
            finally:
                finished.set()

        monkeypatch.setattr(controller, "snapshot", failed_snapshot)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.get, "/api/state")
            try:
                assert entered.wait(2)
                assert wait([future], timeout=1.5)[0], "read waits forever for failed storage"
                assert future.result().status_code == 503
            finally:
                release.set()
            future.result()
        assert finished.wait(2)
        monkeypatch.setattr(controller, "snapshot", original)
        assert client.get("/api/state").status_code == 200


def test_cancelled_caller_does_not_cancel_or_duplicate_blocked_work(building, clock, tmp_path, monkeypatch):
    import asyncio
    from backend.contracts import ContractError
    from backend.reader import SnapshotReader

    app = create_app(building=building, clock=clock, runs_dir=tmp_path)
    entered, release = Event(), Event()
    with TestClient(app):
        controller = app.state.controller
        original, calls = controller.snapshot, 0

        def blocked():
            nonlocal calls
            calls += 1
            entered.set()
            assert release.wait(5)
            return original()

        monkeypatch.setattr(controller, "snapshot", blocked)

        async def exercise():
            reader = SnapshotReader(controller)
            caller = asyncio.create_task(reader.read())
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                caller.cancel()
                with pytest.raises(asyncio.CancelledError): await caller
                with pytest.raises(ContractError) as failure: await reader.read()
                assert failure.value.code == "CONTROLLER_BUSY"
                assert calls == 1
            finally:
                release.set()
                await reader.close()
            assert (await reader.read()).run_id == controller.run_id
            assert calls == 2

        asyncio.run(exercise())

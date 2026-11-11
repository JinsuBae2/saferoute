from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from threading import Event

import httpx
import pytest

from scenario_runner.runner import Runner
from test_scenario_runner import arm, building, clock, scenario, setup


@pytest.mark.parametrize("blocked_method", ["_get", "_log"])
def test_state_does_not_wait_for_network_or_log_io(setup, clock, monkeypatch, blocked_method):
    client, runner = setup
    arm(client)
    runner.tick()
    before = runner.state()
    entered, release = Event(), Event()
    original = getattr(runner, blocked_method)

    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(runner, blocked_method, blocked)
    clock.advance(2000)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tick = pool.submit(runner.tick)
        try:
            assert entered.wait(2)
            Event().wait(.3)
            read = pool.submit(runner.state)
            assert wait([read], timeout=1)[0], "simulation state is locked behind I/O"
            during = read.result()
            assert during.run_id == before.run_id
            assert during.simulation_time_ms == before.simulation_time_ms
            assert during.error_code == "CONTROLLER_UNAVAILABLE"
            during.zones[0].smoke = 1
            assert runner.state().zones[0].smoke == before.zones[0].smoke
        finally:
            release.set()
        tick.result()
    after = runner.state()
    assert after.simulation_time_ms >= 2000
    assert after.error_code is None


def busy(path):
    return httpx.Response(503, json={"error": {"code": "CONTROLLER_BUSY", "message": "busy", "field": None}},
                          request=httpx.Request("GET", "http://testserver"+path))


def test_controller_busy_retries_without_failing_the_run(setup, clock, monkeypatch):
    client, runner = setup
    arm(client)
    runner.tick()
    run = runner.state().run_id
    original = client.get
    monkeypatch.setattr(client, "get", lambda path, **kwargs: busy(path))
    runner.tick()
    assert runner.state().status == "RUNNING"
    assert runner.state().error_code == "CONTROLLER_UNAVAILABLE"
    monkeypatch.setattr(client, "get", original)
    clock.advance(1000)
    runner.tick()
    assert runner.state().run_id == run
    assert runner.state().status == "RUNNING"
    assert runner.state().error_code is None


def test_initial_busy_has_no_fake_state_and_later_binds(building, scenario, clock, tmp_path, monkeypatch):
    from backend.app import create_app
    from fastapi.testclient import TestClient

    with TestClient(create_app(building=building, clock=clock, runs_dir=tmp_path/'fresh')) as client:
        runner = Runner(building, scenario, client, tmp_path/'runner', clock=clock)
        original = client.get
        monkeypatch.setattr(client, "get", lambda path, **kwargs: busy(path))
        runner.tick()
        with pytest.raises(ValueError, match="준비"):
            runner.state()
        monkeypatch.setattr(client, "get", original)
        clock.advance(1000)
        runner.tick()
        assert runner.state().status == "WAITING_FOR_ARM"
        assert runner.state().run_id == client.get('/api/session').json()['run_id']
        runner.close()


def test_reset_then_busy_bind_does_not_publish_previous_run(setup, clock, monkeypatch):
    client, runner = setup
    arm(client)
    runner.tick()
    old_run = runner.state().run_id
    original = client.get
    monkeypatch.setattr(client, "get", lambda path, **kwargs: busy(path) if path == '/api/state' else original(path, **kwargs))
    with pytest.raises(httpx.HTTPStatusError):
        runner.restart()
    new_run = client.get('/api/session').json()['run_id']
    assert new_run != old_run
    with pytest.raises(ValueError, match="준비"):
        runner.state()
    monkeypatch.setattr(client, "get", original)
    clock.advance(1000)
    runner.tick()
    runner.tick()
    assert runner.state().run_id == new_run
    assert runner.state().status == "RUNNING"


def test_unbound_simulation_endpoints_report_unavailable(building, scenario, clock, tmp_path):
    from fastapi.testclient import TestClient
    from scenario_runner.app import create_app

    app = create_app(building, scenario, controller_url="http://unused", runs_dir=tmp_path)
    app.state.runner = Runner(building, scenario, None, tmp_path, clock=clock)
    # Exercise routes before a completed binding; no background producer in this test.
    client = TestClient(app)
    for path in ("/sim/state", "/sim/health"):
        response = client.get(path)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "CONTROLLER_UNAVAILABLE"
        assert response.headers["retry-after"] == "1"
        assert response.headers["cache-control"] == "no-store"


def test_delayed_rebind_storage_failure_is_terminal_not_normal(setup, clock, monkeypatch):
    client, runner = setup
    original = client.get
    monkeypatch.setattr(client, "get", lambda path, **kwargs: busy(path) if path == '/api/state' else original(path, **kwargs))
    with pytest.raises(httpx.HTTPStatusError): runner.restart()
    monkeypatch.setattr(client, "get", original)

    def failed_directory(*args, **kwargs): raise OSError("test binding disk failure")

    clock.advance(1000)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "mkdir", failed_directory)
        runner.tick()
    assert runner.log_path is None
    assert runner.state().status == "FAILED"
    assert runner.state().error_code == "LOG_WRITE_FAILED"
    runner.tick()
    assert runner.state().status == "FAILED"


def test_delayed_initial_bind_permanent_error_is_reported(building, scenario, clock, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from scenario_runner.app import create_app

    with httpx.Client(base_url="http://test", transport=httpx.MockTransport(lambda request: busy(request.url.path))) as client:
        runner = Runner(building, scenario, client, tmp_path, clock=clock)
        runner.tick()
        def invalid(path, **kwargs):
            return httpx.Response(401, request=httpx.Request("GET", "http://test" + path))
        monkeypatch.setattr(client, "get", invalid)
        clock.advance(1000)
        runner.tick()
        assert runner.status == "FAILED"
        app = create_app(building, scenario, controller_url="http://unused", runs_dir=tmp_path)
        app.state.runner = runner
        response = TestClient(app).get("/sim/state")
        assert response.status_code == 503
        assert "실패" in response.json()["error"]["message"]
        runner.close()

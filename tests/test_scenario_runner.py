import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from scenario_runner.config import Scenario, load_scenario
from scenario_runner.runner import Runner
from test_observation_state import ROOT, building, clock


@pytest.fixture
def scenario(building):
    return load_scenario(ROOT / "data/scenarios/two-route-smoke.runtime.json", building)


@pytest.fixture
def setup(building, scenario, clock, tmp_path):
    with TestClient(create_app(building=building, clock=clock, runs_dir=tmp_path / "controller")) as client:
        runner = Runner(building, scenario, client, tmp_path / "sim", clock=clock)
        runner.tick()
        yield client, runner
        runner.close()


def arm(client):
    run_id = client.get("/api/session").json()["run_id"]
    assert client.post("/api/control/arm", json=dict(schema_version=1,run_id=run_id,reason="start test")).status_code == 200


def advance(runner, clock, target):
    while runner.state().simulation_time_ms < target:
        clock.advance(100)
        runner.tick()


def at_s(client):
    return next(r for r in client.get("/api/state").json()["routes"] if r["node_id"] == "S")


def test_truth_moves_before_delayed_controller_and_clear_is_explicit(setup, clock):
    client, runner = setup
    assert runner.state().status == "WAITING_FOR_ARM"
    clock.advance(1000)
    runner.tick()
    assert runner.state().simulation_time_ms == 0
    arm(client)
    runner.tick()
    advance(runner, clock, 15000)
    assert next(z.smoke for z in runner.state().zones if z.zone_id == "Z-A") == .7
    assert at_s(client)["next_node_id"] == "A"
    advance(runner, clock, 17000)
    assert at_s(client)["next_node_id"] == "B"
    advance(runner, clock, 27000)
    assert at_s(client)["next_node_id"] is None
    advance(runner, clock, 40000)
    assert at_s(client)["next_node_id"] is None
    response = client.post("/api/control/clear", json=dict(schema_version=1,run_id=runner.run_id,
        source_id="DETECTOR-A",hazard_type="SMOKE",reason="operator verified simulation"))
    assert response.status_code == 200
    assert at_s(client)["next_node_id"] == "A"
    advance(runner, clock, 45000)
    assert runner.state().status == "COMPLETED"
    clock.advance(3000)
    assert at_s(client)["next_node_id"] is None
    assert set(runner.state().model_dump()) == {"schema_version", "building_id", "building_version", "scenario_id",
        "run_id", "simulation_time_ms", "simulation_sequence", "status", "zones", "error_code"}


def test_reset_stops_producer_without_rebinding_or_sending_old_queue(setup, clock):
    client, runner = setup
    arm(client)
    runner.tick()
    advance(runner, clock, 15500)
    old = runner.run_id
    new = client.post("/api/control/reset", json=dict(schema_version=1,run_id=old,reason="test reset")).json()["run_id"]
    clock.advance(5000)
    runner.tick()
    assert runner.state().status == "FAILED" and runner.state().error_code == "RUN_MISMATCH"
    assert runner.run_id == old and old != new
    assert all(s["last_source_sequence"] is None for s in client.get("/api/state").json()["sources"])


@pytest.mark.parametrize("kind,delay,error", [("DROP",0,None),("DELAY",4000,"STALE_SEQUENCE"),("UNAVAILABLE",0,None)])
def test_faults_preserve_original_samples_and_fail_closed(building, scenario, clock, tmp_path, kind, delay, error):
    data = scenario.model_dump()
    data["faults"] = [dict(source_id="DETECTOR-A",kind=kind,start_ms=0,end_ms=2000,delay_ms=delay)]
    scenario = Scenario.model_validate(data).validate_for(building)
    with TestClient(create_app(building=building,clock=clock,runs_dir=tmp_path / "controller")) as client:
        runner = Runner(building,scenario,client,tmp_path / "sim",clock=clock)
        runner.tick()
        arm(client)
        runner.tick()
        advance(runner, clock, 3500)
        assert at_s(client)["reason_codes"] == ["REQUIRED_OBSERVATION_UNKNOWN"]
        advance(runner, clock, 7000)
        assert runner.state().status == "RUNNING"
        evidence = [json.loads(line) for line in runner.log_path.read_text(encoding="utf-8").splitlines()]
        if error: assert any(r.get("error_code") == error for r in evidence)
        if kind == "DROP": assert any(r["operation"] == "drop" for r in evidence)
        runner.close()


def test_refuses_existing_producer_and_armed_session(setup, building, scenario, clock, tmp_path):
    client, _ = setup
    with pytest.raises(ValueError, match="fresh"):
        Runner(building,scenario,client,tmp_path / "second",clock=clock).tick()
    arm(client)
    with pytest.raises(ValueError, match="INITIALIZING"):
        Runner(building,scenario,client,tmp_path / "third",clock=clock).tick()


def test_large_clock_jump_does_not_refresh_stale_samples(setup, clock):
    client, runner = setup
    arm(client)
    runner.tick()
    clock.advance(10000)
    runner.tick()
    evidence = [json.loads(line) for line in runner.log_path.read_text(encoding="utf-8").splitlines()]
    assert any(r.get("error_code") == "STALE_OBSERVATION" for r in evidence)
    assert runner.state().status == "RUNNING"


def test_connection_and_log_failure_still_discards_queue(setup, clock, monkeypatch):
    import httpx
    client, runner = setup
    arm(client)
    runner.tick()
    assert runner.queue
    def disconnected(*args): raise httpx.ConnectError("offline")
    def disk_full(*args, **kwargs): raise OSError("disk full")
    monkeypatch.setattr(runner,"_get",disconnected)
    monkeypatch.setattr(runner,"_log",disk_full)
    runner.tick()
    assert runner.state().status == "FAILED" and runner.state().error_code == "LOG_WRITE_FAILED"
    assert not runner.queue


def test_simultaneous_producers_detect_initial_sequence_conflict(building, scenario, clock, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    with TestClient(create_app(building=building,clock=clock,runs_dir=tmp_path / "controller")) as client:
        barrier = Barrier(2)
        class SynchronizedClient:
            def get(self, path):
                response = client.get(path)
                if path == "/api/state": barrier.wait(timeout=5)
                return response
            def post(self, *args, **kwargs): return client.post(*args,**kwargs)
        runners = [Runner(building,scenario,SynchronizedClient(),tmp_path / str(index),clock=clock) for index in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda runner: runner.tick(),runners))
        assert sorted(r.status for r in runners) == ["FAILED", "WAITING_FOR_ARM"]
        assert next(r for r in runners if r.status=="FAILED").error_code == "SOURCE_CONFLICT"
        for runner in runners: runner.close()

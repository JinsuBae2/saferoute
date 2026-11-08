import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app, expire_periodically
from backend.contracts import ContractError, parse_contract
from backend.controller import Controller

ROOT = Path(__file__).resolve().parents[1]


class FakeClock:
    def __init__(self):
        self.wall = datetime(2026, 11, 10, 1, tzinfo=timezone.utc)
        self.mono = 10000.0

    def utcnow(self): return self.wall
    def monotonic_ms(self): return self.mono

    def advance(self, milliseconds):
        self.wall += timedelta(milliseconds=milliseconds)
        self.mono += milliseconds


@pytest.fixture
def building():
    return parse_contract("Building", json.loads((ROOT / "data/fixtures/two-route-v1.json").read_text()))


@pytest.fixture
def clock(): return FakeClock()


@pytest.fixture
def controller(building, clock, tmp_path):
    return Controller(building, tmp_path / "runs", clock=clock, operator_id="test-operator")


def payload(controller, clock, source="CAM-A", kind="ALARM", hazard="FIRE", sequence=1, **changes):
    source_type = next(s.source_type for s in controller.building.sources if s.source_id == source)
    return dict(schema_version=1,run_id=controller.session().run_id,building_id="TWO_ROUTE",building_version=1,
                event_id=str(uuid4()),source_id=source,source_type=source_type,source_sequence=sequence,
                event_kind=kind,hazard_type=hazard if kind=="ALARM" else None,
                validity="UNAVAILABLE" if kind=="UNAVAILABLE" else "VALID",
                observed_at=clock.utcnow().isoformat().replace("+00:00","Z"),
                media_time_ms=100 if source_type=="VIDEO_AI" and kind in {"ALARM","OBSERVATION"} else None,
                confidence=.9 if source_type=="VIDEO_AI" and kind=="ALARM" else None,
                reason_code="EOF" if kind=="UNAVAILABLE" else None) | changes


def control(controller, **changes):
    return dict(schema_version=1,run_id=controller.session().run_id,reason="test operator confirmation") | changes


def prepare(controller, clock):
    for source in ("DETECTOR-A", "DETECTOR-B"):
        controller.receive(payload(controller,clock,source,"OBSERVATION"))
    return controller.arm(control(controller))


def causes(controller):
    return {(c.source_id,c.hazard_type) for c in controller.snapshot().active_causes}


def validity(controller, source):
    return next(s.validity for s in controller.snapshot().sources if s.source_id==source)


def test_initializing_requires_observations_and_explicit_arm(controller, clock):
    assert controller.session().controller_mode=="INITIALIZING"
    with pytest.raises(ContractError) as error: controller.arm(control(controller))
    assert error.value.code=="CONTROLLER_NOT_READY"
    assert prepare(controller,clock).controller_mode=="NORMAL"
    assert all(f.mode == "DEFAULT" for sign in controller.snapshot().signs for f in sign.faces)


def test_sensor_causes_are_independent_and_normal_or_eof_never_clear(controller, clock):
    prepare(controller,clock)
    controller.receive(payload(controller,clock,"DETECTOR-A",hazard="SMOKE",sequence=2))
    controller.receive(payload(controller,clock,"SPRINKLER-A",hazard="SPRINKLER"))
    controller.receive(payload(controller,clock))
    controller.receive(payload(controller,clock,kind="OBSERVATION",sequence=2))
    controller.receive(payload(controller,clock,kind="UNAVAILABLE",sequence=3))
    assert causes(controller)=={("CAM-A","FIRE"),("DETECTOR-A","SMOKE"),("SPRINKLER-A","SPRINKLER")}
    assert validity(controller,"CAM-A")=="UNAVAILABLE"
    assert controller.session().controller_mode=="EMERGENCY"
    controller.clear(control(controller,source_id="CAM-A",hazard_type="FIRE"))
    assert causes(controller)=={("DETECTOR-A","SMOKE"),("SPRINKLER-A","SPRINKLER")}


def test_clear_last_cause_does_not_restore_expired_observations(controller, clock):
    prepare(controller,clock)
    controller.receive(payload(controller,clock))
    clock.advance(3000)
    controller.expire()
    assert controller.session().controller_mode=="EMERGENCY"
    controller.clear(control(controller,source_id="CAM-A",hazard_type="FIRE"))
    assert controller.session().controller_mode=="DEGRADED"
    assert validity(controller,"CAM-A")=="STALE"


def test_video_heartbeat_and_duplicate_do_not_extend_validity(controller, clock):
    event=payload(controller,clock)
    controller.receive(event)
    clock.advance(2000)
    assert controller.receive(event).duplicate is True
    controller.receive(payload(controller,clock,kind="HEARTBEAT",sequence=2))
    clock.advance(1000)
    controller.expire()
    assert validity(controller,"CAM-A")=="STALE"
    assert causes(controller)=={("CAM-A","FIRE")}


def test_delayed_input_uses_remaining_validity_and_monotonic_deadline(controller, clock):
    event=payload(controller,clock)
    clock.advance(2000)
    controller.receive(event)
    clock.wall -= timedelta(hours=1)
    clock.mono += 999
    controller.expire()
    assert validity(controller,"CAM-A")=="VALID"
    clock.mono += 1
    controller.expire()
    assert validity(controller,"CAM-A")=="STALE"


def test_guidance_version_does_not_increase_for_repeated_same_alarm(controller, clock):
    prepare(controller,clock)
    receipt=controller.receive(payload(controller,clock))
    second=controller.receive(payload(controller,clock,sequence=2))
    assert receipt.guidance_version==second.guidance_version
    controller.receive(payload(controller,clock,kind="OBSERVATION",sequence=3))
    assert controller.snapshot().guidance_version==receipt.guidance_version


@pytest.mark.parametrize("changes,code", [({"source_id":"UNKNOWN"},"UNKNOWN_SOURCE"),({"source_sequence":0},"SCHEMA_VALIDATION_FAILED"),({"observed_at":"2026-11-10T01:00:01Z"},"CLOCK_INVALID"),({"building_version":2},"BUILDING_MISMATCH"),({"observed_at":"2026-11-10T00:59:57Z"},"STALE_OBSERVATION")])
def test_rejected_input_never_changes_alarm_or_sequence(controller,clock,changes,code):
    event=payload(controller,clock,**changes)
    with pytest.raises(ContractError) as error: controller.receive(event)
    assert error.value.code==code
    assert not causes(controller)
    assert controller.receive(payload(controller,clock)).accepted


def test_duplicate_conflict_and_sequence_handling(controller,clock):
    event=payload(controller,clock)
    controller.receive(event)
    for changed,code in [(dict(event,confidence=.5),"EVENT_ID_CONFLICT"),(dict(event,event_id=str(uuid4())),"STALE_SEQUENCE")]:
        with pytest.raises(ContractError) as error: controller.receive(changed)
        assert error.value.code==code


def test_reset_preserves_records_rejects_previous_run_and_clears_readiness(controller,clock,tmp_path):
    event=payload(controller,clock)
    controller.receive(event)
    old=controller.session().run_id
    receipt=controller.reset(control(controller))
    assert receipt.previous_run_id==old and receipt.run_id!=old
    assert controller.session().controller_mode=="INITIALIZING"
    assert not causes(controller)
    with pytest.raises(ContractError) as error: controller.receive(event)
    assert error.value.code=="RUN_MISMATCH"
    assert (tmp_path/"runs"/old/"events.jsonl").exists()
    assert (tmp_path/"runs"/receipt.run_id/"manifest.json").exists()


def test_concurrent_duplicates_and_expiry_have_single_effect(controller,clock,tmp_path):
    event=payload(controller,clock)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(controller.receive,[event]*20))
    assert sum(not r.duplicate for r in results)==1
    assert len(causes(controller))==1
    clock.advance(3000)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _:controller.expire(),range(20)))
    records=[json.loads(line) for line in (tmp_path/"runs"/controller.session().run_id/"decisions.jsonl").read_text().splitlines()]
    assert sum(r["operation"]=="expire" for r in records)==1
    assert validity(controller,"CAM-A")=="STALE"


def test_clear_actor_reason_and_rejection_are_recorded(controller,clock,tmp_path):
    controller.receive(payload(controller,clock))
    controller.clear(control(controller,source_id="CAM-A",hazard_type="FIRE"))
    with pytest.raises(ContractError): controller.clear(control(controller,source_id="CAM-A",hazard_type="FIRE"))
    log=tmp_path/"runs"/controller.session().run_id
    decisions=[json.loads(line) for line in (log/"decisions.jsonl").read_text().splitlines()]
    clear=next(r for r in decisions if r["operation"]=="clear")
    assert clear["actor"]=="test-operator" and clear["reason"]=="test operator confirmation"
    events=[json.loads(line) for line in (log/"events.jsonl").read_text().splitlines()]
    assert any(r.get("error_code")=="SOURCE_CAUSE_INACTIVE" for r in events)


def test_audit_failure_stops_accepting_input(controller,clock,monkeypatch):
    def fail(*args,**kwargs): raise OSError("disk full")
    monkeypatch.setattr(controller.audit,"write",fail)
    with pytest.raises(ContractError) as error: controller.receive(payload(controller,clock))
    assert error.value.code=="CONTROLLER_NOT_READY"
    with pytest.raises(ContractError): controller.snapshot()


def test_expiry_runs_without_http_requests(controller,clock):
    async def exercise():
        controller.receive(payload(controller,clock))
        clock.advance(3000)
        called=asyncio.Event()
        original=controller.expire
        loop=asyncio.get_running_loop()
        def observed():
            original()
            loop.call_soon_threadsafe(called.set)
        controller.expire=observed
        task=asyncio.create_task(expire_periodically(controller,interval_seconds=.001))
        await asyncio.wait_for(called.wait(),timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert controller.sources["CAM-A"].validity=="STALE"
    asyncio.run(exercise())


def test_http_contracts_errors_and_cache_headers(building,clock,tmp_path):
    app=create_app(building=building,runs_dir=tmp_path/"runs",clock=clock)
    with TestClient(app) as client:
        store=app.state.controller
        assert client.get("/api/health").json()=={"status":"ok"}
        for endpoint,model in [("session","Session"),("building","Building"),("state","StateSnapshot")]:
            response=client.get("/api/"+endpoint)
            assert response.status_code==200
            assert response.headers["cache-control"]=="no-store"
            parse_contract(model,response.json())
        bad=client.post("/api/events",json=payload(store,clock,zone_id="Z-B"))
        assert bad.status_code==422 and bad.json()["error"]["code"]=="SCHEMA_VALIDATION_FAILED"
        malformed=client.post("/api/events",content="{",headers={"content-type":"application/json"})
        assert malformed.status_code==422 and "error" in malformed.json()
        invalid=client.post("/api/events",json=payload(store,clock,hazard_type=None))
        assert invalid.status_code==400
        event=payload(store,clock)
        assert client.post("/api/events",json=event).status_code==200
        assert client.post("/api/events",json=event).json()["duplicate"] is True
        for source in ("DETECTOR-A","DETECTOR-B"):
            assert client.post("/api/events",json=payload(store,clock,source,"OBSERVATION")).status_code==200
        assert client.post("/api/control/arm",json=control(store)).json()["controller_mode"]=="EMERGENCY"
        assert client.post("/api/control/clear",json=control(store,source_id="CAM-A",hazard_type="FIRE")).json()["cleared"] is True
        assert client.post("/api/control/reset",json=control(store)).json()["controller_mode"]=="INITIALIZING"


def test_bad_numeric_input_is_logged_without_disabling_controller(controller,clock,tmp_path):
    with pytest.raises(ContractError) as error:
        controller.receive(payload(controller,clock,confidence=float("nan")))
    assert error.value.code=="SCHEMA_VALIDATION_FAILED"
    assert controller.receive(payload(controller,clock)).accepted
    rows=(tmp_path/"runs"/controller.session().run_id/"events.jsonl").read_text().splitlines()
    assert json.loads(rows[0])["error_code"]=="SCHEMA_VALIDATION_FAILED"


def test_overlapping_recovery_input_and_expiry_remain_consistent(controller,clock):
    controller.receive(payload(controller,clock))
    clock.advance(3000)
    recovered=payload(controller,clock,sequence=2)
    def action(index):
        return controller.expire() if index%2 else controller.receive(recovered)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(action,range(40)))
    assert validity(controller,"CAM-A")=="VALID"
    assert causes(controller)=={("CAM-A","FIRE")}


def test_openapi_exposes_c02_request_shapes(building,clock,tmp_path):
    with TestClient(create_app(building=building,runs_dir=tmp_path/"runs",clock=clock)) as client:
        schema=client.get("/openapi.json").json()
        request=schema["paths"]["/api/events"]["post"]["requestBody"]["content"]["application/json"]["schema"]
        assert request["$ref"].endswith("/ObservationEvent")

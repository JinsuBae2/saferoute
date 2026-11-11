"""B06 registered manual inputs use the existing event/clear boundary."""

from uuid import uuid4

import pytest

from test_wfi_routing import api, observe  # noqa: F401 -- shared armed WFI fixture
from test_wfi_space import BUILDING


def event(clock, run_id, source_id, sequence=1):
    return dict(schema_version=1, run_id=run_id, building_id=BUILDING.building_id,
                building_version=BUILDING.building_version, event_id=str(uuid4()), source_id=source_id,
                source_type="MANUAL_TEST", source_sequence=sequence, event_kind="ALARM", hazard_type="FIRE",
                validity="VALID", observed_at=clock.utcnow().isoformat().replace("+00:00", "Z"),
                media_time_ms=None, confidence=None, reason_code=None)


def clear(client, run_id, source_id):
    return client.post("/api/control/clear", json=dict(schema_version=1, run_id=run_id,
        source_id=source_id, hazard_type="FIRE", reason="B06 시험 화재 해제"))


def test_manual_sources_are_optional_fire_only_and_cover_every_zone():
    """도면 아무 데나 눌러 불을 낼 수 있어야 하므로 모든 구역에 시험 입력이 있어야 한다(이슈 #21).

    예전에는 연기감지기가 있는 12곳에만 두어 호실은 고를 수 없었다. 하나라도 빠지면
    그 방은 눌러도 불이 나지 않는다.
    """
    manual = [s for s in BUILDING.sources if s.source_type == "MANUAL_TEST"]
    assert {s.zone_id for s in manual} == {z.zone_id for z in BUILDING.zones}
    assert len(manual) == len(BUILDING.zones)
    assert all(not s.required and s.allowed_hazard_types == ["FIRE"] for s in manual)


# 버전 5: 북쪽 통로 화재 시 가운데 2층은 계단 A를 내려와 가까운 북서 출구로 간다.
@pytest.mark.parametrize("side,exit_id", [("N", "EXIT-NW"), ("S", "EXIT-N")])
def test_manual_fire_changes_same_origin_route_and_sign(api, side, exit_id):
    client, clock, run_id = api
    response = client.post("/api/events", json=event(clock, run_id, f"MANUAL-F1-PASSAGE-{side}"))
    assert response.status_code == 200, response.text
    state = client.get("/api/state").json()
    route = next(r for r in state["routes"] if r["node_id"] == "F2-J-E2")
    assert route["exit_id"] == exit_id
    command = client.get("/api/signs/SIGN-F2-J-E2/command").json()
    assert command["guidance_version"] == state["guidance_version"]
    assert all(f["mode"] == "DYNAMIC" and f["next_node_id"] == route["next_node_id"]
               and f["exit_id"] == exit_id for f in command["faces"])


def test_manual_clear_preserves_other_manual_sensor_alarms_and_faults(api):
    client, clock, run_id = api
    for side in ("N", "S"):
        assert client.post("/api/events", json=event(clock, run_id, f"MANUAL-F1-PASSAGE-{side}")).status_code == 200
    observe(client, clock, run_id, "SMK-F1-PASSAGE-N", 2, alarm=True)
    clock.advance(3000)  # required observations expire; clear must not make them valid
    assert clear(client, run_id, "MANUAL-F1-PASSAGE-N").status_code == 200
    state = client.get("/api/state").json()
    assert {(c["source_id"], c["hazard_type"]) for c in state["active_causes"]} == {
        ("MANUAL-F1-PASSAGE-S", "FIRE"), ("SMK-F1-PASSAGE-N", "SMOKE")}
    assert any(s["validity"] == "STALE" for s in state["sources"] if s["source_id"].startswith("SMK-"))
    assert clear(client, run_id, "MANUAL-F1-PASSAGE-S").status_code == 200
    state = client.get("/api/state").json()
    assert [c["source_id"] for c in state["active_causes"]] == ["SMK-F1-PASSAGE-N"]
    assert any("REQUIRED_OBSERVATION_UNKNOWN" in n["reason_codes"] for n in state["blocked_nodes"])


def test_duplicates_rejections_and_reset_do_not_invent_success(api):
    client, clock, run_id = api
    payload = event(clock, run_id, "MANUAL-F1-PASSAGE-N")
    assert client.post("/api/events", json=payload).status_code == 200
    assert client.post("/api/events", json=payload).json()["duplicate"] is True
    stale = event(clock, run_id, "MANUAL-F1-PASSAGE-N")
    assert client.post("/api/events", json=stale).json()["error"]["code"] == "STALE_SEQUENCE"
    assert client.post("/api/events", json=event(clock, run_id, "MANUAL-UNKNOWN")).json()["error"]["code"] == "UNKNOWN_SOURCE"
    reset = client.post("/api/control/reset", json=dict(schema_version=1, run_id=run_id, reason="B06 external reset")).json()
    assert reset["run_id"] != run_id
    assert client.post("/api/events", json=payload).json()["error"]["code"] == "RUN_MISMATCH"
    assert clear(client, run_id, "MANUAL-F1-PASSAGE-N").json()["error"]["code"] == "RUN_MISMATCH"
    assert client.get("/api/state").json()["active_causes"] == []

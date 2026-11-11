"""WFI A04: enclosed stairs first, open stairs only when necessary."""

from fractions import Fraction
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.contracts import parse_contract
from backend.contracts.messages import BlockedEdge
from backend.routing import calculate_routes
from http_reads import current_read
from test_observation_state import FakeClock
from test_routing import assert_safe, block_nodes
from test_wfi_space import BUILDING, ZONES

OPEN_EDGES = {"E-F1-S-C-F2-S-C", "E-F2-S-C-F1-S-C", "E-F2-S-D-F3-S-D", "E-F3-S-D-F2-S-D"}
OPEN_PAIRS = {(e.from_node_id, e.to_node_id) for e in BUILDING.edges if e.edge_id in OPEN_EDGES}


def test_open_stair_cost_exceeds_every_possible_primary_route():
    # Positive costs bound any simple primary route, including after multiple alarms.
    primary_total = sum(Fraction(str(e.cost)) for e in BUILDING.edges if e.edge_id not in OPEN_EDGES)
    assert all(Fraction(str(e.cost)) > primary_total for e in BUILDING.edges if e.edge_id in OPEN_EDGES)


@pytest.mark.parametrize("zone_id", [None, *sorted(ZONES)])
def test_available_primary_exit_never_uses_open_stairs(zone_id):
    zone = ZONES[zone_id] if zone_id else None
    nodes = set(zone.blocked_node_ids) if zone else set()
    edges = set(zone.blocked_edge_ids) if zone else set()
    reverse = {}
    for edge in BUILDING.edges:
        if edge.traversable and edge.edge_id not in edges | OPEN_EDGES and not nodes & {edge.from_node_id, edge.to_node_id}:
            reverse.setdefault(edge.to_node_id, []).append(edge.from_node_id)
    reachable = {e.node_id for e in BUILDING.exits if e.enabled and e.node_id not in nodes}
    pending = list(reachable)
    while pending:
        for previous in reverse.get(pending.pop(), []):
            if previous not in reachable:
                reachable.add(previous)
                pending.append(previous)
    blocks = [BlockedEdge(edge_id=e, source_ids=[], reason_codes=["ACTIVE_ALARM"]) for e in edges]
    routes = calculate_routes(BUILDING, block_nodes({n: ["ACTIVE_ALARM"] for n in nodes}), blocks)
    assert_safe(BUILDING, routes, nodes, edges)
    for route in routes:
        if route.node_id in reachable:
            assert route.path_node_ids
            assert not OPEN_PAIRS.intersection(zip(route.path_node_ids, route.path_node_ids[1:])), (zone_id, route)


@pytest.mark.parametrize("blocked,origin,required_pair", [
    (["F2-S-A", "F2-S-B"], "F2-J-E2", ("F2-S-C", "F1-S-C")),
    (["F3-S-A", "F3-S-B"], "F3-S-D", ("F3-S-D", "F2-S-D")),
])
def test_open_stairs_remain_available_when_primary_stairs_are_blocked(blocked, origin, required_pair):
    routes = calculate_routes(BUILDING, block_nodes({n: ["ACTIVE_ALARM"] for n in blocked}))
    assert_safe(BUILDING, routes, blocked)
    route = next(r for r in routes if r.node_id == origin)
    assert route.exit_id in {"EXIT-N", "EXIT-S", "EXIT-NW", "EXIT-SE"}
    assert required_pair in list(zip(route.path_node_ids, route.path_node_ids[1:]))


def observe(client, clock, run_id, source_id, sequence, alarm=False):
    source = next(s for s in BUILDING.sources if s.source_id == source_id)
    response = client.post("/api/events", json=dict(
        schema_version=1, run_id=run_id, building_id=BUILDING.building_id, building_version=BUILDING.building_version,
        event_id=str(uuid4()), source_id=source_id, source_type=source.source_type, source_sequence=sequence,
        event_kind="ALARM" if alarm else "OBSERVATION", hazard_type=source.allowed_hazard_types[0] if alarm else None,
        validity="VALID", observed_at=clock.utcnow().isoformat().replace("+00:00", "Z"),
        media_time_ms=None, confidence=None, reason_code=None))
    assert response.status_code == 200, response.text


@pytest.fixture
def api(tmp_path):
    clock = FakeClock()
    with TestClient(create_app(building=BUILDING, clock=clock, runs_dir=tmp_path / "runs")) as client:
        run_id = current_read(client, "/api/session")["run_id"]
        for source in BUILDING.sources:
            if source.required:
                observe(client, clock, run_id, source.source_id, 1)
        response = client.post("/api/control/arm", json=dict(schema_version=1, run_id=run_id, reason="WFI routing test"))
        assert response.status_code == 200 and response.json()["controller_mode"] == "NORMAL"
        yield client, clock, run_id


@pytest.mark.parametrize("source_id", [s.source_id for s in BUILDING.sources if s.required])
def test_single_required_detector_expiry_keeps_other_routes_and_recovers(api, source_id):
    client, clock, run_id = api
    original = parse_contract("StateSnapshot", current_read(client, "/api/state"))
    clock.advance(1000)
    for source in BUILDING.sources:
        if source.required and source.source_id != source_id:
            observe(client, clock, run_id, source.source_id, 2)
    clock.advance(2000)
    state = parse_contract("StateSnapshot", current_read(client, "/api/state"))
    required = {s.source_id for s in BUILDING.sources if s.required}
    assert state.controller_mode == "DEGRADED" and not state.active_causes
    assert {s.source_id for s in state.sources if s.source_id in required and s.validity != "VALID"} == {source_id}
    zone = ZONES[next(s.zone_id for s in BUILDING.sources if s.source_id == source_id)]
    assert {n.node_id for n in state.blocked_nodes} == set(zone.blocked_node_ids)
    assert {e.edge_id for e in state.blocked_edges} == set(zone.blocked_edge_ids) | {e.edge_id for e in BUILDING.edges if not e.traversable}
    assert_safe(BUILDING, state.routes, zone.blocked_node_ids, zone.blocked_edge_ids)
    assert any(f.mode == "DYNAMIC" for sign in state.signs for f in sign.faces)
    sign = next(s for s in state.signs if any(f.mode == "DYNAMIC" for f in s.faces))
    response = client.get(f"/api/signs/{sign.sign_id}/command")
    assert response.status_code == 200
    command = parse_contract("SignCommand", response.json())
    assert command.guidance_version == state.guidance_version and command.faces == sign.faces

    observe(client, clock, run_id, source_id, 2)
    recovered = parse_contract("StateSnapshot", current_read(client, "/api/state"))
    assert recovered.controller_mode == "NORMAL" and recovered.routes == original.routes
    assert [s.faces for s in recovered.signs] == [s.faces for s in original.signs]


@pytest.mark.parametrize("prefix", ["SMK", "SPK"])
# 버전 5: 북쪽 통로가 막히면 가운데 2층은 계단 A를 내려와 가까운 북서 출구로 간다.
@pytest.mark.parametrize("side,exit_id,stair", [("N", "EXIT-NW", "F1-S-A"), ("S", "EXIT-N", "F1-S-B")])
def test_passage_alarm_uses_primary_stair_and_updates_sign_command(api, prefix, side, exit_id, stair):
    client, clock, run_id = api
    observe(client, clock, run_id, f"{prefix}-F1-PASSAGE-{side}", 2, alarm=True)
    state = parse_contract("StateSnapshot", current_read(client, "/api/state"))
    assert state.controller_mode == "EMERGENCY"
    assert_safe(BUILDING, state.routes, [n.node_id for n in state.blocked_nodes], [e.edge_id for e in state.blocked_edges])
    route = next(r for r in state.routes if r.node_id == "F2-J-E2")
    assert route.exit_id == exit_id and stair in route.path_node_ids
    assert not OPEN_PAIRS.intersection(zip(route.path_node_ids, route.path_node_ids[1:]))
    assert f"EXIT-{side}" not in {r.exit_id for r in state.routes if r.path_node_ids}
    response = client.get("/api/signs/SIGN-F2-J-E2/command")
    assert response.status_code == 200
    command = parse_contract("SignCommand", response.json())
    assert command.building_version == BUILDING.building_version and command.guidance_version == state.guidance_version
    assert all(f.mode == "DYNAMIC" and f.next_node_id == route.next_node_id and f.exit_id == exit_id for f in command.faces)


def test_exit_zones_blocked_then_clear_restores_primary_route(api):
    client, clock, run_id = api
    for zone in ("PASSAGE-N", "PASSAGE-S", "LOBBY"):
        observe(client, clock, run_id, f"SMK-F1-{zone}", 2, alarm=True)
    # 통로 두 곳과 로비가 위험하면 101호 안에서 남동 출구로 나가는 길만 남는다. 101호에는 감지기가 없다.
    routed = {r["node_id"]: r["exit_id"] for r in current_read(client, "/api/state")["routes"] if r["path_node_ids"]}
    assert routed == {"F1-D-R101": "EXIT-SE", "F1-J-R101": "EXIT-SE", "F1-X-SE": "EXIT-SE"}
    response = client.post("/api/control/clear", json=dict(schema_version=1, run_id=run_id,
        source_id="SMK-F1-PASSAGE-N", hazard_type="SMOKE", reason="WFI north passage checked"))
    assert response.status_code == 200
    route = next(r for r in current_read(client, "/api/state")["routes"] if r["node_id"] == "F2-J-E2")
    assert route["exit_id"] == "EXIT-N" and "F1-S-B" in route["path_node_ids"]

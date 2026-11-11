"""WFI building_version 5: 도면의 두 번째 출입구, 방 안 이동, 1층 추가 출구.

경로는 계산기가 정한다. 여기서는 위험 구역을 넣었을 때 사람이 서 있는 문에서
안전한 길이 남으면 그 길로 가고, 남지 않으면 경로 없음이 되는지만 본다.
"""

import pytest

from backend.contracts.messages import BlockedEdge
from backend.routing import calculate_routes
from test_routing import assert_safe, block_nodes
from test_wfi_space import BUILDING, NODES, ZONES


def routes_with(*zone_ids, nodes=()):
    """그 구역들에 경보가 난 상태(구역의 차단 지점·통로 전부)와 추가로 막은 지점에서의 경로."""
    blocked_nodes = set(nodes)
    blocked_edges = set()
    for zone_id in zone_ids:
        blocked_nodes |= set(ZONES[zone_id].blocked_node_ids)
        blocked_edges |= set(ZONES[zone_id].blocked_edge_ids)
    blocks = [BlockedEdge(edge_id=e, source_ids=[], reason_codes=["ACTIVE_ALARM"]) for e in sorted(blocked_edges)]
    routes = calculate_routes(BUILDING, block_nodes({n: ["ACTIVE_ALARM"] for n in blocked_nodes}), blocks)
    assert_safe(BUILDING, routes, blocked_nodes, blocked_edges)
    return {route.node_id: route for route in routes}


def zones_on(path):
    return [NODES[node].zone_id for node in path]


def test_all_four_ground_floor_exits_are_used_for_evacuation():
    assert {e.exit_id for e in BUILDING.exits if e.enabled} == {"EXIT-N", "EXIT-S", "EXIT-NW", "EXIT-SE"}
    assert all("시뮬레이션 가정" in e.assumption for e in BUILDING.exits if e.exit_id in {"EXIT-NW", "EXIT-SE"})


def test_room_307_leaves_by_its_north_door_when_the_south_approach_is_blocked():
    route = routes_with("F3-CORR-W")["F3-D-R307"]
    assert route.path_node_ids, route.reason_codes
    assert "F3-D-R307-N" in route.path_node_ids and "F3-J-SW" not in route.path_node_ids
    # 방 안을 지나 북쪽 문으로 나간다. 서쪽 복도는 밟지 않는다.
    assert "F3-CORR-W" not in zones_on(route.path_node_ids)


def test_room_304_leaves_by_its_east_door_when_its_north_approach_is_blocked():
    route = routes_with("F3-CORR-E")["F3-D-R304"]
    assert route.path_node_ids, route.reason_codes
    assert "F3-D-R304-E" in route.path_node_ids and "F3-CORR-E" not in zones_on(route.path_node_ids)


def test_industry_office_leaves_by_its_east_door_when_the_west_approach_is_blocked():
    route = routes_with("F2-CORR-W")["F2-D-INDUSTRY"]
    assert route.path_node_ids, route.reason_codes
    assert "F2-D-INDUSTRY-E" in route.path_node_ids and "F2-CORR-W" not in zones_on(route.path_node_ids)


def test_conference_room_goes_through_the_room_when_only_one_door_front_is_blocked():
    north = routes_with(nodes=["F1-J-LW"])["F1-D-CONF-N"]
    assert north.path_node_ids and "F1-D-CONF-S" in north.path_node_ids, north.reason_codes
    south = routes_with(nodes=["F1-J-LSW"])["F1-D-CONF-S"]
    assert south.path_node_ids and "F1-D-CONF-N" in south.path_node_ids, south.reason_codes


@pytest.mark.parametrize("door,approaches,room", [
    ("F3-D-R307", ["F3-CORR-W", "F3-CORR-N"], "F3-R307"),
    ("F3-D-R304", ["F3-CORR-E", "F3-CORR-E2"], "F3-R304"),
    ("F2-D-INDUSTRY", ["F2-CORR-W", "F2-CORR-E2"], "F2-INDUSTRY"),
    ("F1-D-CONF-N", ["F1-LOBBY"], "F1-CONF"),
])
def test_no_route_when_both_approaches_or_the_room_itself_are_dangerous(door, approaches, room):
    # 두 접근로가 모두 위험하면 다른 문으로도 나갈 수 없다.
    assert not routes_with(*approaches)[door].path_node_ids
    # 방 안이 위험하면 방을 지나는 우회를 만들지 않는다.
    assert not routes_with(room)[door].path_node_ids


@pytest.mark.parametrize("zone_id", sorted(ZONES))
def test_room_interiors_never_become_a_way_around_a_blocked_zone(zone_id):
    """어느 구역에 경보가 나도 경로는 차단된 지점·통로를 밟지 않고, 경보가 난 방 안을 지나지 않는다."""
    zone = ZONES[zone_id]
    for route in routes_with(zone_id).values():
        assert zone_id not in zones_on(route.path_node_ids), route


def test_rooms_are_crossed_only_when_no_corridor_route_is_left():
    """방은 통로가 아니다. 평상시에는 어떤 출발점도 남의 방 안을 지나가지 않는다."""
    interior = {n.node_id for n in BUILDING.nodes if n.kind == "JUNCTION" and not any(
        part in n.zone_id for part in ("CORR", "LOBBY", "PASSAGE", "STAIR"))}
    assert interior, "방 안 이동 지점이 없다"
    for route in routes_with().values():
        start_zone = NODES[route.node_id].zone_id
        crossed = [n for n in route.path_node_ids if n in interior and NODES[n].zone_id != start_zone]
        assert not crossed, route


def test_exit_nw_is_reached_and_gives_way_to_another_exit_when_blocked():
    lobby = routes_with()["F1-J-LNW"]
    assert lobby.exit_id == "EXIT-NW" and lobby.path_node_ids[-1] == "F1-X-NW"
    # 북서 출구가 막히면 다른 안전한 출구로 바뀐다.
    detour = routes_with(nodes=["F1-X-NW"])["F1-J-LNW"]
    assert detour.path_node_ids and detour.exit_id in {"EXIT-N", "EXIT-S"}


def test_exit_se_is_reached_through_room_101_and_gives_way_when_blocked():
    # 남쪽 통로가 위험하면 101호 사람은 방 안을 지나 남동 출구로 나간다.
    inside = routes_with("F1-PASSAGE-S")["F1-D-R101"]
    assert inside.exit_id == "EXIT-SE" and inside.path_node_ids[-1] == "F1-X-SE"
    assert set(zones_on(inside.path_node_ids)) == {"F1-R101"}
    # 남동 출구가 막히면 통로 쪽 출구로 간다.
    detour = routes_with(nodes=["F1-X-SE"])["F1-D-R101"]
    assert detour.path_node_ids and detour.exit_id in {"EXIT-S", "EXIT-N", "EXIT-NW"}


def test_no_route_anywhere_when_all_four_exits_are_unusable():
    exits = [e.node_id for e in BUILDING.exits]
    assert all(not r.path_node_ids for r in routes_with(nodes=exits).values())
    # 출구가 있는 구역이 모두 위험해도 마찬가지다.
    assert all(not r.path_node_ids for r in routes_with("F1-PASSAGE-N", "F1-PASSAGE-S", "F1-LOBBY", "F1-R101").values())


def test_each_exit_is_lost_when_its_own_zone_is_dangerous():
    for zone_id, exit_id in [("F1-PASSAGE-N", "EXIT-N"), ("F1-PASSAGE-S", "EXIT-S"), ("F1-LOBBY", "EXIT-NW"), ("F1-R101", "EXIT-SE")]:
        assert exit_id not in {r.exit_id for r in routes_with(zone_id).values() if r.path_node_ids}, zone_id


def test_new_doors_and_room_paths_do_not_cross_walls():
    """새로 넣은 문·방 안 통로가 3D 벽을 뚫고 지나가지 않는다(벽 틈에 맞게 놓였는지)."""
    from test_wfi_space import GEOMETRY
    walls = {f["floor_id"]: f["walls"] for f in GEOMETRY["floors"]}

    def crosses(a, b, wall):
        x0, z0, x1, z1 = wall
        for step in range(41):
            t = step / 40
            x, z = a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t
            if x0 < x < x1 and z0 < z < z1: return True
        return False

    new_nodes = {"F3-D-R307-N", "F3-D-R304-E", "F2-D-INDUSTRY-E"} | {
        n.node_id for n in BUILDING.nodes if n.kind == "JUNCTION" and not any(
            part in n.zone_id for part in ("CORR", "LOBBY", "PASSAGE", "STAIR"))}
    assert {"F3-D-R307-N", "F3-D-R304-E", "F2-D-INDUSTRY-E"} <= set(NODES)
    checked = 0
    for edge in BUILDING.edges:
        if not {edge.from_node_id, edge.to_node_id} & new_nodes: continue
        a, b = NODES[edge.from_node_id], NODES[edge.to_node_id]
        hits = [w for w in walls[a.floor_id] if crosses(a.position, b.position, w)]
        assert not hits, (edge.edge_id, hits[:2])
        checked += 1
    assert checked >= 20


def test_people_start_list_is_explicit_and_matches_the_building():
    """인원 배치는 문 목록과 따로 둔다. 문을 늘려도 23명이고, 목록의 자리는 모두 실제 방 입구다."""
    import json
    from pathlib import Path
    people = json.loads((Path(__file__).resolve().parents[1] / "data/space/wfi-people-v1.json").read_text(encoding="utf-8"))
    starts = people["start_node_ids"]
    assert people["building_id"] == BUILDING.building_id
    assert len(starts) == len(set(starts)) == 23
    assert all(NODES[node_id].kind == "DOOR" for node_id in starts)
    assert len([n for n in BUILDING.nodes if n.kind == "DOOR"]) == 26
    assert not {"F3-D-R307-N", "F3-D-R304-E", "F2-D-INDUSTRY-E"} & set(starts)

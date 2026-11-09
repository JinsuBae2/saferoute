"""M02 원주미래산업진흥원 1~3층 공간 데이터 검증.

계약 검증(C02) 위에 공간 검수 항목을 더한다: 노드가 자기 구역 안에 있는지, 양방향 통로,
계단 층 연결, 평상시 출구 도달, 유도등 기본 매핑과 기본 경로 일치, 3D 형상 파일과의 대응.
"""

import heapq
import json
import math
from pathlib import Path

import pytest

from backend.contracts import parse_contract

ROOT = Path(__file__).resolve().parents[1]
RAW = json.loads((ROOT / "data/space/wfi-v1.json").read_text(encoding="utf-8"))
GEOMETRY = json.loads((ROOT / "data/space/wfi-geometry-v1.json").read_text(encoding="utf-8"))
BUILDING = parse_contract("Building", RAW)

NODES = {n.node_id: n for n in BUILDING.nodes}
ZONES = {z.zone_id: z for z in BUILDING.zones}
FLOORS = {f.floor_id: f for f in BUILDING.floors}
ENABLED_EXITS = {e.node_id for e in BUILDING.exits if e.enabled}


def shortest_to_exit(edges):
    reverse = {}
    for e in edges:
        reverse.setdefault(e.to_node_id, []).append((e.from_node_id, e.cost))
    dist = {n: 0.0 for n in ENABLED_EXITS}
    heap = [(0.0, n) for n in sorted(ENABLED_EXITS)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist.get(n, math.inf):
            continue
        for m, c in reverse.get(n, []):
            if d + c < dist.get(m, math.inf) - 1e-9:
                dist[m] = d + c
                heapq.heappush(heap, (d + c, m))
    return dist


DIST = shortest_to_exit([e for e in BUILDING.edges if e.traversable])


def inside(polygon, x, z, tol=1e-6):
    pts = [(p.x, p.z) for p in polygon]
    for (x1, z1), (x2, z2) in zip(pts, pts[1:] + pts[:1]):
        cross = (x2 - x1) * (z - z1) - (z2 - z1) * (x - x1)
        if abs(cross) <= tol and min(x1, x2) - tol <= x <= max(x1, x2) + tol \
                and min(z1, z2) - tol <= z <= max(z1, z2) + tol:
            return True
    hit = False
    for (x1, z1), (x2, z2) in zip(pts, pts[1:] + pts[:1]):
        if (z1 > z) != (z2 > z) and x < x1 + (z - z1) * (x2 - x1) / (z2 - z1):
            hit = not hit
    return hit


def test_round_trips_through_contract_without_coercion():
    assert BUILDING.model_dump(mode="json") == RAW
    assert BUILDING.building_id == "WFI"
    assert [f.floor_id for f in BUILDING.floors] == ["F1", "F2", "F3"]


def test_ids_follow_space_readme_rules():
    kinds = {"J": "JUNCTION", "D": "DOOR", "S": "STAIR", "X": "EXIT"}
    for node in BUILDING.nodes:
        floor, kind = node.node_id.split("-")[:2]
        assert floor == node.floor_id and kinds[kind] == node.kind, node.node_id
    for zone in BUILDING.zones:
        assert zone.zone_id.startswith(zone.floor_id + "-")
    for edge in BUILDING.edges:
        assert edge.edge_id == f"E-{edge.from_node_id}-{edge.to_node_id}"
    for sign in BUILDING.signs:
        assert sign.sign_id == f"SIGN-{sign.node_id}"
    for source in BUILDING.sources:
        assert source.source_id.split("-", 1)[1] == source.zone_id


def test_nodes_sit_inside_their_zone_and_floor():
    for node in BUILDING.nodes:
        assert node.position.y == FLOORS[node.floor_id].elevation, node.node_id
        assert inside(ZONES[node.zone_id].polygon, node.position.x, node.position.z), node.node_id


def test_every_edge_has_a_reverse_with_same_kind_and_cost():
    by_pair = {(e.from_node_id, e.to_node_id): e for e in BUILDING.edges}
    for (a, b), edge in by_pair.items():
        back = by_pair[(b, a)]
        assert (back.kind, back.cost, back.door_open) == (edge.kind, edge.cost, edge.door_open)


def test_stairs_join_same_letter_on_adjacent_floors():
    stair_edges = [e for e in BUILDING.edges if e.kind == "STAIR"]
    assert {(e.from_node_id, e.to_node_id) for e in stair_edges if e.from_node_id < e.to_node_id} == {
        ("F1-S-A", "F2-S-A"), ("F2-S-A", "F3-S-A"), ("F1-S-B", "F2-S-B"), ("F2-S-B", "F3-S-B"),
        ("F1-S-C", "F2-S-C"), ("F2-S-D", "F3-S-D"),
    }
    for e in stair_edges:
        a, b = NODES[e.from_node_id], NODES[e.to_node_id]
        assert a.node_id[-1] == b.node_id[-1]
        assert abs(a.position.y - b.position.y) == pytest.approx(4.0)


def test_open_stairs_are_detour_only():
    """A04: 열린 계단 C·D는 벽으로 둘러싼 A·B보다 비싸고, 뚫린 공간 경보 시 막힌다."""
    cost = {e.edge_id: e.cost for e in BUILDING.edges}
    enclosed = max(cost["E-F1-S-A-F2-S-A"], cost["E-F1-S-B-F2-S-B"])
    assert cost["E-F1-S-C-F2-S-C"] > enclosed and cost["E-F2-S-D-F3-S-D"] > enclosed
    void = set(ZONES["F2-VOID"].blocked_edge_ids)
    assert {"E-F1-S-C-F2-S-C", "E-F2-S-C-F1-S-C", "E-F2-S-D-F3-S-D", "E-F3-S-D-F2-S-D"} <= void


def test_zone_blocks_its_own_nodes_and_their_edges():
    for zone in BUILDING.zones:
        mine = {n.node_id for n in BUILDING.nodes if n.zone_id == zone.zone_id}
        assert set(zone.blocked_node_ids) == mine
        touching = {e.edge_id for e in BUILDING.edges if e.from_node_id in mine or e.to_node_id in mine}
        assert touching <= set(zone.blocked_edge_ids)


def test_every_node_reaches_an_enabled_exit_in_normal_mode():
    assert {e.exit_id for e in BUILDING.exits if e.enabled} == {"EXIT-N", "EXIT-S"}
    assert set(DIST) == set(NODES)


@pytest.mark.parametrize("zone_id", ["F2-CORR-W", "F2-CORR-E", "F3-CORR-W", "F3-CORR-E"])
def test_single_corridor_alarm_leaves_a_detour(zone_id):
    """한쪽 복도에 경보가 나도 반대편 복도에서 출구까지 갈 수 있어야 우회 시연이 된다."""
    zone = ZONES[zone_id]
    blocked = set(zone.blocked_edge_ids)
    dist = shortest_to_exit([e for e in BUILDING.edges if e.traversable and e.edge_id not in blocked])
    floor = zone.floor_id
    others = [n for n in NODES.values() if n.floor_id == floor and n.kind == "JUNCTION"
              and n.node_id not in zone.blocked_node_ids and n.zone_id.startswith(floor + "-CORR-N")]
    assert others and all(n.node_id in dist for n in others)


def test_one_zone_alarm_never_closes_both_exits():
    """M03: 활성 출구가 한 구역에 몰리면 경보 하나로 건물 전체가 안내 불가가 된다."""
    exit_zones = [NODES[n].zone_id for n in ENABLED_EXITS]
    assert len(set(exit_zones)) == len(exit_zones)


@pytest.mark.parametrize("zone_id", sorted(ZONES))
def test_single_zone_alarm_only_strands_dead_end_room_doors(zone_id):
    """경보 구역 밖에서 출구를 잃는 노드는 문이 그 구역 쪽에만 있는 방 문(또는 비활성 출구)뿐이어야 한다."""
    zone = ZONES[zone_id]
    blocked = set(zone.blocked_edge_ids)
    dist = shortest_to_exit([e for e in BUILDING.edges if e.traversable and e.edge_id not in blocked
                             and e.from_node_id not in zone.blocked_node_ids
                             and e.to_node_id not in zone.blocked_node_ids])
    lost = set(NODES) - set(zone.blocked_node_ids) - set(dist)
    assert all(NODES[n].kind in ("DOOR", "EXIT") and n not in ENABLED_EXITS for n in lost), sorted(lost)


def test_sign_defaults_follow_normal_shortest_route():
    out = {}
    for e in BUILDING.edges:
        if e.traversable:
            out.setdefault(e.from_node_id, []).append(e)
    for sign in BUILDING.signs:
        node = sign.node_id
        for face in sign.faces:
            if node in ENABLED_EXITS:
                assert face.next_node_to_display == {node: "EXIT"}
                continue
            expected = min(out[node], key=lambda e: (e.cost + DIST[e.to_node_id], e.to_node_id)).to_node_id
            assert face.default_next_node_id == expected, sign.sign_id
            assert set(face.next_node_to_display) == {e.to_node_id for e in out[node]}


def test_stair_signs_show_stairs_down_toward_lower_floor():
    for sign in BUILDING.signs:
        for face in sign.faces:
            for target, display in face.next_node_to_display.items():
                a, b = NODES[sign.node_id], NODES[target]
                if a.floor_id != b.floor_id:
                    assert display == ("STAIRS_DOWN" if b.position.y < a.position.y else "STAIRS_UP")


def test_virtual_sources_cover_corridors():
    zones = {(s.source_type, s.zone_id) for s in BUILDING.sources}
    for zone in ["F2-CORR-W", "F2-CORR-E", "F3-CORR-W", "F3-CORR-E"]:
        assert ("VIDEO_AI", zone) in zones
    corridors = [z.zone_id for z in BUILDING.zones if "-CORR-" in z.zone_id]
    for zone in corridors + ["F1-LOBBY", "F1-PASSAGE-N", "F1-PASSAGE-S", "F2-VOID"]:
        assert ("SIM_SMOKE_DETECTOR", zone) in zones and ("SIM_SPRINKLER", zone) in zones


def test_geometry_file_matches_building():
    assert (GEOMETRY["building_id"], GEOMETRY["building_version"]) == (BUILDING.building_id, BUILDING.building_version)
    assert [f["floor_id"] for f in GEOMETRY["floors"]] == list(FLOORS)
    for floor in GEOMETRY["floors"]:
        assert floor["elevation"] == FLOORS[floor["floor_id"]].elevation
        assert floor["walls"]
        for x0, z0, x1, z1 in floor["walls"]:
            assert x0 < x1 and z0 < z1
        xs = [p["x"] for p in floor["slab"]]
        zs = [p["z"] for p in floor["slab"]]
        for node in BUILDING.nodes:
            if node.floor_id == floor["floor_id"]:
                assert min(xs) <= node.position.x <= max(xs) and min(zs) <= node.position.z <= max(zs)
        for hole in floor["slab_holes"]:
            assert hole["zone_id"] in ZONES
    assert {s["stair_id"] for s in GEOMETRY["stairs"]} == {"A", "B", "C", "D"}

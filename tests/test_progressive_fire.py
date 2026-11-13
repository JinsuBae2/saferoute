"""A positioned demo alarm starts immediately; its spatial obstruction grows later."""

import pytest

from backend.contracts.building import Edge, Node, Zone
from backend.contracts.common import Position
from test_manual_fire import clear, event
from test_wfi_routing import api  # noqa: F401
from test_wfi_space import BUILDING


def small_building(*, door_open=True):
    zones = [Zone(zone_id=name, floor_id=floor, label=name,
                  polygon=[dict(x=x,z=z) for x,z in [(lo,0),(hi,0),(hi,4),(lo,4)]],
                  blocked_node_ids=[], blocked_edge_ids=[])
             for name,floor,lo,hi in [("A","F1",0,4),("B","F1",4,8),("C","F2",4,8)]]
    nodes = [Node(node_id=name, floor_id=floor, zone_id=zone, position=dict(x=x,y=y,z=2.), kind="JUNCTION")
             for name,floor,zone,x,y in [("a","F1","A",3.,0.),("b","F1","B",5.,0.),("c","F2","C",5.,4.)]]
    edges = [Edge(edge_id="door",from_node_id="a",to_node_id="b",kind="DOOR",cost=2.,traversable=True,door_open=door_open),
             Edge(edge_id="stairs",from_node_id="b",to_node_id="c",kind="STAIR",cost=4.,traversable=True,door_open=None)]
    return BUILDING.model_copy(update=dict(building_id="SMALL",zones=zones,nodes=nodes,edges=edges))


def model(door_open=True):
    from backend.progressive_fire import ProgressiveFire
    result = ProgressiveFire(small_building(door_open=door_open))
    result.ignite("manual", "A", Position(x=1.,y=0.,z=2.), 0)
    return result


def test_local_fire_grows_and_smoke_reaches_open_door_before_flame():
    fire = model()
    early = fire.evaluate(0)
    assert early.state.fires[0].elapsed_ms == 0
    assert any(c.fire > 0 for c in early.state.cells)
    assert not any(c.zone_id == "B" for c in early.state.cells)
    middle = fire.evaluate(15000)
    assert any(c.zone_id == "B" and c.smoke > 0 and c.fire == 0 for c in middle.state.cells)
    assert "b" not in early.nodes
    late = fire.evaluate(60000)
    assert "b" in late.nodes and "door" in late.edges
    assert len(late.state.cells) > len(early.state.cells)


def test_closed_door_and_same_plan_other_floor_are_not_shortcuts():
    closed = model(False).evaluate(300000)
    assert all(c.zone_id == "A" for c in closed.state.cells)
    fire = model()
    assert all(c.zone_id != "C" for c in fire.evaluate(10000).state.cells)
    assert any(c.zone_id == "C" for c in fire.evaluate(90000).state.cells)


def test_wfi_narrow_corridors_have_cells_and_route_penalties_are_not_metres():
    from backend.progressive_fire import ProgressiveFire
    fire = ProgressiveFire(BUILDING)
    for zone in ["F2-CORR-N","F2-CORR-W","F3-CORR-N"]:
        assert any(key.startswith("cell:") for key in fire.by_zone[zone])
    stair = next(n for n in BUILDING.nodes if n.node_id == "F2-S-D")
    fire.ignite("manual",stair.zone_id,stair.position,0)
    assert "F3-S-D" in fire.evaluate(60000).nodes


def test_closed_but_traversable_door_checks_fire_in_the_middle_of_its_path():
    from backend.progressive_fire import ProgressiveFire
    building = small_building(door_open=False)
    building.nodes[0].position.x = .1
    building.nodes[1].position.x = 7.9
    fire = ProgressiveFire(building)
    fire.ignite("manual","A",Position(x=3.,y=0.,z=2.),0)
    result = fire.evaluate(10000)
    assert "door" in result.edges
    assert all(c.zone_id == "A" for c in result.state.cells)


def test_ignition_on_a_path_blocks_that_path_immediately():
    from backend.progressive_fire import ProgressiveFire
    building = small_building()
    building.nodes[0].position.x = .1
    building.nodes[1].position.x = 7.9
    fire = ProgressiveFire(building)
    fire.ignite("manual","A",Position(x=3.,y=0.,z=2.),0)
    assert "door" in fire.evaluate(0).edges


def test_interior_wall_within_one_zone_is_not_crossed_by_the_cell_grid():
    from backend.progressive_fire import ProgressiveFire
    fire = ProgressiveFire(BUILDING)
    fire.ignite("manual","F1-CONF",Position(x=3.6,y=0.,z=7.3),0)
    assert not any(other == "cell:F1-CONF:1:1" for other,_,_ in fire.graph["cell:F1-CONF:1:0"])
    assert not any(c.cell_id == "cell:F1-CONF:1:1" for c in fire.evaluate(7000).state.cells)


def test_multiple_fires_clear_only_their_own_growth():
    fire = model(False)
    fire.ignite("second", "B", Position(x=7.,y=0.,z=2.), 1000)
    fire.remove("manual")
    remaining = fire.evaluate(2000)
    assert [f.source_id for f in remaining.state.fires] == ["second"]
    assert all(c.zone_id != "A" for c in remaining.state.cells)
    fire.remove("second")
    assert fire.evaluate(3000).state is None


def positioned(clock, run_id, source="MANUAL-F3-R304", sequence=1):
    payload = event(clock, run_id, source, sequence)
    payload["ignition_position"] = dict(x=28.,y=8.,z=27.)
    return payload


def test_alarm_is_immediate_but_room_doors_and_routes_close_progressively(api):
    client, clock, run_id = api
    response = client.post("/api/events", json=positioned(clock, run_id))
    assert response.status_code == 200, response.text
    early = client.get("/api/state").json()
    assert early["controller_mode"] == "EMERGENCY"
    assert len(early["active_causes"]) == 1
    assert not {"F3-D-R304", "F3-D-R304-E"} & {n["node_id"] for n in early["blocked_nodes"]}
    assert next(r for r in early["routes"] if r["node_id"] == "F3-D-R304")["exit_id"] is not None
    # Renew required observations while advancing the same server clock.
    from test_wfi_routing import observe
    for seq in range(2,32):
        clock.advance(1000)
        for source in BUILDING.sources:
            if source.required:
                observe(client, clock, run_id, source.source_id, seq)
    late = client.get("/api/state").json()
    assert late["guidance_version"] > early["guidance_version"]
    assert len(late["blocked_edges"]) > len(early["blocked_edges"])
    assert late["fire_simulation"]["fires"][0]["elapsed_ms"] >= 30000
    assert any(r != next(x for x in early["routes"] if x["node_id"] == r["node_id"]) for r in late["routes"])


def test_repeated_alarm_does_not_reset_growth_and_reset_discards_it(api):
    client, clock, run_id = api
    payload = positioned(clock, run_id)
    assert client.post("/api/events", json=payload).status_code == 200
    clock.advance(4000)
    assert client.post("/api/events", json=payload).json()["duplicate"]
    assert client.post("/api/events", json=positioned(clock, run_id, sequence=2)).status_code == 200
    assert client.get("/api/state").json()["fire_simulation"]["fires"][0]["elapsed_ms"] == 4000
    assert clear(client, run_id, "MANUAL-F3-R304").status_code == 200
    assert client.get("/api/state").json()["fire_simulation"] is None
    assert client.post("/api/events", json=positioned(clock, run_id, sequence=3)).status_code == 200
    assert client.post("/api/control/reset", json=dict(schema_version=1,run_id=run_id,reason="new demo")).status_code == 200
    assert client.get("/api/state").json()["fire_simulation"] is None


def test_progressive_clear_preserves_unrelated_alarm_and_unknown_observations(api):
    client, clock, run_id = api
    assert client.post("/api/events",json=positioned(clock,run_id)).status_code == 200
    assert client.post("/api/events",json=event(clock,run_id,"MANUAL-F1-PASSAGE-N")).status_code == 200
    clock.advance(4000)
    assert clear(client,run_id,"MANUAL-F3-R304").status_code == 200
    state = client.get("/api/state").json()
    assert state["controller_mode"] == "EMERGENCY"
    assert {c["source_id"] for c in state["active_causes"]} == {"MANUAL-F1-PASSAGE-N"}
    assert any("REQUIRED_OBSERVATION_UNKNOWN" in n["reason_codes"] for n in state["blocked_nodes"])
    assert state["fire_simulation"] is None


@pytest.mark.parametrize("position", [dict(x=-100.,y=8.,z=27.),dict(x=28.,y=0.,z=27.)])
def test_ignition_must_be_in_its_registered_zone_and_floor(api, position):
    client, clock, run_id = api
    payload = positioned(clock, run_id)
    payload["ignition_position"] = position
    response = client.post("/api/events", json=payload)
    assert response.status_code == 400
    assert response.json()["error"]["field"] == "ignition_position"
    assert client.get("/api/state").json()["active_causes"] == []


def test_ignition_inside_a_wall_is_rejected(api):
    client, clock, run_id = api
    payload = event(clock,run_id,"MANUAL-F1-CONF")
    payload["ignition_position"] = dict(x=3.6,y=0.,z=8.5)
    assert client.post("/api/events",json=payload).status_code == 400


def test_positioned_fire_is_not_duplicated_as_whole_zone_simulated_smoke(tmp_path):
    from backend.controller import Controller
    from backend.rooms import LocalClient
    from scenario_runner.config import load_scenario
    from scenario_runner.runner import Runner
    from test_observation_state import FakeClock, ROOT
    clock = FakeClock()
    controller = Controller(BUILDING,tmp_path/"controller",clock=clock)
    other = Controller(BUILDING,tmp_path/"other",clock=clock)
    runner = Runner(BUILDING,load_scenario(ROOT/"data/scenarios/wfi-idle.json",BUILDING),LocalClient(controller),tmp_path/"runner",clock=clock)
    try:
        runner.auto_arm = True
        runner.tick(); runner.tick()
        controller.receive(positioned(clock,controller.run_id))
        for _ in range(40):
            clock.advance(500); runner.tick()
        snapshot = controller.snapshot()
        assert snapshot.fire_simulation is not None
        assert {c.source_id for c in snapshot.active_causes} == {"MANUAL-F3-R304"}
        assert not any(z.smoke for z in runner.state().zones)
        assert other.snapshot().fire_simulation is None
    finally:
        runner.close(); controller.close(); other.close()


def test_fire_in_a_zone_without_route_nodes_falls_back_to_zone_blocking(api):
    client, clock, run_id = api
    zone = next(z for z in BUILDING.zones if z.zone_id == "F2-VOID")
    payload = event(clock, run_id, "MANUAL-F2-VOID", 1)
    payload["ignition_position"] = dict(x=sum(p.x for p in zone.polygon)/len(zone.polygon), y=4.,
                                        z=sum(p.z for p in zone.polygon)/len(zone.polygon))
    assert client.post("/api/events", json=payload).status_code == 200, payload
    blocked = {e["edge_id"] for e in client.get("/api/state").json()["blocked_edges"]}
    assert set(zone.blocked_edge_ids) and set(zone.blocked_edge_ids) <= blocked


@pytest.mark.parametrize("zone_id", ["F2-ROOM-W", "F3-VOID-N", "F3-CENTER"])
def test_positioned_fire_is_refused_where_no_route_can_change(api, zone_id):
    client, clock, run_id = api
    zone = next(z for z in BUILDING.zones if z.zone_id == zone_id)
    floor = next(f for f in BUILDING.floors if f.floor_id == zone.floor_id)
    payload = event(clock, run_id, f"MANUAL-{zone_id}", 1)
    payload["ignition_position"] = dict(x=sum(p.x for p in zone.polygon)/len(zone.polygon), y=floor.elevation,
                                        z=sum(p.z for p in zone.polygon)/len(zone.polygon))
    response = client.post("/api/events", json=payload)
    assert response.status_code != 200 and response.json()["error"]["code"] == "INVALID_EVENT_COMBINATION", response.text
    assert client.get("/api/state").json()["controller_mode"] != "EMERGENCY"
    # 위치 없는 일반 경보(실제 감지기와 같은 경로)는 그대로 받는다.
    assert client.post("/api/events", json=event(clock, run_id, f"MANUAL-{zone_id}", 1)).status_code == 200
    assert client.get("/api/state").json()["controller_mode"] == "EMERGENCY"



def test_yeongnam_demo_selection_still_holds():
    """선택형 시연 「영남이」의 선정 조건을 서버 모형으로 고정한다(값은 web/src/building/yeongnam.ts, 검증은 tools/yeongnam_check.py).

    두 번의 경로 변경이 불꽃 없이 연기만으로 생기고(불꽃만 반영하면 3초 이상 늦다), 영남이가 그 변경을 정면 유도등에서 보며,
    기본 실행과 행동 10초 지연 모두 차단된 지점·통로를 밟지 않고 출구에 닿는지 본다.
    확산 속도나 건물 자료를 바꿔 이 시험이 깨지면 시연 값을 다시 골라야 한다. 실제 피난 가능 시간을 보장하는 시험이 아니다.
    """
    from tools.yeongnam_check import problems, report

    result = report([0, 10])
    assert problems(result) == []
    first, second = result["changes"]
    cfg, base = result["config"], result["runs"][0]
    # 첫 변경은 복도에 서서 보는 동안, 두 번째는 걷기 시작한 뒤에 온다.
    assert cfg["panicAt"] < first["at"] < cfg["departAt"] < second["at"]
    assert [at for at, _ in base["witnessed"]] == [first["at"], second["at"]]
    assert "F3-S-A" in base["trail"] and base["trail"][-1] == "F1-X-NW"

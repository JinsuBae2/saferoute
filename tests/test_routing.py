"""Independent hand-calculated fixtures and exhaustive path checks for B02."""

import copy
import itertools
import json
from pathlib import Path
import random

import pytest

from backend.contracts import parse_contract
from backend.contracts.messages import BlockedEdge, BlockedNode
from backend.controller import Controller
from backend.routing import calculate_routes, validate_default_routes
from test_observation_state import building, clock, controller, control, payload, prepare

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests/fixtures/routing-cases.json").read_text(encoding="utf-8"))["cases"]


def modified(building, *, edges=None, disabled=(), costs=None, signs=None):
    data = building.model_dump(mode="json")
    if edges is not None:
        data["edges"] = edges
        for zone in data["zones"]: zone["blocked_edge_ids"] = []
    for exit in data["exits"]:
        if exit["exit_id"] in disabled: exit["enabled"] = False
    for edge in data["edges"]:
        if costs and edge["edge_id"] in costs: edge["cost"] = costs[edge["edge_id"]]
    if signs is not None: data["signs"] = signs
    return parse_contract("Building", data)


def block_nodes(spec):
    return [BlockedNode(node_id=node,source_ids=[],reason_codes=reasons) for node,reasons in spec.items()]


def rows(routes):
    return {r.node_id:[r.next_node_id,r.exit_id,r.cost,r.path_node_ids,r.reason_codes] for r in routes}


def assert_safe(building, routes, blocked_nodes=(), blocked_edges=()):
    """Inspect reported paths and next-hop chains without invoking the solver."""
    by_node = {r.node_id:r for r in routes}
    exits = {e.exit_id:e.node_id for e in building.exits if e.enabled}
    assert set(by_node)=={n.node_id for n in building.nodes}
    for route in routes:
        if not route.path_node_ids:
            assert route.next_node_id is None and route.exit_id is None and route.cost is None
            assert route.reason_codes
            continue
        assert not route.reason_codes
        assert len(set(route.path_node_ids))==len(route.path_node_ids)
        assert not set(route.path_node_ids)&set(blocked_nodes)
        assert route.path_node_ids[-1]==exits[route.exit_id]
        total=0
        for start,end in itertools.pairwise(route.path_node_ids):
            edges=[e for e in building.edges if e.from_node_id==start and e.to_node_id==end and e.traversable and e.edge_id not in blocked_edges]
            assert edges, (start,end)
            total+=min(e.cost for e in edges)
        assert route.cost==pytest.approx(total)
        for index,node in enumerate(route.path_node_ids):
            following=by_node[node]
            assert following.exit_id==route.exit_id
            assert following.path_node_ids==route.path_node_ids[index:]


@pytest.mark.parametrize("case",CASES,ids=lambda case:case["id"])
def test_g01_to_g10_all_nodes_match_manual_answers(building,case):
    data=modified(building,disabled=case["disabled_exits"],costs=case["edge_costs"])
    blocked=block_nodes(case["blocked_nodes"])
    routes=calculate_routes(data,blocked)
    assert rows(routes)==case["expected"]
    assert_safe(data,routes,case["blocked_nodes"])


def test_default_routes_match_g01_and_honor_non_shortest_default(building):
    assert rows(validate_default_routes(building))==CASES[0]["expected"]
    data=building.model_dump(mode="json")
    for face in data["signs"][0]["faces"]: face["default_next_node_id"]="B"
    routes=validate_default_routes(parse_contract("Building",data))
    assert rows(routes)["S"]==["B","EXIT-Y",4,["S","B","Y"],[]]
    assert_safe(parse_contract("Building",data),routes)


@pytest.mark.parametrize("problem",["opposite-face-disagreement","cycle","disabled-exit"])
def test_bad_defaults_are_rejected_before_running(building,problem):
    data=building.model_dump(mode="json")
    if problem=="opposite-face-disagreement": data["signs"][0]["faces"][1]["default_next_node_id"]="B"
    if problem=="cycle":
        for face in data["signs"][0]["faces"]: face["default_next_node_id"]="B"
        data["signs"][1]["faces"][0]["default_next_node_id"]="S"
    if problem=="disabled-exit": data["exits"][0]["enabled"]=False
    with pytest.raises(ValueError): validate_default_routes(parse_contract("Building",data))


def test_edge_only_blocking_and_one_way_connections(building):
    blocked=[BlockedEdge(edge_id="A-X",source_ids=[],reason_codes=["ACTIVE_ALARM"])]
    routes=calculate_routes(building,blocked_edges=blocked)
    assert rows(routes)["S"]==["B","EXIT-Y",4,["S","B","Y"],[]]
    assert rows(routes)["A"]==["S","EXIT-Y",5,["A","S","B","Y"],[]]
    assert_safe(building,routes,blocked_edges=["A-X"])
    one_way=modified(building,edges=[e.model_dump() for e in building.edges if e.edge_id!="A-X"],signs=[])
    assert rows(calculate_routes(one_way))["S"][1]=="EXIT-Y"


def test_closed_door_is_distinct_from_non_traversable_edge(building):
    edges=[e.model_dump() for e in building.edges]
    edge=next(e for e in edges if e["edge_id"]=="A-X")
    edge.update(kind="DOOR",door_open=False)
    data=modified(building,edges=edges,signs=[])
    assert rows(calculate_routes(data))["S"][1]=="EXIT-X"
    edge["traversable"]=False
    data=modified(building,edges=edges,signs=[])
    assert rows(calculate_routes(data))["S"][1]=="EXIT-Y"


def test_no_enabled_exits_and_unknown_observation_reasons_are_local(building):
    data=modified(building,disabled=["EXIT-X","EXIT-Y"])
    result=rows(calculate_routes(data))
    assert result["S"][4]==["NO_REACHABLE_EXIT","EXIT_UNAVAILABLE"]
    assert result["I"][4]==["NO_REACHABLE_EXIT"]
    unknown=[BlockedEdge(edge_id="S-B",source_ids=[],reason_codes=["REQUIRED_OBSERVATION_UNKNOWN"])]
    result=rows(calculate_routes(building,block_nodes({"A":["ACTIVE_ALARM"]}),unknown))
    assert result["S"][4]==["NO_REACHABLE_EXIT","REQUIRED_OBSERVATION_UNKNOWN"]
    assert result["I"][4]==["NO_REACHABLE_EXIT"]


def test_all_exit_nodes_blocked_is_distinct_from_isolated_origin(building):
    result=rows(calculate_routes(building,block_nodes({"X":["ACTIVE_ALARM"],"Y":["ACTIVE_ALARM"]})))
    assert result["S"][4]==["NO_REACHABLE_EXIT","EXIT_UNAVAILABLE"]
    assert result["I"][4]==["NO_REACHABLE_EXIT"]
    assert result["X"][4]==["ORIGIN_BLOCKED"]


def test_invalid_defaults_stop_controller_before_creating_a_run(building,clock,tmp_path):
    data=modified(building,disabled=["EXIT-X"])
    with pytest.raises(ValueError): Controller(data,tmp_path/"runs",clock=clock)
    assert not (tmp_path/"runs").exists()


def test_unrepresentable_total_cost_is_a_configuration_error(building):
    data=modified(building,costs={e.edge_id:1e308 for e in building.edges})
    with pytest.raises(ValueError,match="finite wire-number"):
        validate_default_routes(data)


def test_overlapping_alarm_and_unknown_are_never_relaxed_into_a_route(building):
    blocked=block_nodes({"A":["ACTIVE_ALARM"],"B":["ACTIVE_ALARM","REQUIRED_OBSERVATION_UNKNOWN"]})
    result=rows(calculate_routes(building,blocked))
    assert result["S"][3]==[]
    assert result["B"][4]==["ORIGIN_BLOCKED","REQUIRED_OBSERVATION_UNKNOWN"]


def test_unknown_block_id_is_configuration_error(building):
    with pytest.raises(ValueError): calculate_routes(building,block_nodes({"missing":["ACTIVE_ALARM"]}))


def test_tie_breaking_ignores_all_input_array_orders(building):
    data=modified(building,costs=CASES[-1]["edge_costs"]).model_dump(mode="json")
    for seed in range(8):
        shuffled=copy.deepcopy(data)
        rng=random.Random(seed)
        for name in ("nodes","edges","exits"): rng.shuffle(shuffled[name])
        assert rows(calculate_routes(parse_contract("Building",shuffled)))==CASES[-1]["expected"]


def test_decimal_cost_tie_and_next_node_tie_are_stable(building):
    def edge(eid,start,end,cost):
        return dict(edge_id=eid,from_node_id=start,to_node_id=end,kind="CORRIDOR",cost=cost,traversable=True,door_open=None)
    data=modified(building,edges=[edge("SA","S","A",.1),edge("AX","A","X",.2),edge("SY","S","Y",.3)],signs=[])
    assert rows(calculate_routes(data))["S"]==["A","EXIT-X",.3,["S","A","X"],[]]
    data=modified(building,edges=[edge("SB","S","B",1),edge("BX","B","X",1),edge("SA","S","A",1),edge("AX","A","X",1),edge("SA-2","S","A",1)],signs=[])
    assert rows(calculate_routes(data))["S"][3]==["S","A","X"]


@pytest.mark.parametrize("seed",range(16))
def test_small_directed_graphs_match_independent_exhaustive_paths(building,seed):
    rng=random.Random(seed)
    names=["S","A","B","X","Y","I"]
    edges=[]
    for start,end in itertools.permutations(names,2):
        if rng.random()<.3:
            edges.append(dict(edge_id=f"{start}-{end}",from_node_id=start,to_node_id=end,kind="CORRIDOR",cost=rng.randint(1,5),traversable=True,door_open=None))
    data=modified(building,edges=edges,signs=[])
    blocked={"A"} if seed%2 else set()
    routes=calculate_routes(data,block_nodes({n:["ACTIVE_ALARM"] for n in blocked}))
    assert_safe(data,routes,blocked)
    for route in routes:
        candidates=[]
        def enumerate_paths(node,path,cost,steps):
            for exit in data.exits:
                if exit.enabled and exit.node_id==node:
                    candidates.append((cost,exit.exit_id,steps,list(path)))
            for edge in data.edges:
                if edge.from_node_id==node and edge.to_node_id not in path and edge.to_node_id not in blocked:
                    enumerate_paths(edge.to_node_id,path+[edge.to_node_id],cost+edge.cost,steps+[(edge.to_node_id,edge.edge_id)])
        if route.node_id not in blocked: enumerate_paths(route.node_id,[route.node_id],0,[])
        if not candidates: assert route.path_node_ids==[]
        else:
            cost,exit_id,_,path=min(candidates)
            assert (route.cost,route.exit_id,route.path_node_ids)==(cost,exit_id,path)


def test_controller_g07_g08_g09_and_route_audit_are_same_version(controller,clock,tmp_path):
    assert all(r.reason_codes==["INITIALIZING"] for r in controller.snapshot().routes)
    prepare(controller,clock)
    assert rows(controller.snapshot().routes)==CASES[0]["expected"]
    controller.receive(payload(controller,clock))
    controller.receive(payload(controller,clock,"DETECTOR-A",hazard="SMOKE",sequence=2))
    controller.clear(control(controller,source_id="CAM-A",hazard_type="FIRE"))
    assert rows(controller.snapshot().routes)==CASES[7]["expected"]
    controller.receive(payload(controller,clock,"DETECTOR-B",kind="UNAVAILABLE",sequence=2))
    assert rows(controller.snapshot().routes)==CASES[6]["expected"]
    controller.receive(payload(controller,clock,"DETECTOR-B",kind="OBSERVATION",sequence=3))
    controller.clear(control(controller,source_id="DETECTOR-A",hazard_type="SMOKE"))
    snapshot=controller.snapshot()
    assert snapshot.controller_mode=="NORMAL"
    assert rows(snapshot.routes)==CASES[8]["expected"]
    decisions=[json.loads(line) for line in (tmp_path/"runs"/snapshot.run_id/"decisions.jsonl").read_text(encoding="utf-8").splitlines()]
    assert decisions[-1]["guidance_version"]==snapshot.guidance_version
    assert decisions[-1]["routes"]==[r.model_dump(mode="json") for r in snapshot.routes]
    clock.advance(3000)
    controller.expire()
    assert controller.snapshot().controller_mode=="DEGRADED"
    routes = controller.snapshot().routes
    assert {r.node_id for r in routes if r.path_node_ids} == {"X", "Y"}
    assert_safe(controller.building, routes, {"A", "B"})


def test_same_alarm_does_not_recompute_routes(controller,clock,monkeypatch):
    prepare(controller,clock)
    controller.receive(payload(controller,clock))
    def unexpected(*args,**kwargs): raise AssertionError("unchanged guidance must reuse routes")
    monkeypatch.setattr("backend.controller.calculate_routes",unexpected)
    controller.receive(payload(controller,clock,sequence=2))
    assert rows(controller.snapshot().routes)==CASES[1]["expected"]

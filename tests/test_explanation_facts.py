"""A05-1 facts use real controller transitions, not generated explanations."""

import copy
import json
from pathlib import Path

import pytest

from backend.contracts import ContractError, parse_contract
from explanation_worker.facts import extract_basis
from test_observation_state import building, clock, controller, control, payload, prepare


@pytest.mark.parametrize("scenario,mode,path", [
    ("G01", "NORMAL", ["S", "A", "X"]),
    ("G02", "EMERGENCY", ["S", "B", "Y"]),
    ("G04", "EMERGENCY", []),
    ("G07", "DEGRADED", ["S", "B", "Y"]),
    ("G09", "NORMAL", ["S", "A", "X"]),
])
def test_current_facts_match_controller_transitions(controller, clock, scenario, mode, path):
    prepare(controller, clock)
    if scenario in {"G02", "G04", "G09"}:
        controller.receive(payload(controller, clock))
    if scenario == "G04":
        controller.receive(payload(controller, clock, "DETECTOR-B", hazard="SMOKE", sequence=2))
    if scenario == "G07":
        controller.receive(payload(controller, clock, "DETECTOR-A", "UNAVAILABLE", sequence=2,
                                   reason_code="SIMULATION_STOPPED"))
    if scenario == "G09":
        controller.clear(control(controller, source_id="CAM-A", hazard_type="FIRE"))
    state = controller.snapshot()
    before = state.model_dump(mode="json")
    basis = extract_basis(state)
    facts = basis["facts"]
    assert {key: basis[key] for key in basis if key != "facts"} == {
        "schema_version": 1, "run_id": state.run_id, "building_id": "TWO_ROUTE",
        "building_version": 1, "guidance_version": state.guidance_version,
        "basis_generated_at": state.generated_at,
    }
    assert facts["mode"] == {"controller_mode": mode}
    assert facts["route:S"]["path_node_ids"] == path
    assert ("cause:CAM-A:FIRE" in facts) == (scenario in {"G02", "G04"})
    if scenario == "G04":
        assert facts["route:S"]["reason_codes"] == ["NO_REACHABLE_EXIT"]
        assert facts["route:S"]["next_node_id"] is None
        assert facts["route:S"]["cost"] is None
    if scenario == "G07":
        assert facts["blocked-node:A"] == {
            "node_id": "A", "source_ids": ["DETECTOR-A"],
            "reason_codes": ["REQUIRED_OBSERVATION_UNKNOWN"],
        }
    assert state.model_dump(mode="json") == before
    facts["route:S"]["path_node_ids"].append("MUTATED")
    assert state.model_dump(mode="json") == before


def test_allowlist_excludes_command_ack_history_and_is_order_independent():
    root = Path(__file__).resolve().parents[1]
    samples = json.loads((root / "data/contracts/valid.json").read_text(encoding="utf-8"))
    state = parse_contract("StateSnapshot", samples["emergency_state"]["payload"])
    assert any(sign.latest_command is not None and sign.terminals for sign in state.signs)
    before = state.model_dump(mode="json")
    basis = extract_basis(state)
    assert set(basis) == {
        "schema_version", "run_id", "building_id", "building_version", "guidance_version",
        "basis_generated_at", "facts",
    }
    allowed = {
        "mode": {"controller_mode"}, "cause": {"source_id", "hazard_type"},
        "blocked-node": {"node_id", "source_ids", "reason_codes"},
        "blocked-edge": {"edge_id", "source_ids", "reason_codes"},
        "route": {"node_id", "next_node_id", "exit_id", "path_node_ids", "cost", "reason_codes"},
    }
    for fact_id, fact in basis["facts"].items():
        assert set(fact) == allowed[fact_id.split(":", 1)[0]]
    expected_ids = {"mode"}
    expected_ids.update(f"cause:{c.source_id}:{c.hazard_type}" for c in state.active_causes)
    expected_ids.update(f"blocked-node:{n.node_id}" for n in state.blocked_nodes)
    expected_ids.update(f"blocked-edge:{e.edge_id}" for e in state.blocked_edges)
    expected_ids.update(f"route:{r.node_id}" for r in state.routes)
    assert set(basis["facts"]) == expected_ids
    assert basis["facts"]["blocked-edge:S-A"] == {
        "edge_id": "S-A", "source_ids": ["CAM-A"], "reason_codes": ["ACTIVE_ALARM"],
    }
    assert state.model_dump(mode="json") == before
    state.active_causes.reverse()
    state.blocked_nodes.reverse()
    state.blocked_edges.reverse()
    state.routes.reverse()
    assert json.dumps(extract_basis(state)) == json.dumps(basis)
    basis["facts"]["blocked-edge:S-A"]["source_ids"].clear()
    assert next(edge for edge in state.blocked_edges if edge.edge_id == "S-A").source_ids == ["CAM-A"]


@pytest.mark.parametrize("field", ["generated_at", "expires_at", "summary", "model_id", "prompt_version"])
def test_ready_requires_each_result_field(field):
    root = Path(__file__).resolve().parents[1]
    samples = json.loads((root / "data/contracts/valid.json").read_text(encoding="utf-8"))
    value = copy.deepcopy(samples["explanation_ready"]["payload"])
    value[field] = None
    with pytest.raises(ContractError):
        parse_contract("Explanation", value)

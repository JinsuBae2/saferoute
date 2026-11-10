"""Human-readable WFI names retain the existing spatial and control identities."""

import json
from pathlib import Path

from backend.contracts import parse_contract

ROOT = Path(__file__).resolve().parents[1]


def test_wfi_display_covers_the_current_building_and_separates_sign_kinds():
    building = parse_contract("Building", json.loads((ROOT / "data/space/wfi-v1.json").read_text(encoding="utf-8")))
    display = parse_contract("BuildingDisplay", json.loads((ROOT / "data/space/wfi-display-v1.json").read_text(encoding="utf-8"))).validate_for(building)
    assert display.node_labels["F2-S-A"] == "2층 좌측 계단 A"
    assert display.node_labels["F2-S-B"] == "2층 우측 계단 B"
    assert display.node_labels["F2-D-R201"] == "2층 201호 입구"
    assert display.signs["SIGN-F1-X-N"].kind == "EXIT_LOCATION"
    assert display.signs["SIGN-F2-J-N3"].kind == "DIRECTIONAL"
    assert len(set(display.node_labels.values())) == len(building.nodes)
    assert all(label.startswith(("1층", "2층", "3층")) for label in display.zone_labels.values())


def test_camera_installations_are_explicitly_virtual_and_distinct_from_observation_zones():
    building = parse_contract("Building", json.loads((ROOT / "data/space/wfi-v1.json").read_text(encoding="utf-8")))
    display = parse_contract("BuildingDisplay", json.loads((ROOT / "data/space/wfi-display-v1.json").read_text(encoding="utf-8"))).validate_for(building)
    camera = display.sources["CAM-F2-CORR-E"]
    assert camera.label == "2층 우측 계단 B 앞 CAM"
    assert camera.installation.basis == "SIMULATED"
    assert camera.installation.floor_id == "F2"
    assert camera.installation.position.y > 4
    assert next(s.zone_id for s in building.sources if s.source_id == "CAM-F2-CORR-E") == "F2-CORR-E"
    assert display.sources["SMK-F2-CORR-E"].installation is None

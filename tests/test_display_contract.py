"""Display metadata is versioned separately from routing and observation inputs."""

import copy
import json
from pathlib import Path

import pytest

from backend.contracts import ContractError, parse_contract
from tools import validate_config

ROOT = Path(__file__).resolve().parents[1]
BUILDING = json.loads((ROOT / "data/fixtures/two-route-v1.json").read_text(encoding="utf-8"))
SAMPLE = json.loads((ROOT / "data/contracts/valid.json").read_text(encoding="utf-8"))["building_display"]["payload"]


def validate(data, building=None):
    return parse_contract("BuildingDisplay", data).validate_for(parse_contract("Building", building or BUILDING))


def test_display_round_trip_and_validation_do_not_mutate_control_building():
    building = parse_contract("Building", BUILDING)
    before = building.model_dump(mode="json")
    display = parse_contract("BuildingDisplay", SAMPLE).validate_for(building)
    assert display.model_dump(mode="json") == SAMPLE
    assert building.model_dump(mode="json") == before
    assert display.sources["CAM-A"].installation.position.x == 0
    assert next(z for z in building.zones if z.zone_id == "Z-A").polygon[0].x == -1.2
    assert display.sources["DETECTOR-A"].installation is None


@pytest.mark.parametrize("field,value", [("building_id", "OTHER"), ("building_version", 2)])
def test_display_rejects_other_building_or_version(field, value):
    with pytest.raises(ValueError, match="building"):
        validate(dict(SAMPLE, **{field: value}))


@pytest.mark.parametrize("field", ["floor_labels", "zone_labels", "node_labels", "exit_labels", "sources", "signs"])
@pytest.mark.parametrize("change", ["missing", "extra"])
def test_display_requires_exact_building_references(field, change):
    data = copy.deepcopy(SAMPLE)
    key = next(iter(data[field]))
    if change == "missing":
        del data[field][key]
    else:
        data[field]["UNKNOWN"] = copy.deepcopy(data[field][key])
    with pytest.raises(ValueError, match=field):
        validate(data)


@pytest.mark.parametrize("value", ["", " ", " 좌측", 42, None])
def test_display_rejects_invalid_labels(value):
    data = copy.deepcopy(SAMPLE)
    data["node_labels"]["A"] = value
    with pytest.raises(ContractError):
        validate(data)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), "1", True])
def test_installation_requires_finite_coordinates_without_coercion(value):
    data = copy.deepcopy(SAMPLE)
    data["sources"]["CAM-A"]["installation"]["position"]["x"] = value
    with pytest.raises(ContractError):
        validate(data)


def test_installation_requires_known_floor_and_honest_coordinate_basis():
    for change in [dict(floor_id="UNKNOWN"), dict(basis="MEASURED")]:
        data = copy.deepcopy(SAMPLE)
        data["sources"]["CAM-A"]["installation"].update(change)
        with pytest.raises(ValueError):
            validate(data)
    measured = copy.deepcopy(BUILDING)
    measured["coordinate_system"]["measured"] = True
    data = copy.deepcopy(SAMPLE)
    data["sources"]["CAM-A"]["installation"]["basis"] = "MEASURED"
    assert validate(data, measured).sources["CAM-A"].installation.basis == "MEASURED"
    data["sources"]["DETECTOR-A"]["installation"] = data["sources"]["CAM-A"]["installation"]
    with pytest.raises(ValueError):
        validate(data, measured)


def test_nullable_installation_must_be_explicit_and_observed_zone_cannot_be_overridden():
    for change in ["missing", "zone"]:
        data = copy.deepcopy(SAMPLE)
        if change == "missing":
            del data["sources"]["CAM-A"]["installation"]
        else:
            data["sources"]["CAM-A"]["zone_id"] = "Z-S"
        with pytest.raises(ContractError):
            validate(data)


def test_exit_location_sign_must_match_an_exit_and_its_existing_face_mapping():
    data = copy.deepcopy(SAMPLE)
    data["signs"]["SIGN-S"]["kind"] = "EXIT_LOCATION"
    with pytest.raises(ValueError):
        validate(data)
    building = copy.deepcopy(BUILDING)
    building["signs"].append(dict(sign_id="SIGN-X", node_id="X", faces=[dict(
        face_id="FRONT", view_direction=dict(x=0, y=0, z=-1),
        default_next_node_id="X", next_node_to_display={"X":"EXIT"})]))
    data["signs"]["SIGN-S"]["kind"] = "DIRECTIONAL"
    data["signs"]["SIGN-X"] = dict(label="좌측 출구 표지", kind="EXIT_LOCATION")
    assert validate(data, building).signs["SIGN-X"].kind == "EXIT_LOCATION"
    building["signs"][-1]["faces"][0].update(default_next_node_id="A", next_node_to_display={"A":"BACK"})
    with pytest.raises(ValueError):
        validate(data, building)


def test_display_data_is_not_a_control_building_extension():
    with pytest.raises(ContractError):
        parse_contract("Building", dict(BUILDING, display=SAMPLE))


@pytest.mark.parametrize("wrong_version", [False, True])
def test_validate_config_checks_display_references(tmp_path, monkeypatch, capsys, wrong_version):
    data = dict(SAMPLE, building_version=2 if wrong_version else 1)
    path = tmp_path / "display.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["validate_config", "--building", str(ROOT / "data/fixtures/two-route-v1.json"), "--display", str(path)])
    assert validate_config.main() == (2 if wrong_version else 0)
    output = capsys.readouterr()
    if wrong_version:
        assert "building" in output.err
    else:
        assert json.loads(output.out)["display_validated"] is True

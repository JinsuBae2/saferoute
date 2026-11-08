"""Shared wire examples and independent rejection expectations for C02."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from backend.contracts import (
    ContractError, EventContext, check_ack, check_command, check_event, parse_contract,
)

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = json.loads((ROOT / "data/contracts/valid.json").read_text())
REJECTED = json.loads((ROOT / "data/contracts/rejected.json").read_text())
BUILDING = json.loads((ROOT / "data/fixtures/two-route-v1.json").read_text())
NOW = datetime(2026, 11, 10, 1, 0, 0, 200000, tzinfo=timezone.utc)


def sample(name):
    item = SAMPLES[name]
    return parse_contract(item["model"], copy.deepcopy(item["payload"]))


def context(**overrides):
    args = dict(building=parse_contract("Building", BUILDING), session=sample("session"),
                now=NOW, last_sequences={}, seen_events={})
    args.update(overrides)
    return EventContext(**args)


@pytest.mark.parametrize("name", list(SAMPLES))
def test_shared_valid_samples_round_trip_without_coercion(name):
    assert sample(name).model_dump(mode="json") == SAMPLES[name]["payload"]


@pytest.mark.parametrize("case", REJECTED, ids=lambda c: c["name"])
def test_shared_rejected_samples(case):
    item = SAMPLES[case["sample"]]
    payload = dict(copy.deepcopy(item["payload"]), **case["changes"])
    with pytest.raises(ContractError) as caught:
        event = parse_contract(item["model"], payload)
        if case["context"]:
            seen = {sample("fire").event_id: sample("fire")} if case["context"] == "seen_event" else {}
            check_event(event, context(last_sequences={"CAM-A": 17}, seen_events=seen))
    assert caught.value.code == case["expected_code"]
    assert caught.value.to_response().error.code == case["expected_code"]


def test_retry_is_duplicate_even_after_expiry_and_does_not_mutate_context():
    event = sample("fire")
    ctx = context(now=NOW.replace(minute=1), last_sequences={"CAM-A": 20}, seen_events={event.event_id: event})
    result = check_event(event, ctx)
    assert result.duplicate is True
    assert result.remaining_valid_for_ms == 0
    assert ctx.last_sequences == {"CAM-A": 20}
    assert ctx.seen_events == {event.event_id: event}


def test_input_age_is_subtracted_from_remaining_validity():
    result = check_event(sample("fire"), context())
    assert result.duplicate is False
    assert result.remaining_valid_for_ms == 2800


@pytest.mark.parametrize("value", [True, 1.5, "1", 0, -1])
def test_sequence_rejects_non_integer_or_nonpositive_values(value):
    with pytest.raises(ContractError):
        parse_contract("ObservationEvent", dict(SAMPLES["fire"]["payload"], source_sequence=value))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, "0.5", -.1, 1.1])
def test_confidence_rejects_invalid_numbers(value):
    with pytest.raises(ContractError):
        parse_contract("ObservationEvent", dict(SAMPLES["fire"]["payload"], confidence=value))


def test_missing_nullable_field_is_not_silently_defaulted():
    payload = dict(SAMPLES["normal"]["payload"])
    del payload["confidence"]
    with pytest.raises(ContractError):
        parse_contract("ObservationEvent", payload)


def test_building_graph_and_sign_faces_match_documented_fixture():
    building = parse_contract("Building", BUILDING)
    assert len(building.nodes) == 6
    assert len(building.edges) == 8
    assert building.signs[0].faces[0].next_node_to_display == {"A": "LEFT", "B": "RIGHT"}
    assert building.signs[0].faces[1].next_node_to_display == {"A": "RIGHT", "B": "LEFT"}


@pytest.mark.parametrize("change", ["unknown-node", "duplicate-node", "unknown-zone", "wrong-floor", "unknown-face-target", "missing-default", "invalid-door", "nonpositive-cost", "zero-view", "unknown-transform", "unsupported-cause"])
def test_building_rejects_broken_references_and_geometry_contract(change):
    data = copy.deepcopy(BUILDING)
    if change == "unknown-node": data["edges"][0]["to_node_id"] = "MISSING"
    if change == "duplicate-node": data["nodes"].append(data["nodes"][0])
    if change == "unknown-zone": data["sources"][0]["zone_id"] = "MISSING"
    if change == "wrong-floor": data["nodes"][0]["floor_id"] = "MISSING"
    if change == "unknown-face-target": data["signs"][0]["faces"][0]["next_node_to_display"]["I"] = "LEFT"
    if change == "missing-default": data["signs"][0]["faces"][0]["default_next_node_id"] = "B-MISSING"
    if change == "invalid-door": data["edges"][0]["door_open"] = True
    if change == "nonpositive-cost": data["edges"][0]["cost"] = 0
    if change == "zero-view": data["signs"][0]["faces"][0]["view_direction"] = dict(x=0,y=0,z=0)
    if change == "unknown-transform": data["coordinate_system"]["floor_transforms"][0]["floor_id"] = "MISSING"
    if change == "unsupported-cause": data["sources"][1]["allowed_hazard_types"] = ["FIRE"]
    with pytest.raises(ContractError):
        parse_contract("Building", data)


def test_closed_but_traversable_door_is_accepted():
    data = copy.deepcopy(BUILDING)
    data["edges"][0].update(kind="DOOR", door_open=False, traversable=True)
    assert parse_contract("Building", data).edges[0].traversable is True


def test_command_matches_session_building_and_all_faces():
    command = sample("command")
    check_command(command, sample("session"), parse_contract("Building", BUILDING), "SIGN-S", 18)


@pytest.mark.parametrize("change,code", [("old-run","RUN_MISMATCH"),("wrong-sign","UNKNOWN_SIGN"),("old-sequence","STALE_SEQUENCE"),("missing-face","COMMAND_MISMATCH"),("wrong-display","COMMAND_MISMATCH")])
def test_command_context_rejections(change, code):
    payload = copy.deepcopy(SAMPLES["command"]["payload"])
    if change == "old-run": payload["run_id"] = "77777777-7777-4777-8777-777777777777"
    if change == "wrong-sign": payload["sign_id"] = "UNKNOWN"
    if change == "old-sequence": payload["command_sequence"] = 18
    if change == "missing-face": payload["faces"].pop()
    if change == "wrong-display": payload["faces"][0]["display"] = "LEFT"
    with pytest.raises(ContractError) as caught:
        check_command(parse_contract("SignCommand", payload), sample("session"), parse_contract("Building", BUILDING), "SIGN-S", 18)
    assert caught.value.code == code


def test_ack_requires_matching_command_and_unexpired_monotonic_deadline():
    check_ack(sample("ack"), sample("command"), now_monotonic_ms=1000, expires_at_monotonic_ms=1001)
    with pytest.raises(ContractError) as caught:
        check_ack(sample("ack"), sample("command"), now_monotonic_ms=1001, expires_at_monotonic_ms=1001)
    assert caught.value.code == "COMMAND_EXPIRED"


@pytest.mark.parametrize("field,value", [("command_sequence",18),("guidance_version",2),("sign_id","SIGN-B"),("command_id","77777777-7777-4777-8777-777777777777")])
def test_ack_cannot_claim_success_for_another_command(field, value):
    ack = parse_contract("SignAck", dict(SAMPLES["ack"]["payload"], **{field:value}))
    with pytest.raises(ContractError):
        check_ack(ack, sample("command"), now_monotonic_ms=1000, expires_at_monotonic_ms=2000)


def test_ack_cannot_claim_wrong_or_partial_face_application():
    for faces in [SAMPLES["ack"]["payload"]["faces"][:1], [dict(f,display="LEFT") for f in SAMPLES["ack"]["payload"]["faces"]]]:
        ack = parse_contract("SignAck", dict(SAMPLES["ack"]["payload"], faces=faces))
        with pytest.raises(ContractError):
            check_ack(ack, sample("command"), now_monotonic_ms=1000, expires_at_monotonic_ms=2000)


def test_no_route_cannot_keep_an_old_arrow():
    payload = copy.deepcopy(SAMPLES["no_route_command"]["payload"])
    payload["faces"][0]["display"] = "LEFT"
    with pytest.raises(ContractError): parse_contract("SignCommand", payload)


def test_path_must_start_at_origin_and_next_node_must_match():
    for changes in [dict(path_node_ids=["B","Y"]),dict(next_node_id="A"),dict(path_node_ids=["S","B","S","Y"])]:
        with pytest.raises(ContractError):
            parse_contract("Route", dict(SAMPLES["route"]["payload"], **changes))


def test_reset_must_create_new_run():
    with pytest.raises(ContractError):
        parse_contract("ResetReceipt", dict(SAMPLES["reset_receipt"]["payload"], run_id=SAMPLES["reset_receipt"]["payload"]["previous_run_id"]))


def test_exit_sign_uses_self_mapping_without_inventing_self_edge():
    data = copy.deepcopy(BUILDING)
    data["signs"].append(dict(sign_id="SIGN-Y", node_id="Y", faces=[dict(
        face_id="FRONT", view_direction=dict(x=0,y=0,z=-1), default_next_node_id="Y",
        next_node_to_display={"Y":"EXIT"})]))
    building = parse_contract("Building", data)
    payload = copy.deepcopy(SAMPLES["command"]["payload"])
    payload.update(sign_id="SIGN-Y", faces=[dict(face_id="FRONT",mode="DEFAULT",display="EXIT",next_node_id=None,exit_id="EXIT-Y",reason_codes=[])])
    check_command(parse_contract("SignCommand", payload), sample("session"), building, "SIGN-Y", 0)


@pytest.mark.parametrize("now,expiry", [(float("nan"), 10),(0,float("nan")),(float("inf"),20),(0,float("inf"))])
def test_ack_internal_clock_must_be_finite(now, expiry):
    with pytest.raises(ValueError):
        check_ack(sample("ack"), sample("command"), now_monotonic_ms=now, expires_at_monotonic_ms=expiry)


def test_state_cannot_claim_applied_without_matching_verified_ack():
    state = copy.deepcopy(SAMPLES["state"]["payload"])
    state.update(guidance_version=3,controller_mode="EMERGENCY")
    sign = state["signs"][0]
    sign.update(latest_command=SAMPLES["command"]["payload"],faces=SAMPLES["command"]["payload"]["faces"],application_status="APPLIED")
    with pytest.raises(ContractError): parse_contract("StateSnapshot", state)
    sign["terminals"] = [dict(terminal_instance_id=SAMPLES["ack"]["payload"]["terminal_instance_id"],last_ack=copy.deepcopy(SAMPLES["ack"]["payload"]),received_at="2026-11-10T01:00:00.300Z",verified=True)]
    assert parse_contract("StateSnapshot", state).signs[0].application_status == "APPLIED"
    sign["terminals"][0]["last_ack"]["command_sequence"] = 18
    with pytest.raises(ContractError): parse_contract("StateSnapshot", state)


def test_manual_hazard_allowlist_is_checked_against_registered_source():
    data = copy.deepcopy(BUILDING)
    data["sources"][0].update(source_type="MANUAL_TEST",allowed_hazard_types=["SMOKE"])
    event = parse_contract("ObservationEvent", dict(SAMPLES["fire"]["payload"],source_type="MANUAL_TEST",media_time_ms=None,confidence=None))
    with pytest.raises(ContractError) as caught:
        check_event(event, context(building=parse_contract("Building",data)))
    assert caught.value.code == "INVALID_EVENT_COMBINATION"

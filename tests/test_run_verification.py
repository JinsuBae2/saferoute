"""Independent log integrity checks; these do not certify browser or routing behavior."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

from tools.verify_run import verify_run

ROOT = Path(__file__).resolve().parents[1]
RUN = "00000000-0000-4000-8000-000000000001"
COMMAND = "00000000-0000-4000-8000-000000000002"
TERMINAL = "00000000-0000-4000-8000-000000000003"
STAMP = "2026-11-10T01:00:00Z"
FILES = ("events.jsonl", "decisions.jsonl", "commands.jsonl", "acks.jsonl")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def read_records(directory, name):
    return [json.loads(line) for line in (directory / name).read_text(encoding="utf-8").splitlines()]


def write_records(directory, name, records):
    (directory / name).write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


def command(sequence=1):
    return dict(schema_version=1, run_id=RUN, building_id="TWO_ROUTE", building_version=1,
                guidance_version=0, sign_id="SIGN-S", command_id=COMMAND,
                command_sequence=sequence, issued_at=STAMP, valid_for_ms=3000,
                faces=[dict(face_id=face, mode="UNKNOWN", display=None, next_node_id=None,
                            exit_id=None, reason_codes=["INITIALIZING"]) for face in ("FRONT", "REAR")])


def acknowledgement(cmd):
    return dict(schema_version=1, run_id=cmd["run_id"], sign_id=cmd["sign_id"], terminal_instance_id=TERMINAL,
                command_id=cmd["command_id"], command_sequence=cmd["command_sequence"],
                guidance_version=cmd["guidance_version"], status="APPLIED",
                faces=[{key: face[key] for key in ("face_id", "mode", "display")} for face in cmd["faces"]],
                client_apply_duration_ms=8, error_code=None)


def make_run(tmp_path, *, with_ack=True):
    directory = tmp_path / "evidence"
    directory.mkdir()
    encoded = (ROOT / "data/fixtures/two-route-v1.json").read_bytes()
    (directory / "building.json").write_bytes(encoded)
    rows = [("decisions.jsonl", dict(operation="start", actor="tester", reason="new run"))]
    if with_ack:
        cmd = command()
        rows += [("commands.jsonl", dict(operation="issue", command=cmd, issued_monotonic_ms=10000,
                                          expires_at_monotonic_ms=13000)),
                 ("acks.jsonl", dict(operation="ack", outcome="accepted", payload=acknowledgement(cmd),
                                      verified=True, confirms_current=True, server_ack_elapsed_ms=20,
                                      received_monotonic_ms=10020, error_code=None))]
    rows.append(("decisions.jsonl", dict(operation="stop", actor="tester", reason="shutdown")))
    for name in FILES:
        write_records(directory, name, [dict(record, run_id=RUN, recorded_at=STAMP,
            server_monotonic_ms=10000 + index * 20, record_sequence=index + 1)
            for index, (category, record) in enumerate(rows) if category == name])
    write_json(directory / "manifest.json", dict(schema_version=1, run_id=RUN, building_id="TWO_ROUTE",
        building_version=1, building_sha256=hashlib.sha256(encoded).hexdigest(), started_at=STAMP,
        component="B04-test", code_commit=None, code_dirty=None, python_version="3.12.0", platform="test",
        closed=True, ended_at=STAMP, last_record_sequence=len(rows), end_reason="shutdown"))
    return directory


def assert_failed(report, filename):
    assert report["status"] == "FAIL", report
    assert any(error["file"] == filename and "line" in error for error in report["errors"]), report


def test_closed_run_reports_only_log_integrity_and_exact_input_hashes(tmp_path):
    directory = make_run(tmp_path)
    report = verify_run(directory)
    assert report["status"] == "PASS", report
    assert report["scope"] == "LOG_INTEGRITY"
    assert report["counts"]["commands_issued"] == 1
    assert report["counts"]["acks_applied"] == 1
    assert report["input_sha256"]["building.json"] == hashlib.sha256((directory / "building.json").read_bytes()).hexdigest()
    assert report["errors"] == []


def test_empty_command_and_ack_files_can_pass_without_claiming_application(tmp_path):
    report = verify_run(make_run(tmp_path, with_ack=False))
    assert report["status"] == "PASS", report
    assert report["counts"]["commands_issued"] == report["counts"]["acks_applied"] == 0


@pytest.mark.parametrize("damage", ["missing", "blank", "truncated", "nan", "encoding", "nonobject", "depth"])
def test_bad_jsonl_is_a_located_failure(tmp_path, damage):
    directory = make_run(tmp_path)
    path = directory / "acks.jsonl"
    if damage == "missing": path.unlink()
    elif damage == "blank": path.write_bytes(path.read_bytes() + b"\n")
    elif damage == "truncated": path.write_bytes(path.read_bytes()[:-1])
    elif damage == "nan": path.write_text('{"number":NaN}\n', encoding="utf-8")
    elif damage == "encoding": path.write_bytes(b"\xff\n")
    elif damage == "depth": path.write_text('{"x":' + '[' * 20000 + '0' + ']' * 20000 + '}\n', encoding="utf-8")
    else: path.write_text("[]\n", encoding="utf-8")
    assert_failed(verify_run(directory), "acks.jsonl")


@pytest.mark.parametrize("changes", [{"closed": False}, {"schema_version": 2}, {"end_reason": "reset"},
                                      {"last_record_sequence": 5}, {"building_id": "WRONG"},
                                      {"building_version": 2}, {"building_sha256": "0" * 64}])
def test_manifest_must_match_complete_run(tmp_path, changes):
    directory = make_run(tmp_path)
    path = directory / "manifest.json"
    write_json(path, json.loads(path.read_text(encoding="utf-8")) | changes)
    assert_failed(verify_run(directory), "manifest.json")


@pytest.mark.parametrize("field,value", [("record_sequence", 2), ("record_sequence", 10),
                                          ("run_id", TERMINAL), ("record_sequence", True),
                                          ("server_monotonic_ms", None)])
def test_mixed_run_and_illegal_record_sequences_fail(tmp_path, field, value):
    directory = make_run(tmp_path)
    rows = read_records(directory, "acks.jsonl")
    rows[0][field] = value
    write_records(directory, "acks.jsonl", rows)
    assert_failed(verify_run(directory), "acks.jsonl")


@pytest.mark.parametrize("field,value", [("verified", False), ("confirms_current", False),
                                          ("received_monotonic_ms", 13000), ("server_ack_elapsed_ms", -1)])
def test_accepted_ack_claims_and_deadline_are_independently_checked(tmp_path, field, value):
    directory = make_run(tmp_path)
    rows = read_records(directory, "acks.jsonl")
    rows[0][field] = value
    write_records(directory, "acks.jsonl", rows)
    assert_failed(verify_run(directory), "acks.jsonl")


@pytest.mark.parametrize("changes", [{"command_id": TERMINAL}, {"command_sequence": 2},
                                      {"faces": [{"face_id": "FRONT", "mode": "UNKNOWN", "display": None}]}])
def test_unissued_or_mismatched_applied_ack_fails(tmp_path, changes):
    directory = make_run(tmp_path)
    rows = read_records(directory, "acks.jsonl")
    rows[0]["payload"].update(changes)
    write_records(directory, "acks.jsonl", rows)
    assert_failed(verify_run(directory), "acks.jsonl")


def test_noncontiguous_command_sequence_fails(tmp_path):
    directory = make_run(tmp_path)
    rows = read_records(directory, "commands.jsonl")
    rows[0]["command"]["command_sequence"] = 2
    write_records(directory, "commands.jsonl", rows)
    assert_failed(verify_run(directory), "commands.jsonl")


def test_cli_writes_only_report_and_uses_failure_exit_status(tmp_path):
    directory = make_run(tmp_path)
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    result = subprocess.run([sys.executable, "-m", "tools.verify_run", str(directory)], cwd=ROOT, capture_output=True, encoding="utf-8")
    assert result.returncode == 0, result.stderr
    assert json.loads((directory / "verification.json").read_text(encoding="utf-8"))["status"] == "PASS"
    assert {name: (directory / name).read_bytes() for name in before} == before
    (directory / "commands.jsonl").unlink()
    result = subprocess.run([sys.executable, "-m", "tools.verify_run", str(directory)], cwd=ROOT, capture_output=True, encoding="utf-8")
    assert result.returncode == 1
    assert json.loads((directory / "verification.json").read_text(encoding="utf-8"))["status"] == "FAIL"


def append_before_stop(directory, category, record):
    decisions = read_records(directory, "decisions.jsonl")
    stop = decisions[-1]
    row = dict(record, run_id=RUN, recorded_at=STAMP, record_sequence=stop["record_sequence"],
               server_monotonic_ms=stop["server_monotonic_ms"])
    stop["record_sequence"] += 1
    stop["server_monotonic_ms"] += 20
    write_records(directory, "decisions.jsonl", decisions)
    write_records(directory, category, read_records(directory, category) + [row])
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["last_record_sequence"] += 1
    write_json(path, manifest)


def test_duplicate_ack_and_old_valid_ack_remain_distinct_from_current_confirmation(tmp_path):
    directory = make_run(tmp_path)
    original = read_records(directory, "acks.jsonl")[0]
    append_before_stop(directory, "acks.jsonl", original | {"outcome": "duplicate"})
    newer = command(2) | {"command_id": "00000000-0000-4000-8000-000000000004"}
    append_before_stop(directory, "commands.jsonl", dict(operation="issue", command=newer,
                       issued_monotonic_ms=10080, expires_at_monotonic_ms=13080))
    old_ack = original | {"payload": original["payload"] | {"terminal_instance_id": newer["command_id"]},
                          "confirms_current": False}
    append_before_stop(directory, "acks.jsonl", old_ack)
    report = verify_run(directory)
    assert report["status"] == "PASS", report
    assert report["counts"]["acks_accepted"] == 2
    assert report["counts"]["acks_duplicate"] == 1
    assert report["counts"]["acks_confirming_current"] == 2
    rows = read_records(directory, "acks.jsonl")
    rows[-1]["confirms_current"] = True
    write_records(directory, "acks.jsonl", rows)
    assert_failed(verify_run(directory), "acks.jsonl")


def test_conflicting_duplicate_ack_fails_even_if_faces_are_valid(tmp_path):
    directory = make_run(tmp_path)
    original = read_records(directory, "acks.jsonl")[0]
    append_before_stop(directory, "acks.jsonl", original | {"outcome": "duplicate",
        "payload": original["payload"] | {"client_apply_duration_ms": 9}})
    assert_failed(verify_run(directory), "acks.jsonl")


@pytest.mark.parametrize("category,operation", [("events.jsonl", "event"), ("events.jsonl", "/api/events"),
    ("acks.jsonl", "ack"), ("commands.jsonl", "command")])
def test_rejected_invalid_payload_is_valid_evidence(tmp_path, category, operation):
    directory = make_run(tmp_path)
    append_before_stop(directory, category, dict(operation=operation, outcome="rejected",
        payload={"invalid": {"invalid_number": "nan"}}, error_code="SCHEMA_VALIDATION_FAILED", field="schema_version"))
    report = verify_run(directory)
    assert report["status"] == "PASS", report
    assert report["counts"]["rejections"] == 1


def test_ack_record_time_can_follow_deadline_if_receipt_was_in_time(tmp_path):
    directory = make_run(tmp_path)
    rows = read_records(directory, "acks.jsonl")
    rows[0]["server_monotonic_ms"] = 15000
    write_records(directory, "acks.jsonl", rows)
    decisions = read_records(directory, "decisions.jsonl")
    decisions[-1]["server_monotonic_ms"] = 15000
    write_records(directory, "decisions.jsonl", decisions)
    assert verify_run(directory)["status"] == "PASS"


@pytest.mark.parametrize("value", [10 ** 400, {}, [], "100", True, -1])
def test_invalid_numeric_fields_fail_gracefully(tmp_path, value):
    directory = make_run(tmp_path)
    rows = read_records(directory, "acks.jsonl")
    rows[0]["server_monotonic_ms"] = value
    write_records(directory, "acks.jsonl", rows)
    assert_failed(verify_run(directory), "acks.jsonl")


def test_cli_invalid_arguments_exit_two(tmp_path):
    result = subprocess.run([sys.executable, "-m", "tools.verify_run"], cwd=ROOT, capture_output=True, encoding="utf-8")
    assert result.returncode == 2
    assert "Traceback" not in result.stderr


def recorded_controller_run(tmp_path):
    from backend.controller import Controller
    from backend.contracts import ContractError, parse_contract
    from test_observation_state import FakeClock, control, payload, prepare

    building = parse_contract("Building", json.loads((ROOT / "data/fixtures/two-route-v1.json").read_text(encoding="utf-8")))
    clock = FakeClock()
    store = Controller(building, tmp_path / "runs", clock=clock)
    prepare(store, clock)
    first = store.issue_command("SIGN-S").model_dump(mode="json")
    ack = acknowledgement(first)
    store.acknowledge("SIGN-S", ack)
    store.acknowledge("SIGN-S", ack)
    second = store.issue_command("SIGN-S").model_dump(mode="json")
    store.acknowledge("SIGN-S", ack)
    store.acknowledge("SIGN-S", acknowledgement(second))
    store.receive(payload(store, clock))
    store.acknowledge("SIGN-S", acknowledgement(second))
    with pytest.raises(ContractError): store.receive({"bad": "payload"})
    clock.advance(10000)
    store.expire()
    store.clear(control(store, source_id="CAM-A", hazard_type="FIRE"))
    directory = tmp_path / "runs" / store.run_id
    store.close()
    return directory


def test_real_controller_log_replays_observations_decisions_expiry_and_old_acks(tmp_path):
    report = verify_run(recorded_controller_run(tmp_path))
    assert report["status"] == "PASS", report
    assert report["counts"]["commands_issued"] == 2
    assert report["counts"]["acks_accepted"] == 2
    assert report["counts"]["acks_duplicate"] == 3
    assert report["counts"]["acks_confirming_current"] == 3
    assert report["counts"]["rejections"] == 1


@pytest.mark.parametrize("damage", ["sources", "guidance", "terminal_verified", "unissued_snapshot_command", "accepted_event", "application_status"])
def test_real_log_corruption_is_not_trusted_as_its_own_expected_result(tmp_path, damage):
    directory = recorded_controller_run(tmp_path)
    filename = "events.jsonl" if damage == "accepted_event" else "decisions.jsonl"
    records = read_records(directory, filename)
    if damage == "accepted_event":
        next(record for record in records if record["operation"] == "event")["payload"]["building_id"] = "WRONG"
    else:
        record = next(record for record in records if record["operation"] == "clear")
        if damage == "sources": record["sources"][0]["validity"] = "VALID"
        elif damage == "guidance": record["guidance_version"] += 1
        else:
            sign = next(sign for sign in record["signs"] if sign["sign_id"] == "SIGN-S")
            if damage == "terminal_verified": sign["terminals"][0]["verified"] = False
            elif damage == "application_status": sign["application_status"] = "PENDING"
            else: sign["latest_command"]["command_id"] = TERMINAL
    write_records(directory, filename, records)
    assert_failed(verify_run(directory), filename)


def test_reset_and_shutdown_finalize_distinct_verifiable_runs(tmp_path):
    from backend.controller import Controller
    from backend.contracts import parse_contract
    from test_observation_state import FakeClock, control

    building = parse_contract("Building", json.loads((ROOT / "data/fixtures/two-route-v1.json").read_text(encoding="utf-8")))
    store = Controller(building, tmp_path / "runs", clock=FakeClock())
    previous = store.run_id
    store.reset(control(store))
    current = store.run_id
    store.close()
    assert previous != current
    for run_id in (previous, current):
        report = verify_run(tmp_path / "runs" / run_id)
        assert report["status"] == "PASS", report

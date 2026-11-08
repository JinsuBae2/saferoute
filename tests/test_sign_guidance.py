"""B03 HTTP and state checks; ACKs are test clients, not observed browser rendering."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.app import create_app
from backend.contracts import parse_contract
from backend.controller import Controller
from test_observation_state import building, clock, controller, control, payload, prepare


def sign_state(controller, sign_id="SIGN-S"):
    return next(s for s in controller.snapshot().signs if s.sign_id == sign_id)


def displays(sign):
    return [(f.face_id, f.mode, f.display, f.next_node_id, f.exit_id) for f in sign.faces]


@pytest.fixture
def api(building, clock, tmp_path):
    app = create_app(building=building, runs_dir=tmp_path / "runs", clock=clock)
    with TestClient(app) as client:
        prepare(app.state.controller, clock)
        yield client, app.state.controller


def command(client, sign_id="SIGN-S"):
    response = client.get(f"/api/signs/{sign_id}/command")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    return response.json()


def ack(command, instance=None, **changes):
    return dict(schema_version=1, run_id=command["run_id"], sign_id=command["sign_id"],
                terminal_instance_id=instance or str(uuid4()), command_id=command["command_id"],
                command_sequence=command["command_sequence"], guidance_version=command["guidance_version"],
                status="APPLIED", faces=[{k: f[k] for k in ("face_id", "mode", "display")} for f in command["faces"]],
                client_apply_duration_ms=8, error_code=None) | changes


def post_ack(client, value, target=None):
    return client.post(f"/api/signs/{target or value['sign_id']}/ack", json=value)


def records(tmp_path, run_id, category):
    return [json.loads(line) for line in (tmp_path / "runs" / run_id / f"{category}.jsonl").read_text().splitlines()]


def test_faces_follow_readiness_route_and_view_direction(controller, clock):
    assert all(f.mode == "UNKNOWN" and f.reason_codes == ["INITIALIZING"] for s in controller.snapshot().signs for f in s.faces)
    prepare(controller, clock)
    assert displays(sign_state(controller)) == [("FRONT", "DEFAULT", "LEFT", "A", "EXIT-X"), ("REAR", "DEFAULT", "RIGHT", "A", "EXIT-X")]
    assert sign_state(controller).application_status == "NOT_ISSUED"
    controller.receive(payload(controller, clock))
    assert displays(sign_state(controller)) == [("FRONT", "DYNAMIC", "RIGHT", "B", "EXIT-Y"), ("REAR", "DYNAMIC", "LEFT", "B", "EXIT-Y")]
    assert displays(sign_state(controller, "SIGN-B")) == [("FRONT", "DYNAMIC", "FORWARD", "Y", "EXIT-Y")]
    controller.receive(payload(controller, clock, "DETECTOR-B", hazard="SMOKE", sequence=2))
    assert all(f.mode == "NO_ROUTE" and f.display is None and "NO_REACHABLE_EXIT" in f.reason_codes for f in sign_state(controller).faces)
    assert all(f.mode == "NO_ROUTE" and "ORIGIN_BLOCKED" in f.reason_codes for f in sign_state(controller, "SIGN-B").faces)


def test_stale_required_observations_remove_default_arrows(controller, clock):
    prepare(controller, clock)
    clock.advance(3000)
    controller.expire()
    assert all(f.mode == "UNKNOWN" and f.display is None and f.reason_codes == ["REQUIRED_OBSERVATION_UNKNOWN"] for s in controller.snapshot().signs for f in s.faces)


def test_missing_face_mapping_does_not_invent_a_direction(building, clock, tmp_path):
    data = building.model_dump(mode="json")
    del data["signs"][0]["faces"][0]["next_node_to_display"]["B"]
    store = Controller(parse_contract("Building", data), tmp_path / "runs", clock=clock)
    prepare(store, clock)
    store.receive(payload(store, clock))
    front, rear = sign_state(store).faces
    assert front.mode == "NO_ROUTE" and front.display is None and front.reason_codes == ["UNSUPPORTED_DISPLAY"]
    assert rear.mode == "DYNAMIC" and rear.display == "LEFT"


def test_exit_face_has_exit_display_and_no_next_node(building, clock, tmp_path):
    data = building.model_dump(mode="json")
    data["signs"].append(dict(sign_id="SIGN-X", node_id="X", faces=[dict(face_id="FRONT", view_direction=dict(x=0,y=0,z=-1), default_next_node_id="X", next_node_to_display={"X":"EXIT"})]))
    store = Controller(parse_contract("Building", data), tmp_path / "runs", clock=clock)
    prepare(store, clock)
    assert displays(sign_state(store, "SIGN-X")) == [("FRONT", "DEFAULT", "EXIT", None, "EXIT-X")]


def test_commands_renew_per_sign_without_marking_application(api):
    client, store = api
    first, second, other = command(client), command(client), command(client, "SIGN-B")
    assert (first["command_sequence"], second["command_sequence"], other["command_sequence"]) == (1, 2, 1)
    assert len({first["command_id"], second["command_id"], other["command_id"]}) == 3
    assert first["guidance_version"] == second["guidance_version"] == other["guidance_version"]
    assert second["valid_for_ms"] == 3000
    for sign in store.snapshot().signs:
        assert sign.application_status == "PENDING" and not sign.terminals
        assert sign.faces == sign.latest_command.faces
        parse_contract("SignCommand", sign.latest_command.model_dump(mode="json"))


def test_two_signs_have_independent_acknowledged_state(api):
    client, store = api
    first, other = command(client), command(client, "SIGN-B")
    response = post_ack(client, ack(first))
    assert response.status_code == 200 and response.json()["application_status"] == "APPLIED"
    assert sign_state(store, "SIGN-B").application_status == "PENDING"
    assert post_ack(client, ack(other, status="REJECTED", faces=[], client_apply_duration_ms=None, error_code="DISPLAY_FAILED")).status_code == 200
    assert sign_state(store, "SIGN-B").application_status == "REJECTED"
    assert sign_state(store).application_status == "APPLIED"


def test_old_ack_neither_confirms_new_command_nor_replaces_newer_ack(api):
    client, store = api
    instance = str(uuid4())
    first, second = command(client), command(client)
    old, new = ack(first, instance), ack(second, instance)
    assert post_ack(client, old).json()["application_status"] == "PENDING"
    assert post_ack(client, new).json()["application_status"] == "APPLIED"
    assert post_ack(client, old).status_code == 200
    state = sign_state(store)
    assert state.application_status == "APPLIED"
    assert state.terminals[0].last_ack.command_id == second["command_id"]


def test_guidance_change_invalidates_application_before_next_poll(api, clock):
    client, store = api
    value = ack(command(client))
    assert post_ack(client, value).json()["application_status"] == "APPLIED"
    store.receive(payload(store, clock))
    state = sign_state(store)
    assert state.application_status == "PENDING" and state.faces[0].display == "RIGHT"
    assert state.latest_command.guidance_version < store.snapshot().guidance_version
    assert post_ack(client, value).json()["application_status"] == "PENDING"


@pytest.mark.parametrize("changes,code", [
    ({"run_id":str(uuid4())}, "RUN_MISMATCH"),
    ({"command_id":str(uuid4())}, "COMMAND_MISMATCH"),
    ({"command_sequence":99}, "COMMAND_MISMATCH"),
    ({"guidance_version":99}, "COMMAND_MISMATCH"),
    ({"sign_id":"SIGN-B"}, "COMMAND_MISMATCH"),
    ({"faces":[{"face_id":"FRONT","mode":"DEFAULT","display":"RIGHT"}]}, "COMMAND_MISMATCH"),
    ({"extra":"unexpected"}, "SCHEMA_VALIDATION_FAILED"),
])
def test_invalid_ack_is_logged_but_never_applied(api, tmp_path, changes, code):
    client, store = api
    value = ack(command(client), **changes)
    response = post_ack(client, value, "SIGN-S")
    assert response.status_code == (422 if code == "SCHEMA_VALIDATION_FAILED" else 409)
    assert response.json()["error"]["code"] == code
    assert sign_state(store).application_status == "PENDING" and not sign_state(store).terminals
    assert records(tmp_path, store.run_id, "acks")[-1]["error_code"] == code


def test_unknown_sign_and_unknown_command_do_not_create_state(api):
    client, store = api
    assert client.get("/api/signs/MISSING/command").json()["error"]["code"] == "UNKNOWN_SIGN"
    value = ack(command(client), sign_id="MISSING")
    assert post_ack(client, value).status_code == 404
    assert all(s.sign_id != "MISSING" for s in store.snapshot().signs)


def test_command_expiry_uses_monotonic_time_and_rejects_boundary_ack(api, clock, tmp_path):
    client, store = api
    value = ack(command(client))
    assert post_ack(client, value).json()["application_status"] == "APPLIED"
    clock.wall -= timedelta(hours=1)
    clock.mono += 2999
    assert sign_state(store).application_status == "APPLIED"
    clock.mono += 1
    store.expire()
    assert sign_state(store).application_status == "EXPIRED"
    response = post_ack(client, value)
    assert response.status_code == 409 and response.json()["error"]["code"] == "COMMAND_EXPIRED"
    assert records(tmp_path, store.run_id, "acks")[-1]["error_code"] == "COMMAND_EXPIRED"


def test_duplicate_instances_remain_visible_even_with_old_valid_command(api):
    client, store = api
    first, second = command(client), command(client)
    assert post_ack(client, ack(second)).json()["application_status"] == "APPLIED"
    assert post_ack(client, ack(first)).json()["application_status"] == "DUPLICATE_TERMINAL"
    assert len(sign_state(store).terminals) == 2


def test_duplicate_ack_is_idempotent_and_conflicting_ack_is_rejected(api, clock, tmp_path):
    client, store = api
    value = ack(command(client))
    assert post_ack(client, value).status_code == 200
    received = sign_state(store).terminals[0].received_at
    clock.advance(5)
    assert post_ack(client, value).status_code == 200
    assert sign_state(store).terminals[0].received_at == received
    conflict = dict(value, status="REJECTED", faces=[], client_apply_duration_ms=None, error_code="DISPLAY_FAILED")
    response = post_ack(client, conflict)
    assert response.status_code == 409 and response.json()["error"]["code"] == "COMMAND_MISMATCH"
    assert sign_state(store).application_status == "APPLIED"
    assert records(tmp_path, store.run_id, "acks")[-2]["outcome"] == "duplicate"


def test_reset_rejects_previous_ack_and_starts_new_command_sequence(api, tmp_path):
    client, store = api
    old = command(client)
    value = ack(old)
    post_ack(client, value)
    store.reset(control(store))
    assert post_ack(client, value).json()["error"]["code"] == "RUN_MISMATCH"
    new = command(client)
    assert new["run_id"] != old["run_id"] and new["command_sequence"] == 1
    assert all(f["mode"] == "UNKNOWN" for f in new["faces"])
    assert sign_state(store).terminals == []
    assert records(tmp_path, old["run_id"], "commands")[0]["command"]["command_id"] == old["command_id"]


def test_event_decision_command_ack_are_linked_in_run_logs(api, clock, tmp_path):
    client, store = api
    event = payload(store, clock)
    store.receive(event)
    issued = command(client)
    clock.advance(12)
    assert post_ack(client, ack(issued)).status_code == 200
    event_log = records(tmp_path, store.run_id, "events")[-1]
    decision = records(tmp_path, store.run_id, "decisions")[-1]
    command_log = records(tmp_path, store.run_id, "commands")[-1]
    ack_log = records(tmp_path, store.run_id, "acks")[-1]
    assert event_log["payload"]["event_id"] == decision["event_id"] == event["event_id"]
    assert decision["guidance_version"] == command_log["command"]["guidance_version"] == issued["guidance_version"]
    assert decision["signs"][0]["faces"] == issued["faces"]
    assert command_log["command"]["command_id"] == ack_log["payload"]["command_id"]
    assert ack_log["verified"] and ack_log["confirms_current"] and ack_log["server_ack_elapsed_ms"] == 12
    assert all(row["run_id"] == store.run_id for row in (event_log, decision, command_log, ack_log))


@pytest.mark.parametrize("category", ["commands", "acks"])
def test_audit_write_failure_never_reports_success(api, monkeypatch, category):
    client, store = api
    issued = command(client)
    write = store.audit.write
    def fail(run_id, target, record):
        if target == category: raise OSError("disk unavailable")
        return write(run_id, target, record)
    monkeypatch.setattr(store.audit, "write", fail)
    response = client.get("/api/signs/SIGN-S/command") if category == "commands" else post_ack(client, ack(issued))
    assert response.status_code == 503
    assert client.get("/api/state").status_code == 503


def test_concurrent_polls_have_unique_order_and_reversed_acks_do_not_regress(api):
    client, store = api
    with ThreadPoolExecutor(max_workers=4) as pool:
        issued = list(pool.map(lambda _: command(client), range(12)))
    assert sorted(c["command_sequence"] for c in issued) == list(range(1, 13))
    assert len({c["command_id"] for c in issued}) == 12
    instance = str(uuid4())
    for item in sorted(issued, key=lambda c: c["command_sequence"], reverse=True):
        assert post_ack(client, ack(item, instance)).status_code == 200
    state = sign_state(store)
    assert state.application_status == "APPLIED" and state.terminals[0].last_ack.command_sequence == 12


def delay_log_once(store, clock, monkeypatch, category, milliseconds):
    write = store.audit.write
    delayed = False
    def slow_write(run_id, target, record):
        nonlocal delayed
        write(run_id, target, record)
        if target == category and not delayed:
            delayed = True
            clock.advance(milliseconds)
    monkeypatch.setattr(store.audit, "write", slow_write)


def test_ack_response_rechecks_observations_after_log_io(api, clock, monkeypatch):
    client, store = api
    clock.advance(2990)
    issued = command(client)
    delay_log_once(store, clock, monkeypatch, "acks", 20)
    response = post_ack(client, ack(issued))
    assert response.status_code == 200
    assert response.json()["application_status"] == "PENDING"
    assert all(f["mode"] == "UNKNOWN" for f in response.json()["faces"])


@pytest.mark.parametrize("advance,delay,code", [(2990,20,"COMMAND_MISMATCH"), (0,3000,"COMMAND_EXPIRED")])
def test_command_changed_or_expired_during_log_io_is_not_delivered(api, clock, monkeypatch, tmp_path, advance, delay, code):
    client, store = api
    clock.advance(advance)
    delay_log_once(store, clock, monkeypatch, "commands", delay)
    response = client.get("/api/signs/SIGN-S/command")
    assert response.status_code == 409 and response.json()["error"]["code"] == code
    assert records(tmp_path, store.run_id, "commands")[-1]["outcome"] == "discarded"
    assert all(f["mode"] == "UNKNOWN" for f in command(client)["faces"])

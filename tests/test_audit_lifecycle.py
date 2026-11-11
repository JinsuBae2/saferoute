import hashlib
import json

import pytest

from backend.contracts import ContractError
from test_observation_state import building, clock, controller, control


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_close_seals_run_and_rejects_further_use(controller):
    run = controller.run_id
    directory = controller.audit.root / run
    assert read(directory / "manifest.json")["closed"] is False
    controller.close()
    controller.close()
    manifest = read(directory / "manifest.json")
    assert manifest["closed"] is True
    assert manifest["end_reason"] == "shutdown"
    assert manifest["last_record_sequence"] == 2
    assert manifest["building_sha256"] == hashlib.sha256((directory / "building.json").read_bytes()).hexdigest()
    assert all((directory / f"{category}.jsonl").exists() for category in ("events", "decisions", "commands", "acks"))
    with pytest.raises(ContractError): controller.session()


def test_reset_seals_old_run_and_opens_clean_initializing_run(controller):
    old = controller.run_id
    controller.reset(control(controller))
    assert controller.run_id != old
    assert controller.session().controller_mode == "INITIALIZING"
    old_manifest = read(controller.audit.root / old / "manifest.json")
    assert old_manifest["closed"] and old_manifest["end_reason"] == "reset"
    assert old_manifest["last_record_sequence"] == 3
    assert not read(controller.audit.root / controller.run_id / "manifest.json")["closed"]


def test_restart_uses_new_run_and_preserves_unfinished_evidence(controller, clock):
    from backend.controller import Controller
    from tools.verify_run import verify_run
    old = controller.run_id
    directory = controller.audit.root / old
    before = {path.name:path.read_bytes() for path in directory.iterdir()}
    restarted = Controller(controller.building,controller.audit.root,clock=clock)
    assert restarted.run_id != old
    assert restarted.session().controller_mode == "INITIALIZING"
    assert before == {path.name:path.read_bytes() for path in directory.iterdir()}
    assert verify_run(directory)["status"] == "FAIL"
    restarted.close()
    assert verify_run(restarted.audit.root / restarted.run_id)["status"] == "PASS"

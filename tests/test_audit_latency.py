import json
import os
import re
import time

import pytest

from test_observation_state import building, clock, controller


@pytest.mark.parametrize("fails", [False, True])
def test_slow_fsync_is_measured_without_losing_durability_or_leaking_payload(controller, monkeypatch, caplog, fails):
    audit, run_id = controller.audit, controller.run_id
    before = audit.sequences[run_id]
    original = os.fsync

    def slow_fsync(fd):
        time.sleep(.26)
        if fails: raise OSError("test disk failure")
        return original(fd)

    with monkeypatch.context() as patch:
        patch.setattr(os, "fsync", slow_fsync)
        if fails:
            with pytest.raises(OSError, match="test disk failure"):
                audit.write(run_id, "events", {"private_payload": "do-not-log-this"})
        else:
            audit.write(run_id, "events", {"private_payload": "do-not-log-this"})
    messages = [record.message for record in caplog.records if "slow_audit_write" in record.message]
    assert len(messages) == 1
    message = messages[0]
    assert run_id in message and "category=events" in message
    assert "do-not-log-this" not in message and "private_payload" not in message
    assert float(re.search(r"fsync_ms=([\d.]+)", message)[1]) >= 250
    assert "serialize_ms=" in message and "write_flush_ms=" in message and "thread_cpu_ms=" in message
    assert audit.sequences[run_id] == before + (0 if fails else 1)
    if not fails:
        last = json.loads((audit.root / run_id / "events.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        assert last == {"private_payload": "do-not-log-this", "record_sequence": before + 1}

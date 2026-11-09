"""Failure and identity gates; provider fixtures are not actual Bedrock evidence."""

from concurrent.futures import Future
import copy
from datetime import timedelta
import json
from threading import Event

from fastapi.testclient import TestClient
import pytest

from explanation_worker.app import create_app
from explanation_worker.bedrock import Bedrock, OUTPUT_SCHEMA, PROMPT_VERSION, parse_response
from explanation_worker.config import ExplanationConfig
from explanation_worker.facts import extract_basis
from explanation_worker.journal import Journal
from explanation_worker.service import Service
from test_observation_state import building, clock, controller, control, payload, prepare
from test_sign_guidance import ack


class MemoryJournal:
    def __init__(self): self.records = []
    def write(self, record): self.records.append(copy.deepcopy(record))
    def close(self): pass


class ManualExecutor:
    def __init__(self): self.calls = []
    def submit(self, function, basis):
        future = Future()
        self.calls.append((future, basis))
        return future
    def shutdown(self, wait): pass


def response(text=None, refs=None):
    return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
        {"text": text or json.dumps({"summary": "현재 제어 모드는 NORMAL입니다.", "fact_refs": refs or ["mode"]})},
    ]}}, "usage": {"inputTokens": 100, "outputTokens": 30, "totalTokens": 130}}


@pytest.fixture
def service(clock):
    value = Service(ExplanationConfig(), lambda _: response(), MemoryJournal(),
                    utcnow=clock.utcnow, monotonic=lambda: clock.monotonic_ms() / 1000)
    value.executor.shutdown()
    value.executor = ManualExecutor()
    return value


def finish(service, clock, result=None, error=None):
    service.flight["future"].set_result((result or response(), error, clock.utcnow(), clock.monotonic_ms() / 1000))


def test_ready_reuse_identity_and_expiry_are_based_on_original_snapshot(controller, clock, service):
    prepare(controller, clock)
    basis = controller.snapshot()
    assert service.tick(basis).status == "PENDING"
    clock.advance(400)
    finish(service, clock)
    ready = service.tick(controller.snapshot())
    assert ready.status == "READY"
    assert ready.basis_generated_at == basis.generated_at
    assert ready.expires_at == (clock.utcnow() + timedelta(seconds=14.6)).isoformat().replace("+00:00", "Z")
    assert service.tick(controller.snapshot()) == ready
    assert len(service.executor.calls) == 1
    assert [r["outcome"] for r in service.journal.records] == ["requested", "accepted"]
    assert service.journal.records[-1]["usage"]["outputTokens"] == 30
    # Same identity, fresh snapshot: expiry does not slide on each read.
    clock.advance(15000)
    assert service.tick(basis).error_code == "STALE_BASIS"
    assert service.result is None


@pytest.mark.parametrize("change", ["run_id", "building_id", "building_version", "guidance_version", "disconnect"])
def test_old_identity_or_lost_session_cannot_adopt_response(controller, clock, service, change):
    state = controller.snapshot()
    service.tick(state)
    clock.advance(100)
    finish(service, clock)
    if change == "disconnect": service.disconnected()
    else:
        state = state.model_copy(deep=True)
        setattr(state, change, {"run_id": "22222222-2222-4222-8222-222222222222", "building_id": "NEW",
                               "building_version": 2, "guidance_version": 1}[change])
    assert service.tick(state).error_code == "STALE_BASIS"
    assert service.result is None
    assert service.journal.records[-1]["outcome"] == "discarded"


def test_timeout_keeps_one_flight_and_never_adopts_late_result(controller, clock, service):
    service.tick(controller.snapshot())
    clock.advance(5000)
    assert service.tick(controller.snapshot()).error_code == "BEDROCK_UNAVAILABLE"
    clock.advance(5000)
    assert service.tick(controller.snapshot()).status == "UNAVAILABLE"
    assert len(service.executor.calls) == 1
    finish(service, clock)
    assert service.tick(controller.snapshot()).error_code == "BEDROCK_UNAVAILABLE"
    assert service.result is None
    assert [r["outcome"] for r in service.journal.records] == ["requested", "timeout", "discarded"]
    service.tick(controller.snapshot())
    assert len(service.executor.calls) == 2


@pytest.mark.parametrize("bad", [response("not JSON"), response(refs=["route:INVENTED"]),
    response('{"summary":"내용","fact_refs":["mode"],"run_id":"new"}'),
    response('{"summary":" ","fact_refs":["mode"]}'),
    response('{"summary":"내용","fact_refs":["mode","mode"]}'),
    response() | {"stopReason": "max_tokens"}])
def test_invalid_output_is_hidden_and_rate_limited(controller, clock, service, bad):
    service.tick(controller.snapshot())
    clock.advance(100)
    finish(service, clock, bad)
    assert service.tick(controller.snapshot()).error_code == "INVALID_RESPONSE"
    clock.advance(100)
    assert service.tick(controller.snapshot()).error_code == "INVALID_RESPONSE"
    assert len(service.executor.calls) == 1


@pytest.mark.parametrize("error", ["AccessDeniedException", "ThrottlingException"])
def test_provider_errors_are_unavailable(controller, clock, service, error):
    service.tick(controller.snapshot())
    clock.advance(100)
    finish(service, clock, error=error)
    value = service.tick(controller.snapshot())
    assert value.summary is None and value.error_code == "BEDROCK_UNAVAILABLE"


@pytest.mark.parametrize("stage", ["requested", "accepted"])
def test_log_failure_latches_unavailable_without_more_calls(controller, clock, service, stage):
    def fail(_): raise OSError("disk full")
    if stage == "accepted":
        service.tick(controller.snapshot())
        clock.advance(100)
        finish(service, clock)
    service.journal.write = fail
    assert service.tick(controller.snapshot()).error_code == "EXPLANATION_LOG_ERROR"
    clock.advance(6000)
    assert service.tick(controller.snapshot()).error_code == "EXPLANATION_LOG_ERROR"
    assert len(service.executor.calls) == (1 if stage == "accepted" else 0)


def test_future_basis_and_disabled_do_not_call(controller, clock, service):
    state = controller.snapshot()
    state.generated_at = (clock.utcnow() + timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
    assert service.tick(state).error_code == "STALE_BASIS"
    service.config = ExplanationConfig(enabled=False)
    assert service.tick(controller.snapshot()).error_code == "DISABLED"
    assert not service.executor.calls


def test_expiry_during_log_write_cannot_publish_ready(controller, clock, service):
    service.tick(controller.snapshot())
    clock.advance(100)
    finish(service, clock)
    state = controller.snapshot()
    service.journal.write = lambda _: clock.advance(15000)
    assert service.tick(state).error_code == "STALE_BASIS"
    assert service.result is None


def test_journal_appends_and_excludes_second_writer(tmp_path):
    journal = Journal(tmp_path)
    with pytest.raises(FileExistsError): Journal(tmp_path)
    record = {"basis": {"run_id": "test"}, "outcome": "requested"}
    journal.write(record)
    journal.close()
    journal = Journal(tmp_path)
    journal.write(record | {"outcome": "discarded"})
    journal.close()
    lines = (tmp_path / "test/explanations.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2


def test_partial_log_after_crash_is_preserved_and_not_appended(tmp_path):
    journal = Journal(tmp_path)
    folder = tmp_path / "test"
    folder.mkdir()
    path = folder / "explanations.jsonl"
    path.write_bytes(b'{"partial":')
    with pytest.raises(OSError): journal.write({"basis": {"run_id": "test"}})
    assert path.read_bytes() == b'{"partial":'
    journal.close()


def test_probe_kills_its_own_unresponsive_ai_before_other_cleanup():
    import subprocess
    from tools.validate_explanation import stop_ai
    class Process:
        def __init__(self): self.calls = []
        def poll(self): return None
        def terminate(self): self.calls.append("terminate")
        def kill(self): self.calls.append("kill")
        def wait(self, timeout):
            self.calls.append(timeout)
            if timeout == 10: raise subprocess.TimeoutExpired("own-ai", timeout)
    process = Process()
    stop_ai(process)
    assert process.calls == ["terminate", 10, "kill", 5]


def test_api_is_read_only_and_controller_commands_continue_during_hung_provider(controller, clock):
    prepare(controller, clock)
    entered, release = Event(), Event()
    def slow(_):
        entered.set()
        if not release.wait(5): raise TimeoutError()
        return response()
    async def read(): return controller.snapshot().model_dump(mode="json")
    app = create_app(config=ExplanationConfig(), provider=slow, journal=MemoryJournal(), read_state=read)
    with TestClient(app) as client:
        try:
            assert client.get("/api/explanations/current").status_code == 200
            # API uses real UTC; use a current snapshot timestamp for this HTTP test.
            from datetime import datetime, timezone
            clock.wall = datetime.now(timezone.utc)
            assert client.get("/api/explanations/current").json()["status"] == "PENDING"
            assert entered.wait(1)
            controller.receive(payload(controller, clock))
            command = controller.issue_command("SIGN-S")
            assert command.faces[0].next_node_id == "B"
            controller.acknowledge("SIGN-S", ack(command.model_dump(mode="json")))
            assert next(s for s in controller.snapshot().signs if s.sign_id == "SIGN-S").application_status == "APPLIED"
            result = client.get("/api/explanations/current")
            assert result.headers["Cache-Control"] == "no-store"
            assert "X-Explanation-Server-Time" in result.headers
            assert result.json()["status"] != "READY"
            assert client.post("/api/events", json={}).status_code == 404
            async def disconnected(): raise TimeoutError()
            # A separate app with a failed reader must never serve a prior result.
            other = create_app(config=ExplanationConfig(), provider=slow, journal=MemoryJournal(), read_state=disconnected)
            with TestClient(other) as missing:
                assert missing.get("/api/explanations/current").status_code == 503
        finally:
            release.set()


def test_parse_response_uses_only_allowed_facts(controller):
    assert parse_response(response(), extract_basis(controller.snapshot())).fact_refs == ["mode"]


def test_converse_call_contains_only_facts_and_bounded_fixed_schema(controller):
    calls = []
    class Client:
        def converse(self, **kwargs): calls.append(kwargs); return response()
    provider = object.__new__(Bedrock)
    provider.config = ExplanationConfig()
    provider.client = Client()
    basis = extract_basis(controller.snapshot())
    provider(basis)
    sent = calls[0]
    assert sent["modelId"] == provider.config.model_id
    assert sent["inferenceConfig"] == {"maxTokens": 512, "temperature": 0}
    assert json.loads(sent["messages"][0]["content"][0]["text"]) == basis
    assert json.loads(sent["outputConfig"]["textFormat"]["structure"]["jsonSchema"]["schema"]) == OUTPUT_SCHEMA
    assert PROMPT_VERSION == "a05-v2"


@pytest.mark.parametrize("setting", [{"timeout_seconds": 6}, {"min_interval_seconds": 1},
    {"max_tokens": 513}, {"ttl_seconds": 16}, {"controller_url": "http://user:secret@localhost:8000"}])
def test_config_bounds(setting):
    with pytest.raises(ValueError): ExplanationConfig(**setting)

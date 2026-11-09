"""Run the operator entry points, including their error exit codes."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
BUILDING = ROOT / "data/fixtures/two-route-v1.json"
SCENARIO = ROOT / "data/scenarios/two-route-smoke.runtime.json"


def cli(module, *arguments):
    return subprocess.run([sys.executable, "-X", "warn_default_encoding", "-W", "error::EncodingWarning",
                           "-m", module, *map(str, arguments)], cwd=ROOT,
                          capture_output=True, encoding="utf-8", timeout=10)


def test_config_cli_accepts_executable_fixture():
    result = cli("tools.validate_config", "--building", BUILDING, "--scenario", SCENARIO)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["scenario_id"] == "two-route-smoke-v1"


@pytest.mark.parametrize("change", ["version", "source", "video", "zone", "duplicate", "threshold", "initial", "fault"])
def test_config_cli_rejects_bad_scenario_without_traceback(tmp_path, change):
    data = json.loads(SCENARIO.read_text(encoding="utf-8"))
    if change == "version": data["building_version"] = 999
    if change == "source": data["observation_rules"][0]["source_id"] = "MISSING"
    if change == "video": data["observation_rules"][0]["source_id"] = "CAM-A"
    if change == "zone": data["smoke_timeline"][0]["zone_id"] = "MISSING"
    if change == "duplicate": data["smoke_timeline"].append(data["smoke_timeline"][0])
    if change == "threshold": data["observation_rules"][0]["threshold"] = 2
    if change == "initial": data["initial_observations"] = []
    if change == "fault": data["faults"] = [{"source_id":"DETECTOR-A", "kind":"DROP", "start_ms":1000, "end_ms":500, "delay_ms":0}]
    path = tmp_path / "scenario.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    result = cli("tools.validate_config", "--building", BUILDING, "--scenario", path)
    assert result.returncode == 2
    assert "Traceback" not in result.stderr


def test_config_cli_rejects_malformed_file(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{", encoding="utf-8")
    result = cli("tools.validate_config", "--building", path)
    assert result.returncode == 2 and "Traceback" not in result.stderr


def test_control_requires_explicit_run_and_reason():
    result = cli("tools.control", "reset")
    assert result.returncode == 2 and "--run-id" in result.stderr


def test_control_never_rewrites_an_old_event(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text('{"event_kind":"ALARM"}', encoding="utf-8")
    result = cli("tools.control", "event", "--file", path)
    assert result.returncode == 2 and "Traceback" not in result.stderr

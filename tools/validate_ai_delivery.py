"""A01 actual-model development probe against its own loopback TWO_ROUTE controller.

Run with the AI Python environment. This does not certify WFI, browsers, deployment,
independent accuracy, or delivery across machines. No existing server is contacted.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

import httpx
import uvicorn

from backend.app import create_app
from backend.contracts.building import Building
from .validate_ai_model import verify_file

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ("dev-flameless-candle", "dev-candle-match", "dev-smoke-0009")


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def check(condition, message):
    if not condition:
        raise ValueError(message)


def check_observation_freshness(ages, gaps, freshness_ms, source_expirations=0):
    spans = [age + gap for age, gap in zip(ages, gaps)]
    check(source_expirations == 0 and ages and len(gaps) == len(ages) - 1 and
          all(0 <= age < freshness_ms for age in ages) and
          all(gap >= 0 for gap in gaps) and
          all(span < freshness_ms for span in spans),
          "source expired or observation age plus following gap exceeded freshness")
    return max(spans, default=None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory")
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/manifests/assets.json")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    assets = [next(a for a in manifest["videos"] if a["asset_id"] == key) for key in ASSETS]
    for asset in assets:
        check(asset["split"] == "development", "only development clips are allowed")
        verify_file(ROOT / asset["path"], asset["sha256"])
    building = Building.model_validate_json((ROOT / "data/fixtures/two-route-v1.json").read_bytes())
    freshness_ms = next(s.freshness_ms for s in building.sources if s.source_id == "CAM-A")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(building=building, runs_dir=out / "backend"), log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    results = []
    report = dict(scope="DEVELOPMENT_LOOPBACK_DELIVERY", building_id="TWO_ROUTE", building_version=1,
                  freshness_ms=freshness_ms, videos=results, status="FAILED",
                  manifest_sha256=hashlib.sha256(args.manifest.read_bytes()).hexdigest())
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(.05)
        check(server.started, "isolated controller did not start")
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as client:
            for asset in assets:
                name = Path(asset["path"]).name
                session = client.get("/api/session")
                session.raise_for_status()
                run_id = session.json()["run_id"]
                result = dict(video=name, asset_id=asset["asset_id"], video_sha256=asset["sha256"],
                              run_id=run_id, status="FAILED")
                results.append(result)
                command = [sys.executable, "-m", "ai_worker", "--config", "configs/ai.example.json",
                           "--video", str(ROOT / asset["path"]), "--controller", str(client.base_url),
                           "--runs-dir", str(out / "ai")]
                completed = subprocess.run(command, cwd=ROOT, env=os.environ | {"PYTHONUTF8": "1"},
                                           capture_output=True, encoding="utf-8", timeout=240)
                (out / (name + ".console.txt")).write_text(completed.stdout + completed.stderr, encoding="utf-8")
                result["exit_code"] = completed.returncode
                state_response = client.get("/api/state")
                state_response.raise_for_status()
                state = state_response.json()
                (out / (name + ".state.json")).write_text(json.dumps(state, indent=2), encoding="utf-8")
                reset = client.post("/api/control/reset", json=dict(schema_version=1, run_id=run_id,
                                    reason="A01 isolated development delivery probe complete"))
                reset.raise_for_status()
                predictions_path = out / "ai" / run_id / "ai-predictions.jsonl"
                records = rows(predictions_path)
                received_rows = [r for r in rows(out / "backend" / run_id / "events.jsonl")
                                 if r["operation"] == "event" and r["outcome"] == "accepted"]
                transmitted = {r["event"]["event_id"]: r["event"] for r in records if r["operation"] == "send_attempt"}
                received = {r["payload"]["event_id"]: r["payload"] for r in received_rows}
                frames = [r for r in records if r["operation"] == "prediction"]
                observations = [r for r in received_rows if r["payload"]["event_kind"] in {"ALARM", "OBSERVATION"}]
                ages = [(datetime.fromisoformat(r["recorded_at"]) -
                         datetime.fromisoformat(r["payload"]["observed_at"])).total_seconds()*1000
                        for r in observations]
                gaps = [b["server_monotonic_ms"]-a["server_monotonic_ms"]
                        for a, b in zip(observations, observations[1:])]
                alarms = Counter(r["payload"]["hazard_type"] for r in observations if r["payload"]["event_kind"] == "ALARM")
                terminal = [e for e in transmitted.values() if e["event_kind"] == "UNAVAILABLE"]
                result.update(analyzed_frames=len(frames), accepted_events=len(received_rows), alarms=dict(alarms),
                              max_acquisition_to_audit_ms=max(ages, default=None),
                              max_observation_audit_gap_ms=max(gaps, default=None),
                              payload_match=bool(transmitted) and transmitted == received,
                              termination=[e["reason_code"] for e in terminal],
                              worker_result=next((r["result"] for r in records if r["operation"] == "finished"), None),
                              predictions_sha256=hashlib.sha256(predictions_path.read_bytes()).hexdigest(),
                              source_validity=next(s["validity"] for s in state["sources"] if s["source_id"] == "CAM-A"),
                              active_hazards=sorted({c["hazard_type"] for c in state["active_causes"]}))
                check(completed.returncode == 0 and result["worker_result"] is not None, "actual worker did not finish")
                check(result["payload_match"] and result["termination"] == ["EOF"], "delivery payload/EOF mismatch")
                check(result["source_validity"] == "UNAVAILABLE", "EOF must not leave source VALID")
                check(set(result["active_hazards"]) == set(alarms), "EOF changed accumulated alarm causes")
                result["source_expirations"] = sum(
                    r["operation"] == "expire" and "CAM-A" in r.get("source_ids", [])
                    for r in rows(out / "backend" / run_id / "decisions.jsonl"))
                result["max_age_plus_following_gap_ms"] = check_observation_freshness(
                    ages, gaps, freshness_ms, result["source_expirations"])
                integrity = subprocess.run([sys.executable, "-m", "tools.verify_run", str(out / "backend" / run_id)],
                                           cwd=ROOT, capture_output=True, encoding="utf-8", timeout=30)
                result["log_integrity"] = integrity.returncode == 0
                check(result["log_integrity"], "controller log integrity failed")
                result["status"] = "PASS"
                print(json.dumps(result), flush=True)
        check(any(r["alarms"].get("FIRE") for r in results) and any(r["alarms"].get("SMOKE") for r in results),
              "both actual alarm classes were not observed in development clips")
        report["status"] = "PASS"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        print(report["error"], file=sys.stderr)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
        report["controller_stopped"] = not thread.is_alive()
        if thread.is_alive():
            report["status"] = "FAILED"
        (out / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Explicit billable development probe using its own loopback controller and API.

Requires the explanation environment and a separate AI Python/video/config.
This records actual responses for independent V15 review; it does not grade prose.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from uuid import uuid4

import httpx
import uvicorn

from explanation_worker.config import ExplanationConfig

ROOT = Path(__file__).resolve().parents[1]


def serve(kind, sock, root, controller_url):
    if kind == "controller":
        from backend.app import create_app
        app = create_app(runs_dir=Path(root))
    else:
        from explanation_worker.app import create_app
        from explanation_worker.journal import Journal
        app = create_app(config=ExplanationConfig(controller_url=controller_url), journal=Journal(root))
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])


def launch(kind, root, controller_url=""):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    process = multiprocessing.get_context("spawn").Process(target=serve, args=(kind, sock, str(root), controller_url))
    process.start()
    sock.close()
    return process, f"http://127.0.0.1:{port}"


def wait_for(function, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = function()
            if value: return value
        except httpx.HTTPError:
            pass
        time.sleep(.1)
    raise RuntimeError("probe condition did not become true before deadline")


def stop_ai(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ai-python", type=Path, required=True)
    parser.add_argument("--ai-config", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True, help="Development candle/match clip")
    parser.add_argument("--video-sha256", required=True)
    args = parser.parse_args()
    video = args.video.resolve()
    if hashlib.sha256(video.read_bytes()).hexdigest() != args.video_sha256:
        raise ValueError("development video hash mismatch")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    report = {"scope": "DEVELOPMENT_TWO_ROUTE_ACTUAL_BEDROCK", "status": "FAILED", "cases": [],
              "video_sha256": args.video_sha256, "model_id": ExplanationConfig().model_id,
              "independent_v15": "PENDING", "children_stopped": False}
    children, ai = [], None
    stop = threading.Event()
    heartbeat = None
    console = (out / "ai-console.txt").open("w", encoding="utf-8")
    try:
        child, url = launch("controller", out / "runs")
        children.append(child)
        with httpx.Client(base_url=url, timeout=2, trust_env=False) as control:
            session = wait_for(lambda: control.get("/api/session").raise_for_status().json())
            run_id = session["run_id"]
            report["run_id"] = run_id
            modes = {"DETECTOR-A": "OBSERVATION", "DETECTOR-B": "OBSERVATION"}
            failures = []
            def heartbeat_loop():
                sequences = dict.fromkeys(modes, 0)
                with httpx.Client(base_url=url, timeout=2, trust_env=False) as client:
                    while not stop.is_set():
                        try:
                            for source, kind in list(modes.items()):
                                if kind is None: continue
                                sequences[source] += 1
                                event = dict(schema_version=1, run_id=run_id, building_id="TWO_ROUTE", building_version=1,
                                    event_id=str(uuid4()), source_id=source, source_type="SIM_SMOKE_DETECTOR",
                                    source_sequence=sequences[source], event_kind=kind,
                                    hazard_type="SMOKE" if kind == "ALARM" else None, validity="VALID",
                                    observed_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                                    media_time_ms=None, confidence=None, reason_code=None)
                                client.post("/api/events", json=event).raise_for_status()
                        except Exception as error:
                            failures.append(type(error).__name__)
                            return
                        stop.wait(.5)
            heartbeat = threading.Thread(target=heartbeat_loop)
            heartbeat.start()
            wait_for(lambda: all(s["validity"] == "VALID" for s in control.get("/api/state").json()["sources"]
                                 if s["source_id"].startswith("DETECTOR-")))
            request = dict(schema_version=1, run_id=run_id, reason="A05 isolated development probe")
            control.post("/api/control/arm", json=request).raise_for_status()
            child, explanation_url = launch("explanation", out / "runs", url)
            children.append(child)
            with httpx.Client(base_url=explanation_url, timeout=2, trust_env=False) as explanations:
                def capture(name, mode, next_node):
                    def ready():
                        state = control.get("/api/state").raise_for_status().json()
                        route = next(r for r in state["routes"] if r["node_id"] == "S")
                        reply = explanations.get("/api/explanations/current").raise_for_status()
                        value = reply.json()
                        if (state["controller_mode"] == mode and route["next_node_id"] == next_node
                                and value["status"] == "READY" and value["run_id"] == run_id
                                and value["guidance_version"] == state["guidance_version"]):
                            if reply.headers.get("Cache-Control") != "no-store":
                                raise RuntimeError("explanation response is cacheable")
                            if datetime.fromisoformat(value["expires_at"]) <= datetime.fromisoformat(reply.headers["X-Explanation-Server-Time"]):
                                raise RuntimeError("API published expired READY")
                            return {"scenario": name, "state": state, "explanation": value,
                                    "server_time": reply.headers.get("X-Explanation-Server-Time")}
                        return None
                    report["cases"].append(wait_for(ready, 20))
                capture("G01", "NORMAL", "A")
                # resolve() would follow the venv's Python symlink into the system interpreter.
                ai = subprocess.Popen([str(args.ai_python.absolute()), "-m", "ai_worker", "--config", str(args.ai_config.resolve()),
                    "--video", str(video), "--controller", url, "--runs-dir", str(out / "ai")],
                    cwd=ROOT, stdout=console, stderr=subprocess.STDOUT, env=os.environ | {"PYTHONUTF8": "1"})
                capture("G02_actual_video", "EMERGENCY", "B")
                if ai.wait(timeout=90) != 0: raise RuntimeError("actual AI worker failed")
                modes["DETECTOR-B"] = "ALARM"
                capture("G04", "EMERGENCY", None)
                modes["DETECTOR-B"] = "OBSERVATION"
                modes["DETECTOR-A"] = None
                wait_for(lambda: next(s for s in control.get("/api/state").json()["sources"] if s["source_id"] == "DETECTOR-A")["validity"] == "STALE")
                # B heartbeat may have been in flight when changed; wait for its new observation.
                time.sleep(.6)
                for cause in control.get("/api/state").json()["active_causes"]:
                    control.post("/api/control/clear", json=request | {"source_id": cause["source_id"], "hazard_type": cause["hazard_type"]}).raise_for_status()
                capture("G07", "DEGRADED", "B")
                modes["DETECTOR-A"] = "OBSERVATION"
                capture("G09", "NORMAL", "A")
            if failures: raise RuntimeError("sensor heartbeat failed")
            report["status"] = "PASS"
    finally:
        stop.set()
        if heartbeat: heartbeat.join(timeout=5)
        stop_ai(ai)
        console.close()
        for child in reversed(children):
            child.terminate()
            child.join(timeout=15)
            if child.is_alive():
                child.kill()
                child.join(timeout=5)
        report["children_stopped"] = all(not child.is_alive() for child in children)
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cases": len(report["cases"]), "children_stopped": report["children_stopped"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

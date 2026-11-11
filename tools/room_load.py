"""Load check for personal rooms: N rooms, each with a dashboard and sign terminals, for a fixed time.

Measures what an operator needs before opening the demo to visitors: response latency, errors,
expired observations, simulation clock lag and server memory. It only talks to the public room API,
exactly like browsers do. Video AI is requested per room; whether it really ran is reported, never assumed.

    python -m tools.room_load --origin http://127.0.0.1:8010 --minutes 30 --server-pid 12345
"""

import argparse
from collections import Counter, defaultdict
import json
import statistics
import subprocess
import threading
import time
from uuid import uuid4

import httpx


def utc_now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.latency = defaultdict(list)
        self.errors = Counter()
        self.counts = Counter()

    def call(self, name, function):
        started = time.monotonic()
        try:
            response = function()
            elapsed = (time.monotonic() - started) * 1000
            with self.lock:
                self.latency[name].append(elapsed)
                if response.status_code >= 400: self.errors[f"{name} {response.status_code}"] += 1
            return response
        except httpx.HTTPError as error:
            with self.lock: self.errors[f"{name} {type(error).__name__}"] += 1
            return None

    def add(self, name, value=1):
        with self.lock: self.counts[name] += value


def room_user(origin, stats, stop, signs, index):
    """One visitor: a dashboard polling state, sign terminals acknowledging, and a fire/clear cycle."""
    with httpx.Client(base_url=origin, timeout=5, trust_env=False) as client:
        entered = stats.call("enter", lambda: client.post("/api/rooms"))
        if entered is None or entered.status_code not in {200, 201}:
            stats.add("rooms_not_created")
            return
        stats.add("rooms_created")
        building = client.get("/api/room/building").json()
        sign_ids = [sign["sign_id"] for sign in building["signs"]][index * signs:index * signs + signs]
        manual = [s["source_id"] for s in building["sources"] if s["source_type"] == "MANUAL_TEST"]
        required = {s["source_id"] for s in building["sources"] if s["required"]}
        terminals = {sign_id: str(uuid4()) for sign_id in sign_ids}
        ai = stats.call("ai_request", lambda: client.post("/api/room/ai"))
        stats.add(f"ai_{ai.json().get('state', ai.json().get('error', {}).get('code')) if ai is not None else 'no_reply'}")
        epoch, sim_epoch, next_fire, burning, sequence = time.monotonic(), None, 20 + index * 7, None, 0
        while not stop.is_set():
            loop = time.monotonic()
            state_reply = stats.call("state", lambda: client.get("/api/room/state"))
            sim_reply = stats.call("sim_state", lambda: client.get("/api/room/sim/state"))
            if state_reply is not None and state_reply.status_code == 200:
                state = state_reply.json()
                stats.add("state_polls")
                if any(s["validity"] != "VALID" for s in state["sources"] if s["source_id"] in required):
                    stats.add("polls_with_expired_required_observation")
                if state["controller_mode"] == "DEGRADED": stats.add("polls_degraded")
                elapsed = loop - epoch
                if burning is None and elapsed >= next_fire:
                    sequence += 1
                    source = manual[(index + sequence) % len(manual)]
                    event = dict(schema_version=1, run_id=state["run_id"], building_id=state["building_id"],
                                 building_version=state["building_version"], event_id=str(uuid4()), source_id=source,
                                 source_type="MANUAL_TEST", source_sequence=sequence, event_kind="ALARM", hazard_type="FIRE",
                                 validity="VALID", observed_at=utc_now(), media_time_ms=None, confidence=None, reason_code=None)
                    fired = stats.call("fire", lambda: client.post("/api/room/events", json=event))
                    if fired is not None and fired.status_code == 200: burning = elapsed
                elif burning is not None and elapsed - burning >= 40:
                    for cause in state["active_causes"]:
                        stats.call("clear", lambda: client.post("/api/room/control/clear", json=dict(
                            schema_version=1, run_id=state["run_id"], source_id=cause["source_id"],
                            hazard_type=cause["hazard_type"], reason="load check clear")))
                    if not state["active_causes"]: burning, next_fire = None, elapsed + 30
            if sim_reply is not None and sim_reply.status_code == 200:
                sim = sim_reply.json()
                if sim["status"] != "RUNNING": stats.add(f"sim_{sim['status']}_{sim['error_code']}")
                if sim_epoch is None: sim_epoch = (loop, sim["simulation_time_ms"])
                lag = (loop - sim_epoch[0]) * 1000 - (sim["simulation_time_ms"] - sim_epoch[1])
                with stats.lock: stats.latency["sim_clock_lag"].append(lag)
            for sign_id, terminal in terminals.items():
                command_reply = stats.call("sign_command", lambda: client.get(f"/api/room/signs/{sign_id}/command"))
                if command_reply is None or command_reply.status_code != 200: continue
                command = command_reply.json()
                ack = dict(schema_version=1, run_id=command["run_id"], sign_id=sign_id, terminal_instance_id=terminal,
                           command_id=command["command_id"], command_sequence=command["command_sequence"],
                           guidance_version=command["guidance_version"], status="APPLIED",
                           faces=[{k: f[k] for k in ("face_id", "mode", "display")} for f in command["faces"]],
                           client_apply_duration_ms=8, error_code=None)
                stats.call("sign_ack", lambda: client.post(f"/api/room/signs/{sign_id}/ack", json=ack))
            stop.wait(max(0, .8 - (time.monotonic() - loop)))
        stats.call("leave", lambda: client.delete("/api/room"))


def memory_kb(pid):
    try:
        return int(subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, encoding="utf-8", timeout=5).stdout.strip())
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--origin", default="http://127.0.0.1:8000")
    parser.add_argument("--rooms", type=int, default=5)
    parser.add_argument("--signs", type=int, default=2)
    parser.add_argument("--minutes", type=float, default=30)
    parser.add_argument("--server-pid", type=int, help="controller process to sample memory from")
    args = parser.parse_args()
    stats, stop = Stats(), threading.Event()
    users = [threading.Thread(target=room_user, args=(args.origin, stats, stop, args.signs, i)) for i in range(args.rooms)]
    for user in users: user.start()
    memory, deadline = [], time.monotonic() + args.minutes * 60
    while time.monotonic() < deadline:
        if args.server_pid: memory.append(memory_kb(args.server_pid))
        time.sleep(30)
    stop.set()
    for user in users: user.join(timeout=30)
    with httpx.Client(base_url=args.origin, timeout=5, trust_env=False) as client:
        seats = client.get("/api/rooms/availability").json()

    def summary(values):
        ordered = sorted(values)
        return {"count": len(ordered), "p50_ms": round(statistics.median(ordered), 1),
                "p95_ms": round(ordered[int(len(ordered) * .95) - 1], 1), "max_ms": round(ordered[-1], 1)} if ordered else None

    memory = [value for value in memory if value is not None]
    print(json.dumps({"minutes": args.minutes, "rooms": args.rooms, "signs_per_room": args.signs,
                      "latency": {name: summary(values) for name, values in sorted(stats.latency.items())},
                      "errors": dict(stats.errors), "counts": dict(stats.counts),
                      "memory_rss_kb": {"first": memory[0], "last": memory[-1], "max": max(memory)} if memory else None,
                      "seats_after": seats}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

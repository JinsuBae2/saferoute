"""Room capacity includes unfinished cleanup; server shutdown reaps its AI child."""

import threading

import pytest

from backend.rooms import RoomError
from test_rooms import enter, setup, wait_until, wfi  # noqa: F401 (fixtures)
from test_observation_state import clock  # noqa: F401 (fixture)


def test_closing_rooms_keep_their_reservations_without_stalling_a_live_room(setup):
    client, manager, clock = setup
    rooms = [manager.rooms[client.get("/api/room", headers=enter(client)).json()["room_id"]]
             for _ in range(5)]
    release, entered = threading.Event(), []
    for room in rooms[:4]:
        original = room.runner.close

        def blocked_close(original=original, room=room):
            entered.append(room.room_id)
            release.wait(5)
            original()

        room.runner.close = blocked_close
        room.last_seen -= manager.idle_seconds
    live = rooms[-1]
    before = live.runner.state().simulation_time_ms
    try:
        manager.step_all(wait=False)
        assert wait_until(lambda: len(entered) == 4)
        assert manager.availability()["in_use"] == 5
        for _ in range(3):
            with pytest.raises(RoomError) as refusal:
                manager.create()
            assert refusal.value.code == "ROOM_FULL"
            assert wait_until(lambda: not live.busy)
            clock.advance(500)
            manager.step_all(wait=False)
        assert wait_until(lambda: not live.busy)
        assert live.runner.state().simulation_time_ms >= before + 1500
        assert len(entered) == 4  # Repeated expiry did not enqueue another cleanup.
        for room in rooms[:4]:
            with pytest.raises(RoomError):
                manager.internal(room.room_id, manager.internal_token)
    finally:
        release.set()
    assert wait_until(lambda: manager.availability()["in_use"] == 1)
    manager.create()
    assert manager.availability()["in_use"] == 2


def test_finished_cleanup_keeps_the_reservation_until_an_old_step_returns(setup):
    client, manager, _ = setup
    manager.capacity = 1
    who = enter(client)
    room = manager.rooms[client.get("/api/room", headers=who).json()["room_id"]]
    entered, release = threading.Event(), threading.Event()

    def paused_step():
        entered.set()
        release.wait(5)

    room.step = paused_step
    manager.step_all(wait=False)
    try:
        assert entered.wait(2)
        manager.close(room, "ended")
        assert room.controller.closed
        assert manager.availability()["in_use"] == 1
        with pytest.raises(RoomError):
            manager.create()
        assert client.get("/api/room", headers=who).status_code == 401
    finally:
        release.set()
    assert wait_until(lambda: manager.availability()["in_use"] == 0)
    manager.create()


def test_shutdown_closes_a_room_whose_creation_was_already_in_progress(setup):
    _, manager, _ = setup
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    original = manager._build
    built, errors = [], []

    def delayed_build():
        entered.set()
        release.wait(5)
        result = original()
        built.append(result[0])
        return result

    def create():
        try: manager.create()
        except RoomError as error: errors.append(error)

    def shutdown():
        manager.shutdown()
        stopped.set()

    manager._build = delayed_build
    creator = threading.Thread(target=create)
    closer = threading.Thread(target=shutdown)
    creator.start()
    try:
        assert entered.wait(2)
        closer.start()
        assert wait_until(lambda: manager.shutting_down)
        assert not stopped.wait(.05), "shutdown ignored a room still being prepared"
    finally:
        release.set()
        creator.join(5)
        if closer.ident is not None: closer.join(5)
    assert stopped.is_set()
    assert len(errors) == 1 and errors[0].status == 503
    assert built[0].controller.closed
    assert manager.availability()["in_use"] == 0


def test_shutdown_waits_for_cleanup_already_started_by_a_user_request(setup):
    client, manager, _ = setup
    who = enter(client)
    room = manager.rooms[client.get("/api/room", headers=who).json()["room_id"]]
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    original = room.runner.close

    def delayed_close():
        entered.set()
        release.wait(5)
        original()

    def shutdown():
        manager.shutdown()
        stopped.set()

    room.runner.close = delayed_close
    user_close = threading.Thread(target=lambda: manager.close(room, "ended"))
    server_close = threading.Thread(target=shutdown)
    user_close.start()
    try:
        assert entered.wait(2)
        server_close.start()
        assert not stopped.wait(.05), "shutdown returned while the detached room was still closing"
    finally:
        release.set()
        user_close.join(5)
        if server_close.ident is not None: server_close.join(5)
    assert stopped.is_set() and room.controller.closed
    assert manager.availability()["in_use"] == 0


class ChildProcess:
    """The process boundary: terminate may be ignored, and exit must be polled."""

    def __init__(self, exit_after):
        self.exit_after = exit_after
        self.code = None
        self.terminated = self.killed = self.reaped = False

    def terminate(self):
        self.terminated = True
        if self.exit_after == "terminate":
            self.code = -15

    def kill(self):
        self.killed = True
        if self.exit_after == "kill":
            self.code = -9

    def poll(self):
        self.reaped = self.code is not None
        return self.code


def start_ai(client, manager, monkeypatch, exit_after):
    monkeypatch.setattr(manager.ai, "KILL_AFTER_SECONDS", .01)
    monkeypatch.setattr(manager.ai, "REAP_AFTER_SECONDS", .03, raising=False)
    children = []

    def launch(room, run_id):
        child = ChildProcess(exit_after)
        children.append(child)
        return child

    manager.ai.launch = launch
    who = enter(client)
    room = manager.rooms[client.get("/api/room", headers=who).json()["room_id"]]
    manager.ai.request(room, manager.rooms)
    return room, children


@pytest.mark.parametrize("exit_after", ["terminate", "kill"])
def test_shutdown_confirms_ai_exit_and_never_launches_a_waiting_job(setup, monkeypatch, exit_after):
    client, manager, _ = setup
    room, children = start_ai(client, manager, monkeypatch, exit_after)
    other, _ = manager.create()
    manager.ai.request(other, manager.rooms)
    try:
        manager.shutdown()
        child = children[0]
        assert child.reaped, "shutdown returned without confirming the child process exited"
        assert child.killed == (exit_after == "kill")
        assert len(children) == 1
        assert manager.ai.stopping is None
        assert manager.ai.jobs == []
        with pytest.raises(RoomError):
            manager.ai.request(room, {room.room_id: room})
        with pytest.raises(RoomError):
            manager.create()
    finally:
        for child in children:
            child.code = -9


def test_shutdown_failure_keeps_the_child_reference_but_still_closes_rooms(setup, monkeypatch):
    client, manager, _ = setup
    room, children = start_ai(client, manager, monkeypatch, "never")
    child = children[0]
    try:
        with pytest.raises(RuntimeError, match="AI"):
            manager.shutdown()
        assert child.terminated and child.killed and child.code is None
        assert manager.ai.stopping["handle"] is child
        assert room.controller.closed
        assert manager.availability()["in_use"] == 0
        with pytest.raises(RoomError):
            manager.ai.request(room, {room.room_id: room})
    finally:
        child.code = -9

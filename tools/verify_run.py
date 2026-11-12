"""Verify saved run evidence without rerunning routing or certifying a browser/device."""

import argparse
import hashlib
import json
from math import isclose, isfinite
from pathlib import Path
import sys

from pydantic import TypeAdapter

from backend.contracts import check_ack, check_command, parse_contract
from backend.contracts.common import RunIdentity, UTCString, UUIDString
from backend.contracts.messages import Session, SourceState, StateSnapshot
from backend.contracts.validation import ERROR_STATUS

CATEGORIES = ("events", "decisions", "commands", "acks")
SNAPSHOT_FIELDS = ("guidance_version", "controller_mode", "sources", "active_causes",
                   "blocked_nodes", "blocked_edges", "routes", "signs")


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _integer(value, minimum=0):
    _require(type(value) is int and value >= minimum, "expected an integer >= " + str(minimum))
    return value


def _number(value):
    _require(type(value) in (int, float) and 0 <= value <= sys.float_info.max and isfinite(value),
             "expected a finite nonnegative number")
    return value


def _text(value):
    _require(isinstance(value, str) and bool(value.strip()), "expected nonempty text")
    return value


def _reject_constant(value):
    raise ValueError("non-JSON number: " + value)


def _object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate JSON key: " + key)
        result[key] = value
    return result


def _decode(value):
    try:
        result = json.loads(value, parse_constant=_reject_constant, object_pairs_hook=_object)
    except RecursionError as problem:
        raise ValueError("JSON nesting exceeds supported depth") from problem
    _require(isinstance(result, dict), "expected a JSON object")
    return result


def _identity(value, manifest):
    for key in ("run_id", "building_id", "building_version"):
        _require(getattr(value, key) == manifest[key], key + " does not match manifest")


class _Replay:
    def __init__(self, manifest, building, counts):
        self.manifest, self.building, self.counts = manifest, building, counts
        self.guidance_version, self.armed, self.pending = 0, False, None
        self.sources = {source.source_id: SourceState(source_id=source.source_id, validity="INITIALIZING",
            last_event_id=None, last_observed_at=None, last_source_sequence=None).model_dump() for source in building.sources}
        self.source_config = {source.source_id: source for source in building.sources}
        self.causes, self.seen_events, self.sequences = {}, {}, {}
        self.commands, self.latest, self.seen_acks, self.terminals = {}, {}, {}, {}
        self.snapshot = None
        self.previous_time = 0
        self.faces = {sign.sign_id: [dict(face_id=face.face_id, mode="UNKNOWN", display=None,
            next_node_id=None, exit_id=None, reason_codes=["INITIALIZING"]) for face in sign.faces] for sign in building.signs}

    def mode(self):
        if not self.armed: return "INITIALIZING"
        if self.causes: return "EMERGENCY"
        if any(source.required and self.sources[source.source_id]["validity"] != "VALID" for source in self.building.sources):
            return "DEGRADED"
        return "NORMAL"

    def key(self):
        return (self.mode(), tuple(sorted(self.causes)), tuple((source.source_id,
            self.sources[source.source_id]["validity"] == "VALID") for source in self.building.sources if source.required))

    def session(self):
        return Session(schema_version=1, run_id=self.manifest["run_id"], building_id=self.building.building_id,
                       building_version=self.building.building_version, controller_mode=self.mode())

    def rejected(self, record):
        _require("payload" in record, "rejection is missing payload evidence")
        _require(record["error_code"] in ERROR_STATUS, "unknown rejection error code")
        _require(record["field"] is None or isinstance(record["field"], str), "invalid rejection field")
        self.counts["rejections"] += 1

    def events(self, record):
        operation, outcome = record["operation"], record["outcome"]
        if outcome == "rejected":
            _require(operation in {"event", "arm", "clear", "reset"} or operation.startswith("/"), "unknown rejected event operation")
            self.rejected(record)
            return
        _require(operation in {"event", "arm", "clear", "reset"}, "unknown event operation")
        _require(outcome in {"accepted", "duplicate"}, "unknown event outcome")
        if operation == "event":
            event = parse_contract("ObservationEvent", record["payload"])
            _identity(event, self.manifest)
            source = self.source_config.get(event.source_id)
            _require(source is not None, "unknown observation source")
            _require(source.source_type == event.source_type and (event.hazard_type is None or
                event.hazard_type in source.allowed_hazard_types), "observation disagrees with source configuration")
            previous = self.seen_events.get(event.event_id)
            if outcome == "duplicate":
                _require(previous == event, "duplicate event has no identical accepted predecessor")
                return
            _require(previous is None, "accepted event reuses an event_id")
            _require(event.source_sequence > self.sequences.get(event.source_id, 0), "accepted event source_sequence did not increase")
            self.seen_events[event.event_id] = event
            self.sequences[event.source_id] = event.source_sequence
            self.pending = (operation, event)
        else:
            _require(outcome == "accepted", "control operation cannot be duplicate")
            request = parse_contract("ClearRequest" if operation == "clear" else "ControlRequest", record["payload"])
            _require(request.run_id == self.manifest["run_id"], "control run_id does not match manifest")
            _require(record["reason"] == request.reason, "control reason does not match payload")
            _text(record["actor"])
            self.pending = (operation, request)

    def apply_pending(self, operation, record):
        _require(self.pending is not None and self.pending[0] == operation, "decision has no matching accepted input")
        value = self.pending[1]
        self.pending = None
        if operation == "event":
            _require(record["event_id"] == value.event_id, "decision event_id differs from accepted input")
            source = self.sources[value.source_id]
            source["last_event_id"], source["last_source_sequence"] = value.event_id, value.source_sequence
            if value.event_kind == "UNAVAILABLE":
                source["validity"], source["last_observed_at"] = "UNAVAILABLE", value.observed_at
            elif not (value.source_type == "VIDEO_AI" and value.event_kind == "HEARTBEAT"):
                source["validity"], source["last_observed_at"] = "VALID", value.observed_at
            if value.event_kind == "ALARM":
                key = (value.source_id, value.hazard_type)
                first = self.causes.get(key, (value.event_id, value.event_id))[0]
                self.causes[key] = (first, value.event_id)
        elif operation == "arm":
            _require(all(not source.required or self.sources[source.source_id]["validity"] == "VALID"
                         for source in self.building.sources), "arm accepted without valid required observations")
            self.armed = True
        elif operation == "clear":
            key = (value.source_id, value.hazard_type)
            _require(key in self.causes, "clear decision has no active cause")
            _require(record["source_id"] == value.source_id and record["hazard_type"] == value.hazard_type,
                     "clear decision differs from accepted input")
            del self.causes[key]

    def decisions(self, record):
        operation = record["operation"]
        if operation in {"start", "stop"}:
            _text(record["actor"])
            _text(record["reason"])
            return
        if operation == "reset":
            self.apply_pending(operation, record)
            TypeAdapter(UUIDString).validate_python(record["next_run_id"])
            _require(record["next_run_id"] != self.manifest["run_id"], "reset must identify a different run")
            return
        if operation == "command_expire":
            _require(record["guidance_version"] == self.guidance_version, "command expiry changes guidance version")
            data = dict(self.snapshot) if self.snapshot else dict(guidance_version=0, controller_mode="INITIALIZING",
                sources=list(self.sources.values()), active_causes=[], blocked_nodes=[], blocked_edges=[], routes=[])
            data["signs"] = record["signs"]
        else:
            before = self.key()
            if operation == "fire_spread":
                _require(any(self.seen_events[first].ignition_position is not None
                             for first, _ in self.causes.values()),
                         "fire_spread has no active positioned fire")
            elif operation == "expire":
                source_ids = record["source_ids"]
                _require(isinstance(source_ids, list) and source_ids and all(isinstance(item, str) for item in source_ids)
                         and len(set(source_ids)) == len(source_ids), "invalid expired sources")
                for source_id in source_ids:
                    _require(source_id in self.sources and self.sources[source_id]["validity"] == "VALID", "expired source was not valid")
                    self.sources[source_id]["validity"] = "STALE"
            else:
                _require(operation in {"event", "arm", "clear"}, "unknown decision operation")
                self.apply_pending(operation, record)
            if self.key() != before or operation == "fire_spread": self.guidance_version += 1
            data = {key: record[key] for key in SNAPSHOT_FIELDS}
        _require(type(data["guidance_version"]) is int and data["guidance_version"] == self.guidance_version,
                 "guidance_version disagrees with ordered decisions")
        _require(data["controller_mode"] == self.mode(), "controller_mode disagrees with accepted evidence")
        snapshot = StateSnapshot(**self.session().model_dump(), **{key: value for key, value in data.items()
            if key != "controller_mode"}, generated_at=record["recorded_at"])
        _require({source.source_id: source.model_dump() for source in snapshot.sources} == self.sources,
                 "snapshot sources disagree with accepted evidence")
        _require({(cause.source_id, cause.hazard_type): (cause.first_event_id, cause.last_event_id)
                  for cause in snapshot.active_causes} == self.causes, "snapshot causes disagree with accepted evidence")
        _require(all(cause.ignition_position == self.seen_events[cause.first_event_id].ignition_position
                     for cause in snapshot.active_causes), "snapshot ignition position differs from first accepted event")
        if operation != "command_expire":
            _require({route.node_id for route in snapshot.routes} == {node.node_id for node in self.building.nodes},
                     "snapshot routes do not cover configured nodes")
        self.validate_signs(snapshot, record["server_monotonic_ms"])
        self.faces = {sign.sign_id: [face.model_dump() for face in sign.faces] for sign in snapshot.signs}
        self.snapshot = data

    def validate_signs(self, snapshot, recorded_time):
        _require({sign.sign_id for sign in snapshot.signs} == set(self.faces), "snapshot signs differ from building")
        for sign in snapshot.signs:
            _require({face.face_id for face in sign.faces} == {face["face_id"] for face in self.faces[sign.sign_id]},
                     "snapshot face IDs differ from building")
            latest = self.latest.get(sign.sign_id)
            _require(sign.latest_command == (self.commands[latest][0] if latest else None), "snapshot latest_command disagrees with issued evidence")
            expected = {key[1]: value for key, value in self.terminals.items() if key[0] == sign.sign_id}
            _require({terminal.terminal_instance_id for terminal in sign.terminals} == set(expected), "snapshot terminals disagree with accepted ACKs")
            for terminal in sign.terminals:
                ack, verified = expected[terminal.terminal_instance_id]
                _require(terminal.last_ack == ack and terminal.verified is verified, "snapshot terminal claims disagree with accepted ACK")
            statuses = {"NOT_ISSUED"}
            if latest:
                command, _, deadline = self.commands[latest]
                pending = "PENDING"
                if len(expected) == 1 and command.guidance_version == self.guidance_version and command.faces == sign.faces:
                    ack, verified = next(iter(expected.values()))
                    if ack.command_id == latest: pending = "APPLIED" if verified else "REJECTED"
                # Snapshot construction precedes the recorded timestamp; expiry can fall between them.
                statuses = {pending} if recorded_time < deadline else {pending, "EXPIRED"}
                if self.previous_time >= deadline: statuses = {"EXPIRED"}
                if len(expected) > 1: statuses = {"DUPLICATE_TERMINAL"}
            _require(sign.application_status in statuses, "snapshot application_status disagrees with command/ACK timing evidence")

    def command(self, record):
        operation = record["operation"]
        if operation == "command" and record.get("outcome") == "rejected":
            self.rejected(record)
            return
        if operation == "discard":
            _require(record["command_id"] in self.commands, "discard has no issued command")
            _require(record["outcome"] == "discarded" and record["error_code"] in {"COMMAND_EXPIRED", "COMMAND_MISMATCH"}, "invalid command discard")
            return
        _require(operation == "issue", "unknown command operation")
        command = parse_contract("SignCommand", record["command"])
        previous = self.latest.get(command.sign_id)
        sequence = self.commands[previous][0].command_sequence if previous else 0
        check_command(command, self.session(), self.building, command.sign_id, sequence)
        _require(command.command_sequence == sequence + 1, "command_sequence must increase by exactly one")
        _require(command.command_id not in self.commands, "command_id was already issued")
        _require(command.guidance_version == self.guidance_version, "command guidance_version is not current")
        _require([face.model_dump() for face in command.faces] == self.faces[command.sign_id], "command faces disagree with current guidance")
        issued, deadline = _number(record["issued_monotonic_ms"]), _number(record["expires_at_monotonic_ms"])
        _require(isclose(deadline - issued, command.valid_for_ms, rel_tol=0, abs_tol=1e-6), "command deadline disagrees with valid_for_ms")
        _require(issued <= record["server_monotonic_ms"], "command issue time is after its recording time")
        self.commands[command.command_id] = (command, issued, deadline)
        self.latest[command.sign_id] = command.command_id
        self.counts["commands_issued"] += 1

    def acks(self, record):
        operation, outcome = record["operation"], record["outcome"]
        if outcome == "rejected":
            _require(operation == "ack" or operation.startswith("/"), "unknown rejected ACK operation")
            self.rejected(record)
            return
        _require(operation == "ack" and outcome in {"accepted", "duplicate"}, "unknown ACK operation or outcome")
        ack = parse_contract("SignAck", record["payload"])
        _require(ack.command_id in self.commands, "ACK refers to an unissued command")
        command, issued, deadline = self.commands[ack.command_id]
        received = _number(record["received_monotonic_ms"])
        _require(issued <= received <= record["server_monotonic_ms"], "ACK receive time is outside issue/record times")
        _require(isclose(_number(record["server_ack_elapsed_ms"]), received - issued, rel_tol=0, abs_tol=1e-6), "ACK elapsed time disagrees with receipt time")
        verified = check_ack(ack, command, now_monotonic_ms=received, expires_at_monotonic_ms=deadline)
        current = self.latest[ack.sign_id] == ack.command_id and ack.guidance_version == self.guidance_version
        _require(record["verified"] is verified, "ACK verified claim disagrees with command evidence")
        _require(record["confirms_current"] is (current and verified), "ACK confirms_current claim disagrees with current guidance")
        _require(record["error_code"] is None, "accepted ACK record has an error_code")
        key = (ack.command_id, ack.terminal_instance_id)
        previous = self.seen_acks.get(key)
        _require((previous == ack) if outcome == "duplicate" else previous is None, "ACK duplicate/accepted outcome disagrees with prior evidence")
        if outcome == "accepted":
            self.seen_acks[key] = ack
            terminal_key = (ack.sign_id, ack.terminal_instance_id)
            terminal = self.terminals.get(terminal_key)
            if terminal is None or terminal[0].command_sequence < ack.command_sequence:
                self.terminals[terminal_key] = (ack, verified)
        self.counts["acks_" + outcome] += 1
        if verified: self.counts["acks_applied"] += 1
        if current and verified: self.counts["acks_confirming_current"] += 1

    def record(self, category, record):
        if self.pending:
            _require(category == "decisions" and record["operation"] == self.pending[0], "accepted input is missing its following decision")
        {"events": self.events, "decisions": self.decisions, "commands": self.command, "acks": self.acks}[category](record)
        self.previous_time = record["server_monotonic_ms"]


def verify_run(directory: Path) -> dict:
    """Return a report; input files are never modified and malformed evidence fails closed."""
    directory = Path(directory)
    counts = dict.fromkeys((*CATEGORIES, "commands_issued", "acks_accepted", "acks_duplicate",
                           "acks_applied", "acks_confirming_current", "rejections"), 0)
    report = dict(scope="LOG_INTEGRITY", status="FAIL", counts=counts, errors=[], input_sha256={})

    def error(filename, line, message):
        report["errors"].append(dict(file=filename, line=line, message=str(message)))

    def read(filename):
        try:
            raw = (directory / filename).read_bytes()
            report["input_sha256"][filename] = hashlib.sha256(raw).hexdigest()
            return raw.decode("utf-8")
        except (OSError, UnicodeError) as problem:
            error(filename, None, problem)
            return None

    manifest, building = None, None
    for filename in ("manifest.json", "building.json"):
        raw = read(filename)
        if raw is None: continue
        try:
            data = _decode(raw)
            if filename == "building.json":
                building = parse_contract("Building", data)
            else:
                _require(type(data["schema_version"]) is int and data["schema_version"] == 1, "unsupported or legacy manifest schema_version")
                RunIdentity.model_validate({key: data[key] for key in RunIdentity.model_fields})
                _require(data["closed"] is True, "run is not finalized")
                for key in ("started_at", "ended_at"):
                    TypeAdapter(UTCString).validate_python(data[key])
                for key in ("component", "python_version", "platform", "building_sha256"):
                    _text(data[key])
                _require(data["code_commit"] is None or isinstance(data["code_commit"], str), "invalid code_commit")
                _require(data["code_dirty"] is None or type(data["code_dirty"]) is bool, "invalid code_dirty")
                _integer(data["last_record_sequence"], 1)
                _require(data["end_reason"] in {"reset", "shutdown"}, "unsupported end_reason")
                manifest = data
                report["run_id"] = data["run_id"]
        except (ValueError, KeyError, TypeError) as problem:
            error(filename, None, problem)
    if manifest and building:
        if (manifest["building_id"], manifest["building_version"]) != (building.building_id, building.building_version):
            error("manifest.json", None, "building identity does not match building.json")
        if manifest["building_sha256"] != report["input_sha256"].get("building.json"):
            error("manifest.json", None, "building_sha256 does not match exact building.json bytes")

    records = []
    for category in CATEGORIES:
        filename = category + ".jsonl"
        raw = read(filename)
        if raw is None: continue
        lines = raw.splitlines()
        counts[category] = len(lines)
        if raw and not raw.endswith("\n"):
            error(filename, len(lines), "unterminated JSONL record (possible truncation)")
        previous = 0
        for line, text in enumerate(lines, 1):
            try:
                record = _decode(text)
                sequence = _integer(record["record_sequence"], 1)
                _require(sequence > previous, "record_sequence is not increasing within file")
                previous = sequence
                TypeAdapter(UUIDString).validate_python(record["run_id"])
                if manifest: _require(record["run_id"] == manifest["run_id"], "record run_id does not match manifest")
                TypeAdapter(UTCString).validate_python(record["recorded_at"])
                _number(record["server_monotonic_ms"])
                _text(record["operation"])
                records.append((sequence, filename, line, category, record))
            except (ValueError, KeyError, TypeError) as problem:
                error(filename, line, problem)
    records.sort(key=lambda item: item[0])
    previous_time = 0
    for expected, (sequence, filename, line, category, record) in enumerate(records, 1):
        if sequence != expected: error(filename, line, f"expected record_sequence {expected}, found {sequence}")
        if record["server_monotonic_ms"] < previous_time:
            error(filename, line, "server_monotonic_ms moved backwards")
        previous_time = record["server_monotonic_ms"]
        if record["operation"] == "start" and expected != 1:
            error(filename, line, "start decision is not the first record")
        if record["operation"] in {"stop", "reset"} and category == "decisions" and expected != len(records):
            error(filename, line, "records continue after the final decision")
    if manifest:
        if len(records) != manifest["last_record_sequence"] or not records or records[-1][0] != manifest["last_record_sequence"]:
            error("manifest.json", None, "last_record_sequence does not match complete record sequence")
        if not records or records[0][3] != "decisions" or records[0][4]["operation"] != "start":
            error("decisions.jsonl", 1, "first record must be a start decision")
        ending = "reset" if manifest["end_reason"] == "reset" else "stop"
        if not records or records[-1][3] != "decisions" or records[-1][4]["operation"] != ending:
            error("manifest.json", None, "final decision does not match end_reason")
    if manifest and building:
        replay = _Replay(manifest, building, counts)
        for _, filename, line, category, record in records:
            try:
                replay.record(category, record)
            except (ValueError, KeyError, TypeError, AttributeError, IndexError) as problem:
                error(filename, line, problem)
        if replay.pending:
            error("decisions.jsonl", None, "accepted input has no decision")
    if not report["errors"]: report["status"] = "PASS"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    args = parser.parse_args(argv)
    report = verify_run(args.run_directory)
    try:
        (args.run_directory / "verification.json").write_text(
            json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    except OSError as problem:
        print("Cannot write verification.json: " + str(problem), file=sys.stderr)
        return 1
    print(json.dumps(dict(scope=report["scope"], status=report["status"], errors=len(report["errors"]))))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

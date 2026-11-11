"""Evaluate one completed VIDEO_AI run against complete per-video event annotations."""
import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, TypeAdapter, model_validator

from ai_worker.config import AIConfig
from backend.contracts.common import (Identifier, NonnegativeInt, NonnegativeNumber, PositiveInt,
                                     SchemaVersion, Text, UTCString, UUIDString, WireModel)
from backend.contracts.messages import EventReceipt, ObservationEvent

Hash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Hazard = Literal["FIRE", "SMOKE"]
GAP_MS = 1000


def require(condition, message):
    if not condition:
        raise ValueError(message)


class TruthEvent(WireModel):
    event_id: Identifier
    hazard_type: Hazard
    start_ms: NonnegativeInt
    end_ms: PositiveInt


class GroundTruth(WireModel):
    schema_version: SchemaVersion
    asset_id: Identifier
    scene_id: Identifier
    video_sha256: Hash
    source: Text
    split: Literal["development", "evaluation", "fixture"]
    annotator: Text
    reviewer: Text | None
    annotation_complete: bool
    training_overlap: Literal["excluded", "unknown", "known"]
    development_used: bool
    duration_ms: PositiveInt
    normal_video: bool
    events: list[TruthEvent]

    @model_validator(mode="after")
    def annotations(self):
        require(self.annotation_complete, "only complete per-video annotations are supported")
        require(len({e.event_id for e in self.events}) == len(self.events), "duplicate truth event_id")
        require(self.normal_video == (not self.events), "empty events must explicitly declare a normal video")
        for hazard in ("FIRE", "SMOKE"):
            previous_end = 0
            for event in sorted((e for e in self.events if e.hazard_type == hazard), key=lambda e: e.start_ms):
                require(previous_end <= event.start_ms < event.end_ms <= self.duration_ms,
                        "truth intervals must be nonoverlapping [start_ms,end_ms) within the video")
                previous_end = event.end_ms
        if self.split == "evaluation":
            require(not self.development_used and self.training_overlap != "known" and self.reviewer is not None,
                    "evaluation requires reviewed annotations, no declared development use or known training overlap")
        return self


class LogRecord(WireModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    operation: str
    run_id: UUIDString
    source_type: Literal["VIDEO_AI"]
    source_id: Identifier
    recorded_at: UTCString


class Prediction(LogRecord):
    operation: Literal["prediction"]
    frame_index: NonnegativeInt
    media_time_ms: NonnegativeInt
    observed_at: UTCString
    inference_completed_at: UTCString
    read_to_completion_ms: NonnegativeNumber
    events: Annotated[list[ObservationEvent], Field(min_length=1, max_length=2)]


def decode(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    def bad_number(value):
        raise ValueError(f"non-JSON number: {value}")
    def finite_float(value):
        number = float(value)
        require(math.isfinite(number), "nonfinite JSON number")
        return number
    result = json.loads(text, object_pairs_hook=unique, parse_constant=bad_number, parse_float=finite_float)
    require(isinstance(result, dict), "expected a JSON object")
    return result


def event_identity(event, start, config):
    require((event.run_id, event.source_id, event.source_type, event.building_id, event.building_version) ==
            (start["run_id"], start["source_id"], "VIDEO_AI", config.building_id, config.building_version),
            "mixed event identity")


def read_run(rows, truth):
    require(rows and rows[0].get("operation") == "start", "run must begin with start")
    start = rows[0]
    config = AIConfig.model_validate(start.get("config"))
    require(start.get("video_sha256") == truth.video_sha256, "video hash does not match annotations")
    require(start.get("source_id") == config.source_id, "config source does not match log")
    core_rows = []
    for index, row in enumerate(rows):
        record = LogRecord.model_validate(row)
        require((record.run_id, record.source_id) == (start["run_id"], config.source_id), "mixed log identity")
        if record.operation == "preview_unavailable":
            TypeAdapter(Text).validate_python(row.get("error_type"), strict=True)
        elif record.operation == "preview_finished":
            require(index == len(rows)-1 and core_rows[-1].get("operation") == "finished",
                    "preview shutdown must follow completed AI run and end the log")
            TypeAdapter(NonnegativeInt).validate_python(row.get("dropped_pending_frames"), strict=True)
        else:
            core_rows.append(row)
    # Preview availability is separate from AI completion; never filter failed/unknown AI operations.
    rows = core_rows
    require(rows[-1].get("operation") == "finished", "run must have successful finished record")
    finish = rows[-1]
    predictions, predicted, sent, receipts, preflights = [], {}, {}, set(), []
    previous_media, previous_frame, skipped = -1, -1, 0
    allowed = {"start", "video_preflight", "prediction", "send_attempt", "send_result", "send_rejected",
               "transport_error", "skip_duplicate_time", "skip_late_frame", "finished"}
    for index, row in enumerate(rows):
        record = LogRecord.model_validate(row)
        require((record.run_id, record.source_id) == (start["run_id"], config.source_id), "mixed log identity")
        op = record.operation
        require(op in allowed, f"failed or unsupported log operation: {op}")
        require(op != "start" or index == 0, "multiple starts")
        require(op != "finished" or index == len(rows)-1, "multiple finished records")
        if op == "video_preflight":
            preflights.append(TypeAdapter(PositiveInt).validate_python(row.get("decoded_frames"), strict=True))
        elif op == "skip_late_frame":
            skipped += 1
        elif op == "prediction":
            frame = Prediction.model_validate(row)
            require(previous_media < frame.media_time_ms < truth.duration_ms and frame.frame_index > previous_frame,
                    "frame/media time must increase within annotated duration")
            require(datetime.fromisoformat(frame.observed_at) <= datetime.fromisoformat(frame.inference_completed_at),
                    "inference completion precedes acquisition UTC")
            previous_media, previous_frame = frame.media_time_ms, frame.frame_index
            hazards = set()
            for event in frame.events:
                event_identity(event, start, config)
                require(event.event_kind in {"ALARM", "OBSERVATION"}, "non-frame event in prediction")
                require(event.media_time_ms == frame.media_time_ms and event.observed_at == frame.observed_at,
                        "event does not refer to its acquired frame")
                require(event.event_id not in predicted and event.source_sequence == len(predicted)+1,
                        "duplicate event or noncontiguous prediction sequence")
                require(event.hazard_type not in hazards, "duplicate class in one frame")
                hazards.add(event.hazard_type)
                predicted[event.event_id] = event.model_dump(mode="json")
            require(len(frame.events) == 1 or None not in hazards, "OBSERVATION cannot accompany ALARM")
            predictions.append(frame)
        elif op == "send_attempt":
            event = ObservationEvent.model_validate(row.get("event"))
            event_identity(event, start, config)
            payload = event.model_dump(mode="json")
            if event.event_id in sent:
                require(sent[event.event_id] == payload, "retry changed event payload")
            else:
                require(event.source_sequence == len(sent)+1, "noncontiguous transmitted sequence")
                sent[event.event_id] = payload
        elif op == "send_result":
            receipt = EventReceipt.model_validate(row.get("receipt"))
            require(receipt.run_id == start["run_id"] and receipt.event_id == row.get("event_id") and
                    receipt.event_id in sent and receipt.event_id not in receipts, "invalid or repeated receipt")
            receipts.add(receipt.event_id)
    require(predictions, "no analyzed frames")
    terminal = [event for key, event in sent.items() if key not in predicted]
    require(len(terminal) == 1 and terminal[0]["event_kind"] == "UNAVAILABLE" and
            terminal[0]["reason_code"] == "EOF" and terminal[0]["source_sequence"] == len(sent),
            "expected exactly one final EOF event")
    require(terminal[0]["media_time_ms"] == predictions[-1].media_time_ms, "EOF media time mismatch")
    require(all(sent.get(key) == event for key, event in predicted.items()) and receipts == set(sent),
            "missing, altered or unacknowledged prediction events")
    result = finish.get("result", {})
    require(isinstance(result, dict), "finished result must be a JSON object")
    require(result.get("run_id") == start["run_id"] and result.get("termination") == "EOF", "run did not finish at EOF")
    require(len(preflights) == 1, "expected one preflight")
    for field, expected in (("frames", preflights[0]), ("analyzed_frames", len(predictions)),
                            ("skipped_late_frames", skipped), ("accepted_events", len(receipts))):
        require(TypeAdapter(NonnegativeInt).validate_python(result.get(field), strict=True) == expected,
                f"finished {field} disagrees with log")
    elapsed = result.get("processing_elapsed_ms")
    if elapsed is not None:
        elapsed = TypeAdapter(NonnegativeNumber).validate_python(elapsed, strict=True)
    return start, config, predictions, list(predicted.values()), elapsed, skipped


def fraction(numerator, denominator):
    return dict(value=numerator / denominator if denominator else None,
                numerator=numerator, denominator=denominator)


def score_events(events, truth):
    classes = {}
    for hazard in ("FIRE", "SMOKE"):
        groups = []
        for event in (e for e in events if e["event_kind"] == "ALARM" and e["hazard_type"] == hazard):
            at = event["media_time_ms"]
            if not groups or at - groups[-1]["last_alarm_ms"] > GAP_MS:
                groups.append(dict(start_ms=at, last_alarm_ms=at, event_ids=[]))
            groups[-1]["last_alarm_ms"] = at
            groups[-1]["event_ids"].append(event["event_id"])
        intervals = sorted((e for e in truth.events if e.hazard_type == hazard), key=lambda e: e.start_ms)
        matched, latencies = set(), []
        for group in groups:
            match = next((e for e in intervals if e.event_id not in matched and
                          e.start_ms <= group["start_ms"] < e.end_ms), None)
            group["truth_event_id"] = match.event_id if match else None
            group["latency_ms"] = group["start_ms"] - match.start_ms if match else None
            if match:
                matched.add(match.event_id)
                latencies.append(group["latency_ms"])
        tp, fp, fn = len(matched), len(groups)-len(matched), len(intervals)-len(matched)
        classes[hazard] = dict(tp=tp, fp=fp, fn=fn, precision=fraction(tp, tp+fp), recall=fraction(tp, tp+fn),
                               predicted_events=groups,
                               missed_events=[e.model_dump() for e in intervals if e.event_id not in matched],
                               latency_ms=dict(count=len(latencies), values=latencies,
                                               mean=statistics.fmean(latencies) if latencies else None,
                                               maximum=max(latencies) if latencies else None),
                               normal_video_false_alarms=dict(
                                   fp=fp if truth.normal_video else None,
                                   duration_ms=truth.duration_ms if truth.normal_video else None,
                                   per_hour=fp*3600000/truth.duration_ms if truth.normal_video else None))
    return classes


def evaluate(prediction_bytes, truth_bytes):
    truth = GroundTruth.model_validate(decode(truth_bytes.decode("utf-8")))
    rows = [decode(line) for line in prediction_bytes.decode("utf-8").splitlines() if line.strip()]
    start, config, frames, events, elapsed, skipped = read_run(rows, truth)
    return dict(schema_version=1, scope="SINGLE_VIDEO_EVENT_METRICS", dataset_split=truth.split,
                performance_verdict="NOT_ASSESSED", asset_id=truth.asset_id, scene_id=truth.scene_id,
                run_id=start["run_id"], source_id=start["source_id"], source_type="VIDEO_AI",
                video_sha256=truth.video_sha256, model_sha256=config.model_sha256,
                inputs=dict(predictions_sha256=hashlib.sha256(prediction_bytes).hexdigest(),
                            ground_truth_sha256=hashlib.sha256(truth_bytes).hexdigest()),
                config=config.model_dump(mode="json"), runtime=start.get("runtime"),
                annotation=truth.model_dump(mode="json"),
                matching=dict(merge_gap_ms=GAP_MS, boundary_tolerance_ms=0,
                              truth_interval="[start_ms,end_ms)", rule="prediction_start_one_to_one"),
                classes=score_events(events, truth),
                processing=dict(analyzed_frames=len(frames), skipped_late_frames=skipped,
                                video_loop_elapsed_ms=elapsed,
                                video_loop_frames_per_second=len(frames)*1000/elapsed if elapsed else None,
                                max_read_to_completion_ms=max(f.read_to_completion_ms for f in frames)),
                limitations=["Input provenance and annotations are declarations, not independently authenticated.",
                             "No accuracy pass/fail, mAP, field generalization or dataset-wide score is inferred.",
                             "Loop throughput includes playback, transmission and logging; excludes model/preflight setup.",
                             "Read-to-completion starts after frame read and includes playback waiting and event preparation; not inference-only time.",
                             "Null runtime/elapsed fields in older logs mean unrecorded evidence, not zero cost."])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--ground-truth", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.predictions.read_bytes(), args.ground_truth.read_bytes())
        serialized = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(serialized + "\n")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"AI evaluation rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(dict(output=str(args.output), scope=report["scope"],
                          dataset_split=report["dataset_split"], performance_verdict="NOT_ASSESSED")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

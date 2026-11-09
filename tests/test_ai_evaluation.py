"""Hand-computed event metrics using explicitly synthetic fixture annotations/logs."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
from uuid import uuid4

import pytest

from tools.evaluate_ai import GroundTruth, decode, evaluate, main
from ai_worker.inference import package_version

ROOT = Path(__file__).resolve().parents[1]


def test_unavailable_distribution_metadata_is_null_without_stopping_inference(monkeypatch):
    def version(name):
        if name == "opencv-python":
            raise importlib.metadata.PackageNotFoundError(name)
        return "fixture-version"
    monkeypatch.setattr(importlib.metadata, "version", version)
    assert package_version("opencv-python") is None
    assert package_version("torch") == "fixture-version"


def truth(events=(), duration=5000, **changes):
    return dict(schema_version=1, asset_id="fixture-video", scene_id="fixture-scene",
                video_sha256="a"*64, source="fixture://synthetic-not-independent-evaluation",
                split="fixture", annotator="fixture-author", reviewer="fixture-reviewer",
                annotation_complete=True, training_overlap="unknown", development_used=False,
                duration_ms=duration, normal_video=not events,
                events=[dict(event_id=f"truth-{i}", hazard_type=h, start_ms=start, end_ms=end)
                        for i, (h, start, end) in enumerate(events)]) | changes


def log_rows(samples, duration=5000):
    config = json.loads((ROOT / "configs/ai.example.json").read_text(encoding="utf-8"))
    run_id, sequence = str(uuid4()), 0
    base = datetime(2026, 11, 9, tzinfo=timezone.utc)
    utc = lambda ms: (base + timedelta(milliseconds=ms)).isoformat().replace("+00:00", "Z")
    rows = []
    def record(operation, at=0, **fields):
        rows.append(dict(operation=operation, run_id=run_id, source_id="CAM-A", source_type="VIDEO_AI",
                         recorded_at=utc(at), **fields))
    def event(kind, media, hazard=None):
        nonlocal sequence
        sequence += 1
        return dict(schema_version=1, run_id=run_id, building_id="TWO_ROUTE", building_version=1,
                    source_id="CAM-A", source_type="VIDEO_AI", event_id=str(uuid4()), source_sequence=sequence,
                    event_kind=kind, observed_at=utc(media if kind != "UNAVAILABLE" else duration),
                    media_time_ms=media, hazard_type=hazard, confidence=.9 if hazard else None,
                    validity="UNAVAILABLE" if kind == "UNAVAILABLE" else "VALID",
                    reason_code="EOF" if kind == "UNAVAILABLE" else None)
    def deliver(value, at):
        record("send_attempt", at, attempt=1, event=deepcopy(value))
        record("send_result", at, attempt=1, event_id=value["event_id"],
               receipt=dict(event_id=value["event_id"], run_id=run_id, accepted=True,
                            duplicate=False, guidance_version=0))
    record("start", config=config, video_sha256="a"*64, video_name="synthetic-fixture",
           runtime={"purpose": "test_fixture_not_hardware_evidence"})
    record("video_preflight", decoded_frames=len(samples), method="fixture_not_actual_decode")
    for i, (at, hazards) in enumerate(samples):
        events = [event("ALARM", at, h) for h in hazards] if hazards else [event("OBSERVATION", at)]
        record("prediction", at+5, frame_index=i, media_time_ms=at, observed_at=utc(at),
               inference_completed_at=utc(at+5), read_to_completion_ms=5.0, events=events, detections=[])
        for value in events: deliver(value, at+5)
    deliver(event("UNAVAILABLE", samples[-1][0]), duration)
    record("finished", duration, result=dict(run_id=run_id, frames=len(samples), analyzed_frames=len(samples),
           skipped_late_frames=0, accepted_events=sequence, termination="EOF", processing_elapsed_ms=float(duration)))
    return rows


def encoded(rows, annotation):
    return ("\n".join(json.dumps(r) for r in rows)+"\n").encode(), json.dumps(annotation).encode()


def metrics(samples, events=(), duration=5000):
    return evaluate(*encoded(log_rows(samples, duration), truth(events, duration)))


def test_hand_calculated_tp_fp_fn_gap_boundary_and_media_latency():
    report = metrics([(0, []), (500, ["FIRE"]), (1000, ["FIRE"]), (2000, ["FIRE"]),
                      (3500, ["FIRE"]), (4000, ["SMOKE"]), (4500, ["SMOKE"])],
                     [("FIRE", 400, 3000), ("FIRE", 4800, 4900), ("SMOKE", 3900, 4800)])
    fire, smoke = report["classes"]["FIRE"], report["classes"]["SMOKE"]
    assert (fire["tp"], fire["fp"], fire["fn"]) == (1, 1, 1)
    assert fire["precision"] == fire["recall"] == dict(value=.5, numerator=1, denominator=2)
    assert fire["latency_ms"]["values"] == [100]
    assert fire["missed_events"][0]["start_ms"] == 4800
    assert len(fire["predicted_events"][0]["event_ids"]) == 3  # exactly 1000ms stays one event
    assert (smoke["tp"], smoke["fp"], smoke["fn"]) == (1, 0, 0)
    assert smoke["latency_ms"]["mean"] == 100
    assert fire["normal_video_false_alarms"] == dict(fp=None, duration_ms=None, per_hour=None)
    assert report["processing"]["video_loop_frames_per_second"] == 1.4
    assert report["dataset_split"] == "fixture" and report["performance_verdict"] == "NOT_ASSESSED"


def test_repeated_prediction_event_in_one_truth_interval_is_fp():
    fire = metrics([(500, ["FIRE"]), (2000, ["FIRE"])], [("FIRE", 0, 4000)])["classes"]["FIRE"]
    assert (fire["tp"], fire["fp"], fire["fn"]) == (1, 1, 0)


@pytest.mark.parametrize("samples", [[(1000, ["FIRE"])], [(500, ["FIRE"]), (1500, ["FIRE"])]])
def test_half_open_end_and_event_start_rule(samples):
    events = [("FIRE", 0, 1000)] if len(samples) == 1 else [("FIRE", 1000, 2000)]
    fire = metrics(samples, events)["classes"]["FIRE"]
    assert (fire["tp"], fire["fp"], fire["fn"]) == (0, 1, 1)


def test_zero_denominators_and_missed_events_are_visible():
    report = metrics([(0, [])], [("FIRE", 0, 500)])
    fire, smoke = report["classes"]["FIRE"], report["classes"]["SMOKE"]
    assert fire["precision"] == dict(value=None, numerator=0, denominator=0)
    assert fire["recall"] == dict(value=0, numerator=0, denominator=1)
    assert fire["fn"] == 1 and fire["latency_ms"]["count"] == 0
    assert smoke["precision"]["value"] is None and smoke["recall"]["value"] is None


def test_simultaneous_classes_match_independently():
    report = metrics([(500, ["FIRE", "SMOKE"])], [("FIRE", 0, 1000), ("SMOKE", 400, 800)])
    assert report["classes"]["FIRE"]["latency_ms"]["values"] == [500]
    assert report["classes"]["SMOKE"]["latency_ms"]["values"] == [100]


def test_normal_video_fp_rate_uses_event_count_and_full_duration():
    smoke = metrics([(0, ["SMOKE"]), (1000, ["SMOKE"]), (2500, ["SMOKE"])],
                    duration=3600000)["classes"]["SMOKE"]
    assert smoke["normal_video_false_alarms"] == dict(fp=2, duration_ms=3600000, per_hour=2)


def test_transport_retry_does_not_inflate_detections_and_hashes_bind_inputs():
    rows = log_rows([(0, ["FIRE"])])
    index = next(i for i, r in enumerate(rows) if r["operation"] == "send_attempt")
    duplicate = deepcopy(rows[index])
    duplicate["attempt"] = 2
    rows.insert(index+1, duplicate)
    data, annotation = encoded(rows, truth())
    report = evaluate(data, annotation)
    assert report["classes"]["FIRE"]["fp"] == 1
    assert report["inputs"]["predictions_sha256"] == hashlib.sha256(data).hexdigest()
    assert report["inputs"]["ground_truth_sha256"] == hashlib.sha256(annotation).hexdigest()


@pytest.mark.parametrize("change", ["hash", "mixed_source", "mixed_run", "failed", "missing_receipt",
                                   "altered_payload", "frame_time", "finished_count", "missing_start",
                                   "sequence", "old_termination", "negative_elapsed", "duplicate_prediction"])
def test_invalid_or_incomplete_evidence_is_rejected(change):
    rows, gt = log_rows([(0, ["FIRE"]), (500, ["FIRE"])]), truth()
    frame = next(r for r in rows if r["operation"] == "prediction")
    attempt = next(r for r in rows if r["operation"] == "send_attempt")
    if change == "hash": gt["video_sha256"] = "b"*64
    elif change == "mixed_source": rows[2]["source_type"] = "SIM_SMOKE_DETECTOR"
    elif change == "mixed_run": rows[2]["run_id"] = str(uuid4())
    elif change == "failed": rows[-1]["operation"] = "failed"
    elif change == "missing_receipt": rows.pop(next(i for i, r in enumerate(rows) if r["operation"] == "send_result"))
    elif change == "altered_payload": attempt["event"]["confidence"] = .8
    elif change == "frame_time": frame["events"][0]["media_time_ms"] = 1
    elif change == "finished_count": rows[-1]["result"]["analyzed_frames"] = 99
    elif change == "missing_start": rows.pop(0)
    elif change == "sequence": attempt["event"]["source_sequence"] = 10
    elif change == "old_termination": rows[-1]["result"]["termination"] = "READ_ENDED_UNVERIFIED"
    elif change == "negative_elapsed": rows[-1]["result"]["processing_elapsed_ms"] = -1
    elif change == "duplicate_prediction": rows.insert(3, deepcopy(frame))
    with pytest.raises(ValueError): evaluate(*encoded(rows, gt))


@pytest.mark.parametrize("change", ["overlap", "duplicate_id", "end", "incomplete", "not_bool",
                                   "normal_with_event", "evaluation_development", "evaluation_training", "unreviewed"])
def test_invalid_annotations_cannot_be_scored(change):
    gt = truth([("FIRE", 0, 1000), ("FIRE", 1000, 2000)])
    if change == "overlap": gt["events"][1]["start_ms"] = 999
    elif change == "duplicate_id": gt["events"][1]["event_id"] = gt["events"][0]["event_id"]
    elif change == "end": gt["events"][1]["end_ms"] = 5001
    elif change == "incomplete": gt["annotation_complete"] = False
    elif change == "not_bool": gt["annotation_complete"] = 1
    elif change == "normal_with_event": gt["normal_video"] = True
    else:
        gt["split"] = "evaluation"
        if change == "evaluation_development": gt["development_used"] = True
        elif change == "evaluation_training": gt["training_overlap"] = "known"
        elif change == "unreviewed": gt["reviewer"] = None
    with pytest.raises(ValueError): GroundTruth.model_validate(gt)


@pytest.mark.parametrize("data", ['{"x":1,"x":2}', '{"x":NaN}', '{"x":1e999}', '[]'])
def test_nonfinite_duplicate_or_nonobject_json_is_rejected(data):
    with pytest.raises(ValueError): decode(data)


def test_older_log_without_runtime_or_loop_duration_marks_missing_evidence():
    rows = log_rows([(0, [])])
    rows[0].pop("runtime")
    rows[-1]["result"].pop("processing_elapsed_ms")
    report = evaluate(*encoded(rows, truth()))
    assert report["runtime"] is None
    assert report["processing"]["video_loop_frames_per_second"] is None


def test_cli_writes_fixture_report_but_never_overwrites_existing_output(tmp_path, capsys):
    data, gt = encoded(log_rows([(0, [])]), truth())
    predictions, annotations, output = [tmp_path / f for f in ("predictions.jsonl", "truth.json", "report.json")]
    predictions.write_bytes(data)
    annotations.write_bytes(gt)
    args = ["--predictions", str(predictions), "--ground-truth", str(annotations), "--output", str(output)]
    assert main(args) == 0
    previous = output.read_bytes()
    assert json.loads(previous)["dataset_split"] == "fixture"
    assert main(args) == 1 and output.read_bytes() == previous
    assert "rejected" in capsys.readouterr().err


def test_cli_invalid_input_returns_failure_without_report(tmp_path):
    p, gt, out = [tmp_path / f for f in ("bad.jsonl", "truth.json", "report.json")]
    p.write_text("{}", encoding="utf-8")
    gt.write_text(json.dumps(truth()), encoding="utf-8")
    assert main(["--predictions", str(p), "--ground-truth", str(gt), "--output", str(out)]) == 1
    assert not out.exists()

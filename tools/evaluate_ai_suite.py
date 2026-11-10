"""Revalidate and aggregate an explicit list of completed VIDEO_AI runs, without a performance verdict."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys
from typing import Annotated

from pydantic import Field

from backend.contracts.common import Identifier, SchemaVersion, Text, WireModel
from .evaluate_ai import decode, evaluate, fraction, require


class Entry(WireModel):
    asset_id: Identifier
    predictions: Text
    ground_truth: Text


class Manifest(WireModel):
    schema_version: SchemaVersion
    entries: Annotated[list[Entry], Field(min_length=1)]


def aggregate(reports):
    classes = {}
    normal_ms = sum(r["annotation"]["duration_ms"] for r in reports if r["annotation"]["normal_video"])
    for hazard in ("FIRE", "SMOKE"):
        tp, fp, fn = (sum(r["classes"][hazard][k] for r in reports) for k in ("tp", "fp", "fn"))
        delays = [value for r in reports for value in r["classes"][hazard]["latency_ms"]["values"]]
        normal_fp = sum(r["classes"][hazard]["fp"] for r in reports if r["annotation"]["normal_video"])
        classes[hazard] = dict(tp=tp, fp=fp, fn=fn, precision=fraction(tp, tp+fp), recall=fraction(tp, tp+fn),
            latency_ms=dict(count=len(delays), values=delays, mean=statistics.fmean(delays) if delays else None,
                            maximum=max(delays, default=None)),
            normal_video_false_alarms=dict(fp=normal_fp, duration_ms=normal_ms,
                                           per_hour=normal_fp*3600000/normal_ms if normal_ms else None))
    count = sum(r["processing"]["analyzed_frames"] for r in reports)
    elapsed = [r["processing"]["video_loop_elapsed_ms"] for r in reports]
    total_ms = sum(elapsed) if all(value is not None for value in elapsed) else None
    scenes = {}
    for r in reports:
        scenes.setdefault(r["scene_id"], []).append(r["asset_id"])
    return dict(video_count=len(reports), scene_groups=scenes, scene_group_count=len(scenes),
        duration_ms=sum(r["annotation"]["duration_ms"] for r in reports), classes=classes,
        processing=dict(analyzed_frames=count,
            skipped_late_frames=sum(r["processing"]["skipped_late_frames"] for r in reports),
            video_loop_elapsed_ms=total_ms, elapsed_recorded_videos=sum(value is not None for value in elapsed),
            video_loop_frames_per_second=count*1000/total_ms if total_ms else None,
            max_read_to_completion_ms=max(r["processing"]["max_read_to_completion_ms"] for r in reports)))


def evaluate_suite(manifest_bytes, base_dir):
    manifest = Manifest.model_validate(decode(manifest_bytes.decode("utf-8")))
    requested = [entry.asset_id for entry in manifest.entries]
    require(len(set(requested)) == len(requested), "duplicate requested asset_id")
    cases, reports, videos = [], [], set()
    common = None
    for entry in manifest.entries:
        case = dict(asset_id=entry.asset_id, predictions=entry.predictions, ground_truth=entry.ground_truth,
                    status="FAILED", inputs={})
        cases.append(case)
        try:
            pred = (base_dir / entry.predictions).read_bytes()
            case["inputs"]["predictions_sha256"] = hashlib.sha256(pred).hexdigest()
            truth = (base_dir / entry.ground_truth).read_bytes()
            case["inputs"]["ground_truth_sha256"] = hashlib.sha256(truth).hexdigest()
            result = evaluate(pred, truth)
            # Keep the validated per-video metrics even when the suite consistency gate rejects them.
            case["report"] = result
            require(result["asset_id"] == entry.asset_id, "requested asset_id disagrees with ground truth")
            require(result["video_sha256"] not in videos, "duplicate video SHA-256")
            identity = {key: result[key] for key in ("dataset_split", "config", "matching", "runtime")}
            require(common is None or identity == common, "mixed split, config, matching or runtime declarations")
            common = identity
            videos.add(result["video_sha256"])
            reports.append(result)
            case["status"] = "VALIDATED"
        except (OSError, ValueError, KeyError, TypeError) as error:
            case["error"] = f"{type(error).__name__}: {error}"
    complete = len(reports) == len(manifest.entries)
    return dict(schema_version=1, scope="VIDEO_SUITE_EVENT_METRICS", status="COMPLETE" if complete else "INCOMPLETE",
        performance_verdict="NOT_ASSESSED", manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        requested_assets=requested, validated_videos=len(reports), failed_videos=len(cases)-len(reports),
        common=common if complete else None, cases=cases, aggregate=aggregate(reports) if complete else None,
        limitations=["The caller's manifest defines the requested denominator; this does not certify the final frozen evaluation list.",
            "No performance pass/fail, target agreement, independent review or training-overlap exclusion is inferred.",
            "Same scene_id clips remain one declared scene group, not independent scenes. Hash declarations do not prove provenance.",
            "Per-video matching never joins events across videos. Ratios use summed counts, not averages of video ratios.",
            "Loop elapsed time includes playback and transmission, not pure inference; any unknown duration makes total throughput unknown."])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Explicit asset/log/ground-truth list; paths relative to this file")
    parser.add_argument("--output", type=Path, required=True, help="New JSON result file; never overwrite")
    args = parser.parse_args(argv)
    try:
        result = evaluate_suite(args.manifest.read_bytes(), args.manifest.resolve().parent)
        serialized = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(serialized + "\n")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"AI suite rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(dict(status=result["status"], validated_videos=result["validated_videos"],
                          failed_videos=result["failed_videos"], performance_verdict="NOT_ASSESSED")))
    return 0 if result["status"] == "COMPLETE" else 1


if __name__ == "__main__":
    raise SystemExit(main())

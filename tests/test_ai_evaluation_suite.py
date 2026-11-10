"""Synthetic fixtures only: no independent evaluation annotations are opened."""
import hashlib
import json

import pytest

from test_ai_evaluation import encoded, log_rows, truth
from tools.evaluate_ai_suite import evaluate_suite, main


def case(tmp_path, key, samples, events=(), duration=5000, scene="same-scene"):
    rows = log_rows(samples, duration)
    digest = hashlib.sha256(key.encode()).hexdigest()
    rows[0]["video_sha256"] = digest
    annotation = truth(events, duration, asset_id=key, scene_id=scene, video_sha256=digest)
    pred, gt = encoded(rows, annotation)
    (tmp_path / f"{key}.jsonl").write_bytes(pred)
    (tmp_path / f"{key}.json").write_bytes(gt)
    return dict(asset_id=key, predictions=f"{key}.jsonl", ground_truth=f"{key}.json")


def manifest(entries):
    return json.dumps(dict(schema_version=1, entries=entries)).encode()


def test_counts_are_summed_not_video_ratios_and_scene_groups_remain_visible(tmp_path):
    entries = [case(tmp_path, "fire", [(500, ["FIRE"])], [("FIRE", 0, 900), ("SMOKE", 0, 900)], 1000),
               case(tmp_path, "normal-a", [(0, ["FIRE"]), (2000, ["FIRE"])], duration=5000),
               case(tmp_path, "normal-b", [(0, [])], duration=15000, scene="other-scene")]
    raw = manifest(entries)
    r = evaluate_suite(raw, tmp_path)
    assert r["status"] == "COMPLETE" and r["performance_verdict"] == "NOT_ASSESSED"
    assert r["manifest_sha256"] == hashlib.sha256(raw).hexdigest()
    total = r["aggregate"]
    assert total["video_count"] == 3 and total["scene_group_count"] == 2
    assert total["scene_groups"]["same-scene"] == ["fire", "normal-a"]
    fire, smoke = total["classes"]["FIRE"], total["classes"]["SMOKE"]
    assert (fire["tp"], fire["fp"], fire["fn"]) == (1, 2, 0)
    assert fire["precision"] == dict(value=1/3, numerator=1, denominator=3)
    assert fire["normal_video_false_alarms"] == dict(fp=2, duration_ms=20000, per_hour=360)
    assert fire["latency_ms"] == dict(count=1, values=[500], mean=500, maximum=500)
    assert smoke["fn"] == 1 and smoke["precision"]["value"] is None and smoke["recall"]["value"] == 0
    assert r["cases"][0]["report"]["classes"]["SMOKE"]["missed_events"]
    assert total["processing"]["video_loop_frames_per_second"] == 4/21
    assert total["processing"]["analyzed_frames"] == 4


@pytest.mark.parametrize("bad", ["missing_log", "incomplete_truth", "unreviewed_evaluation", "unfinished_log",
                                "wrong_asset", "duplicate_video", "mixed_config", "mixed_runtime", "mixed_split"])
def test_failure_is_retained_and_never_becomes_partial_whole_suite_score(tmp_path, bad):
    entries = [case(tmp_path, key, [(0, [])]) for key in ["a", "b", "c"]]
    gt = json.loads((tmp_path / "b.json").read_bytes())
    rows = [json.loads(line) for line in (tmp_path / "b.jsonl").read_text(encoding="utf-8").splitlines()]
    if bad == "missing_log": entries[1]["predictions"] = "missing.jsonl"
    elif bad == "incomplete_truth": gt["annotation_complete"] = False
    elif bad == "unreviewed_evaluation": gt.update(split="evaluation", reviewer=None)
    elif bad == "unfinished_log": rows.pop()
    elif bad == "wrong_asset": gt["asset_id"] = "not-b"
    elif bad == "duplicate_video":
        gt["video_sha256"] = rows[0]["video_sha256"] = hashlib.sha256(b"a").hexdigest()
    elif bad == "mixed_config": rows[0]["config"]["confidence"] = .3
    elif bad == "mixed_runtime": rows[0]["runtime"] = {"purpose": "different"}
    elif bad == "mixed_split": gt["split"] = "development"
    pred, annotation = encoded(rows, gt)
    (tmp_path / "b.jsonl").write_bytes(pred)
    (tmp_path / "b.json").write_bytes(annotation)
    r = evaluate_suite(manifest(entries), tmp_path)
    assert r["status"] == "INCOMPLETE" and r["aggregate"] is None and r["common"] is None
    assert r["validated_videos"] == 2 and r["failed_videos"] == 1
    assert [c["status"] for c in r["cases"]] == ["VALIDATED", "FAILED", "VALIDATED"]
    assert r["cases"][1]["error"]


def test_unknown_elapsed_and_absent_normal_denominator_are_not_zero_cost_or_perfect_score(tmp_path):
    entries = [case(tmp_path, key, [(500, ["FIRE"])], [("FIRE", 0, 1000)]) for key in ["a", "b"]]
    p = tmp_path / "a.jsonl"
    rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()]
    del rows[-1]["result"]["processing_elapsed_ms"]
    p.write_text("\n".join(json.dumps(row) for row in rows)+"\n", encoding="utf-8")
    r = evaluate_suite(manifest(entries), tmp_path)
    assert r["status"] == "COMPLETE"
    processing = r["aggregate"]["processing"]
    assert processing["elapsed_recorded_videos"] == 1
    assert processing["video_loop_elapsed_ms"] is None and processing["video_loop_frames_per_second"] is None
    assert r["aggregate"]["classes"]["FIRE"]["normal_video_false_alarms"] == dict(fp=0, duration_ms=0, per_hour=None)
    # Identical event times in different videos must not be merged into one incident.
    assert r["aggregate"]["classes"]["FIRE"]["tp"] == 2


@pytest.mark.parametrize("bad", ["empty", "duplicate_id", "extra_key"])
def test_invalid_list_is_rejected_before_any_output(tmp_path, bad):
    entries = [dict(asset_id="a", predictions="missing", ground_truth="missing")]
    if bad == "empty": entries = []
    elif bad == "duplicate_id": entries *= 2
    else: entries[0]["unexpected"] = True
    p, output = tmp_path / "manifest.json", tmp_path / "result.json"
    p.write_bytes(manifest(entries))
    assert main(["--manifest", str(p), "--output", str(output)]) == 1
    assert not output.exists()


def test_cli_resolves_paths_from_manifest_and_preserves_existing_output(tmp_path, monkeypatch):
    entry = case(tmp_path, "a", [(0, [])])
    p, output = tmp_path / "manifest.json", tmp_path / "result.json"
    p.write_bytes(manifest([entry]))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    assert main(["--manifest", str(p), "--output", str(output)]) == 0
    original = output.read_bytes()
    assert main(["--manifest", str(p), "--output", str(output)]) == 1
    assert output.read_bytes() == original
    (tmp_path / "a.jsonl").unlink()
    failure = tmp_path / "failed.json"
    assert main(["--manifest", str(p), "--output", str(failure)]) == 1
    assert json.loads(failure.read_bytes())["aggregate"] is None

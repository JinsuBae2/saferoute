import hashlib
import json
import sys
from types import SimpleNamespace

import pytest

from tools.validate_ai_model import summarize_frames, verify_file
from tools import validate_ai_model as trial


def test_trial_counts_frames_once_per_class_and_keeps_empty_detections():
    frames = [
        {"boxes": [{"class": "fire"}, {"class": "fire"}, {"class": "smoke"}],
         "predict_ms": 20, "rss_mib": 100},
        {"boxes": [], "predict_ms": 40, "rss_mib": 120},
    ]
    result = summarize_frames(frames)
    assert result["sampled_frames"] == 2
    assert result["frames_with_detection"] == {"fire": 1, "smoke": 1}
    assert result["predict_mean_ms"] == 30
    assert result["predict_p95_ms"] == 40
    assert result["sampled_rss_max_mib"] == 120
    with pytest.raises(ValueError, match="No decoded"):
        summarize_frames([])


def test_changed_or_missing_asset_cannot_silently_run(tmp_path):
    asset = tmp_path / "video.webm"
    asset.write_bytes(b"original")
    expected = hashlib.sha256(b"original").hexdigest()
    assert verify_file(asset, expected) == expected
    asset.write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_file(asset, expected)
    with pytest.raises(FileNotFoundError):
        verify_file(tmp_path / "missing", expected)


@pytest.mark.parametrize("timestamps, invalid, pace, predict_seconds", [
    ([0, 0, 500], False, False, 0), ([500, 0], True, False, 0),
    ([0, 0, 500], False, True, .1), ([0, 0, 500], False, True, 3.1),
])
def test_timestamp_sampling_and_playback_timing(tmp_path, monkeypatch, timestamps, invalid, pace, predict_seconds):
    clock = SimpleNamespace(now=0.0)

    def advance(seconds):
        clock.now += seconds

    monkeypatch.setattr(trial.time, "perf_counter", lambda: clock.now)
    monkeypatch.setattr(trial.time, "sleep", advance)

    class Capture:
        index = -1
        released = False

        def isOpened(self):
            return True

        def read(self):
            advance(.01)
            self.index += 1
            return self.index < len(timestamps), object()

        def get(self, prop):
            return timestamps[self.index] if prop == 0 else 0

        def release(self):
            self.released = True

    cap = Capture()
    cv2 = SimpleNamespace(VideoCapture=lambda _: cap, CAP_PROP_POS_MSEC=0,
                          CAP_PROP_FPS=1, CAP_PROP_FRAME_COUNT=2, CAP_PROP_FRAME_WIDTH=3,
                          CAP_PROP_FRAME_HEIGHT=4, CAP_PROP_FOURCC=5, imwrite=lambda *_: True)
    monkeypatch.setitem(sys.modules, "cv2", cv2)
    monkeypatch.setitem(sys.modules, "psutil", SimpleNamespace(
        Process=lambda: SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=1024**2))))
    empty = SimpleNamespace(tolist=lambda: [])
    result = SimpleNamespace(speed={}, boxes=SimpleNamespace(cls=empty, conf=empty, xyxy=empty),
                             plot=lambda: None)
    calls = []

    def predict(*args, **kwargs):
        calls.append(cap.index)
        advance(predict_seconds)
        return [result]

    model = SimpleNamespace(names={}, predict=predict)
    args = (model, {"path": "dummy.webm", "asset_id": "sample"}, tmp_path, tmp_path, 640, 500, .25)
    if invalid:
        with pytest.raises(ValueError, match="regressing"):
            trial.run_video(*args, pace=pace)
    else:
        report = trial.run_video(*args, pace=pace)
        assert report["decoded_frames"] == 3
        assert report["skipped_duplicate_timestamp_frames"] == 1
        assert report["sampled_frames"] == 2
        assert calls == [0, 2]
        frames = [json.loads(line) for line in (tmp_path / "sample.jsonl").read_text(encoding="utf-8").splitlines()]
        assert [(f["frame_index"], f["media_time_ms"]) for f in frames] == [(0, 0), (2, 500)]
        if pace and predict_seconds < 1:
            assert report["max_completion_gap_ms"] == pytest.approx(490)
            assert report["max_read_to_completion_ms"] == pytest.approx(470)
            assert report["max_playback_lateness_ms"] == pytest.approx(110)
        elif pace:
            assert report["max_completion_gap_ms"] > 3000
            assert report["max_playback_lateness_ms"] > 3000
        else:
            assert report["max_playback_lateness_ms"] is None
    assert cap.released


def test_default_manifest_uses_repo_and_duplicate_ids_fail_before_output(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    directory = root / "data/manifests"
    directory.mkdir(parents=True)
    (directory / "assets.json").write_text(json.dumps({
        "model": {}, "videos": [{"asset_id": name, "split": "development"} for name in ("sample", "SAMPLE")]
    }), encoding="utf-8")
    output = tmp_path / "output"
    monkeypatch.setattr(trial, "__file__", str(root / "tools/validate_ai_model.py"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["validate_ai_model", "--output", str(output)])
    with pytest.raises(ValueError, match="Duplicate asset_id"):
        trial.main()
    assert not output.exists()

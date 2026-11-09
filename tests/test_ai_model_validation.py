import hashlib

import pytest

from tools.validate_ai_model import summarize_frames, verify_file


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

"""The billable browser probe must reject unrelated video before starting services."""
import importlib.util
from pathlib import Path
import sys

import pytest


def test_browser_probe_rejects_wrong_video_before_any_service_start(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[1] / "deploy/resource-checks/a05-100-browser-server.py"
    spec = importlib.util.spec_from_file_location("browser_probe", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    video = tmp_path / "unrelated.mp4"
    video.write_bytes(b"not the authorized development video")
    output = tmp_path / "output"
    monkeypatch.setattr(sys, "argv", [str(source), "--video", str(video), "--output", str(output),
                                     "--ai-python", "unused", "--ai-config", "unused"])
    def forbidden(*args, **kwargs):
        raise AssertionError("no service or billable worker may start")
    monkeypatch.setattr(module, "launch", forbidden)
    with pytest.raises(ValueError, match="expected development candle"):
        module.main()
    assert not output.exists()

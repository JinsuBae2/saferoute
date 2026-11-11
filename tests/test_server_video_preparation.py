"""The server-copy evidence must fail closed even with Python optimization."""
import hashlib
import json
from pathlib import Path
import subprocess

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "deploy/resource-checks"


@pytest.mark.parametrize("fault", ["source_hash", "frames", "timestamps", None])
@pytest.mark.parametrize("script_name,output_dir,codec", [
    ("a01-81-prepare.sh", "server-video-preparation", "FFV1"),
    ("a01-84-prepare.sh", "server-video-preparation-utvideo", "UTVideo"),
])
def test_preparation_verifies_before_publishing(tmp_path, monkeypatch, fault, script_name, output_dir, codec):
    source = tmp_path / "smoke.webm"
    source.write_bytes(b"original")
    manifest_dir = tmp_path / "data/manifests"
    manifest_dir.mkdir(parents=True)
    asset = dict(asset_id="dev-smoke-0009", path="smoke.webm", split="development",
                 sha256="wrong" if fault == "source_hash" else hashlib.sha256(source.read_bytes()).hexdigest(),
                 transformation="Original bytes unchanged", read_validation={"fourcc": "AV01"},
                 license="original-license")
    (manifest_dir / "assets.json").write_text(json.dumps({"videos": [asset]}), encoding="utf-8")

    def fake_run(args, **kwargs):
        if "framemd5" in args:
            derived = str(args[args.index("-i") + 1]).endswith(".mkv")
            value = "different" if fault == "frames" and derived else "same"
            output = f"0, 0, 0, 1, 10, {value}\n"
        elif args[0] == "ffprobe":
            time = "0.1" if fault == "timestamps" and args[-1].endswith(".mkv") else "0.0"
            output = json.dumps({"frames": [{"best_effort_timestamp_time": time}]})
        else:
            Path(args[-1]).write_bytes(b"derived")
            output = ""
        return subprocess.CompletedProcess(args, 0, stdout=output)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.chdir(tmp_path)
    script = SCRIPTS / script_name
    embedded = script.read_text(encoding="utf-8").split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    optimized = compile(embedded, str(script), "exec", optimize=2)
    output = tmp_path / "runs" / output_dir / "assets.server.json"
    if fault:
        with pytest.raises(ValueError, match="mismatch"):
            exec(optimized, {})
        assert not output.exists()
    else:
        exec(optimized, {})
        derived = json.loads(output.read_text(encoding="utf-8"))["videos"][0]
        assert "read_validation" not in derived
        assert codec in derived["transformation"]
        assert derived["license"] == asset["license"]
        assert derived["split"] == "development"
        assert derived["server_derivation"]["original_sha256"] == asset["sha256"]
        assert source.read_bytes() == b"original"

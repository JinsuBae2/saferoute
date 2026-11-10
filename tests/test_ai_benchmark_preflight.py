"""The offline benchmark must reject non-development or mismatched inputs first."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest


@pytest.mark.parametrize('invalid', ['evaluation', 'video_hash'])
def test_benchmark_rejects_invalid_inputs_before_model_or_output(tmp_path, monkeypatch, invalid):
    root = Path(__file__).resolve().parents[1]
    source = root/'deploy/resource-checks/a01-105-benchmark.py'
    spec = importlib.util.spec_from_file_location('alternative_benchmark', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model, video = tmp_path/'model.pt', tmp_path/'video.mp4'
    model.write_bytes(b'fixture model')
    video.write_bytes(b'fixture video')
    config = json.loads((root/'configs/ai.example.json').read_bytes())
    config.update(model_path=str(model), model_sha256=hashlib.sha256(model.read_bytes()).hexdigest())
    config_path, manifest_path = tmp_path/'config.json', tmp_path/'manifest.json'
    config_path.write_text(json.dumps(config), encoding='utf-8')
    manifest_path.write_text(json.dumps({'videos':[dict(asset_id='fixture',path=str(video),
        split='evaluation' if invalid=='evaluation' else 'development',
        sha256='0'*64 if invalid=='video_hash' else hashlib.sha256(video.read_bytes()).hexdigest())]}), encoding='utf-8')
    output = tmp_path/'output'
    monkeypatch.setattr(sys, 'argv', [str(source),'--manifest',str(manifest_path),'--config',str(config_path),'--output',str(output)])
    def forbidden(*args, **kwargs):
        raise AssertionError('model must not load')
    monkeypatch.setattr(module, 'Detector', forbidden)
    with pytest.raises(ValueError, match='only development|SHA-256 mismatch'):
        module.main()
    assert not output.exists()

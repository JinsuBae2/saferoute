"""Offline CPU model comparison using existing frame probe; no control/API calls.

Run from repository root with PYTHONPATH=. and the AI environment. Model load and
ffprobe setup are excluded from predict_ms. Each input must be development-only.
"""
import argparse
import hashlib
import json
from pathlib import Path

from ai_worker.config import AIConfig
from ai_worker.inference import Detector, package_version
from ai_worker.video import inspect_video
from tools.validate_ai_delivery import select_assets
from tools.validate_ai_model import run_video, verify_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest_bytes, config_bytes = args.manifest.read_bytes(), args.config.read_bytes()
    manifest = json.loads(manifest_bytes)
    assets = select_assets(manifest, [a['asset_id'] for a in manifest['videos']])
    config = AIConfig.model_validate_json(config_bytes)
    verify_file(Path(config.model_path), config.model_sha256)
    for asset in assets:
        verify_file(Path(asset['path']), asset['sha256'])
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output/'config.json').write_bytes(config_bytes)
    report = dict(scope='DEVELOPMENT_CPU_PREDICT_PROBE', status='FAILED', config=config.model_dump(),
                  manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                  config_sha256=hashlib.sha256(config_bytes).hexdigest(), cases=[])
    try:
        detector = Detector(config)
        report['runtime'] = detector.metadata | {'dill': package_version('dill')}
        for asset in assets:
            preflight = inspect_video(Path(asset['path']))
            case = run_video(detector.model, asset, Path.cwd(), args.output,
                             config.imgsz, config.interval_ms, config.confidence)
            case['preflight'] = preflight
            if case['decoded_frames'] != preflight['decoded_frames']:
                raise ValueError('benchmark decode count differs from preflight')
            log_path = args.output/(asset['asset_id']+'.jsonl')
            case['predictions_sha256'] = hashlib.sha256(log_path.read_bytes()).hexdigest()
            report['cases'].append(case)
        report['status'] = 'PASS'
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (args.output/'summary.json').write_text(json.dumps(report, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'cases': len(report['cases'])}))


if __name__ == '__main__':
    main()

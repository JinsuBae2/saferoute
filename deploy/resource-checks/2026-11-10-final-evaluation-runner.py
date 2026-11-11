"""One-off frozen five-video evaluation; run from the isolated source root.

Inputs: runs/evaluation-inputs.server.json, committed final-evaluation-lock.json.
Never uses the development-only probe or changes labels/settings after inference.
"""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import threading
import time

import httpx
import uvicorn

from ai_worker.config import AIConfig
from backend.app import create_app
from backend.contracts.building import Building
from tools.validate_ai_delivery import check_observation_freshness, rows


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_bytes())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def main():
    lock = read('docs/ai/final-evaluation-lock.json')
    assert not lock['ground_truth_freeze_pending']
    assets = read('runs/evaluation-inputs.server.json')['videos']
    assert [a['asset_id'] for a in assets] == lock['selected_assets']
    config_path = Path('configs/ai.xiazh.clahe.native.development.json')
    assert AIConfig.model_validate_json(config_path.read_bytes()).model_dump() == lock['config']
    assert sha(lock['config']['model_path']) == lock['config']['model_sha256']
    for asset, frozen in zip(assets, lock['inputs']):
        assert asset['split'] == 'evaluation' and asset['asset_id'] == frozen['asset_id']
        assert sha(asset['path']) == asset['sha256'] == frozen['video_sha256']
        assert sha(frozen['ground_truth_path']) == frozen['ground_truth_sha256']
    out = Path('runs/final-evaluation')
    out.mkdir(exist_ok=False)
    building = Building.model_validate_json(Path('data/fixtures/two-route-v1.json').read_bytes())
    freshness = next(s.freshness_ms for s in building.sources if s.source_id == 'CAM-A')
    report = dict(status='RUNNING', scope='FROZEN_EVALUATION_AI_REVIEW_NOT_QA5',
                  started_at_utc=datetime.now(timezone.utc).isoformat(),
                  source_commit=lock['source_commit'], lock_sha256=sha('docs/ai/final-evaluation-lock.json'),
                  runner_sha256=sha(__file__), config_sha256=sha(config_path),
                  python=platform.python_version(), platform=platform.platform(), cpu_count=os.cpu_count(),
                  packages={p: importlib.metadata.version(p) for p in
                            ['numpy', 'opencv-python', 'torch', 'ultralytics', 'onnxruntime-ep-openvino', 'onnxruntime', 'fastapi']},
                  source_sha256={p.as_posix(): sha(p) for d in ['ai_worker', 'backend', 'tools']
                                 for p in sorted(Path(d).rglob('*.py'))},
                  load_before=os.getloadavg(), videos=[])
    write(out / 'summary.json', report)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    server = uvicorn.Server(uvicorn.Config(create_app(building=building, runs_dir=out/'backend'), log_level='warning'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    started = time.monotonic()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(.05)
        assert server.started
        with httpx.Client(base_url=f'http://127.0.0.1:{sock.getsockname()[1]}', trust_env=False, timeout=10) as client:
            for asset, frozen in zip(assets, lock['inputs']):
                session = client.get('/api/session'); session.raise_for_status()
                run_id = session.json()['run_id']
                result = dict(asset_id=asset['asset_id'], run_id=run_id, status='RUNNING',
                              video_sha256=asset['sha256'], ground_truth_sha256=frozen['ground_truth_sha256'])
                report['videos'].append(result); write(out/'summary.json', report)
                tick = time.monotonic()
                command = [sys.executable, '-m', 'ai_worker', '--config', str(config_path),
                           '--video', asset['path'], '--controller', str(client.base_url), '--runs-dir', str(out/'ai')]
                try:
                    proc = subprocess.run(command, capture_output=True, encoding='utf-8', timeout=600)
                    (out/(asset['asset_id']+'.console.txt')).write_text(proc.stdout+proc.stderr, encoding='utf-8')
                    result['exit_code'] = proc.returncode
                except subprocess.TimeoutExpired:
                    result['error'] = 'worker timeout after 600 seconds'
                result['elapsed_seconds'] = time.monotonic()-tick
                state = client.get('/api/state'); state.raise_for_status()
                write(out/(asset['asset_id']+'.state.json'), state.json())
                reset = client.post('/api/control/reset', json=dict(schema_version=1, run_id=run_id,
                                    reason='Frozen evaluation complete; preserve first execution including failures'))
                reset.raise_for_status()
                try:
                    prediction_path = out/'ai'/run_id/'ai-predictions.jsonl'
                    records = rows(prediction_path)
                    accepted = [r for r in rows(out/'backend'/run_id/'events.jsonl')
                                if r['operation']=='event' and r['outcome']=='accepted']
                    transmitted = {r['event']['event_id']:r['event'] for r in records if r['operation']=='send_attempt'}
                    received = {r['payload']['event_id']:r['payload'] for r in accepted}
                    observations = [r for r in accepted if r['payload']['event_kind'] in {'ALARM','OBSERVATION'}]
                    ages = [(datetime.fromisoformat(r['recorded_at'])-datetime.fromisoformat(r['payload']['observed_at'])).total_seconds()*1000 for r in observations]
                    gaps = [b['server_monotonic_ms']-a['server_monotonic_ms'] for a,b in zip(observations, observations[1:])]
                    alarms = Counter(r['payload']['hazard_type'] for r in observations if r['payload']['event_kind']=='ALARM')
                    expiry = sum(r['operation']=='expire' and 'CAM-A' in r.get('source_ids', []) for r in rows(out/'backend'/run_id/'decisions.jsonl'))
                    result.update(analyzed_frames=sum(r['operation']=='prediction' for r in records),
                                  accepted_events=len(accepted), alarms=dict(alarms), source_expirations=expiry,
                                  payload_match=bool(transmitted) and transmitted==received,
                                  termination=[e['reason_code'] for e in transmitted.values() if e['event_kind']=='UNAVAILABLE'],
                                  worker_result=next((r['result'] for r in records if r['operation']=='finished'),None),
                                  predictions_sha256=sha(prediction_path), max_acquisition_to_audit_ms=max(ages,default=None),
                                  max_observation_gap_ms=max(gaps,default=None),
                                  source_validity=next(s['validity'] for s in state.json()['sources'] if s['source_id']=='CAM-A'),
                                  retained_alarm_causes=set(alarms)=={c['hazard_type'] for c in state.json()['active_causes']})
                    try:
                        result['max_age_plus_following_gap_ms']=check_observation_freshness(ages,gaps,freshness,expiry)
                        result['freshness_pass']=True
                    except ValueError as error:
                        result.update(freshness_pass=False, freshness_error=str(error))
                    verify = subprocess.run([sys.executable,'-m','tools.verify_run',str(out/'backend'/run_id)],capture_output=True,encoding='utf-8',timeout=30)
                    result['log_integrity']=verify.returncode==0
                    metrics_path=out/(asset['asset_id']+'.metrics.json')
                    evaluate=subprocess.run([sys.executable,'-m','tools.evaluate_ai','--predictions',str(prediction_path),
                                             '--ground-truth',frozen['ground_truth_path'],'--output',str(metrics_path)],capture_output=True,encoding='utf-8',timeout=30)
                    result['evaluation_exit_code']=evaluate.returncode
                    if evaluate.returncode:
                        result['evaluation_error']=evaluate.stdout+evaluate.stderr
                    else:
                        result['metrics_sha256']=sha(metrics_path)
                    finished=result['worker_result'] or {}
                    checks=[result.get('exit_code')==0,result['payload_match'],result['termination']==['EOF'],
                            result['source_validity']=='UNAVAILABLE',result['retained_alarm_causes'],result['freshness_pass'],
                            result['log_integrity'],finished.get('skipped_late_frames')==0,evaluate.returncode==0]
                    result['status']='PASS' if all(checks) else 'FAIL'
                except Exception as error:
                    result.update(status='INCOMPLETE',error=f'{type(error).__name__}: {error}')
                write(out/'summary.json',report)
                print(json.dumps(result),flush=True)
    finally:
        server.should_exit=True; thread.join(timeout=10); sock.close()
        report.update(controller_stopped=not thread.is_alive(),elapsed_seconds=time.monotonic()-started,
                      finished_at_utc=datetime.now(timezone.utc).isoformat(),load_after=os.getloadavg())
        report['status']='COMPLETE' if len(report['videos'])==len(assets) and all(v['status'] not in {'RUNNING','INCOMPLETE'} for v in report['videos']) and not thread.is_alive() else 'INCOMPLETE'
        write(out/'summary.json',report)


if __name__ == '__main__':
    main()

"""Bounded, isolated A05 browser probe server; real Bedrock calls are billable.

Run from the repository root with PYTHONPATH=. in the explanation environment.
The output directory accepts fire/stop_explanation/reset/finish marker files.
Only this process's controller, explanation worker and AI child are controlled.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from uuid import uuid4

import httpx

from tools.validate_explanation import launch, stop_ai, wait_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ai-python', type=Path, required=True)
    parser.add_argument('--ai-config', type=Path, required=True)
    parser.add_argument('--video', type=Path, required=True)
    args = parser.parse_args()
    expected = '248be916e95fe7fa5155c94125d60abb3e611721f1f14de7629c2572eb99c3e5'
    if hashlib.sha256(args.video.read_bytes()).hexdigest() != expected:
        raise ValueError('expected development candle/match original')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    report = dict(scope='DEVELOPMENT_BROWSER_TWO_ROUTE', status='FAILED', actions=[],
                  video_sha256=expected, independent_v15='PENDING', children_stopped=False)
    children, ai, heartbeat = [], None, None
    stop = threading.Event()
    failures = []
    console = (out/'ai-console.txt').open('w', encoding='utf-8')
    try:
        controller, url = launch('controller', out/'runs')
        children.append(controller)
        with httpx.Client(base_url=url, timeout=2, trust_env=False) as control:
            session = wait_for(lambda: control.get('/api/session').raise_for_status().json())
            run_id = session['run_id']
            report['run_id'] = run_id

            def sensors():
                sequences = {'DETECTOR-A': 0, 'DETECTOR-B': 0}
                with httpx.Client(base_url=url, timeout=2, trust_env=False) as client:
                    while not stop.is_set():
                        try:
                            for source in sequences:
                                sequences[source] += 1
                                value = dict(schema_version=1, run_id=run_id, building_id='TWO_ROUTE', building_version=1,
                                    event_id=str(uuid4()), source_id=source, source_type='SIM_SMOKE_DETECTOR',
                                    source_sequence=sequences[source], event_kind='OBSERVATION', hazard_type=None,
                                    validity='VALID', observed_at=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
                                    media_time_ms=None, confidence=None, reason_code=None)
                                client.post('/api/events', json=value).raise_for_status()
                        except Exception as error:
                            failures.append(type(error).__name__)
                            return
                        stop.wait(.5)

            heartbeat = threading.Thread(target=sensors)
            heartbeat.start()
            wait_for(lambda: all(s['validity']=='VALID' for s in control.get('/api/state').json()['sources']
                                 if s['source_id'].startswith('DETECTOR-')))
            request = dict(schema_version=1, run_id=run_id, reason='A05 isolated browser development probe')
            control.post('/api/control/arm', json=request).raise_for_status()
            explanation, explanation_url = launch('explanation', out/'runs', url)
            children.append(explanation)
            (out/'connection.json').write_text(json.dumps(dict(controller_url=url, explanation_url=explanation_url,
                                                              run_id=run_id)), encoding='utf-8')
            handled = set()
            deadline = time.monotonic()+600
            fire_deadline = None
            while time.monotonic() < deadline:
                if failures:
                    raise RuntimeError('sensor heartbeat failed: '+','.join(failures))
                for action in ('fire', 'stop_explanation', 'reset', 'finish'):
                    if action in handled or not (out/action).is_file():
                        continue
                    if action == 'fire':
                        ai = subprocess.Popen([str(args.ai_python.absolute()), '-m', 'ai_worker',
                            '--config', str(args.ai_config.resolve()), '--video', str(args.video.resolve()),
                            '--controller', url, '--runs-dir', str(out/'ai')], cwd=Path.cwd(),
                            stdout=console, stderr=subprocess.STDOUT, env=os.environ|{'PYTHONUTF8':'1'})
                        fire_deadline = time.monotonic()+90
                    elif action == 'stop_explanation':
                        explanation.terminate()
                        explanation.join(timeout=15)
                        if explanation.is_alive():
                            raise RuntimeError('explanation did not stop')
                    elif action == 'reset':
                        if ai is None or ai.poll()!=0:
                            raise RuntimeError('reset requires successful completed AI run')
                        stop.set()
                        heartbeat.join(timeout=5)
                        if heartbeat.is_alive():
                            raise RuntimeError('sensor heartbeat did not stop')
                        control.post('/api/control/reset', json=request).raise_for_status()
                    elif action == 'finish':
                        if not {'fire','stop_explanation','reset'} <= handled or ai is None or ai.poll()!=0:
                            raise RuntimeError('finish requires fire, explanation stop, reset and successful AI')
                        report['status'] = 'COMPLETED_AWAITING_BROWSER_ASSERTIONS'
                    handled.add(action)
                    state = control.get('/api/state').raise_for_status().json()
                    report['actions'].append(dict(action=action, recorded_at=datetime.now(timezone.utc).isoformat(), state=state))
                    (out/'progress.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                if 'finish' in handled:
                    break
                if ai is not None:
                    if ai.poll() not in (None, 0):
                        raise RuntimeError('actual AI child failed')
                    if ai.poll() is None and time.monotonic() > fire_deadline:
                        raise TimeoutError('actual AI child exceeded 90 seconds')
                time.sleep(.2)
            else:
                raise TimeoutError('browser probe exceeded ten minute limit')
    except Exception as error:
        report['error_type'] = type(error).__name__
        report['error'] = str(error)
        raise
    finally:
        stop.set()
        if heartbeat:
            heartbeat.join(timeout=5)
        stop_ai(ai)
        console.close()
        for child in reversed(children):
            if child.is_alive():
                child.terminate()
                child.join(timeout=15)
                if child.is_alive():
                    child.kill()
                    child.join(timeout=5)
        report['children_stopped'] = all(not child.is_alive() for child in children) and (ai is None or ai.poll() is not None)
        (out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()

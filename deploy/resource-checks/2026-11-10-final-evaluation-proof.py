"""Reconstruct published closeout evidence from the preserved first server run.

PYTHONPATH=. python deploy/resource-checks/2026-11-10-final-evaluation-proof.py
Use --write only to create the new public report after downloading the raw archive.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

from tools.evaluate_ai_suite import evaluate_suite
from tools.validate_ai_delivery import check_observation_freshness, rows


def read(path):
    return json.loads(Path(path).read_bytes())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    root = Path('runs/final-evaluation-12-results/runs/final-evaluation').resolve()
    summary = read(root/'summary.json')
    lock = read('docs/ai/final-evaluation-lock.json')
    assert summary['lock_sha256'] == sha('docs/ai/final-evaluation-lock.json')
    assert summary['runner_sha256'] == sha(lock['runner_path']) == lock['runner_sha256']
    assert datetime.fromisoformat(summary['started_at_utc']) > datetime.fromisoformat(lock['frozen_at_utc'])
    assert [v['asset_id'] for v in summary['videos']] == lock['selected_assets']
    normalized_sources = {}
    source_archive = Path('runs/final-evaluation-12-source.tar')
    with tarfile.open(source_archive) as archive:
        for path, expected in summary['source_sha256'].items():
            actual = archive.extractfile(path).read()
            git_bytes = subprocess.check_output(['git','show',lock['source_commit']+':'+path])
            assert hashlib.sha256(actual).hexdigest() == expected, path
            assert actual.replace(b'\r\n',b'\n') == git_bytes.replace(b'\r\n',b'\n'), path
            normalized_sources[path] = hashlib.sha256(actual.replace(b'\r\n',b'\n')).hexdigest()
    assert summary['config_sha256'] == sha('configs/ai.xiazh.clahe.native.development.json') == lock['config_file_sha256']
    entries = []
    for case, frozen in zip(summary['videos'], lock['inputs']):
        pred = root/'ai'/case['run_id']/'ai-predictions.jsonl'
        truth = Path(frozen['ground_truth_path']).resolve()
        assert sha(pred) == case['predictions_sha256']
        assert sha(truth) == frozen['ground_truth_sha256'] == case['ground_truth_sha256']
        records = rows(pred)
        start = records[0]
        assert start['config'] == lock['config']
        assert start['video_sha256'] == frozen['video_sha256'] == case['video_sha256']
        assert datetime.fromisoformat(start['recorded_at']) > datetime.fromisoformat(lock['frozen_at_utc'])
        received = [r for r in rows(root/'backend'/case['run_id']/'events.jsonl')
                    if r['operation']=='event' and r['outcome']=='accepted']
        transmitted = {r['event']['event_id']:r['event'] for r in records if r['operation']=='send_attempt'}
        assert case['payload_match'] == (bool(transmitted) and transmitted == {r['payload']['event_id']:r['payload'] for r in received})
        assert case['termination'] == [e['reason_code'] for e in transmitted.values() if e['event_kind']=='UNAVAILABLE']
        assert case['analyzed_frames'] == sum(r['operation']=='prediction' for r in records)
        assert case['accepted_events'] == len(received)
        observations = [r for r in received if r['payload']['event_kind'] in {'ALARM','OBSERVATION'}]
        ages = [(datetime.fromisoformat(r['recorded_at'])-datetime.fromisoformat(r['payload']['observed_at'])).total_seconds()*1000 for r in observations]
        gaps = [b['server_monotonic_ms']-a['server_monotonic_ms'] for a,b in zip(observations,observations[1:])]
        expiry = sum(r['operation']=='expire' and 'CAM-A' in r.get('source_ids',[]) for r in rows(root/'backend'/case['run_id']/'decisions.jsonl'))
        assert case['source_expirations'] == expiry
        try:
            value = check_observation_freshness(ages,gaps,3000,expiry)
            assert case['freshness_pass'] and case['max_age_plus_following_gap_ms']==value
        except ValueError:
            assert not case['freshness_pass']
        verify = subprocess.run([sys.executable,'-m','tools.verify_run',str(root/'backend'/case['run_id'])],capture_output=True,encoding='utf-8',timeout=30)
        assert case['log_integrity'] == (verify.returncode==0)
        entries.append(dict(asset_id=case['asset_id'], predictions=str(pred), ground_truth=str(truth)))
    manifest = json.dumps(dict(schema_version=1, entries=entries),ensure_ascii=False).encode('utf-8')
    suite = evaluate_suite(manifest,Path('.'))
    assert suite['status']=='COMPLETE', [(c['asset_id'], c.get('error')) for c in suite['cases']]
    assert suite['common']['config']==lock['config'] and suite['common']['matching']==lock['matching']
    metrics = []
    for case in suite['cases']:
        r = case['report']
        metrics_path = root/(case['asset_id']+'.metrics.json')
        assert sha(metrics_path) == next(v['metrics_sha256'] for v in summary['videos'] if v['asset_id']==case['asset_id'])
        original = read(metrics_path)
        assert original == r
        c = {k:r[k] for k in ['asset_id','scene_id','run_id','video_sha256','inputs','annotation','processing']}
        c['classes']={}
        for hazard, values in r['classes'].items():
            c['classes'][hazard] = values | {'predicted_events': [
                {k:v for k,v in group.items() if k!='event_ids'} | {'alarm_sample_count':len(group['event_ids'])}
                for group in values['predicted_events']]}
        metrics.append(c)
    checks=[]
    def test(name, actual, target, op):
        checks.append(dict(name=name,actual=actual,target=target,status='INCOMPLETE' if actual is None else ('PASS' if op(actual,target) else 'FAIL')))
    targets=lock['targets'];agg=suite['aggregate']
    for hazard in ['FIRE','SMOKE']:
        c=agg['classes'][hazard]
        for metric in ['precision','recall']:
            test(hazard+'_'+metric,c[metric]['value'],targets[hazard][metric+'_min'],lambda a,b:a>=b)
        test(hazard+'_normal_fp_per_hour',c['normal_video_false_alarms']['per_hour'],targets['normal_false_alarms_per_hour_max_per_class'],lambda a,b:a<=b)
        test(hazard+'_max_matched_delay_ms',c['latency_ms']['maximum'],targets['matched_event_latency_ms_max'],lambda a,b:a<=b)
    test('skipped_late_frames',agg['processing']['skipped_late_frames'],0,lambda a,b:a==b)
    test('source_expirations',sum(c['source_expirations'] for c in summary['videos']),0,lambda a,b:a==b)
    for key in ['payload_match','log_integrity','freshness_pass','retained_alarm_causes']:
        test(key,all(c[key] for c in summary['videos']),True,lambda a,b:a==b)
    test('eof_unavailable',all(c['termination']==['EOF'] and c['source_validity']=='UNAVAILABLE' for c in summary['videos']),True,lambda a,b:a==b)
    test('controller_stopped',summary['controller_stopped'],True,lambda a,b:a==b)
    verdict=next((s for s in ['INCOMPLETE','FAIL'] if any(c['status']==s for c in checks)),'PASS')
    ports_before=(root.parent/'ports-before.txt').read_text(encoding='utf-8').splitlines()
    ports_after=(root.parent/'ports-after.txt').read_text(encoding='utf-8').splitlines()
    report=dict(schema_version=1,scope='FIRST_FROZEN_EVALUATION_AI_REVIEW_NOT_QA5',
                execution_status_note='execution.status describes completion of the requested runs. execution.videos[*].status PASS covers worker completion, delivery, EOF, freshness, zero skipped samples, log integrity and evaluator acceptance only; it is NOT a per-video performance pass. Only performance_verdict and target_checks assess the locked performance targets; this run is FAIL.',
                performance_verdict=verdict,targets=targets,target_checks=checks,
                source_commit=lock['source_commit'],freeze_sha256=sha('docs/ai/final-evaluation-lock.json'),
                source_archive_sha256=sha(source_archive), source_lf_sha256=normalized_sources,
                source_byte_note='Windows git archive emitted CRLF. Every server raw source hash matches archived bytes; LF-normalized bytes equal the stated Git commit. Raw and normalized hashes are distinct.',
                summary_sha256=sha(root/'summary.json'),raw_archive_sha256=sha('runs/final-evaluation-12-results.tar.gz'),
                execution=summary,aggregate=agg,cases=metrics,runtime=suite['common']['runtime'],
                ports_before=ports_before,ports_after=ports_after,
                limitations=['Codex sampled visual review, not QA5 human independent acceptance.',
                             'Model/protocol locked before labels; GT frozen before first prediction; no tuning after evaluation.',
                             'Original annotation intervals retained; small ignition and gradual smoke timing uncertain.',
                             '5 clips represent 3 declared scene groups; publisher training overlap unknown.',
                             'Short normal-video denominator is not field reliability; no mAP without box labels.',
                             'TWO_ROUTE isolated CPU single-worker execution, not WFI joint or deployment acceptance.'])
    target=Path('deploy/resource-checks/2026-11-10-final-evaluation.json')
    if '--write' in sys.argv:
        with target.open('x',encoding='utf-8') as stream:
            stream.write(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    else:
        assert read(target)==report
    print(json.dumps({'status':'EVIDENCE_RECONSTRUCTED','performance_verdict':verdict,'aggregate':agg},ensure_ascii=False))


if __name__=='__main__':
    main()

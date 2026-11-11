"""Development-only real inference/JPEG probe. Run in the AI Python environment.

Own loopback processes only; no Bedrock, deployment, independent accuracy or UI verdict.
"""

import argparse
import asyncio
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import cv2
import httpx
import psutil
import uvicorn

from tools.validate_explanation import wait_for, stop_ai as stop_parent

ROOT = Path(__file__).resolve().parents[1]


def stop_ai(process):
    children=[]
    if process is not None and process.poll() is None:
        try:
            children=psutil.Process(process.pid).children(recursive=True)
        except psutil.NoSuchProcess:
            pass
    stop_parent(process)
    for child in children:
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive=psutil.wait_procs(children,timeout=3)
    for child in alive:
        child.kill()
    psutil.wait_procs(alive,timeout=3)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def serve(kind, sock, output, controller, delay):
    if kind == 'controller':
        from backend.app import create_app
        app = create_app(runs_dir=Path(output))
    else:
        os.environ['SAFEROUTE_PREVIEW_CONTROLLER'] = controller
        from preview_worker.app import create_app
        app = create_app()
        if delay:
            @app.middleware('http')
            async def slow_upload(request, call_next):
                if request.url.path == '/internal/preview':
                    await asyncio.sleep(delay)
                return await call_next(request)
    uvicorn.Server(uvicorn.Config(app, log_level='warning', limit_concurrency=16)).run(sockets=[sock])


def launch(kind, output, controller='', delay=0):
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    url = f'http://127.0.0.1:{sock.getsockname()[1]}'
    process = multiprocessing.get_context('spawn').Process(target=serve, args=(kind,sock,str(output),controller,delay))
    process.start()
    sock.close()
    return process, url


def verify_frames(video, captures, predictions):
    by_id = {r['preview_frame_id']:r for r in predictions}
    selected = {c['metadata']['frame']['frame_index']:c for c in captures}
    cap = cv2.VideoCapture(str(video))
    index, checked = 0, []
    try:
        while selected:
            ok, frame = cap.read()
            if not ok: raise ValueError('captured frame absent from original video')
            capture = selected.pop(index, None)
            if capture:
                meta = capture['metadata']['frame']
                prediction = by_id[meta['frame_id']]
                assert meta['observed_at'] == prediction['observed_at']
                assert meta['inference_completed_at'] == prediction['inference_completed_at']
                assert meta['media_time_ms'] == prediction['media_time_ms']
                height,width = frame.shape[:2]
                assert (width,height)==(meta['width'],meta['height'])
                expected=[]
                for box in prediction['detections']:
                    coords=[min(1.,max(0.,x/size)) for x,size in zip(box['xyxy'],[width,height,width,height])]
                    if coords[0]<coords[2] and coords[1]<coords[3]:
                        expected.append(dict(hazard_type=box['class'],confidence=box['confidence'],xyxy=coords))
                assert expected==meta['detections']
                scale=min(1.,640/max(width,height))
                if scale<1: frame=cv2.resize(frame,(max(1,round(width*scale)),max(1,round(height*scale))))
                ok, encoded=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,80])
                assert ok and encoded.tobytes()==Path(capture['jpeg_path']).read_bytes()
                checked.append(dict(frame_id=meta['frame_id'],frame_index=index,
                                    jpeg_sha256=hashlib.sha256(encoded).hexdigest(),
                                    hazards=sorted({d['hazard_type'] for d in meta['detections']})))
            index+=1
    finally:
        cap.release()
    return checked


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--assets-root',type=Path,default=ROOT)
    args=parser.parse_args()
    assets_root=args.assets_root.resolve()
    manifest=json.loads((ROOT/'data/manifests/assets.json').read_text(encoding='utf-8'))
    model=assets_root/manifest['model']['path']
    assert digest(model)==manifest['model']['sha256']
    out=args.output.resolve()
    out.mkdir(parents=True,exist_ok=False)
    config=json.loads((ROOT/'configs/ai.example.json').read_text(encoding='utf-8'))
    config['model_path']=str(model)
    (out/'ai.local.json').write_text(json.dumps(config),encoding='utf-8')
    report=dict(scope='DEVELOPMENT_LOCAL_REAL_PREVIEW',status='FAILED',cases=[],children_stopped=False,
                model_sha256=manifest['model']['sha256'],independent_evaluation='NOT_PERFORMED')
    children=[]
    ai=None
    try:
        process,control_url=launch('controller',out/'backend')
        children.append(process)
        with httpx.Client(base_url=control_url,timeout=2,trust_env=False) as control:
            wait_for(lambda:control.get('/api/session').raise_for_status())
            process,preview_url=launch('preview',out,control_url)
            children.append(process)
            process,slow_url=launch('preview',out,control_url,2)
            children.append(process)
            # Reserve an unlistened port for an unavailable preview destination.
            with socket.socket() as unused:
                unused.bind(('127.0.0.1',0))
                missing_url=f'http://127.0.0.1:{unused.getsockname()[1]}'
                trials=[('normal','dev-flameless-candle',preview_url),('fire','dev-candle-match',preview_url),
                        ('smoke','dev-smoke-0009',preview_url),('slow-upload','dev-candle-match',slow_url),
                        ('offline','dev-candle-match',missing_url)]
                for name,key,url in trials:
                    asset=next(a for a in manifest['videos'] if a['asset_id']==key)
                    video=assets_root/asset['path']
                    assert asset['split']=='development' and digest(video)==asset['sha256']
                    session=control.get('/api/session').raise_for_status().json()
                    run_id=session['run_id']
                    case=dict(case=name,asset_id=key,video_sha256=asset['sha256'],run_id=run_id,status='FAILED')
                    report['cases'].append(case)
                    captures=[]
                    with httpx.Client(base_url=preview_url,timeout=1,trust_env=False) as reader:
                        wait_for(lambda:reader.get('/api/previews/CAM-A',params={'run_id':run_id}).raise_for_status())
                        console=(out/(name+'.console.txt')).open('w',encoding='utf-8')
                        try:
                            ai=subprocess.Popen([sys.executable,'-m','ai_worker','--config',str(out/'ai.local.json'),
                                '--video',str(video),'--controller',control_url,'--preview-url',url,
                                '--runs-dir',str(out/'ai')],cwd=ROOT,stdout=console,stderr=subprocess.STDOUT,
                                env=os.environ|{'PYTHONUTF8':'1'})
                            deadline=time.monotonic()+150
                            seen=set()
                            while ai.poll() is None:
                                if time.monotonic()>deadline: raise TimeoutError('AI development probe timed out')
                                response=reader.get('/api/previews/CAM-A',params={'run_id':run_id})
                                response.raise_for_status()
                                data=response.json()
                                if name in {'normal','fire','smoke'} and data['status']=='READY':
                                    frame=data['frame']
                                    if frame['frame_id'] not in seen:
                                        seen.add(frame['frame_id'])
                                        image=reader.get('/api/preview-frames/'+frame['frame_id']+'.jpg',
                                                         params={'run_id':run_id,'source_id':'CAM-A'})
                                        if image.status_code==200:
                                            assert image.headers['X-Preview-Frame-Id']==frame['frame_id']
                                            assert image.headers['Cache-Control']=='no-store'
                                            path=out/(frame['frame_id']+'.jpg')
                                            path.write_bytes(image.content)
                                            captures.append(dict(metadata=data,jpeg_path=str(path)))
                                        else: assert image.status_code==404
                                time.sleep(.05)
                            assert ai.returncode==0
                        finally:
                            stop_ai(ai)
                            console.close()
                        path=out/'ai'/run_id/'ai-predictions.jsonl'
                        records=[json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
                        predictions=[r for r in records if r['operation']=='prediction']
                        accepted=[json.loads(line) for line in (out/'backend'/run_id/'events.jsonl').read_text(encoding='utf-8').splitlines()]
                        accepted=[r['payload'] for r in accepted if r['operation']=='event' and r['outcome']=='accepted']
                        sent={r['event']['event_id']:r['event'] for r in records if r['operation']=='send_attempt'}
                        assert sent and sent=={e['event_id']:e for e in accepted}
                        result=next(r['result'] for r in records if r['operation']=='finished')
                        case.update(analyzed_frames=len(predictions),accepted_events=len(accepted),
                                    skipped_late_frames=result['skipped_late_frames'],payload_match=True,
                                    predictions_sha256=digest(path),captures=verify_frames(video,captures,predictions))
                        if name in {'normal','fire','smoke'}:
                            assert captures
                            expected={'normal':None,'fire':'FIRE','smoke':'SMOKE'}[name]
                            assert any(not c['hazards'] if expected is None else expected in c['hazards'] for c in case['captures'])
                            eof=reader.get('/api/previews/CAM-A',params={'run_id':run_id}).raise_for_status().json()
                            assert eof['status']=='EOF' and eof['frame'] is None
                            case['terminal_status']='EOF'
                        else:
                            assert len(predictions)==51 and len(accepted)>=52
                            case['fault']='2s upload middleware delay' if name=='slow-upload' else 'unlistened destination'
                        reset=control.post('/api/control/reset',json=dict(schema_version=1,run_id=run_id,reason='preview probe complete'))
                        reset.raise_for_status()
                        assert reader.get('/api/previews/CAM-A',params={'run_id':run_id}).status_code==409
                        case['old_run_rejected']=True
                        case['status']='PASS'
                        (out/(name+'.captures.json')).write_text(json.dumps(captures,indent=2),encoding='utf-8')
                        print(json.dumps({k:v for k,v in case.items() if k!='captures'}),flush=True)
        report['status']='PASS'
    finally:
        stop_ai(ai)
        for child in reversed(children):
            child.terminate()
            child.join(timeout=5)
            if child.is_alive():
                child.kill()
                child.join(timeout=5)
        report['children_stopped']=all(not p.is_alive() for p in children)
        (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    return 0


if __name__=='__main__':
    raise SystemExit(main())

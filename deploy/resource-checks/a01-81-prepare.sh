#!/usr/bin/env bash
# Reproduce the explicit AV1 development-copy preparation from A01-2.
set -eu
cd "${1:?Pass an isolated saferoute checkout directory}"
export PYTHONUTF8=1
.venv-ai/bin/python - <<'PY'
from pathlib import Path
from copy import deepcopy
import hashlib,json,subprocess
root=Path.cwd()
out=root/'runs/server-video-preparation'
out.mkdir(parents=True)
original=json.loads((root/'data/manifests/assets.json').read_text(encoding='utf-8'))
manifest=deepcopy(original)
records=[]
def digest(p):
    with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def run(args):
    return subprocess.run(args,capture_output=True,text=True,check=True,timeout=300).stdout
def frame_hashes(path):
    text=run(['ffmpeg','-nostdin','-v','error','-i',str(path),'-map','0:v:0','-pix_fmt','yuv420p','-f','framemd5','-'])
    return [tuple(v.strip() for v in line.split(',')[-2:]) for line in text.splitlines() if line and not line.startswith('#')]
def times(path):
    info=json.loads(run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))
    return [round(float(f['best_effort_timestamp_time'])*1000) for f in info['frames']]
for asset in manifest['videos']:
    if asset['asset_id'] not in {'dev-smoke-0009','dev-metro-ermita-corridor'}: continue
    src=root/asset['path']
    if digest(src)!=asset['sha256']:
        raise ValueError(f"Original SHA-256 mismatch: {asset['asset_id']}")
    target=out/(src.stem+'-ffv1.mkv')
    run(['ffmpeg','-nostdin','-v','error','-n','-c:v','libdav1d','-threads','2','-i',str(src),'-map','0:v:0','-c:v','ffv1','-level','3','-pix_fmt','yuv420p','-threads','2','-fps_mode','passthrough','-an',str(target)])
    src_hashes,dst_hashes=frame_hashes(src),frame_hashes(target)
    src_times,dst_times=times(src),times(target)
    if not src_hashes or src_hashes!=dst_hashes:
        raise ValueError(f"Decoded frame mismatch: {asset['asset_id']}")
    if src_times!=dst_times or len(src_times)!=len(src_hashes):
        raise ValueError(f"Media timestamp mismatch: {asset['asset_id']}")
    evidence=dict(asset_id=asset['asset_id'],original_path=asset['path'],original_sha256=asset['sha256'],derived_path=target.relative_to(root).as_posix(),derived_sha256=digest(target),decoded_frames=len(src_hashes),decoded_yuv420p_hashes_equal=True,frame_media_timestamps_ms_equal=True,original_scene_unchanged=True)
    records.append(evidence)
    asset['path']=evidence['derived_path'];asset['sha256']=evidence['derived_sha256'];asset['size_bytes']=target.stat().st_size
    asset.pop('read_validation',None)
    asset['transformation']='Derived from original SHA-256 in server_derivation: FFmpeg libdav1d to FFV1/yuv420p MKV; audio removed; decoded frame hashes and millisecond timestamps verified equal. Original bytes preserved separately.'
    asset['server_derivation']=evidence
    print(json.dumps(evidence),flush=True)
manifest['purpose']='Server development trial with explicit lossless AV1-to-FFV1 derived copies; originals preserved; not independent evaluation'
(out/'assets.server.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
(out/'conversion-evidence.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
PY

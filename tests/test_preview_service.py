"""Preview transport/identity fault tests; synthetic JPEG is not AI evidence."""

import base64
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from queue import Queue

from preview_worker.app import create_app
from preview_worker.store import MAX_BODY, Store, loopback_origin
from test_ai_worker import Clock, Video, detection, setup
from test_observation_state import building
from test_preview_contract import preview
from ai_worker.worker import run
from ai_worker.preview import Publisher
from backend.contracts import ContractError


@pytest.fixture
def api(setup):
    fixture = SimpleNamespace(now=datetime(2026,11,10,1,0,0,200000,tzinfo=timezone.utc), disconnected=False)
    async def read():
        if fixture.disconnected:
            raise TimeoutError()
        return setup.client.get('/api/state').json(), setup.client.get('/api/building').json()
    fixture.store = Store(lambda: fixture.now)
    with TestClient(create_app(read_context=read, store=fixture.store)) as client:
        fixture.client, fixture.setup = client, setup
        yield fixture


def update(api, sequence=1, index=15):
    payload = preview()
    payload['run_id'] = api.setup.session.run_id
    payload['frame']['frame_index'] = index
    payload['frame']['frame_id'] = str(uuid4())
    return dict(sequence=sequence, preview=payload, jpeg_base64=base64.b64encode(b'\xff\xd8synthetic\xff\xd9').decode('ascii'))


def query(api, source='CAM-A', run_id=None):
    return api.client.get('/api/previews/'+source, params={'run_id':run_id or api.setup.session.run_id})


def image(api, frame_id, source='CAM-A', run_id=None):
    return api.client.get('/api/preview-frames/'+frame_id+'.jpg',
                          params={'run_id':run_id or api.setup.session.run_id, 'source_id':source})


def test_metadata_and_jpeg_are_same_frame_and_replacement_never_substitutes(api):
    assert query(api).json()['status'] == 'INITIALIZING'
    first = update(api)
    fid = first['preview']['frame']['frame_id']
    assert api.client.post('/internal/preview', json=first).status_code == 204
    result = query(api)
    assert result.json() == dict(first['preview'], generated_at='2026-11-10T01:00:00.200000Z')
    assert result.headers['Cache-Control'] == 'no-store'
    jpeg = image(api, fid)
    assert jpeg.status_code == 200 and jpeg.content == b'\xff\xd8synthetic\xff\xd9'
    assert jpeg.headers['X-Preview-Frame-Id'] == fid
    assert jpeg.headers['Cache-Control'] == 'no-store'
    assert api.client.post('/internal/preview', json=update(api, 2, 16)).status_code == 204
    assert image(api, fid).status_code == 404
    assert len(api.store.entries) == 1


def test_expiry_clears_both_metadata_and_image_and_never_renews(api):
    data = update(api)
    api.client.post('/internal/preview', json=data)
    api.now = api.now.replace(second=3, microsecond=0)
    assert query(api).json()['status'] == 'STALE'
    assert query(api).json()['frame'] is None
    assert image(api,data['preview']['frame']['frame_id']).status_code == 404
    assert api.store.entries['CAM-A'].jpeg is None


@pytest.mark.parametrize('status,code', [('EOF',None), ('UNAVAILABLE','DECODE_FAILED'), ('UNAVAILABLE','INFERENCE_FAILED')])
def test_terminal_states_clear_frame_and_reject_delayed_updates_even_after_disconnect(api,status,code):
    data = update(api)
    api.client.post('/internal/preview',json=data)
    terminal = deepcopy(data)
    terminal.update(sequence=2,jpeg_base64=None)
    terminal['preview'].update(status=status,error_code=code,frame=None)
    assert api.client.post('/internal/preview',json=terminal).status_code == 204
    assert query(api).json()['status'] == status
    assert image(api,data['preview']['frame']['frame_id']).status_code == 404
    api.disconnected = True
    assert query(api).status_code == 503
    api.disconnected = False
    recovered=query(api).json()
    assert (recovered['status'],recovered['error_code'],recovered['frame'])==(status,code,None)
    assert api.client.post('/internal/preview',json=update(api,3,16)).status_code == 409


def test_controller_disconnect_drops_cached_jpeg_and_checks_current_session_after_reset(api):
    data = update(api)
    api.client.post('/internal/preview',json=data)
    api.disconnected = True
    assert query(api).status_code == 503
    api.disconnected = False
    assert query(api).json()['frame'] is None
    assert api.client.post('/internal/preview',json=data).status_code == 409
    oldrun = api.setup.session.run_id
    newrun = api.setup.client.post('/api/control/reset',json=dict(schema_version=1,run_id=oldrun,reason='preview reset')).json()['run_id']
    assert query(api).status_code == 409
    assert image(api,data['preview']['frame']['frame_id'],run_id=newrun).status_code == 404
    assert query(api,run_id=newrun).json()['status'] == 'INITIALIZING'
    assert api.client.post('/internal/preview',json=data).status_code == 409


@pytest.mark.parametrize('source', ['CAM-OTHER','DETECTOR-A'])
def test_different_camera_and_non_video_source_never_receive_image(api,source):
    data = update(api)
    api.client.post('/internal/preview',json=data)
    assert query(api,source).status_code == 404
    assert image(api,data['preview']['frame']['frame_id'],source).status_code == 404


@pytest.mark.parametrize('mutation', ['freshness','building','sequence','index','jpeg','future','null-jpeg'])
def test_invalid_and_out_of_order_updates_cannot_replace_ready_image(api,mutation):
    first = update(api)
    api.client.post('/internal/preview',json=first)
    data = update(api,2,16)
    if mutation=='freshness': data['preview']['freshness_ms']=4000
    if mutation=='building': data['preview']['building_version']=2
    if mutation=='sequence': data['sequence']=1
    if mutation=='index': data['preview']['frame']['frame_index']=15
    if mutation=='jpeg': data['jpeg_base64']='broken'
    if mutation=='null-jpeg': data['jpeg_base64']=None
    if mutation=='future': data['preview']['generated_at']='2026-11-10T01:00:01Z'
    assert api.client.post('/internal/preview',json=data).status_code in {409,422}
    assert query(api).json()['frame']==first['preview']['frame']


def test_oversized_and_malformed_requests_have_bounded_contract_error(api):
    response=api.client.post('/internal/preview',content=b'x'*(MAX_BODY+1))
    assert response.status_code==413
    assert response.headers['Cache-Control']=='no-store'
    assert response.json()['error']['code']=='SCHEMA_VALIDATION_FAILED'
    assert api.client.post('/internal/preview',content=b'{').status_code==422
    assert api.client.get('/api/previews/CAM-A').status_code==422


@pytest.mark.parametrize('url',['https://127.0.0.1:8003','http://example.com','http://127.0.0.1:8003/path',
                               'http://user:pass@localhost','http://localhost/?x=1'])
def test_preview_delivery_cannot_expand_to_external_origin(url):
    with pytest.raises(ValueError): loopback_origin(url)


def test_failed_preview_offers_do_not_stop_real_controller_observations(setup):
    calls=[]
    class Broken:
        dropped=3
        def offer(self,*args):
            calls.append(args)
            raise OSError('preview failed')
        def close(self,reason): calls.append(reason)
    path=setup.directory/'fake-video'
    path.write_bytes(b'fixture')
    result=run(setup.config,path,setup.client,setup.directory/'ai',SimpleNamespace(predict=lambda _: [detection()]),
               clock=setup.clock,cv2_module=Video([0,500,1000]),video_probe=lambda _: {'decoded_frames':3},
               preview_url='http://127.0.0.1:8003',publisher_factory=lambda *args: Broken())
    assert result['accepted_events']==4 and calls[-1]=='EOF'
    assert len({args[2] for args in calls[:-1]})==3
    assert len(setup.client.get('/api/state').json()['active_causes'])==1


def test_full_pending_queue_and_dead_child_drop_without_waiting():
    publisher=Publisher.__new__(Publisher)
    publisher.queue=Queue(maxsize=1)
    publisher.process=SimpleNamespace(is_alive=lambda:True)
    publisher.dropped=0
    frame=SimpleNamespace(shape=(2,2,3))
    publisher.offer(frame)
    for _ in range(50): publisher.offer(frame)
    assert publisher.queue.qsize()==1 and publisher.dropped==50
    publisher.process=SimpleNamespace(is_alive=lambda:False)
    publisher.offer(frame)
    assert publisher.dropped==51


@pytest.mark.parametrize('fault,expected', [('read','DECODE_FAILED'),('inference','INFERENCE_FAILED'),('open','VIDEO_OPEN_FAILED')])
def test_worker_fault_notifies_preview_and_preserves_original_failure(setup,fault,expected):
    closed=[]
    class Recording:
        dropped=0
        def offer(self,*args): pass
        def close(self,reason): closed.append(reason)
    video=Video([0])
    if fault=='open': video.isOpened=lambda:False
    def predict(_):
        if fault=='inference': raise ValueError('injected inference failure')
        return []
    path=setup.directory/'fake-video'
    path.write_bytes(b'fixture')
    with pytest.raises((ValueError,RuntimeError)):
        run(setup.config,path,setup.client,setup.directory/'ai',SimpleNamespace(predict=predict),
            clock=setup.clock,cv2_module=video,video_probe=lambda _: {'decoded_frames':2},
            preview_url='http://127.0.0.1:8003',publisher_factory=lambda *args:Recording())
    assert video.released and closed==[expected]


def test_disconnect_mid_upload_does_not_escape_as_unhandled_asgi_error(api):
    async def exercise():
        messages=iter([{'type':'http.request','body':b'{','more_body':True}, {'type':'http.disconnect'}])
        async def receive(): return next(messages,{'type':'http.disconnect'})
        async def send(message): pass
        scope=dict(type='http',asgi={'version':'3.0'},http_version='1.1',method='POST',scheme='http',
                   path='/internal/preview',raw_path=b'/internal/preview',query_string=b'',headers=[],
                   server=('test',80),client=('127.0.0.1',1234),root_path='')
        await asyncio.wait_for(api.client.app(scope,receive,send),2)
    asyncio.run(exercise())


def test_two_registered_cameras_keep_images_and_sequences_separate(api):
    state=api.setup.client.get('/api/state').json()
    building=api.setup.client.get('/api/building').json()
    camera=next(s for s in building['sources'] if s['source_id']=='CAM-A')
    building['sources'].append(dict(camera,source_id='CAM-B'))
    source=next(s for s in state['sources'] if s['source_id']=='CAM-A')
    state['sources'].append(dict(source,source_id='CAM-B'))
    async def read(): return state,building
    with TestClient(create_app(read_context=read,store=Store(lambda:api.now))) as client:
        api.client=client
        first=update(api)
        second=update(api)
        second['preview']['source_id']='CAM-B'
        assert client.post('/internal/preview',json=first).status_code==204
        assert query(api,'CAM-B').json()['status']=='INITIALIZING'
        assert client.post('/internal/preview',json=second).status_code==204
        fid=first['preview']['frame']['frame_id']
        assert image(api,fid,'CAM-A').status_code==200
        assert image(api,fid,'CAM-B').status_code==404
        assert query(api,'CAM-B').json()['frame']['frame_id']==second['preview']['frame']['frame_id']


@pytest.mark.parametrize('code,status', [('PREVIEW_FRAME_UNAVAILABLE',404), ('PREVIEW_UPDATE_REJECTED',409)])
def test_preview_errors_have_consistent_shared_contract_status(code,status):
    error=ContractError(code,'preview unavailable')
    assert error.status_code==status and error.to_response().error.code==code


def test_preview_encoding_error_survives_controller_outage_and_can_recover(api):
    data=update(api)
    data['preview'].update(status='UNAVAILABLE',error_code='PREVIEW_FAILED',frame=None)
    data['jpeg_base64']=None
    assert api.client.post('/internal/preview',json=data).status_code==204
    api.disconnected=True
    assert query(api).status_code==503
    api.disconnected=False
    assert query(api).json()['error_code']=='PREVIEW_FAILED'
    assert api.client.post('/internal/preview',json=update(api,2,16)).status_code==204
    assert query(api).json()['status']=='READY'

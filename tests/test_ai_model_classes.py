"""Class index changes must never swap FIRE/SMOKE events; no real model in CI."""
import hashlib
import sys
from types import SimpleNamespace

import pytest

from ai_worker.inference import Detector
from ai_worker.config import AIConfig


def fake_dependencies(monkeypatch, names):
    tensor = lambda values: SimpleNamespace(tolist=lambda: values)
    boxes = SimpleNamespace(cls=tensor([0, 1]), conf=tensor([.8, .9]),
                            xyxy=tensor([[1, 2, 3, 4], [5, 6, 7, 8]]))
    model = SimpleNamespace(names=names, predict=lambda *a, **kw: [SimpleNamespace(boxes=boxes)])
    monkeypatch.setitem(sys.modules, 'numpy', SimpleNamespace(zeros=lambda *a, **kw: None, uint8=None))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(set_num_threads=lambda n: None, get_num_threads=lambda: 4))
    monkeypatch.setitem(sys.modules, 'ultralytics', SimpleNamespace(YOLO=lambda p: model, settings={}))


@pytest.mark.parametrize('names,expected', [({0:'smoke',1:'fire'}, ['SMOKE','FIRE']),
                                          ({0:'fire',1:'smoke'}, ['FIRE','SMOKE'])])
def test_actual_model_names_map_boxes_without_swapping(monkeypatch, tmp_path, names, expected):
    fake_dependencies(monkeypatch, names)
    path = tmp_path/'weights.pt'
    path.write_bytes(b'fixture only')
    config = SimpleNamespace(model_path=str(path), model_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                             imgsz=640, confidence=.25, cpu_threads=4, preprocess="none")
    detector = Detector(config)
    boxes = detector.predict(None)
    assert [b['class'] for b in boxes] == expected
    assert [b['confidence'] for b in boxes] == [.8,.9]
    assert [b['xyxy'] for b in boxes] == [[1,2,3,4],[5,6,7,8]]
    assert detector.metadata['model_classes'] == names


@pytest.mark.parametrize('names', [{0:'person',1:'car'}, {0:'fire'}, {0:'fire',1:'fire'},
                                  {0:'fire',1:'smoke',2:'other'}, {1:'fire',2:'smoke'}])
def test_unrecognized_or_incomplete_classes_rejected_before_inference(monkeypatch, tmp_path, names):
    fake_dependencies(monkeypatch, names)
    path = tmp_path/'weights.pt'
    path.write_bytes(b'fixture only')
    config = SimpleNamespace(model_path=str(path), model_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match='exactly smoke and fire'):
        Detector(config)


def test_selected_threads_applied_after_library_warmup(monkeypatch, tmp_path):
    fake_dependencies(monkeypatch, {0: 'fire', 1: 'smoke'})
    state = {'threads': 8}
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        set_num_threads=lambda n: state.update(threads=n),
        get_num_threads=lambda: state['threads']))
    path = tmp_path / 'weights.pt'
    path.write_bytes(b'fixture only')
    config = SimpleNamespace(model_path=str(path), model_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                             imgsz=640, confidence=.25, cpu_threads=2, preprocess='none')
    detector = Detector(config)
    assert state['threads'] == detector.metadata['torch_threads'] == 2
    detector.predict(None)
    assert state['threads'] == 2


@pytest.mark.parametrize('override', [{'cpu_threads': 0}, {'cpu_threads': 5},
                                     {'cpu_threads': True}, {'preprocess': 'unknown'},
                                     {'onnx_provider': 'unknown'}, {'onnx_provider': 'openvino'}])
def test_invalid_runtime_policy_rejected(override):
    import json
    from pathlib import Path
    config = json.loads(Path('configs/ai.xiazh.development.json').read_bytes())
    with pytest.raises(ValueError):
        AIConfig.model_validate(config | override)


def test_legacy_config_retains_untransformed_four_thread_behavior():
    from pathlib import Path
    config = AIConfig.model_validate_json(Path('configs/ai.xiazh.development.json').read_bytes())
    assert config.cpu_threads == 4 and config.preprocess == 'none' and config.onnx_provider == 'cpu'


@pytest.mark.parametrize('io_binding', [False, True])
@pytest.mark.parametrize('provider', ['cpu', 'openvino', 'missing_device', 'missing_provider'])
def test_onnx_uses_bounded_cpu_session_before_video_inference(monkeypatch, tmp_path, io_binding, provider):
    fake_dependencies(monkeypatch, {0: 'fire', 1: 'smoke'})
    state = {'threads': 8}
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        set_num_threads=lambda n: state.update(threads=n), get_num_threads=lambda: state['threads']))
    model = sys.modules['ultralytics'].YOLO('unused')
    original_session = object()
    backend = SimpleNamespace(session=original_session, use_io_binding=io_binding)
    model.predictor = SimpleNamespace(model=SimpleNamespace(backend=backend))
    original_predict = model.predict
    sessions = []

    def predict(*args, **kwargs):
        sessions.append(backend.session)
        return original_predict(*args, **kwargs)

    model.predict = predict
    cpu_device = SimpleNamespace(ep_name='OpenVINOExecutionProvider', device=SimpleNamespace(type='cpu'))
    gpu_device = SimpleNamespace(ep_name='OpenVINOExecutionProvider', device=SimpleNamespace(type='gpu'))

    class Options:
        def __init__(self):
            self.entries = {}

        def add_session_config_entry(self, key, value):
            self.entries[key] = value

        def get_session_config_entry(self, key):
            return self.entries[key]

        def add_provider_for_devices(self, devices, options):
            import json
            assert devices == [cpu_device]
            assert json.loads(options['load_config']) == {'CPU': {
                'INFERENCE_NUM_THREADS': 2, 'NUM_STREAMS': 1, 'INFERENCE_PRECISION_HINT': 'f32',
                'PERFORMANCE_HINT': 'LATENCY', 'ENABLE_HYPER_THREADING': True}}

    path = tmp_path / 'weights.onnx'
    path.write_bytes(b'fixture only')

    def session(filename, options, providers=None, enable_fallback=None):
        assert filename == str(path)
        if provider == 'cpu':
            assert providers == ['CPUExecutionProvider'] and enable_fallback is None
        else:
            assert providers is None and enable_fallback == 0 and options.intra_op_num_threads == 1
            providers = ['CPUExecutionProvider'] if provider == 'missing_provider' else ['OpenVINOExecutionProvider', 'CPUExecutionProvider']
        return SimpleNamespace(get_providers=lambda: providers, get_session_options=lambda: options)

    registered = []

    monkeypatch.setitem(sys.modules, 'onnxruntime', SimpleNamespace(
        SessionOptions=Options, InferenceSession=session, __version__='fixture',
        get_available_providers=lambda: ['CPUExecutionProvider'],
        register_execution_provider_library=lambda name, path: registered.append((name, path)),
        get_ep_devices=lambda: [gpu_device] if provider == 'missing_device' else [cpu_device, gpu_device],
        OrtHardwareDeviceType=SimpleNamespace(CPU='cpu')))
    monkeypatch.setitem(sys.modules, 'onnxruntime_ep_openvino', SimpleNamespace(
        get_ep_name=lambda: 'OpenVINOExecutionProvider', get_library_path=lambda: 'fixture-library'))
    monkeypatch.setattr('ai_worker.inference.package_version', lambda name: 'fixture')
    config = SimpleNamespace(model_path=str(path), model_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                             imgsz=640, confidence=.25, cpu_threads=2, preprocess='none',
                             onnx_provider='cpu' if provider == 'cpu' else 'openvino')
    if io_binding:
        with pytest.raises(ValueError, match='IO binding'):
            Detector(config)
        assert backend.session is original_session
    elif provider in ['missing_device', 'missing_provider']:
        with pytest.raises(ValueError, match='OpenVINO CPU'):
            Detector(config)
        assert sessions == [original_session]  # no video inference after a failed provider setup
    else:
        detector = Detector(config)
        assert detector.metadata['torch_threads'] == state['threads'] == 1
        assert sessions == [original_session, backend.session]
        detector.predict(None)
        assert sessions[-1] is backend.session and backend.session is not original_session
        expected = {
            'version': 'fixture', 'providers': ['CPUExecutionProvider'],
            'intra_op_num_threads': 2, 'allow_spinning': '0'}
        if provider == 'openvino':
            assert registered == [('saferoute_openvino', 'fixture-library')]
            expected.update(providers=['OpenVINOExecutionProvider', 'CPUExecutionProvider'],
                            intra_op_num_threads=1, openvino_plugin='fixture',
                            provider_options_requested=detector.metadata['onnx_runtime']['provider_options_requested'])
        assert detector.metadata['onnx_runtime'] == expected

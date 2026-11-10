"""Class index changes must never swap FIRE/SMOKE events; no real model in CI."""
import hashlib
import sys
from types import SimpleNamespace

import pytest

from ai_worker.inference import Detector


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
                             imgsz=640, confidence=.25)
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

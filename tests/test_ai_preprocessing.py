"""Preprocessing must not alter preview pixels or bounding-box geometry."""
import sys
from types import SimpleNamespace
import pytest

from ai_worker.inference import Detector


@pytest.mark.parametrize('width,height', [(200, 100), (1920, 1080)])
def test_clahe_changes_only_new_luminance_buffer_and_keeps_box_coordinates(monkeypatch, width, height):
    original = SimpleNamespace(shape=(height, width, 3))
    scale = min(1, 640 / max(width, height))
    small = SimpleNamespace(shape=(round(height * scale), round(width * scale), 3)) if scale < 1 else original
    transformed = object()

    class Lab:
        channels = ['luminance', 'chroma-a', 'chroma-b']

        def __getitem__(self, key):
            assert key == (slice(None), slice(None), 0)
            return self.channels[0]

        def __setitem__(self, key, value):
            assert key == (slice(None), slice(None), 0)
            self.channels = [value, *self.channels[1:]]

    lab = Lab()

    def convert(frame, conversion):
        if conversion == 'to-lab':
            assert frame is small
            return lab
        assert conversion == 'to-bgr' and frame is lab
        assert lab.channels == ['equalized', 'chroma-a', 'chroma-b']
        return transformed

    def equalize(value):
        assert value == 'luminance'
        return 'equalized'

    tensor = lambda values: SimpleNamespace(tolist=lambda: values)
    box = [5, 10, 20, 30]

    def predict(frame, **kwargs):
        assert frame is transformed
        return [SimpleNamespace(boxes=SimpleNamespace(
            cls=tensor([0]), conf=tensor([.8]), xyxy=tensor([box])))]

    def resize(frame, size, interpolation):
        assert frame is original and size == (640, 360) and interpolation == 'linear'
        return small

    monkeypatch.setitem(sys.modules, 'cv2', SimpleNamespace(
        cvtColor=convert, resize=resize, INTER_LINEAR='linear',
        COLOR_BGR2LAB='to-lab', COLOR_LAB2BGR='to-bgr'))
    detector = Detector.__new__(Detector)
    detector.config = SimpleNamespace(imgsz=640, confidence=.25)
    detector.clahe = SimpleNamespace(apply=equalize)
    detector.model = SimpleNamespace(predict=predict, names={0: 'fire', 1: 'smoke'})
    assert detector.predict(original) == [{'class': 'FIRE', 'confidence': .8, 'xyxy': [v / scale for v in box]}]


def test_none_passes_original_frame_directly_without_importing_cv2(monkeypatch):
    original = object()
    tensor = lambda values: SimpleNamespace(tolist=lambda: values)

    def predict(frame, **kwargs):
        assert frame is original
        return [SimpleNamespace(boxes=SimpleNamespace(
            cls=tensor([]), conf=tensor([]), xyxy=tensor([])))]

    monkeypatch.setitem(sys.modules, 'cv2', None)
    detector = Detector.__new__(Detector)
    detector.config = SimpleNamespace(imgsz=640, confidence=.25)
    detector.clahe = None
    detector.model = SimpleNamespace(predict=predict, names={0: 'fire', 1: 'smoke'})
    assert detector.predict(original) == []

import hashlib
import importlib.metadata
import os
from pathlib import Path
import platform


ROOT = Path(__file__).resolve().parents[1]


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None  # missing distribution metadata must not stop working inference


class Detector:
    def __init__(self, config):
        path = ROOT / config.model_path
        if file_hash(path) != config.model_sha256:
            raise ValueError("model SHA-256 mismatch")
        os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / "runs/ultralytics"))
        os.environ["YOLO_OFFLINE"] = "true"
        import numpy as np
        import torch
        from ultralytics import YOLO, settings

        settings.update({"sync": False})
        self.model, self.config = YOLO(str(path)), config
        if self.model.names not in ({0: "smoke", 1: "fire"}, {0: "fire", 1: "smoke"}):
            raise ValueError("candidate classes must be exactly smoke and fire at indices 0 and 1")
        self.predict(np.zeros((config.imgsz, config.imgsz, 3), dtype=np.uint8))
        torch.set_num_threads(4)
        self.metadata = dict(model_classes=dict(self.model.names), device="cpu", python=platform.python_version(), os=platform.platform(),
                             cpu=platform.processor(), logical_cpu_count=os.cpu_count(),
                             torch_threads=torch.get_num_threads(),
                             packages={p: package_version(p) for p in
                                       ("torch", "torchvision", "ultralytics", "opencv-python", "numpy")})

    def predict(self, frame):
        result = self.model.predict(frame, device="cpu", imgsz=self.config.imgsz,
                                    conf=self.config.confidence, verbose=False)[0]
        return [{"class": self.model.names[int(cls)].upper(), "confidence": score, "xyxy": box}
                for cls, score, box in zip(result.boxes.cls.tolist(), result.boxes.conf.tolist(),
                                           result.boxes.xyxy.tolist())]

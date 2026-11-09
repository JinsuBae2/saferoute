import hashlib
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


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
        if self.model.names != {0: "smoke", 1: "fire"}:
            raise ValueError("candidate classes must be smoke=0/fire=1")
        self.predict(np.zeros((config.imgsz, config.imgsz, 3), dtype=np.uint8))
        torch.set_num_threads(4)

    def predict(self, frame):
        result = self.model.predict(frame, device="cpu", imgsz=self.config.imgsz,
                                    conf=self.config.confidence, verbose=False)[0]
        return [{"class": self.model.names[int(cls)].upper(), "confidence": score, "xyxy": box}
                for cls, score, box in zip(result.boxes.cls.tolist(), result.boxes.conf.tolist(),
                                           result.boxes.xyxy.tolist())]

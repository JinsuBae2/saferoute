import hashlib
import importlib.metadata
import json
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
        self.clahe = None
        if config.preprocess == "clahe":
            import cv2
            self.clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        self.predict(np.zeros((config.imgsz, config.imgsz, 3), dtype=np.uint8))
        # Ultralytics sets CPU threads during first predict; apply our bound afterwards.
        # ONNX owns the compute pool; one Torch preprocessing thread avoids a second pool.
        torch.set_num_threads(1 if path.suffix.lower() == ".onnx" else config.cpu_threads)
        onnx_runtime = None
        if path.suffix.lower() == ".onnx":
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = config.cpu_threads
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            # The pinned Ultralytics backend owns preprocessing/output metadata. Replace only
            # its CPU session, using the identical verified file, before any video is read.
            backend = self.model.predictor.model.backend
            if backend.use_io_binding:
                raise ValueError("ONNX CPU worker must not use device IO binding")
            provider_options = None
            if config.onnx_provider == "openvino":
                import onnxruntime_ep_openvino as ep
                ep_name = ep.get_ep_name()
                if ep_name not in ort.get_available_providers():
                    ort.register_execution_provider_library("saferoute_openvino", ep.get_library_path())
                devices = [d for d in ort.get_ep_devices() if d.ep_name == ep_name
                           and d.device.type == ort.OrtHardwareDeviceType.CPU]
                if len(devices) != 1:
                    raise ValueError("exactly one OpenVINO CPU device is required")
                options.intra_op_num_threads = 1  # fallback ops; OpenVINO owns the compute pool
                provider_options = {"load_config": json.dumps({"CPU": {
                    "INFERENCE_NUM_THREADS": config.cpu_threads, "NUM_STREAMS": 1,
                    "INFERENCE_PRECISION_HINT": "f32", "PERFORMANCE_HINT": "LATENCY",
                    "ENABLE_HYPER_THREADING": True}})}
                options.add_provider_for_devices(devices, provider_options)
                backend.session = ort.InferenceSession(str(path), options, enable_fallback=0)
                if ep_name not in backend.session.get_providers():
                    raise ValueError("OpenVINO CPU provider was not activated")
            else:
                backend.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
            backend.session_options = options
            self.predict(np.zeros((config.imgsz, config.imgsz, 3), dtype=np.uint8))
            onnx_runtime = dict(version=ort.__version__, providers=backend.session.get_providers(),
                                intra_op_num_threads=backend.session.get_session_options().intra_op_num_threads,
                                allow_spinning=backend.session.get_session_options().get_session_config_entry(
                                    "session.intra_op.allow_spinning"))
            if provider_options is not None:
                onnx_runtime.update(openvino_plugin=package_version("onnxruntime-ep-openvino"),
                                    provider_options_requested=provider_options)
        self.metadata = dict(model_classes=dict(self.model.names), device="cpu", python=platform.python_version(), os=platform.platform(),
                             cpu=platform.processor(), logical_cpu_count=os.cpu_count(),
                             torch_threads=torch.get_num_threads(),
                             preprocessing_version="clahe_input_v1" if self.clahe is not None else "none",
                             onnx_runtime=onnx_runtime,
                             packages={p: package_version(p) for p in
                                       ("torch", "torchvision", "ultralytics", "opencv-python", "numpy")})

    def predict(self, frame):
        ratio_x = ratio_y = 1
        if self.clahe is not None:
            import cv2
            height, width = frame.shape[:2]
            scale = min(1.0, self.config.imgsz / max(height, width))
            if scale < 1:
                frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))),
                                   interpolation=cv2.INTER_LINEAR)
                ratio_x, ratio_y = width / frame.shape[1], height / frame.shape[0]
            # Bound color-processing cost, and keep the original preview pixels intact.
            lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
            lab[:, :, 0] = self.clahe.apply(lab[:, :, 0])
            frame = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        result = self.model.predict(frame, device="cpu", imgsz=self.config.imgsz,
                                    conf=self.config.confidence, verbose=False)[0]
        return [{"class": self.model.names[int(cls)].upper(), "confidence": score,
                 "xyxy": [v * (ratio_x if i % 2 == 0 else ratio_y) for i, v in enumerate(box)]}
                for cls, score, box in zip(result.boxes.cls.tolist(), result.boxes.conf.tolist(),
                                           result.boxes.xyxy.tolist())]

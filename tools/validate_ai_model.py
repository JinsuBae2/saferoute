"""A01 offline CPU trial; development evidence, not independent evaluation."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import statistics
import time


def verify_file(path, expected_sha256):
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected_sha256:
        raise ValueError(f"SHA-256 mismatch: {path}")
    return actual


def summarize_frames(frames):
    if not frames:
        raise ValueError("No decoded samples; no successful trial to report")
    counts = Counter()
    for frame in frames:
        counts.update({box["class"] for box in frame["boxes"]})
    times = sorted(frame["predict_ms"] for frame in frames)
    return {
        "sampled_frames": len(frames),
        "frames_with_detection": {name: counts[name] for name in ("fire", "smoke")},
        "predict_mean_ms": statistics.mean(times),
        "predict_p95_ms": times[math.ceil(len(times) * .95) - 1],
        "predict_max_ms": max(times),
        "sampled_rss_max_mib": max(f["rss_mib"] for f in frames),
    }


def run_video(model, asset, root, output, imgsz, interval_ms, confidence):
    import cv2
    import psutil

    path = root / asset["path"]
    cap = cv2.VideoCapture(str(path))
    frames = []
    decoded = 0
    next_due = 0.0
    previous = -1.0
    process = psutil.Process()
    started = time.perf_counter()
    metadata = {
        "reported_fps": cap.get(cv2.CAP_PROP_FPS),
        "reported_frame_count": cap.get(cv2.CAP_PROP_FRAME_COUNT),
        "width": cap.get(cv2.CAP_PROP_FRAME_WIDTH),
        "height": cap.get(cv2.CAP_PROP_FRAME_HEIGHT),
        "fourcc": "".join(chr((int(cap.get(cv2.CAP_PROP_FOURCC)) >> (8*i)) & 255)
                          for i in range(4)),
    }
    try:
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {path}")
        with (output / f'{asset["asset_id"]}.jsonl').open("x", encoding="utf-8") as log:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                timestamp = cap.get(cv2.CAP_PROP_POS_MSEC)
                if not math.isfinite(timestamp) or timestamp <= previous:
                    raise ValueError(f"Non-increasing media timestamp: {path}: {timestamp}")
                previous = timestamp
                decoded += 1
                if timestamp + 1e-6 < next_due:
                    continue
                next_due = (math.floor((timestamp + 1e-6) / interval_ms) + 1) * interval_ms
                before = time.perf_counter()
                result = model.predict(frame, device="cpu", imgsz=imgsz,
                                       conf=confidence, verbose=False)[0]
                elapsed_ms = (time.perf_counter() - before) * 1000
                record = {
                    "frame_index": decoded - 1,
                    "media_time_ms": timestamp,
                    "predict_ms": elapsed_ms,
                    "stages_ms": result.speed,
                    "rss_mib": process.memory_info().rss / 1024**2,
                    "boxes": [
                        {"class": model.names[int(cls)], "confidence": score, "xyxy": box}
                        for cls, score, box in zip(result.boxes.cls.tolist(),
                                                   result.boxes.conf.tolist(),
                                                   result.boxes.xyxy.tolist())
                    ],
                }
                frames.append(record)
                log.write(json.dumps(record) + "\n")
                if len(frames) == 1:
                    if not cv2.imwrite(str(output / f'{asset["asset_id"]}-first.jpg'), result.plot()):
                        raise OSError("Cannot save first-frame evidence")
    finally:
        cap.release()
    elapsed_s = time.perf_counter() - started
    # shortcut: OpenCV read=False cannot distinguish EOF from truncation; A02 needs explicit failure handling.
    return {
        "asset_id": asset["asset_id"], "video_metadata": metadata,
        "decoded_frames": decoded, "last_decoded_media_time_ms": previous,
        "read_termination": "read_returned_false_not_verified_eof",
        "offline_elapsed_s": elapsed_s,
        "offline_sample_throughput_fps": len(frames) / elapsed_s,
        **summarize_frames(frames),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("data/manifests/assets.json"))
    parser.add_argument("--output", type=Path, required=True, help="New output directory")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--interval-ms", type=int, default=500)
    parser.add_argument("--confidence", type=float, default=.25)
    args = parser.parse_args()
    if args.imgsz <= 0 or args.interval_ms <= 0 or not 0 < args.confidence < 1:
        parser.error("imgsz/interval must be positive and confidence between 0 and 1")
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    weights = manifest["model"]
    assets = manifest["videos"]
    if not assets or any(a["split"] != "development" for a in assets):
        raise ValueError("This trial accepts development assets only")
    for item in [weights, *assets]:
        verify_file(root / item["path"], item["sha256"])
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(root / "runs/ultralytics"))
    os.environ["YOLO_OFFLINE"] = "true"
    import numpy as np
    import torch
    from ultralytics import YOLO, settings

    settings.update({"sync": False})
    started = time.perf_counter()
    model = YOLO(str(root / weights["path"]))
    if model.names != {0: "smoke", 1: "fire"}:
        raise ValueError(f"Unexpected actual classes: {model.names}")
    load_s = time.perf_counter() - started
    warmup_threads_before = torch.get_num_threads()
    started = time.perf_counter()
    # Synthetic warm-up is timing only; never counted as development evidence.
    model.predict(np.zeros((args.imgsz, args.imgsz, 3), dtype=np.uint8), device="cpu",
                  imgsz=args.imgsz, conf=args.confidence, verbose=False)
    warmup_s = time.perf_counter() - started
    warmup_threads_after = torch.get_num_threads()
    # Ultralytics sets CPU threads on first predict; fix the trial count afterwards.
    torch.set_num_threads(4)
    report = {
        "kind": "development_execution_trial_not_accuracy_evaluation",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(), "os": platform.platform(),
        "cpu": platform.processor(), "logical_cpu_count": os.cpu_count(),
        "device": "cpu", "torch_threads": torch.get_num_threads(),
        "packages": {p: importlib.metadata.version(p) for p in
                     ("torch", "torchvision", "ultralytics", "opencv-python", "numpy", "psutil")},
        "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
        "model_sha256": weights["sha256"], "actual_classes": model.names,
        "imgsz": args.imgsz, "interval_ms": args.interval_ms, "confidence": args.confidence,
        "model_load_s": load_s, "synthetic_warmup_s": warmup_s,
        "synthetic_warmup_torch_threads_before": warmup_threads_before,
        "synthetic_warmup_torch_threads_after": warmup_threads_after,
        "videos": [],
    }
    for asset in assets:
        result = run_video(model, asset, root, args.output, args.imgsz,
                           args.interval_ms, args.confidence)
        report["videos"].append(result)
        print(json.dumps(result), flush=True)
    (args.output / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

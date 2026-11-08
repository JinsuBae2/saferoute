"""Append-only local run evidence. Errors are propagated to the controller."""

import hashlib
import json
from math import isfinite
import os
from pathlib import Path


def json_evidence(value):
    """Keep rejected non-JSON numbers as explicit evidence, not a log-write failure."""
    if isinstance(value, float) and not isfinite(value): return {"invalid_number": str(value)}
    if isinstance(value, dict): return {key: json_evidence(item) for key, item in value.items()}
    if isinstance(value, list): return [json_evidence(item) for item in value]
    return value


class AuditLog:
    def __init__(self, root: Path):
        self.root = Path(root)

    def begin(self, run_id, building, started_at):
        directory = self.root / run_id
        directory.mkdir(parents=True, exist_ok=False)
        encoded = building.model_dump_json().encode()
        manifest = dict(run_id=run_id, building_id=building.building_id,
                        building_version=building.building_version,
                        building_sha256=hashlib.sha256(encoded).hexdigest(),
                        started_at=started_at, component="B03-guidance-controller")
        with (directory / "manifest.json").open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

    def write(self, run_id, category, record):
        if category not in {"events", "decisions", "commands", "acks"}:
            raise ValueError("unknown audit category")
        with (self.root / run_id / f"{category}.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(json_evidence(record), ensure_ascii=True, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

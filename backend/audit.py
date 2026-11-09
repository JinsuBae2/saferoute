"""Append-only local run evidence. Errors are propagated to the controller."""

import hashlib
import json
from math import isfinite
import os
from pathlib import Path
import platform
import subprocess


def json_evidence(value):
    """Keep rejected non-JSON numbers as explicit evidence, not a log-write failure."""
    if isinstance(value, float) and not isfinite(value): return {"invalid_number": str(value)}
    if isinstance(value, dict): return {key: json_evidence(item) for key, item in value.items()}
    if isinstance(value, list): return [json_evidence(item) for item in value]
    return value


class AuditLog:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.sequences = {}
        self.manifests = {}
        try:
            def git(*args):
                return subprocess.run(["git", *args], cwd=Path(__file__).resolve().parents[1],
                    capture_output=True, encoding="utf-8", check=True, timeout=5).stdout.strip()
            self.code_commit, self.code_dirty = git("rev-parse", "HEAD"), bool(git("status", "--porcelain"))
        except (OSError, subprocess.SubprocessError):
            self.code_commit, self.code_dirty = None, None

    def begin(self, run_id, building, started_at):
        directory = self.root / run_id
        directory.mkdir(parents=True, exist_ok=False)
        encoded = building.model_dump_json().encode("utf-8")
        (directory / "building.json").write_bytes(encoded)
        for category in ("events", "decisions", "commands", "acks"):
            (directory / f"{category}.jsonl").touch(exist_ok=False)
        manifest = dict(schema_version=1, run_id=run_id, building_id=building.building_id,
                        building_version=building.building_version,
                        building_sha256=hashlib.sha256(encoded).hexdigest(),
                        started_at=started_at, component="B04-guidance-controller", closed=False,
                        code_commit=self.code_commit, code_dirty=self.code_dirty,
                        python_version=platform.python_version(), platform=platform.platform())
        with (directory / "manifest.json").open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.manifests[run_id] = manifest
        self.sequences[run_id] = 0

    def finish(self, run_id, ended_at, reason):
        manifest = self.manifests[run_id] | dict(closed=True, ended_at=ended_at,
            end_reason=reason, last_record_sequence=self.sequences[run_id])
        directory = self.root / run_id
        temporary = directory / "manifest.tmp"
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(directory / "manifest.json")
        self.manifests[run_id] = manifest

    def write(self, run_id, category, record):
        if category not in {"events", "decisions", "commands", "acks"}:
            raise ValueError("unknown audit category")
        if self.manifests[run_id]["closed"]:
            raise ValueError("run is closed")
        sequence = self.sequences[run_id] + 1
        record = record | {"record_sequence": sequence}
        with (self.root / run_id / f"{category}.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(json_evidence(record), ensure_ascii=True, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.sequences[run_id] = sequence

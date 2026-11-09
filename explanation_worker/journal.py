"""Append-only explanation evidence with one process owning a log root."""

import json
import os
from pathlib import Path


class Journal:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = self.root / ".explanation-worker.lock"
        with self.lock.open("x", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))

    def write(self, record):
        directory = self.root / record["basis"]["run_id"]
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "explanations.jsonl").open("a+b") as handle:
            if handle.tell():
                handle.seek(-1, os.SEEK_END)
                if handle.read(1) != b"\n":
                    raise OSError("incomplete explanation log; preserve it for inspection")
            handle.write((json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())

    def close(self):
        self.lock.unlink()

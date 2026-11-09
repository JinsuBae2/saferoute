"""File-only preflight: count decoded frames, not unreliable FPS/container counts."""
import json
import subprocess

from .events import WorkerError


def inspect_video(path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
             "-show_program_version", "-show_entries",
             "stream=nb_read_frames:program_version=version", "-of", "json", str(path.resolve())],
            capture_output=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WorkerError(f"VIDEO_PREFLIGHT_UNAVAILABLE: {type(error).__name__}") from error
    if result.returncode or result.stderr.strip():
        raise WorkerError(f"DECODE_FAILED: ffprobe {result.returncode}: {result.stderr[:2048]}")
    try:
        info = json.loads(result.stdout)
        count = info["streams"][0]["nb_read_frames"]
        if not isinstance(count, str) or not count.isascii() or not count.isdecimal() or int(count) <= 0:
            raise ValueError("no decoded video frames")
        version = info["program_version"]["version"]
        if not isinstance(version, str) or not version:
            raise ValueError("missing ffprobe version")
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise WorkerError("DECODE_FAILED: invalid ffprobe result") from error
    return {"decoded_frames": int(count), "ffprobe_version": version,
            "method": "ffprobe_full_decode_count"}

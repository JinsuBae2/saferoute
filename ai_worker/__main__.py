import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

import httpx

from .config import AIConfig
from .inference import Detector, ROOT
from .worker import run


def main():
    parser = argparse.ArgumentParser(description="A02 actual CPU video inference to VIDEO_AI events")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--controller", default="http://127.0.0.1:8000")
    parser.add_argument("--runs-dir", type=Path, default=ROOT / "runs")
    parser.add_argument("--preview-url", help="Optional local preview API origin, e.g. http://127.0.0.1:8003")
    args = parser.parse_args()
    try:
        url = urlsplit(args.controller)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
            raise ValueError("controller must be an HTTP(S) origin without credentials/path/query")
        config = AIConfig.model_validate(json.loads(args.config.read_text(encoding="utf-8")))
        if args.preview_url:
            from preview_worker.store import loopback_origin
            loopback_origin(args.preview_url)
        if not args.video.is_file():
            raise ValueError("video file does not exist")
        detector = Detector(config)
        with httpx.Client(base_url=args.controller, timeout=config.request_timeout_ms / 1000,
                          trust_env=False, follow_redirects=False) as client:
            result = run(config, args.video, client, args.runs_dir, detector, preview_url=args.preview_url)
        print(json.dumps(result))
        return 0
    except KeyboardInterrupt:
        print("AI worker stopped by operator", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"AI worker stopped: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

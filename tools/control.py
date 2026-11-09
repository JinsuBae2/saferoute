"""Internal operator CLI. Mutations require the intended run; no automatic rebinding."""

import argparse
import json
from pathlib import Path
import sys

import httpx

from backend.contracts import ContractError, parse_contract


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("session")
    sub.add_parser("state")
    event = sub.add_parser("event")
    event.add_argument("--file", required=True)
    for name in ("arm", "clear", "reset"):
        command = sub.add_parser(name)
        command.add_argument("--run-id", required=True)
        command.add_argument("--reason", required=True)
        if name == "clear":
            command.add_argument("--source-id", required=True)
            command.add_argument("--hazard-type", choices=["FIRE", "SMOKE", "SPRINKLER"], required=True)
    args = parser.parse_args()
    payload = None
    try:
        if args.operation == "event":
            payload = parse_contract("ObservationEvent", json.loads(Path(args.file).read_text(encoding="utf-8"))).model_dump(mode="json")
        elif args.operation in {"arm", "clear", "reset"}:
            data = dict(schema_version=1, run_id=args.run_id, reason=args.reason)
            if args.operation == "clear": data.update(source_id=args.source_id, hazard_type=args.hazard_type)
            payload = parse_contract("ClearRequest" if args.operation == "clear" else "ControlRequest", data).model_dump(mode="json")
    except (OSError, ValueError, ContractError) as error:
        print(f"Invalid input: {error}", file=sys.stderr)
        return 2
    path = "/api/" + ("events" if args.operation == "event" else "control/" + args.operation if payload is not None else args.operation)
    try:
        with httpx.Client(base_url=args.url, timeout=5, trust_env=False) as client:
            response = client.get(path) if payload is None else client.post(path, json=payload)
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as error:
        detail = error.response.text if isinstance(error, httpx.HTTPStatusError) else str(error)
        print(f"Request failed: {detail}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

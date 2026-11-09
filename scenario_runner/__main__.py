"""Run the independent scenario HTTP service after starting the controller."""

import argparse
from pathlib import Path
import sys

import uvicorn

from .app import create_app
from .config import load_building, load_scenario

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building",type=Path,default=ROOT / "data/fixtures/two-route-v1.json")
    parser.add_argument("--scenario",type=Path,default=ROOT / "data/scenarios/two-route-smoke.runtime.json")
    parser.add_argument("--controller-url",default="http://127.0.0.1:8000")
    parser.add_argument("--host",default="127.0.0.1")
    parser.add_argument("--port",type=int,default=8001)
    parser.add_argument("--runs-dir",type=Path,default=ROOT / "runs")
    args = parser.parse_args(argv)
    try:
        building = load_building(args.building)
        scenario = load_scenario(args.scenario,building)
        if not 1 <= args.port <= 65535: raise ValueError("port must be 1..65535")
        app = create_app(building,scenario,controller_url=args.controller_url,runs_dir=args.runs_dir)
    except (OSError,ValueError) as error:
        print(f"Invalid configuration: {error}",file=sys.stderr)
        return 2
    uvicorn.run(app,host=args.host,port=args.port,workers=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

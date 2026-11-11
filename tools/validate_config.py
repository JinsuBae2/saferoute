"""Validate building/default routes and, optionally, an executable scenario."""

import argparse
import json
from pathlib import Path
import sys

from backend.contracts import parse_contract
from scenario_runner.config import load_building, load_scenario


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building", required=True)
    parser.add_argument("--scenario")
    parser.add_argument("--display", help="Presentation metadata for the same building/version")
    args = parser.parse_args()
    try:
        building = load_building(args.building)
        scenario = load_scenario(args.scenario, building) if args.scenario else None
        if args.display:
            parse_contract("BuildingDisplay", json.loads(Path(args.display).read_text(encoding="utf-8"))).validate_for(building)
    except (OSError, ValueError) as error:
        print(f"Invalid configuration: {error}", file=sys.stderr)
        return 2
    print(json.dumps(dict(building_id=building.building_id, building_version=building.building_version,
                         nodes=len(building.nodes), signs=len(building.signs),
                         scenario_id=scenario.scenario_id if scenario else None,
                         **({"display_validated": True} if args.display else {})), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

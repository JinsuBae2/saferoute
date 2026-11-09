"""Validate building/default routes and, optionally, an executable scenario."""

import argparse
import json
import sys

from scenario_runner.config import load_building, load_scenario


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building", required=True)
    parser.add_argument("--scenario")
    args = parser.parse_args()
    try:
        building = load_building(args.building)
        scenario = load_scenario(args.scenario, building) if args.scenario else None
    except (OSError, ValueError) as error:
        print(f"Invalid configuration: {error}", file=sys.stderr)
        return 2
    print(json.dumps(dict(building_id=building.building_id, building_version=building.building_version,
                         nodes=len(building.nodes), signs=len(building.signs),
                         scenario_id=scenario.scenario_id if scenario else None), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

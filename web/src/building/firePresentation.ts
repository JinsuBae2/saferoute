import type { Building, FireSimulation, HazardCell, Position } from "@contracts";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { insidePolygon, visibleWalls } from "./geometry";
import type { BuildingGeometry } from "./geometry";

/** 목록으로 고르면 구역 안의 대표 지점, 도면으로 고르면 클릭한 지점을 사용한다. */
export function defaultIgnition(building: Building, zoneId: string): Position | null {
  const zone = building.zones.find(z=>z.zone_id===zoneId);
  if (!zone) return null;
  const y = building.floors.find(f=>f.floor_id===zone.floor_id)!.elevation;
  const geometry = rawGeometry as unknown as BuildingGeometry;
  const floor = geometry.building_id === building.building_id && geometry.building_version === building.building_version
    ? geometry.floors.find(f=>f.floor_id===zone.floor_id) : undefined;
  const walls = floor ? visibleWalls(floor,geometry.stairs) : [];
  const available = (p: Position) => insidePolygon(p,zone.polygon) && !walls.some(([x0,z0,x1,z1])=>p.x>x0 && p.x<x1 && p.z>z0 && p.z<z1);
  const center = {x:zone.polygon.reduce((s,p)=>s+p.x,0)/zone.polygon.length, y, z:zone.polygon.reduce((s,p)=>s+p.z,0)/zone.polygon.length};
  if (available(center)) return center;
  const node = building.nodes.find(n=>n.zone_id===zoneId && available(n.position));
  return node?.position ?? null;
}

export function localSmoke(cells: readonly HazardCell[], zoneId: string, x: number, z: number): number {
  let smoke = 0;
  for (const cell of cells) {
    if (cell.zone_id === zoneId && Math.hypot(cell.position.x-x,cell.position.z-z) <= 2) smoke = Math.max(smoke,cell.smoke);
  }
  return smoke;
}

export function simulationFireCells(field: FireSimulation | null | undefined, floors: ReadonlySet<string>) {
  return field?.cells.filter(c=>c.fire>0 && floors.has(c.floor_id) && !c.cell_id.startsWith("node:") && !c.cell_id.startsWith("edge:")) ?? [];
}

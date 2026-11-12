import { describe, expect, it } from "vitest";
import type { Building, FireSimulation } from "@contracts";
import raw from "@space/wfi-v1.json";
import geometry from "@space/wfi-geometry-v1.json";
import { insidePolygon, visibleWalls } from "./geometry";
import type { BuildingGeometry } from "./geometry";
import { defaultIgnition, localSmoke, newFireFloors, simulationFireCells } from "./firePresentation";

const building = raw as Building;
const field: FireSimulation = { model:"DEMO_GRAPH_V1",cell_size_m:2, fires:[], cells:[
  {cell_id:"a",zone_id:"room",floor_id:"F1",position:{x:0,y:0,z:0},fire:.18,smoke:.7},
  {cell_id:"b",zone_id:"room",floor_id:"F1",position:{x:8,y:0,z:0},fire:0,smoke:0},
  {cell_id:"c",zone_id:"upstairs",floor_id:"F2",position:{x:0,y:4,z:0},fire:1,smoke:1},
] };

describe("server progressive fire presentation", () => {
  it("chooses an in-zone point even for narrow or concave WFI corridors", () => {
    for (const zone of building.zones) {
      const p = defaultIgnition(building,zone.zone_id);
      expect(p).not.toBeNull();
      expect(insidePolygon(p!,zone.polygon)).toBe(true);
      expect(p!.y).toBe(building.floors.find(f=>f.floor_id===zone.floor_id)!.elevation);
      const walls = visibleWalls(geometry.floors.find(f=>f.floor_id===zone.floor_id)! as unknown as BuildingGeometry["floors"][number],geometry.stairs as BuildingGeometry["stairs"]);
      expect(walls.some(([x0,z0,x1,z1])=>p!.x>x0 && p!.x<x1 && p!.z>z0 && p!.z<z1)).toBe(false);
    }
  });
  it("uses only nearby cells in the same zone for smoke, not the whole room or other floor", () => {
    expect(localSmoke(field.cells,"room",0,0)).toBe(.7);
    expect(localSmoke(field.cells,"room",8,0)).toBe(0);
    expect(localSmoke(field.cells,"outside",0,0)).toBe(0);
  });
  it("shows only server-reported flames and respects floor visibility", () => {
    expect(simulationFireCells(field,new Set(["F1"])).map(c=>c.cell_id)).toEqual(["a"]);
    expect(simulationFireCells(null,new Set(["F1"]))).toEqual([]);
  });
});

describe("newFireFloors", () => {
  const cause = (zone: string, id: string) => ({ source_id: `MANUAL-${zone}`, hazard_type: "FIRE" as const,
    first_event_id: id, last_event_id: id, activated_at: "2026-11-12T00:00:00Z", ignition_position: null });

  it("shows the floor again for a second fire on the same floor, but not on plain refreshes", () => {
    const first = [cause("F3-R304", "e1")];
    const opened = newFireFloors(building, first, new Set());
    expect([...opened.floors]).toEqual(["F3"]);
    // 사용자가 3층을 숨긴 뒤 같은 상태가 다시 와도 켜지 않는다.
    expect(newFireFloors(building, first, opened.seen).floors.size).toBe(0);
    const second = newFireFloors(building, [...first, cause("F3-R307", "e2")], opened.seen);
    expect([...second.floors]).toEqual(["F3"]);
    expect(newFireFloors(building, [...first, cause("F3-R307", "e2")], second.seen).floors.size).toBe(0);
  });
});

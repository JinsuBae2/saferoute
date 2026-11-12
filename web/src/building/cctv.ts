import type { Building, BuildingDisplay, Position } from "@contracts";

// WFI v5 가상 카메라의 조준점. 위치는 표시 자료, 시야 방향은 복도 안의 시연 지점이다.
const targets: Readonly<Record<string, string>> = {
  "CAM-F2-CORR-W": "F2-J-W2",
  "CAM-F2-CORR-E": "F2-J-E2",
  "CAM-F3-CORR-W": "F3-J-W2",
  "CAM-F3-CORR-E": "F3-J-E2",
};

export type CctvPose = { eye: Position; target: Position; zoneId: string };

export function cctvPose(building: Building | null, display: BuildingDisplay | null, id: string | null): CctvPose | null {
  if (!id || building?.building_id !== "WFI" || building.building_version !== 5 || !display) return null;
  const lens = display.sources[id]?.installation;
  const source = building.sources.find(s => s.source_id === id && s.source_type === "VIDEO_AI");
  const aim = building.nodes.find(n => n.node_id === targets[id]);
  if (!lens || !source || !aim || aim.floor_id !== lens.floor_id || aim.zone_id !== source.zone_id) return null;
  return { eye: lens.position, target: { ...aim.position, y: aim.position.y + 1.2 }, zoneId: source.zone_id };
}

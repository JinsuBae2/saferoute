import type { Building, BuildingDisplay, Position } from "@contracts";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("표시 자료의 객체 형식이 잘못됐습니다");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("표시 자료의 필드 또는 공간 ID가 일치하지 않습니다");
  }
}

function text(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error("표시 이름이 올바르지 않습니다");
}

/** Static assets need runtime validation as well as generated TypeScript shapes. */
export function parseDisplay(value: unknown, building: Building): BuildingDisplay {
  const data = object(value);
  keys(data, ["schema_version", "building_id", "building_version", "floor_labels", "zone_labels", "node_labels", "exit_labels", "sources", "signs"]);
  if (data.schema_version !== 1 || data.building_id !== building.building_id || data.building_version !== building.building_version) {
    throw new Error("표시 자료와 현재 건물의 ID·버전이 다릅니다");
  }
  const labels: [string, string[]][] = [
    ["floor_labels", building.floors.map((f) => f.floor_id)],
    ["zone_labels", building.zones.map((z) => z.zone_id)],
    ["node_labels", building.nodes.map((n) => n.node_id)],
    ["exit_labels", building.exits.map((e) => e.exit_id)],
  ];
  for (const [field, ids] of labels) {
    const entries = object(data[field]);
    keys(entries, ids);
    Object.values(entries).forEach(text);
  }
  const sources = object(data.sources);
  keys(sources, building.sources.map((s) => s.source_id));
  for (const source of building.sources) {
    const entry = object(sources[source.source_id]);
    keys(entry, ["label", "installation"]);
    text(entry.label);
    if (entry.installation === null) continue;
    const installation = object(entry.installation);
    keys(installation, ["floor_id", "position", "basis"]);
    if (!building.floors.some((f) => f.floor_id === installation.floor_id)) throw new Error("설치 위치의 층을 찾을 수 없습니다");
    const position = object(installation.position);
    keys(position, ["x", "y", "z"]);
    if (Object.values(position).some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("설치 좌표가 올바르지 않습니다");
    if (installation.basis !== "SIMULATED" && installation.basis !== "MEASURED") throw new Error("설치 위치 근거가 없습니다");
    if (installation.basis === "MEASURED" && (!building.coordinate_system.measured || source.source_type !== "VIDEO_AI")) {
      throw new Error("가상 좌표·설비를 실측 위치로 표시할 수 없습니다");
    }
  }
  const signs = object(data.signs);
  keys(signs, building.signs.map((s) => s.sign_id));
  for (const sign of building.signs) {
    const entry = object(signs[sign.sign_id]);
    keys(entry, ["label", "kind"]);
    text(entry.label);
    if (entry.kind !== "EXIT_LOCATION" && entry.kind !== "DIRECTIONAL") throw new Error("표지 종류가 올바르지 않습니다");
    if (entry.kind === "EXIT_LOCATION" && (
      !building.exits.some((e) => e.node_id === sign.node_id)
      || sign.faces.some((face) => face.default_next_node_id !== sign.node_id
        || Object.keys(face.next_node_to_display).length !== 1 || face.next_node_to_display[sign.node_id] !== "EXIT")
    )) throw new Error("출구 위치 표지가 기존 출구·표시면과 일치하지 않습니다");
  }
  return data as BuildingDisplay;
}

/** nodeId는 지점 이름표의 지점 ID, 카메라 이름표면 null. 출구 이름표를 출구 아이콘과 잇는 데 쓴다. */
export type SceneLabel = { text: string; floorId: string; position: Position; sourceId?: string; camera: boolean; priority: number; nodeId: string | null };

/** All floors show landmarks; one floor also shows room entrances. */
export function sceneLabels(building: Building, display: BuildingDisplay | null, visibleFloors: ReadonlySet<string>): SceneLabel[] {
  if (display === null) return [];
  const labels: SceneLabel[] = building.nodes
    .filter((node) => visibleFloors.has(node.floor_id) && (node.kind === "STAIR" || node.kind === "EXIT" || (visibleFloors.size === 1 && node.kind === "DOOR")))
    .map((node) => ({ text: display.node_labels[node.node_id], floorId: node.floor_id, position: node.position, camera: false, priority: node.kind === "DOOR" ? 2 : 1, nodeId: node.node_id }));
  for (const registered of building.sources) {
    if (registered.source_type !== "VIDEO_AI") continue;
    const source = display.sources[registered.source_id];
    const installation = source.installation;
    if (installation === null || !visibleFloors.has(installation.floor_id)) continue;
    labels.push({ text: source.label + (installation.basis === "SIMULATED" ? " (가상)" : ""), floorId: installation.floor_id, position: installation.position, camera: true, sourceId: registered.source_id, priority: 0, nodeId: null });
  }
  return labels;
}


type LabelBox = { left: number; top: number; width: number; height: number; priority: number };

/** Prefer landmarks and keep overlapping names available after zoom or rotation. */
export function visibleLabelIndexes(boxes: readonly LabelBox[]): Set<number> {
  const visible = new Set<number>();
  const placed: LabelBox[] = [];
  const ordered = boxes.map((box, index) => ({ box, index })).sort((a, b) => a.box.priority - b.box.priority);
  for (const { box, index } of ordered) {
    const overlaps = placed.some((other) => box.left < other.left + other.width + 3
      && box.left + box.width + 3 > other.left && box.top < other.top + other.height + 3
      && box.top + box.height + 3 > other.top);
    if (!overlaps) {
      placed.push(box);
      visible.add(index);
    }
  }
  return visible;
}

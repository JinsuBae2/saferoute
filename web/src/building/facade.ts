/** 직사각형 외관을 활성 출구의 통로 폭에 맞춰 나눈다. 높이는 층 바닥 기준이다. */
import type { Building } from "@contracts";
import type { GeometryFloor } from "./geometry";

export type FacadeBox = { x: number; y: number; z: number; width: number; height: number; depth: number };
export const EXIT_RUN_LENGTH = 4.5;
type Interval = readonly [number, number];

/** 돌출된 위층을 받치는 외관용 기둥. 아래층 바닥이 높이 0이다. */
export function facadeColumns(building: Building, upper: GeometryFloor, lower: GeometryFloor, height: number): FacadeBox[] {
  const xs = upper.slab.map((point) => point.x);
  const zs = upper.slab.map((point) => point.z);
  const belowZs = lower.slab.map((point) => point.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const rows = [
    ...(Math.min(...belowZs) - minZ > 0.5 ? [minZ + 0.5] : []),
    ...(maxZ - Math.max(...belowZs) > 0.5 ? [maxZ - 0.5] : []),
  ];
  const perRow = Math.round((maxX - minX) / 6.4) + 1;
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  const passages = building.exits.flatMap((exit) => {
    const node = nodes.get(exit.node_id);
    const inner = nodes.get(building.edges.find((edge) => edge.to_node_id === exit.node_id)?.from_node_id ?? "");
    if (!exit.enabled || node?.floor_id !== lower.floor_id || inner === undefined) return [];
    const dx = node.position.x - inner.position.x;
    const dz = node.position.z - inner.position.z;
    const length = Math.hypot(dx, dz);
    return length === 0 ? [] : [{ x: node.position.x, z: node.position.z, dx: dx / length, dz: dz / length }];
  });
  return height <= 0 ? [] : rows.flatMap((z) => Array.from({ length: perRow }, (_, index) => ({
    x: minX + 0.5 + index * (maxX - minX - 1) / (perRow - 1), y: height / 2, z,
    width: 0.6, height, depth: 0.6,
  }))).filter((column) => !passages.some((passage) => {
    const dx = column.x - passage.x;
    const dz = column.z - passage.z;
    const along = dx * passage.dx + dz * passage.dz;
    const across = Math.abs(dx * passage.dz - dz * passage.dx);
    // 출구부터 미끄럼틀 끝까지 사람과 양쪽 난간이 지나가는 폭을 비운다.
    return along >= -0.3 && along <= EXIT_RUN_LENGTH + 0.3 && across < 0.9 + 0.3;
  }));
}

function withoutOpenings(min: number, max: number, openings: readonly Interval[]): Interval[] {
  const pieces: Interval[] = [];
  let cursor = min;
  for (const [start, end] of openings) {
    if (start > cursor) pieces.push([cursor, Math.min(start, max)]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < max) pieces.push([cursor, max]);
  return pieces.filter(([start, end]) => end > start);
}

export function facadeParts(building: Building, floor: GeometryFloor, wallHeight: number): { glass: FacadeBox[]; frames: FacadeBox[]; band: FacadeBox[] } {
  const xs = floor.slab.map((point) => point.x);
  const zs = floor.slab.map((point) => point.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const sides = [
    { alongX: true, min: minX, max: maxX, edge: minZ, outward: -1 },
    { alongX: true, min: minX, max: maxX, edge: maxZ, outward: 1 },
    { alongX: false, min: minZ, max: maxZ, edge: minX, outward: -1 },
    { alongX: false, min: minZ, max: maxZ, edge: maxX, outward: 1 },
  ];
  const exits = new Set(building.exits.filter((exit) => exit.enabled).map((exit) => exit.node_id));
  const openings: Interval[][] = sides.map(() => []);
  for (const node of building.nodes) {
    if (node.floor_id !== floor.floor_id || !exits.has(node.node_id)) continue;
    const distances = sides.map((side) => Math.abs((side.alongX ? node.position.z : node.position.x) - side.edge));
    const index = distances.indexOf(Math.min(...distances));
    const side = sides[index];
    const center = side.alongX ? node.position.x : node.position.z;
    openings[index].push([Math.max(side.min, center - 0.9), Math.min(side.max, center + 0.9)]);
  }
  const glass: FacadeBox[] = [];
  const frames: FacadeBox[] = [];
  const band: FacadeBox[] = [];
  sides.forEach((side, index) => {
    const gaps: [number, number][] = [];
    for (const [start, end] of openings[index].sort((a, b) => a[0] - b[0])) {
      const previous = gaps.at(-1);
      if (previous !== undefined && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else if (end > start) gaps.push([start, end]);
    }
    const box = (start: number, end: number, bottom: number, height: number, depth: number, offset: number): FacadeBox => ({
      x: side.alongX ? (start + end) / 2 : side.edge + side.outward * offset,
      y: bottom + height / 2,
      z: side.alongX ? side.edge + side.outward * offset : (start + end) / 2,
      width: side.alongX ? end - start : depth,
      height,
      depth: side.alongX ? depth : end - start,
    });
    for (const [start, end] of withoutOpenings(side.min, side.max, gaps)) glass.push(box(start, end, 0, wallHeight, 0.1, 0.08));
    const doorHeight = Math.min(2.3, wallHeight);
    if (wallHeight > doorHeight) {
      for (const [start, end] of gaps) glass.push(box(start, end, doorHeight, wallHeight - doorHeight, 0.1, 0.08));
    }
    const count = Math.max(1, Math.round((side.max - side.min) / 1.8));
    for (let frame = 0; frame <= count; frame += 1) {
      const center = side.min + (side.max - side.min) * frame / count;
      if (gaps.some(([start, end]) => center + 0.06 > start && center - 0.06 < end)) continue;
      frames.push(box(center - 0.06, center + 0.06, 0, wallHeight, 0.12, 0.08));
    }
    // 하단 띠도 비워 바닥보다 낮아지는 미끄럼판을 막지 않는다.
    const grow = side.alongX ? 1 : 0;
    for (const [start, end] of withoutOpenings(side.min - grow, side.max + grow, gaps)) band.push(box(start, end, -0.45, 0.45, 1, 0.5));
  });
  return { glass, frames, band };
}

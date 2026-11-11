/**
 * 3D 표시용 형상 자료. Building 계약과 별도 파일이며 서버로 보내지 않는다.
 * 형식 정본은 data/space/README.md 10.1절, 연동 규칙은 05번 명세 2.3절이다.
 *
 * 이 파일은 정적 자산이라 서버 계약 검증을 거치지 않는다. 그래서 읽을 때
 * 형식을 직접 확인하고, 건물 ID·자료 버전이 현재 실행과 같을 때만 사용한다.
 */
import type { Building } from "@contracts";

export type PlanPoint = { readonly x: number; readonly z: number };

/** 벽 직사각형 [x0, z0, x1, z1]. 바닥(층 elevation)부터 wall_height만큼 올라간다. */
export type WallRect = readonly [number, number, number, number];

export type SlabHole = {
  readonly zone_id: string;
  readonly polygon: readonly PlanPoint[];
};

export type GeometryFloor = {
  readonly floor_id: string;
  readonly elevation: number;
  readonly slab: readonly PlanPoint[];
  readonly slab_holes: readonly SlabHole[];
  readonly walls: readonly WallRect[];
};

export type StairKind = "ENCLOSED" | "OPEN";

export type GeometryStair = {
  readonly stair_id: string;
  readonly kind: StairKind;
  readonly floors: readonly string[];
  readonly footprint: readonly PlanPoint[];
  readonly note?: string;
};

export type BuildingGeometry = {
  readonly format: "saferoute-geometry";
  readonly format_version: number;
  readonly building_id: string;
  readonly building_version: number;
  readonly unit: "m";
  readonly floor_height: number;
  readonly wall_height: number;
  readonly slab_thickness: number;
  readonly note: string;
  readonly floors: readonly GeometryFloor[];
  readonly stairs: readonly GeometryStair[];
};

export const SUPPORTED_FORMAT_VERSION = 1;

export class GeometryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeometryFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePoints(value: unknown, where: string): readonly PlanPoint[] {
  if (!Array.isArray(value)) throw new GeometryFormatError(`${where}가 배열이 아닙니다`);
  return value.map((point, index) => {
    if (!isRecord(point) || typeof point.x !== "number" || typeof point.z !== "number") {
      throw new GeometryFormatError(`${where}[${index}]에 x·z 좌표가 없습니다`);
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) {
      throw new GeometryFormatError(`${where}[${index}] 좌표가 유한하지 않습니다`);
    }
    return { x: point.x, z: point.z };
  });
}

/** 정적 파일이라 서버 검증을 못 받는다. 쓰기 전에 형식을 직접 확인한다. */
export function parseGeometry(value: unknown): BuildingGeometry {
  if (!isRecord(value)) throw new GeometryFormatError("형상 자료가 객체가 아닙니다");
  if (value.format !== "saferoute-geometry") {
    throw new GeometryFormatError("형상 파일 형식이 saferoute-geometry가 아닙니다");
  }
  if (value.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new GeometryFormatError(
      `지원하지 않는 형상 형식 버전입니다: ${String(value.format_version)}`,
    );
  }
  if (typeof value.building_id !== "string" || typeof value.building_version !== "number") {
    throw new GeometryFormatError("building_id·building_version이 없습니다");
  }
  if (value.unit !== "m") throw new GeometryFormatError("좌표 단위가 m이 아닙니다");
  for (const key of ["floor_height", "wall_height", "slab_thickness"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new GeometryFormatError(`${key}가 유한한 수가 아닙니다`);
    }
  }
  if (!Array.isArray(value.floors) || value.floors.length === 0) {
    throw new GeometryFormatError("층 형상이 없습니다");
  }
  if (!Array.isArray(value.stairs)) throw new GeometryFormatError("계단 형상이 배열이 아닙니다");

  const floors = value.floors.map((floor, index): GeometryFloor => {
    if (!isRecord(floor) || typeof floor.floor_id !== "string" || typeof floor.elevation !== "number") {
      throw new GeometryFormatError(`floors[${index}]에 floor_id·elevation이 없습니다`);
    }
    if (!Array.isArray(floor.walls)) throw new GeometryFormatError(`floors[${index}].walls가 배열이 아닙니다`);
    const walls = floor.walls.map((wall, wallIndex): WallRect => {
      if (!Array.isArray(wall) || wall.length !== 4 || wall.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        throw new GeometryFormatError(`floors[${index}].walls[${wallIndex}]가 [x0, z0, x1, z1] 형식이 아닙니다`);
      }
      return [wall[0] as number, wall[1] as number, wall[2] as number, wall[3] as number] as const;
    });
    const holes = Array.isArray(floor.slab_holes) ? floor.slab_holes : [];
    return {
      floor_id: floor.floor_id,
      elevation: floor.elevation,
      slab: requirePoints(floor.slab, `floors[${index}].slab`),
      slab_holes: holes.map((hole, holeIndex): SlabHole => {
        if (!isRecord(hole) || typeof hole.zone_id !== "string") {
          throw new GeometryFormatError(`floors[${index}].slab_holes[${holeIndex}]에 zone_id가 없습니다`);
        }
        return {
          zone_id: hole.zone_id,
          polygon: requirePoints(hole.polygon, `floors[${index}].slab_holes[${holeIndex}].polygon`),
        };
      }),
      walls,
    };
  });

  const stairs = value.stairs.map((stair, index): GeometryStair => {
    if (!isRecord(stair) || typeof stair.stair_id !== "string") {
      throw new GeometryFormatError(`stairs[${index}]에 stair_id가 없습니다`);
    }
    if (stair.kind !== "ENCLOSED" && stair.kind !== "OPEN") {
      throw new GeometryFormatError(`stairs[${index}].kind가 ENCLOSED·OPEN이 아닙니다`);
    }
    if (!Array.isArray(stair.floors) || stair.floors.some((id) => typeof id !== "string")) {
      throw new GeometryFormatError(`stairs[${index}].floors가 층 ID 배열이 아닙니다`);
    }
    return {
      stair_id: stair.stair_id,
      kind: stair.kind,
      floors: stair.floors as readonly string[],
      footprint: requirePoints(stair.footprint, `stairs[${index}].footprint`),
      ...(typeof stair.note === "string" ? { note: stair.note } : {}),
    };
  });

  return {
    format: "saferoute-geometry",
    format_version: SUPPORTED_FORMAT_VERSION,
    building_id: value.building_id,
    building_version: value.building_version,
    unit: "m",
    floor_height: value.floor_height as number,
    wall_height: value.wall_height as number,
    slab_thickness: value.slab_thickness as number,
    note: typeof value.note === "string" ? value.note : "",
    floors,
    stairs,
  };
}

export type GeometryMismatch = "BUILDING_ID" | "BUILDING_VERSION" | "MISSING_FLOOR";

export type GeometryMatch =
  | { readonly matched: true }
  | { readonly matched: false; readonly reason: GeometryMismatch; readonly detail: string };

/**
 * 05번 명세 2.3절: building_id와 building_version이 모두 같을 때만 함께 쓴다.
 * 하나라도 다르면 3D를 그리지 않는다. 경로·유도등 안내는 계속 서버 결과를 따른다.
 */
export function matchesBuilding(geometry: BuildingGeometry, building: Building): GeometryMatch {
  if (geometry.building_id !== building.building_id) {
    return {
      matched: false,
      reason: "BUILDING_ID",
      detail: `형상 ${geometry.building_id} / 공간 ${building.building_id}`,
    };
  }
  if (geometry.building_version !== building.building_version) {
    return {
      matched: false,
      reason: "BUILDING_VERSION",
      detail: `형상 v${geometry.building_version} / 공간 v${building.building_version}`,
    };
  }
  const known = new Set(geometry.floors.map((floor) => floor.floor_id));
  const missing = building.floors.filter((floor) => !known.has(floor.floor_id));
  if (missing.length > 0) {
    return {
      matched: false,
      reason: "MISSING_FLOOR",
      detail: missing.map((floor) => floor.floor_id).join(", "),
    };
  }
  return { matched: true };
}

export type Box2 = {
  readonly centerX: number;
  readonly centerZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
};

/** 좌표 순서가 뒤집혀 있어도 같은 직사각형으로 읽는다. */
export function wallBox(rect: WallRect): Box2 {
  const [x0, z0, x1, z1] = rect;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    // 두께가 0인 벽도 보이도록 최소 폭을 준다.
    sizeX: Math.max(maxX - minX, 0.05),
    sizeZ: Math.max(maxZ - minZ, 0.05),
  };
}

/** 점이 다각형 안에 있는지. 경계는 안쪽으로 본다. */
export function insidePolygon(point: PlanPoint, polygon: readonly PlanPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.z > point.z !== b.z > point.z;
    if (!straddles) continue;
    const crossX = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossX) inside = !inside;
  }
  return inside;
}

/**
 * 열린 계단(C·D) 범위 안에 남아 있는 난간 선을 벽으로 그리지 않기 위한 판정.
 * 공간 기준 문서 10.1절이 "계단 범위 안의 벽을 숨긴다"고 안내한 처리다.
 */
export function isInsideOpenStair(
  rect: WallRect,
  floorId: string,
  stairs: readonly GeometryStair[],
): boolean {
  const box = wallBox(rect);
  const center = { x: box.centerX, z: box.centerZ };
  return stairs.some(
    (stair) =>
      stair.kind === "OPEN" &&
      stair.floors.includes(floorId) &&
      insidePolygon(center, stair.footprint),
  );
}

/** 해당 층에서 실제로 그릴 벽. 열린 계단 안의 난간 선은 제외한다. */
export function visibleWalls(
  floor: GeometryFloor,
  stairs: readonly GeometryStair[],
): readonly WallRect[] {
  return floor.walls.filter((wall) => !isInsideOpenStair(wall, floor.floor_id, stairs));
}

export type StepBox = Box2 & { readonly centerY: number };

/**
 * 아래층 바닥(bottomY)에서 위층 바닥(topY)까지 오르는 디딤판들. footprint의 긴 변을 따라 오른다.
 * shortcut: 형상 자료에 오르는 방향이 없어 직선 한 구간으로 그린다, 방향·참 자료가 생기면 그 값을 쓴다.
 */
export function stairSteps(
  footprint: readonly PlanPoint[],
  bottomY: number,
  topY: number,
  reversed = false,
  count = 12,
): readonly StepBox[] {
  const xs = footprint.map((point) => point.x);
  const zs = footprint.map((point) => point.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const lengthX = Math.max(...xs) - minX;
  const lengthZ = Math.max(...zs) - minZ;
  const alongX = lengthX > lengthZ;
  const run = (alongX ? lengthX : lengthZ) / count;
  return Array.from({ length: count }, (_, index) => {
    const along = (reversed ? count - 1 - index : index) * run + run / 2;
    return {
      centerX: alongX ? minX + along : minX + lengthX / 2,
      centerZ: alongX ? minZ + lengthZ / 2 : minZ + along,
      centerY: bottomY + ((index + 1) * (topY - bottomY)) / count,
      sizeX: alongX ? run : lengthX,
      sizeZ: alongX ? lengthZ : run,
    };
  });
}

export type StairStepAlong = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 디딤판이 향하는 쪽(진행 방향)의 각도. */
  readonly yaw: number;
  readonly run: number;
  readonly width: number;
};

/**
 * 계단의 평면 중심선(아래에서 위로)과 디딤판 폭. 안내도의 모양을 따른다.
 * - 밀폐 계단: 가운데 벽을 끼고 올라갔다가 되돌아오는 꺾인 계단
 * - 열린 계단 중 넓적한 것: 대각선으로 오르다 둥글게 꺾여 직선으로 이어지는 계단
 * - 열린 계단 중 길쭉한 것: 곧은 계단
 * entry는 아래층에서 계단에 들어서는 지점이다. 그쪽에서 시작하도록 방향을 맞춘다.
 * shortcut: 형상 자료에 계단 모양·방향이 없어 종류와 가로세로 비로 추정한다, 자료에 모양이 생기면 그 값을 쓴다.
 */
export function stairCenterline(stair: GeometryStair, entry: PlanPoint | null): { points: readonly PlanPoint[]; width: number } {
  const xs = stair.footprint.map((point) => point.x);
  const zs = stair.footprint.map((point) => point.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const [sizeX, sizeZ] = [maxX - minX, maxZ - minZ];
  const alongZ = sizeZ >= sizeX;
  // 긴 변을 u, 짧은 변을 v로 놓고 만든 뒤 평면 좌표로 되돌린다.
  const [long, short] = alongZ ? [sizeZ, sizeX] : [sizeX, sizeZ];
  const at = (u: number, v: number): PlanPoint => (alongZ ? { x: minX + v, z: minZ + u } : { x: minX + u, z: minZ + v });
  let points: PlanPoint[];
  let width: number;
  if (stair.kind === "ENCLOSED") {
    width = short / 2 - 0.25;
    points = [at(0.5, short / 4), at(long - 0.7, short / 4), at(long - 0.7, (short * 3) / 4), at(0.5, (short * 3) / 4)];
  } else if (long / short < 2) {
    width = 1.3;
    points = [at(long * 0.62, 0.5), at(long * 0.24, short * 0.42), at(long * 0.1, short * 0.66), at(long * 0.2, short - 0.7), at(long - 0.5, short - 0.7)];
  } else {
    width = short - 0.3;
    points = [at(0.4, short / 2), at(long - 0.4, short / 2)];
  }
  if (entry !== null) {
    const far = (point: PlanPoint) => Math.hypot(point.x - entry.x, point.z - entry.z);
    if (stair.kind === "ENCLOSED") {
      // 꺾인 계단은 들어선 쪽으로 되돌아온다. 들어서는 쪽이 반대편이면 긴 변을 따라 뒤집는다.
      if (far(points[1]) < far(points[0])) points = points.map((point) => (alongZ ? { x: point.x, z: minZ + maxZ - point.z } : { x: minX + maxX - point.x, z: point.z }));
      // 두 줄 가운데 들어서는 지점에 가까운 줄로 올라간다. 먼 줄에서 시작하면 가운데 벽을 가로질러 걷게 된다.
      if (far(points[3]) < far(points[0])) points = [...points].reverse();
    } else if (far(points[points.length - 1]) < far(points[0])) {
      points = [...points].reverse();
    }
  }
  return { points, width };
}

/**
 * 두 층을 잇는 계단 가운데 point에 가장 가까운 것. 계단 지점(STAIR)은 계단 앞 복도에 찍혀 있어
 * 계단 범위 안에 있지 않은 경우가 많으므로, 포함 여부가 아니라 범위까지의 거리로 고른다.
 */
export function nearestStair(stairs: readonly GeometryStair[], floorA: string, floorB: string, point: PlanPoint): GeometryStair | null {
  let best: GeometryStair | null = null;
  let bestDistance = Infinity;
  for (const stair of stairs) {
    if (!stair.floors.includes(floorA) || !stair.floors.includes(floorB)) continue;
    const xs = stair.footprint.map((corner) => corner.x);
    const zs = stair.footprint.map((corner) => corner.z);
    const dx = Math.max(Math.min(...xs) - point.x, 0, point.x - Math.max(...xs));
    const dz = Math.max(Math.min(...zs) - point.z, 0, point.z - Math.max(...zs));
    const distance = Math.hypot(dx, dz);
    if (distance < bestDistance) [best, bestDistance] = [stair, distance];
  }
  return best;
}

/** 중심선을 따라 아래층 바닥(bottomY)에서 위층 바닥(topY)까지 디딤판을 고르게 놓는다. */
export function stairRun(points: readonly PlanPoint[], width: number, bottomY: number, topY: number): readonly StairStepAlong[] {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.z - points[index].z));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const count = Math.max(8, Math.min(40, Math.round(total / 0.3)));
  const run = total / count;
  return Array.from({ length: count }, (_, step) => {
    let left = (step + 0.5) * run;
    let segment = 0;
    while (segment < lengths.length - 1 && left > lengths[segment]) {
      left -= lengths[segment];
      segment += 1;
    }
    const from = points[segment];
    const to = points[segment + 1];
    const share = lengths[segment] === 0 ? 0 : left / lengths[segment];
    return {
      x: from.x + (to.x - from.x) * share,
      y: bottomY + ((step + 1) * (topY - bottomY)) / count,
      z: from.z + (to.z - from.z) * share,
      yaw: Math.atan2(to.x - from.x, to.z - from.z),
      run,
      width,
    };
  });
}

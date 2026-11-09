/**
 * 3D 화면 배치 계산. 실제 좌표·층 연결·경로 비용은 바꾸지 않고 "그리는 위치"만 정한다.
 *
 * - 층 펼침: 층마다 표시 높이를 (층 순서 × 간격)만큼 더 올린다. 바닥·벽·지점·경로·유도등·
 *   위험 표시가 모두 같은 함수를 써야 층을 벌려도 서로 어긋나지 않는다.
 * - 화면 맞춤: 보이는 층의 바닥 범위를 감싸는 상자를 구해 카메라 위치를 정한다.
 */
import type { BuildingGeometry, PlanPoint } from "./geometry";

/** 층 간격 조절 범위(m). 0이면 실제 층 높이 그대로다. */
export const SPREAD_MIN = 0;
export const SPREAD_MAX = 12;

export type FloorLift = (floorId: string) => number;

/** 층 순서(형상 파일의 floors 순서, 아래층부터)에 간격을 곱한 추가 높이. 모르는 층은 0. */
export function floorLift(geometry: BuildingGeometry, spread: number): FloorLift {
  const clamped = Math.min(SPREAD_MAX, Math.max(SPREAD_MIN, Number.isFinite(spread) ? spread : 0));
  const order = [...geometry.floors].sort((a, b) => a.elevation - b.elevation).map((floor) => floor.floor_id);
  const lift = new Map(order.map((id, index) => [id, index * clamped]));
  return (floorId) => lift.get(floorId) ?? 0;
}

/** 실제 y(층 elevation 기준)를 표시 y로 바꾼다. */
export function displayY(y: number, floorId: string, lift: FloorLift): number {
  return y + lift(floorId);
}

export type ViewBox = {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
};

/** 보이는 층들의 바닥 외곽과 벽 높이를 감싸는 표시 좌표 상자. 보이는 층이 없으면 null. */
export function visibleBox(
  geometry: BuildingGeometry,
  visibleFloors: ReadonlySet<string>,
  lift: FloorLift,
): ViewBox | null {
  const floors = geometry.floors.filter((floor) => visibleFloors.has(floor.floor_id));
  if (floors.length === 0) return null;
  const points: PlanPoint[] = floors.flatMap((floor) => [...floor.slab]);
  const bottoms = floors.map((floor) => displayY(floor.elevation, floor.floor_id, lift));
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...bottoms),
    maxY: Math.max(...bottoms) + geometry.wall_height,
    minZ: Math.min(...points.map((point) => point.z)),
    maxZ: Math.max(...points.map((point) => point.z)),
  };
}

export type ViewMode = "ANGLE" | "TOP";

export type CameraPose = {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  /** 이 상자를 다 담는 데 필요한 거리. 확대 제한의 기준으로 쓴다. */
  readonly distance: number;
};

/**
 * 상자 전체가 화면에 들어오는 카메라 위치.
 * ANGLE은 안내도 아래쪽(+z)·오른쪽에서 내려다보는 기본 시점, TOP은 거의 바로 위에서 본 평면이다.
 * TOP은 아주 조금 아래쪽(+z)으로 비켜 서서, 카메라 up을 바꾸지 않아도 화면 위쪽이
 * 안내도 위쪽(-z)과 같아지게 한다. 정확히 수직이면 회전 기준이 정해지지 않는다.
 */
export function fitPose(box: ViewBox, mode: ViewMode, fovDeg: number, aspect: number): CameraPose {
  const center = {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    z: (box.minZ + box.maxZ) / 2,
  };
  const sizeX = box.maxX - box.minX;
  const sizeY = box.maxY - box.minY;
  const sizeZ = box.maxZ - box.minZ;
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 0.1));
  const fit = (extent: number, fov: number) => extent / 2 / Math.tan(fov / 2);

  if (mode === "TOP") {
    const distance = Math.max(fit(sizeX, hFov), fit(sizeZ, vFov)) * 1.12 + sizeY / 2;
    return {
      position: { x: center.x, y: center.y + distance, z: center.z + distance * 0.02 },
      target: center,
      distance,
    };
  }

  const radius = Math.sqrt(sizeX ** 2 + sizeY ** 2 + sizeZ ** 2) / 2;
  const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
  // 방향: 오른쪽 아래(+x, +z)에서 약 35° 내려다본다.
  const elevation = (35 * Math.PI) / 180;
  const azimuth = (40 * Math.PI) / 180;
  const flat = Math.cos(elevation) * distance;
  return {
    position: {
      x: center.x + flat * Math.sin(azimuth),
      y: center.y + Math.sin(elevation) * distance,
      z: center.z + flat * Math.cos(azimuth),
    },
    target: center,
    distance,
  };
}

/**
 * 바닥에 눕힌 평면 화살표(기본 방향 -z, 안내도 위쪽)를 평면 방향 (dx, dz)로 돌리는 y축 회전각.
 * y축으로 θ 돌리면 (0, 0, -1)은 (-sin θ, 0, -cos θ)가 된다.
 */
export function planYaw(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** 회전 중심이 건물 밖으로 멀리 나가지 않게 상자 안(여유 포함)으로 묶는다. */
export function clampTarget(
  target: { x: number; y: number; z: number },
  box: ViewBox,
  margin = 4,
): { x: number; y: number; z: number } {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    x: clamp(target.x, box.minX - margin, box.maxX + margin),
    y: clamp(target.y, box.minY, box.maxY),
    z: clamp(target.z, box.minZ - margin, box.maxZ + margin),
  };
}

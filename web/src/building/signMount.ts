/**
 * 유도등 면과 위치 QR이 실제로 걸리는 자리. 3D 표시, 유도등 변경 목격 판정, QR 인식이 모두 이 값을 쓴다.
 * 가상 설비의 표시용 배치다(실제 설치 도면이 아니다). 방향·화살표 계산은 하지 않는다. 면의 기준 방향은 건물 자료의 view_direction 그대로다.
 */
import type { Building } from "@contracts";
import type { GeometryFloor, GeometryStair, PlanPoint, WallRect } from "./geometry";
import { insidePolygon, interiorWalls, segmentHitsWall, visibleWalls } from "./geometry";

type Sign = Building["signs"][number];
type Face = Sign["faces"][number];
type Node = Building["nodes"][number];

/** 표지판 가운데 높이(바닥에서, m). 보는 화면(개요·1인칭)과 무관하게 같다. 아랫변 2.25 m로 머리 위를 지난다. */
export const SIGN_HEIGHT = 2.45;
export const SIGN_WIDTH = 1.1;
export const SIGN_TALL = 0.4;
/** 여러 방향을 보는 다면형에서 면이 가운데에서 떨어진 거리(m). 네 면이 상자 모양으로 둘러선다. */
const SIGN_HALF = 0.55;

/** 면이 모두 한 축(앞뒤)에 있으면 판 하나의 양면형이다. 다른 쪽을 보는 면이 섞이면 다면형으로 건다. */
export function singleBoard(sign: Sign): boolean {
  const first = sign.faces[0].view_direction;
  return sign.faces.every((face) => Math.abs(face.view_direction.x * first.x + face.view_direction.z * first.z) > 0.98 * Math.hypot(face.view_direction.x, face.view_direction.z) * Math.hypot(first.x, first.z));
}

export type FacePlace = { readonly x: number; readonly z: number; /** 면이 향하는 쪽(그 면을 보는 사람 쪽)의 단위 벡터. */ readonly normalX: number; readonly normalZ: number };

/** 면 하나가 걸린 평면 위치와 향하는 쪽. view_direction은 그 면을 보는 사람의 시선이므로 면은 그 반대쪽을 향한다. */
export function facePlace(sign: Sign, node: Pick<Node, "position">, face: Face): FacePlace {
  const size = Math.hypot(face.view_direction.x, face.view_direction.z) || 1;
  const normalX = -face.view_direction.x / size;
  const normalZ = -face.view_direction.z / size;
  const out = singleBoard(sign) ? 0.052 : SIGN_HALF;
  return { x: node.position.x + normalX * out, z: node.position.z + normalZ * out, normalX, normalZ };
}

/** QR 판 가운데 높이(바닥에서, m)와 한 변(m). 서서 휴대폰으로 비추는 높이다. */
export const QR_HEIGHT = 1.4;
export const QR_SIZE = 0.45;
/** 벽면에서 띄우는 거리(m). 벽과 같은 면에 겹쳐 깜빡이지 않게 한다. */
const QR_OFF = 0.03;
/** 유도등 지점에서 이 거리 안의 벽에만 붙인다(m). 더 멀면 그 지점의 QR이라고 보기 어렵다. */
const QR_NEAR = 3.5;

export type QrMount = FacePlace;

/**
 * 그 유도등 지점의 위치 QR을 붙일 벽면. 없으면 null이고 그 지점에는 QR을 두지 않는다(공중에 띄우지 않는다).
 * - 실제로 그리는 안쪽 벽의 면에만 붙인다. 유리 외벽·열린 계단 난간·문틈(벽이 끊긴 곳)은 대상이 아니다.
 * - 지점에서 그 면이 벽에 가리지 않고 보여야 하고, 판 앞이 지점과 같은 구역이어야 한다. 벽 너머 다른 방 쪽 면에는 붙지 않는다.
 * - 판(0.45 m)이 다 올라갈 만큼 긴 면에서, 지점에 가장 가까운 자리를 고른다.
 */
export function qrMount(node: Pick<Node, "position">, zone: readonly PlanPoint[], floor: GeometryFloor, stairs: readonly GeometryStair[]): QrMount | null {
  const { x, z } = node.position;
  const margin = QR_SIZE / 2 + 0.08;
  const all = visibleWalls(floor, stairs);
  let best: (QrMount & { distance: number }) | null = null;
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  for (const [x0, z0, x1, z1] of interiorWalls(floor, stairs)) {
    const candidates: QrMount[] = [];
    if (z1 - z0 >= margin * 2) {
      if (x < x0) candidates.push({ x: x0 - QR_OFF, z: clamp(z, z0 + margin, z1 - margin), normalX: -1, normalZ: 0 });
      if (x > x1) candidates.push({ x: x1 + QR_OFF, z: clamp(z, z0 + margin, z1 - margin), normalX: 1, normalZ: 0 });
    }
    if (x1 - x0 >= margin * 2) {
      if (z < z0) candidates.push({ x: clamp(x, x0 + margin, x1 - margin), z: z0 - QR_OFF, normalX: 0, normalZ: -1 });
      if (z > z1) candidates.push({ x: clamp(x, x0 + margin, x1 - margin), z: z1 + QR_OFF, normalX: 0, normalZ: 1 });
    }
    for (const place of candidates) {
      const distance = Math.hypot(place.x - x, place.z - z);
      if (distance < 0.5 || distance > QR_NEAR || (best !== null && distance >= best.distance)) continue;
      const front = { x: place.x + place.normalX * 0.12, z: place.z + place.normalZ * 0.12 };
      if (!insidePolygon(front, zone)) continue;
      // 판 양 끝 앞도 벽에 묻히지 않아야 한다(모서리에 걸친 자리 제외).
      const along = { x: -place.normalZ * (QR_SIZE / 2), z: place.normalX * (QR_SIZE / 2) };
      const buried = all.some(([a, b, c, d]) => [-1, 1].some((side) => { const px = front.x + along.x * side; const pz = front.z + along.z * side; return px > a && px < c && pz > b && pz < d; }));
      if (buried || all.some((wall) => segmentHitsWall(wall, x, z, front.x, front.z))) continue;
      best = { ...place, distance };
    }
  }
  return best === null ? null : { x: best.x, z: best.z, normalX: best.normalX, normalZ: best.normalZ };
}

/** 건물 전체의 QR 부착 자리(유도등 ID → 자리). 붙일 벽이 없는 지점은 빠진다. */
export function qrMounts(building: Building, floors: readonly GeometryFloor[], stairs: readonly GeometryStair[]): Map<string, QrMount> {
  const mounts = new Map<string, QrMount>();
  for (const sign of building.signs) {
    const node = building.nodes.find((item) => item.node_id === sign.node_id);
    const zone = building.zones.find((item) => item.zone_id === node?.zone_id);
    const floor = floors.find((item) => item.floor_id === node?.floor_id);
    if (node === undefined || zone === undefined || floor === undefined) continue;
    const mount = qrMount(node, zone.polygon, floor, stairs);
    if (mount !== null) mounts.set(sign.sign_id, mount);
  }
  return mounts;
}

export type { WallRect };

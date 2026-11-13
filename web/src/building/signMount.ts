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

/** CEILING 천장에 매단 판 하나(양면 가능), SOLID 면마다 판을 세워 둘러싼 입체형. */
export type SignForm = "CEILING" | "SOLID";

/** 판 가운데 높이(바닥에서, m). 보는 화면(개요·1인칭)과 무관하게 같다. */
export const SIGN_HEIGHT = 2.45;
/** 판의 가로·세로와 외함 두께(m). 양면 판은 두께가 두 배다. */
const SIZE = { wide: 1.1, tall: 0.4, deep: 0.05 } as const;
const PIPE = 0.016;
/** 면을 알아볼 수 있는 한계. 면의 정면과 보는 방향 사이 각의 코사인이다(약 35도). */
const FACING = 0.82;

export type FacePlace = { readonly x: number; readonly z: number; /** 면이 향하는 쪽(그 면을 보는 사람 쪽)의 단위 벡터. */ readonly normalX: number; readonly normalZ: number };
/** 면 하나를 실제로 보여 주는 표시면의 자리. y는 바닥에서 판 가운데까지, tall은 판 높이, facing은 알아볼 수 있는 한계(코사인)다. */
export type FaceMount = FacePlace & { readonly faceId: string; readonly y: number; readonly tall: number; readonly facing: number };
/** 표시면 한 장. 자료의 면(faceId)의 표시값을 받아 그린다. */
export type SignPanel = FacePlace & { readonly faceId: string };
/** 기구 하나. (x, z)는 가운데다. 경로 지점과 다를 수 있다(벽과 겹치면 옮긴다). */
export type SignFixture = { readonly form: SignForm; readonly x: number; readonly z: number; readonly y: number;
  readonly wide: number; readonly tall: number; readonly deep: number; readonly panels: readonly SignPanel[]; readonly faces: readonly FaceMount[] };
export type SignInstall = { readonly fixtures: readonly SignFixture[]; readonly faces: ReadonlyMap<string, FaceMount & { readonly form: SignForm }> };
/** 실제로 세우는 덩어리 하나(외함·지지 파이프·천장 받침). (x, z)는 가운데, y는 바닥에서 가운데까지, wide는 normal에 직각인 가로, deep은 normal 방향 두께다. */
export type FixturePart = { readonly role: "HOUSING" | "STEM" | "BASE"; readonly x: number; readonly z: number; readonly y: number; readonly normalX: number; readonly normalZ: number; readonly wide: number; readonly tall: number; readonly deep: number };

/**
 * 기구를 이루는 덩어리. 3D는 이 도형을 그대로 세우고, 벽 겹침 검사도 이 도형으로 한다(따로 어림한 상자를 쓰지 않는다).
 * rod는 판 윗변에서 천장까지의 길이로, 천장형·입체형의 지지 파이프와 받침에만 쓴다.
 */
export function fixtureParts(fixture: SignFixture, rod: number): FixturePart[] {
  const first = fixture.panels[0];
  const parts: FixturePart[] = [];
  if (fixture.form === "SOLID") {
    // 면마다 얇은 외함을 하나씩. 표시면 바로 뒤에 있다.
    for (const panel of fixture.panels) parts.push({ role: "HOUSING", x: panel.x - panel.normalX * (fixture.deep / 2), z: panel.z - panel.normalZ * (fixture.deep / 2), y: fixture.y, normalX: panel.normalX, normalZ: panel.normalZ, wide: fixture.wide, tall: fixture.tall, deep: fixture.deep });
  } else parts.push({ role: "HOUSING", x: fixture.x, z: fixture.z, y: fixture.y, normalX: first.normalX, normalZ: first.normalZ, wide: fixture.wide, tall: fixture.tall, deep: fixture.deep });
  const top = fixture.y + fixture.tall / 2;
  const stem = (x: number, z: number) => parts.push({ role: "STEM", x, z, y: top + rod / 2, normalX: first.normalX, normalZ: first.normalZ, wide: PIPE, tall: rod, deep: PIPE });
  if (fixture.form === "CEILING") {
    const [tx, tz] = [-first.normalZ, first.normalX];
    stem(fixture.x + tx * fixture.wide * 0.3, fixture.z + tz * fixture.wide * 0.3);
    stem(fixture.x - tx * fixture.wide * 0.3, fixture.z - tz * fixture.wide * 0.3);
    parts.push({ role: "BASE", x: fixture.x, z: fixture.z, y: top + rod, normalX: first.normalX, normalZ: first.normalZ, wide: fixture.wide * 0.8, tall: 0.02, deep: 0.06 });
  } else stem(fixture.x, fixture.z);
  return parts;
}

/** 덩어리 하나가 평면에서 차지하는 네 모서리. */
function partCorners(part: FixturePart): PlanPoint[] {
  const [tx, tz] = [-part.normalZ, part.normalX];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: part.x + tx * part.wide / 2 * a + part.normalX * part.deep / 2 * b, z: part.z + tz * part.wide / 2 * a + part.normalZ * part.deep / 2 * b }));
}

/** 기구의 외함·지지대가 벽과 겹치는지. 실제로 세우는 도형(fixtureParts)의 모서리가 벽 안에 있거나 변·대각선이 벽을 지나면 겹친 것이다. */
export function fixtureHitsWall(fixture: SignFixture, walls: readonly WallRect[]): boolean {
  return fixtureParts(fixture, 0.3).some((part) => {
    const corners = partCorners(part);
    return [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]].some(([a, b]) => walls.some((wall) => segmentHitsWall(wall, corners[a].x, corners[a].z, corners[b].x, corners[b].z)));
  });
}

/** 그 표시면을 정면 1.5 m 앞에서 볼 때 벽에 가리는지. 접근 방향을 보는 면이 있어도 가려 있으면 소용없다. */
export function faceHidden(face: FacePlace, walls: readonly WallRect[]): boolean {
  const [fx, fz] = [face.x + face.normalX * 0.01, face.z + face.normalZ * 0.01];
  return walls.some((wall) => segmentHitsWall(wall, face.x + face.normalX * 1.5, face.z + face.normalZ * 1.5, fx, fz));
}

/** 그 지점으로 같은 층에서 걸어오는 이웃 지점들. */
export type SignSite = { readonly approaches: readonly PlanPoint[] };

/**
 * 유도등 하나의 설치. 경로 지점(node)과 실제로 걸리는 자리는 다르다. 3D 표시, 변경 목격 판정, 검증 스크립트가 모두 이 결과를 쓴다.
 * - 그쪽에서 걸어오는 통로가 없는 면은 달지 않는다(자료에는 앞뒤 면이 늘 짝으로 있다). 그 방향의 접근이 없으므로 안내가 빠지지 않는다.
 * - 남은 면은 지점 위 천장에 건다. 한 축(앞뒤)이면 판 하나, 두 축이면 입체형이다.
 * - 외함·지지대가 벽과 겹치면 겹치지 않는 가장 가까운 자리로 옮긴다.
 */
export function signInstall(sign: Sign, node: Pick<Node, "position" | "kind">, floor: GeometryFloor, site: SignSite): SignInstall {
  const all = floor.walls;
  const { x, z } = node.position;
  const unit = (face: Face) => {
    const size = Math.hypot(face.view_direction.x, face.view_direction.z) || 1;
    return { faceId: face.face_id, viewX: face.view_direction.x / size, viewZ: face.view_direction.z / size, normalX: -face.view_direction.x / size, normalZ: -face.view_direction.z / size };
  };
  const rest = sign.faces.map(unit).filter((face) => node.kind !== "JUNCTION" || site.approaches.some((from) => {
    const [dx, dz] = [x - from.x, z - from.z];
    return (face.viewX * dx + face.viewZ * dz) / (Math.hypot(dx, dz) || 1) >= 0.7;
  }));
  if (rest.length === 0) return { fixtures: [], faces: new Map() };
  const first = rest[0];
  const flat = rest.every((face) => Math.abs(face.normalX * first.normalX + face.normalZ * first.normalZ) > 0.98);
  // 양면 판은 외함 하나에 앞뒤로 면이 붙고, 입체형은 면마다 얇은 외함이 가운데에서 가로 절반만큼 나와 선다.
  const deep = flat && rest.length > 1 ? SIZE.deep * 2 : SIZE.deep;
  const out = flat ? deep / 2 : SIZE.wide / 2 + deep;
  const at = (cx: number, cz: number): SignFixture => {
    const panels = rest.map((face) => ({ faceId: face.faceId, x: cx + face.normalX * out, z: cz + face.normalZ * out, normalX: face.normalX, normalZ: face.normalZ }));
    return { form: flat ? "CEILING" : "SOLID", x: cx, z: cz, y: SIGN_HEIGHT, wide: SIZE.wide, tall: SIZE.tall, deep, panels,
      faces: panels.map((panel) => ({ ...panel, y: SIGN_HEIGHT, tall: SIZE.tall, facing: FACING })) };
  };
  const shifts = [[0, 0], ...[0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1].flatMap((d) => [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [d, -d], [-d, d], [-d, -d]])];
  const fixture = shifts.map(([dx, dz]) => at(x + dx, z + dz)).find((item) => !fixtureHitsWall(item, all)) ?? at(x, z);
  return { fixtures: [fixture], faces: new Map(fixture.faces.map((face) => [face.faceId, { ...face, form: fixture.form }] as const)) };
}

/** 건물의 모든 유도등 설치. 열쇠는 sign_id다. */
export function signInstalls(building: Pick<Building, "signs" | "nodes" | "edges">, floors: readonly GeometryFloor[]): Map<string, SignInstall> {
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  const installs = new Map<string, SignInstall>();
  for (const sign of building.signs) {
    const node = nodes.get(sign.node_id);
    const floor = floors.find((item) => item.floor_id === node?.floor_id);
    if (node === undefined || floor === undefined) continue;
    const incoming = building.edges.filter((edge) => edge.to_node_id === node.node_id && edge.traversable).map((edge) => ({ edge, from: nodes.get(edge.from_node_id) }))
      .filter((item) => item.from !== undefined && item.from.floor_id === node.floor_id);
    installs.set(sign.sign_id, signInstall(sign, node, floor, { approaches: incoming.map((item) => ({ x: item.from!.position.x, z: item.from!.position.z })) }));
  }
  return installs;
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

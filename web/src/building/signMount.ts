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

/**
 * 유도등 설치 유형. 「유도등 및 유도표지의 화재안전기술기준(NFTC 303, 2024. 7. 1. 시행)」과 소방청 질의회신·해설의 구분을 따른다.
 * - EXIT 피난구유도등: 바깥 출구와 계단실 출입구, 바닥에서 1.5 m 이상(2.2.1, 2.2.2). 녹색 바탕.
 * - CORRIDOR 복도통로유도등: 벽으로 구획된 복도의 벽, 바닥에서 1 m 이하(2.3.1.1.3). 흰 바탕.
 * - HALL 거실통로유도등: 로비처럼 벽·기둥이 없는 트인 통로의 천장, 바닥에서 1.5 m 이상(2.3.1.2). 흰 바탕.
 * - CROSSING 복도 교차부의 천장형 통로유도등(거실통로유도등 형식): 벽부형만으로는 방향을 분명히 알리기 어려운 갈림길의 보완이다(해설서의 허용 범위, 조문의 필수 설치는 아니다).
 * 계단통로유도등은 계단참에 다는 것인데 이 건물 자료에는 계단참 유도등이 없어 두지 않는다.
 * 화살표가 바뀌는 것은 이 시연의 가변 안내 장치다. 크기는 판매 중인 제품의 외형 치수다(docs/implementation/sign-install.md).
 */
export type SignKind = "EXIT" | "CORRIDOR" | "HALL" | "CROSSING";
/** WALL 벽부형(벽에 평행), CEILING 천장형(판 하나, 양면 가능), SOLID 입체형(면마다 판을 세워 둘러싼 것). */
export type SignForm = "WALL" | "CEILING" | "SOLID";

/** 벽부형 복도통로유도등 판 가운데 높이. 윗변 0.9925 m로 1 m 이하다. */
export const SIGN_LOW = 0.9;
/** 출입구 위 피난구유도등 판 가운데 높이. 문틀(2.1 m) 위다. */
export const SIGN_DOOR = 2.3;
/** 천장형 판 가운데 높이(바닥에서, m). 보는 화면(개요·1인칭)과 무관하게 같다. */
export const SIGN_HEIGHT = 2.45;
/** 외형 치수(m, 가로×세로×두께). 피난구 중형 와이드 벽부 510×162.5×46, 복도통로 소형 벽부 147×185×42, 천장 양면 중형 300×260×100. */
const SIZE = {
  EXIT: { wide: 0.51, tall: 0.1625, deep: 0.046 },
  CORRIDOR: { wide: 0.147, tall: 0.185, deep: 0.042 },
  CEILING: { wide: 0.3, tall: 0.26, deep: 0.1 },
} as const;
/** 양면 천장형의 두께와 천장 지지 파이프 굵기(m). */
const DOUBLE_DEEP = 0.1;
const PIPE = 0.016;
/** 외함 뒷면을 벽면에서 띄우는 틈(m). 벽과 같은 면에 겹치지 않게 한다. */
const WALL_GAP = 0.002;
/** 면이 보는 쪽 뒤로, 또는 옆으로 이 거리 안에 벽이 있으면 그 벽에 붙인다(m). */
const WALL_REACH = 2.5;
/** 면을 알아볼 수 있는 한계. 면의 정면과 보는 방향 사이 각의 코사인이다. 마주 보는 면은 약 35도, 옆벽의 벽부형은 표시면이 외함에서 나와 있어 약 70도까지 본다. */
const FACING = 0.82;
const FACING_SIDE = 0.34;

export type FacePlace = { readonly x: number; readonly z: number; /** 면이 향하는 쪽(그 면을 보는 사람 쪽)의 단위 벡터. */ readonly normalX: number; readonly normalZ: number };
/** 면 하나를 실제로 보여 주는 표시면의 자리. y는 바닥에서 판 가운데까지, tall은 판 높이, facing은 알아볼 수 있는 한계(코사인)다. */
export type FaceMount = FacePlace & { readonly faceId: string; readonly y: number; readonly tall: number; readonly facing: number };
/** 표시면 한 장. 자료의 면(faceId)의 표시값을 받아 그린다. (viewX, viewZ)는 그 면을 보는 사람의 시선이다. */
export type SignPanel = FacePlace & { readonly faceId: string; readonly viewX: number; readonly viewZ: number };
/** 기구 하나. 한 유도등(sign)이 방향에 따라 여러 기구로 나뉠 수 있다. (x, z)는 외함 가운데다. */
export type SignFixture = { readonly kind: SignKind; readonly form: SignForm; readonly x: number; readonly z: number; readonly y: number;
  readonly wide: number; readonly tall: number; readonly deep: number; readonly panels: readonly SignPanel[]; readonly faces: readonly FaceMount[] };
export type SignInstall = { readonly fixtures: readonly SignFixture[]; readonly faces: ReadonlyMap<string, FaceMount & { readonly kind: SignKind; readonly form: SignForm }> };
/** 실제로 세우는 덩어리 하나(외함·지지 파이프·천장 받침). (x, z)는 가운데, y는 바닥에서 가운데까지, wide는 normal에 직각인 가로, deep은 normal 방향 두께다. */
export type FixturePart = { readonly role: "HOUSING" | "STEM" | "BASE"; readonly x: number; readonly z: number; readonly y: number; readonly normalX: number; readonly normalZ: number; readonly wide: number; readonly tall: number; readonly deep: number };

/** (x, z)에서 (dx, dz) 방향으로 나아가 벽 직사각형에 처음 닿는 거리. 닿지 않으면 null. */
function rayToWall([x0, z0, x1, z1]: WallRect, x: number, z: number, dx: number, dz: number): number | null {
  let low = 0;
  let high = Infinity;
  for (const [start, delta, lo, hi] of [[x, dx, x0, x1], [z, dz, z0, z1]]) {
    if (Math.abs(delta) < 1e-9) {
      if (!(lo < start && start < hi)) return null;
    } else {
      low = Math.max(low, Math.min((lo - start) / delta, (hi - start) / delta));
      high = Math.min(high, Math.max((lo - start) / delta, (hi - start) / delta));
    }
  }
  return low < high && low > 0 ? low : null;
}

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
  if (fixture.form === "WALL") return parts;
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

const TURN = ["FORWARD", "RIGHT", "BACK", "LEFT"] as const;
/**
 * 자료의 면이 가리키는 방향을, 다른 쪽을 향해 붙은 표시면에서 본 화살표로 옮긴다. 방향 자체는 서버 표시값 그대로다.
 * (viewX, viewZ)는 자료의 면을 보는 사람의 시선, (normalX, normalZ)는 표시면이 향하는 쪽이다. 화살표가 아닌 값(출구 표시 등)은 그대로 둔다.
 */
export function shownDisplay(display: string, viewX: number, viewZ: number, normalX: number, normalZ: number): string {
  const turn = TURN.indexOf(display as (typeof TURN)[number]);
  if (turn < 0) return display;
  // 보는 사람의 오른쪽은 (-z, x)다(건물 자료의 화살표 규칙과 같다).
  const [dx, dz] = [[viewX, viewZ], [-viewZ, viewX], [-viewX, -viewZ], [viewZ, -viewX]][turn];
  const angle = Math.atan2(-normalX * dz + normalZ * dx, -normalX * dx - normalZ * dz) * 180 / Math.PI;
  return Math.abs(angle) <= 45.001 ? "FORWARD" : Math.abs(angle) >= 134.999 ? "BACK" : angle > 0 ? "RIGHT" : "LEFT";
}

/** 그 지점의 쓰임. approaches는 같은 층에서 이 지점으로 걸어오는 이웃 지점들, junction은 문이 아닌 통로가 셋 이상 만나는 갈림길, corridor는 벽으로 구획된 복도 구역인지다. */
export type SignSite = { readonly approaches: readonly PlanPoint[]; readonly junction: boolean; readonly corridor: boolean };

/**
 * 유도등 하나의 설치. 경로 지점(node)과 실제로 걸리는 자리는 다르다. 3D 표시, 변경 목격 판정, 검증 스크립트가 모두 이 결과를 쓴다.
 * 1. 그쪽에서 걸어오는 통로가 없는 면은 달지 않는다(자료에는 앞뒤 면이 늘 짝으로 있다). 그 방향의 접근이 없으므로 안내가 빠지지 않는다.
 * 2. 출구·계단실 출입구는 그 자리 위의 피난구유도등이다.
 * 3. 복도에서는 보는 사람 정면에 벽이 있으면 그 벽에(모퉁이·맞은편 벽), 갈림길이 아니면 옆벽에 낮은 벽부형을 붙인다.
 *    옆벽의 한 장은 앞뒤 두 면을 함께 맡고, 같은 방향을 그 판에서 본 화살표로 그린다(shownDisplay).
 * 4. 남은 면은 천장에 건다. 복도 갈림길이면 보완 천장형(CROSSING), 트인 공간이면 거실통로유도등(HALL)이다. 한 축이면 양면 판, 두 축이면 입체형이다.
 * 외함이 벽과 겹치거나 표시면이 가리는 자리는 쓰지 않고, 천장 기구가 벽과 겹치면 겹치지 않는 자리로 옮긴다.
 */
export function signInstall(sign: Sign, node: Pick<Node, "position" | "kind">, floor: GeometryFloor, stairs: readonly GeometryStair[], site: SignSite): SignInstall {
  const all = floor.walls;
  const mountable = interiorWalls(floor, stairs);
  const { x, z } = node.position;
  const fixtures: SignFixture[] = [];
  const unit = (face: Face) => {
    const size = Math.hypot(face.view_direction.x, face.view_direction.z) || 1;
    return { faceId: face.face_id, viewX: face.view_direction.x / size, viewZ: face.view_direction.z / size, normalX: -face.view_direction.x / size, normalZ: -face.view_direction.z / size };
  };
  const needed = sign.faces.map(unit).filter((face) => node.kind !== "JUNCTION" || site.approaches.some((from) => {
    const [dx, dz] = [x - from.x, z - from.z];
    return (face.viewX * dx + face.viewZ * dz) / (Math.hypot(dx, dz) || 1) >= 0.7;
  }));
  /** 벽면에 붙는 낮은 벽부형. (dirX, dirZ)는 지점에서 벽 쪽이다. 붙일 수 없으면 null. */
  const onWall = (dirX: number, dirZ: number, shown: (typeof needed)[number], served: typeof needed, facing: number): SignFixture | null => {
    const reach = Math.min(...mountable.map((wall) => rayToWall(wall, x, z, dirX, dirZ) ?? Infinity));
    if (reach < 0.3 || reach > WALL_REACH) return null;
    const size = SIZE.CORRIDOR;
    const face = { x: x + dirX * (reach - WALL_GAP - size.deep), z: z + dirZ * (reach - WALL_GAP - size.deep), normalX: -dirX, normalZ: -dirZ };
    const fixture: SignFixture = { kind: "CORRIDOR", form: "WALL", x: face.x + dirX * size.deep / 2, z: face.z + dirZ * size.deep / 2, y: SIGN_LOW, ...size,
      panels: [{ ...face, faceId: shown.faceId, viewX: shown.viewX, viewZ: shown.viewZ }],
      faces: served.map((item) => ({ ...face, faceId: item.faceId, y: SIGN_LOW, tall: size.tall, facing })) };
    return fixtureHitsWall(fixture, all) || faceHidden(face, all) ? null : fixture;
  };
  let rest = needed;
  if (node.kind === "JUNCTION" && site.corridor) {
    // 보는 사람 정면의 벽(모퉁이·맞은편 벽).
    rest = rest.filter((face) => {
      const fixture = onWall(face.viewX, face.viewZ, face, [face], FACING);
      if (fixture !== null) fixtures.push(fixture);
      return fixture === null;
    });
    // 갈림길이 아닌 복도 지점: 한 축(앞뒤)의 면을 옆벽 한 장이 맡는다. 가까운 쪽 벽을 먼저 본다.
    if (!site.junction) {
      const done = new Set<string>();
      for (const face of rest) {
        if (done.has(face.faceId)) continue;
        const pair = rest.filter((item) => Math.abs(item.viewX * face.viewX + item.viewZ * face.viewZ) > 0.98);
        const sides = [[-face.viewZ, face.viewX], [face.viewZ, -face.viewX]]
          .map(([dirX, dirZ]) => ({ dirX, dirZ, reach: Math.min(...mountable.map((wall) => rayToWall(wall, x, z, dirX, dirZ) ?? Infinity)) }))
          .sort((a, b) => a.reach - b.reach);
        const fixture = sides.map((side) => onWall(side.dirX, side.dirZ, face, pair, FACING_SIDE)).find((item) => item !== null);
        if (fixture !== null && fixture !== undefined) {
          fixtures.push(fixture);
          for (const item of pair) done.add(item.faceId);
        }
      }
      rest = rest.filter((face) => !done.has(face.faceId));
    }
  }
  if (rest.length > 0) {
    const first = rest[0];
    const flat = rest.every((face) => Math.abs(face.normalX * first.normalX + face.normalZ * first.normalZ) > 0.98);
    const kind: SignKind = node.kind !== "JUNCTION" ? "EXIT" : site.corridor ? "CROSSING" : "HALL";
    const base = kind === "EXIT" ? SIZE.EXIT : SIZE.CEILING;
    const y = kind === "EXIT" ? SIGN_DOOR : SIGN_HEIGHT;
    // 양면 판은 두께 100 mm의 외함 하나, 입체형은 면마다 얇은 외함이 가운데에서 가로 절반만큼 나와 선다.
    const deep = !flat ? SIZE.EXIT.deep : rest.length > 1 ? DOUBLE_DEEP : base.deep;
    const out = flat ? deep / 2 : base.wide / 2 + deep;
    const at = (cx: number, cz: number): SignFixture => {
      const panels = rest.map((face) => ({ faceId: face.faceId, viewX: face.viewX, viewZ: face.viewZ, x: cx + face.normalX * out, z: cz + face.normalZ * out, normalX: face.normalX, normalZ: face.normalZ }));
      return { kind, form: flat ? "CEILING" : "SOLID", x: cx, z: cz, y, wide: base.wide, tall: base.tall, deep, panels,
        faces: panels.map((panel) => ({ faceId: panel.faceId, x: panel.x, z: panel.z, normalX: panel.normalX, normalZ: panel.normalZ, y, tall: base.tall, facing: FACING })) };
    };
    // 지점이 벽에 붙어 있으면 기구가 벽에 묻힌다. 가까운 순서로 옮겨 보며 겹치지 않는 첫 자리를 쓴다.
    const shifts = [[0, 0], ...[0.1, 0.2, 0.3, 0.45, 0.6].flatMap((d) => [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [d, -d], [-d, d], [-d, -d]])];
    fixtures.push(shifts.map(([dx, dz]) => at(x + dx, z + dz)).find((fixture) => !fixtureHitsWall(fixture, all)) ?? at(x, z));
  }
  const faces = new Map(fixtures.flatMap((fixture) => fixture.faces.map((face) => [face.faceId, { ...face, kind: fixture.kind, form: fixture.form }] as const)));
  return { fixtures, faces };
}

/** 건물의 모든 유도등 설치. 열쇠는 sign_id다. 복도인지는 구역 ID의 CORR로 본다(건물 자료에 구역 용도 항목이 따로 없다). */
export function signInstalls(building: Pick<Building, "signs" | "nodes" | "edges">, floors: readonly GeometryFloor[], stairs: readonly GeometryStair[]): Map<string, SignInstall> {
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  const installs = new Map<string, SignInstall>();
  for (const sign of building.signs) {
    const node = nodes.get(sign.node_id);
    const floor = floors.find((item) => item.floor_id === node?.floor_id);
    if (node === undefined || floor === undefined) continue;
    const incoming = building.edges.filter((edge) => edge.to_node_id === node.node_id && edge.traversable).map((edge) => ({ edge, from: nodes.get(edge.from_node_id) }))
      .filter((item) => item.from !== undefined && item.from.floor_id === node.floor_id);
    const site: SignSite = {
      approaches: incoming.map((item) => ({ x: item.from!.position.x, z: item.from!.position.z })),
      junction: new Set(incoming.filter((item) => item.edge.kind !== "DOOR").map((item) => item.from!.node_id)).size >= 3,
      corridor: node.zone_id.includes("-CORR-"),
    };
    installs.set(sign.sign_id, signInstall(sign, node, floor, stairs, site));
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

/**
 * 선택형 시연 「영남이」: 휴게공간에서 이어폰을 끼고 자다가 늦게 대피하는 한 사람.
 *
 * 연출하는 것은 이 사람의 행동(자기·알아채기·복도로 나와 당황·방송 듣기·유도등 확인)뿐이다.
 * 화재 확산·경로·유도등 방향은 서버 결과 그대로이며, 여기서 위험 판정을 건너뛰거나 탈출을 보장하지 않는다.
 * 시점은 서버가 준 발화 후 경과 시간으로 정해, 새로고침하거나 다른 화면에서 봐도 같은 장면이다.
 *
 * 발화 위치·출발점·시점은 서버 확산 모형과 경로 계산으로 후보를 모의해 고른 값이다(docs/implementation/yeongnam-demo.md).
 * 이 발화에서는 불꽃보다 연기가 먼저 통로를 막는다(시험용 확산 모형 기준, tools/yeongnam_check.py로 다시 확인).
 * - 36초쯤: 302호 앞 복도가 연기로 막힌다(불꽃은 약 40초에 닿는다). 300호 앞 갈림길 유도등이 직진에서 우회전으로 바뀐다.
 *   영남이는 복도에 나와 서서 이 유도등을 마주 보고 있다.
 * - 45초쯤: 계단 B가 연기로 막힌다(불꽃은 약 52초). 북쪽 복도를 걷던 영남이 정면의 유도등이 계단 A 쪽으로 바뀐다.
 * shortcut: WFI v7 한 건물의 좌표다, 건물 자료나 확산 속도가 바뀌면 후보 모의부터 다시 한다.
 */
import type { Building, Position, StateSnapshot } from "@contracts";
import type { WallRect } from "./geometry";
import { segmentHitsWall } from "./geometry";
import type { SignInstall } from "./signMount";

export const YEONGNAM = {
  buildingId: "WFI",
  buildingVersion: 7,
  /** 영남이로 지정한 기존 인원의 시작 위치(3층 300호 문). 새 인원을 더하지 않는다. */
  startNodeId: "F3-D-R300",
  zoneId: "F3-R302",
  ignition: { x: 44, y: 8, z: 19.5 } as Position,
  /** 방 안에서 자는 자리. 300호를 휴게공간으로 꾸민 것은 시연 설정이고 실제 용도가 아니다. */
  rest: { x: 40.4, z: 1.7 },
  restLabel: "휴게공간(시연 설정 · 실제 300호)",
  /**
   * 깨어나 복도로 나와 서는 자리(300호 문 앞 복도 지점)와 바라보는 쪽(302호가 있는 남쪽).
   * 방 안에서는 벽에 가려 복도 끝이 보이지 않는다. 문에서 한 걸음(1.1 m)이며 대피 경로의 첫 구간이다.
   */
  watchNodeId: "F3-J-R0",
  watchToward: { x: 37.1, z: 15.3 },
  /** 발화 후 경과 시간(초)으로 나눈 단계의 시작. */
  noticeAt: 26,
  riseAt: 28.5,
  panicAt: 31.5,
  listenAt: 35.5,
  departAt: 38,
  /** 바뀐 유도등을 확인하느라 멈춰 서는 시간(초). */
  lookSeconds: 1.5,
  /**
   * 걷다가 유도등 변경을 보지 못한 경우에 출발 뒤 휴대폰을 꺼내는 시점(초). 변경을 봤으면 확인을 마친 직후에 꺼낸다.
   * 기본 실행의 이동 중 변경(출발 약 7초 뒤)보다 늦어야 그 장면을 휴대폰이 가리지 않는다.
   */
  phoneAfter: 14,
} as const;

/** 자기 → 알아채기 → 복도로 나오기 → 불·연기를 보고 당황 → 이어폰 빼고 방송 듣기 → 대피. */
export type YeongnamPhase = "SLEEP" | "NOTICE" | "RISE" | "PANIC" | "LISTEN" | "EVACUATE";

/** 발화 전(준비만 한 상태, null)에는 자고 있다. */
export function yeongnamPhase(elapsedSeconds: number | null): YeongnamPhase {
  if (elapsedSeconds === null || elapsedSeconds < YEONGNAM.noticeAt) return "SLEEP";
  if (elapsedSeconds < YEONGNAM.riseAt) return "NOTICE";
  if (elapsedSeconds < YEONGNAM.panicAt) return "RISE";
  if (elapsedSeconds < YEONGNAM.listenAt) return "PANIC";
  return elapsedSeconds < YEONGNAM.departAt ? "LISTEN" : "EVACUATE";
}

/**
 * 개발용: 지정한 지점들을 차례로 걷는 모습을 그린다. 주소 끝에 `?devWalk=F1-S-B,F2-S-B,F3-S-B`처럼 붙였을 때만 켜진다.
 * 대피에서는 생기지 않는 이동(계단을 올라가는 쪽)을 실제 캐릭터와 1인칭으로 확인하는 데 쓴다.
 * 첫 번째 사람의 그리는 자리만 바꾼다. 경로·대피 판정은 건드리지 않고, 그 사람이 대피를 시작하면 꺼진다.
 */
export function devWalk(href: string): string[] | null {
  const value = /[?&]devWalk=([A-Za-z0-9,_-]+)/.exec(href)?.[1];
  const nodes = value === undefined ? [] : value.split(",").filter((item) => item.length > 0);
  return nodes.length >= 2 ? nodes : null;
}

/**
 * 검증용: 영남이의 행동을 이만큼(초) 늦춘다. 주소 끝에 `?yeongnamDelay=10`을 붙였을 때만 0이 아니다.
 * 행동이 늦어져도 탈출하는지 실제 화면에서 확인하는 데 쓴다. 불·연기·경로는 그대로다.
 */
export function yeongnamDelay(href: string): number {
  const value = Number(/[?&]yeongnamDelay=([0-9.]+)/.exec(href)?.[1] ?? 0);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 120) : 0;
}

export function yeongnamSupported(building: Pick<Building, "building_id" | "building_version">): boolean {
  return building.building_id === YEONGNAM.buildingId && building.building_version === YEONGNAM.buildingVersion;
}

/**
 * 이 실행에서 영남이 시연의 화재가 났는지와 발화 후 경과 시간(ms).
 * 정해 둔 자리에서 난 시험 화재만 시연으로 본다. 다른 자리의 화재에서는 영남이도 다른 사람처럼 바로 대피한다.
 */
export function yeongnamFire(state: StateSnapshot): { readonly elapsedMs: number } | null {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  const cause = state.active_causes.find((item) => item.hazard_type === "FIRE" && item.ignition_position != null
    && near(item.ignition_position.x, YEONGNAM.ignition.x) && near(item.ignition_position.y, YEONGNAM.ignition.y) && near(item.ignition_position.z, YEONGNAM.ignition.z));
  if (cause === undefined) return null;
  const fire = state.fire_simulation?.fires.find((item) => item.source_id === cause.source_id);
  return fire === undefined ? null : { elapsedMs: fire.elapsed_ms };
}

export type FaceShown = ReadonlyMap<string, string | null>;

/** 유도등 면별 표시값. 열쇠는 "유도등/면"이다. */
export function shownFaces(state: Pick<StateSnapshot, "signs">): Map<string, string | null> {
  return new Map(state.signs.flatMap((sign) => sign.faces.map((face) => [`${sign.sign_id}/${face.face_id}`, face.display] as const)));
}

export type Viewer = { readonly x: number; readonly z: number; readonly floorId: string; /** 바라보는 방향의 단위 벡터. */ readonly headingX: number; readonly headingZ: number };

/** 유도등 면을 알아볼 수 있는 거리(m), 시선·면이 정면에서 벗어나도 되는 각의 코사인(약 35도), 눈높이(m). */
const SIGN_SIGHT = 14;
const SIGN_AHEAD = 0.82;
const EYE = 1.6;
/** 1인칭 화면 위아래 끝까지의 각 여유(도). 이보다 더 올려다보거나 내려다봐야 하면 면이 화면 밖으로 벗어난다. */
const SIGN_LIFT = 30;

/**
 * 보는 사람 앞에서 실제로 방향이 바뀐 유도등 면. 없으면 빈 배열이다.
 * 지점 좌표가 아니라 면이 실제로 걸린 자리와 향하는 쪽(signMount)으로 판정한다.
 * 같은 층에서, 바라보는 쪽 정면 가까이에 있고, 그 면이 보는 사람을 향해 있고, 화면 위로 벗어날 만큼 가깝지 않고, 벽에 가리지 않고,
 * 화살표가 다른 화살표로 바뀐 것만 센다. 꺼지거나 켜진 것(안내 불가 전환), 등 뒤나 먼 곳의 변경,
 * 경로만 바뀌고 화살표는 같은 것은 "방향 변경을 봤다"가 아니다.
 */
export function witnessedSignChanges(building: Pick<Building, "signs" | "nodes">, walls: readonly WallRect[], before: FaceShown, after: FaceShown, installs: ReadonlyMap<string, SignInstall>, viewer: Viewer): string[] {
  const seen: string[] = [];
  for (const sign of building.signs) {
    const node = building.nodes.find((item) => item.node_id === sign.node_id);
    if (node === undefined || node.floor_id !== viewer.floorId) continue;
    for (const face of sign.faces) {
      const key = `${sign.sign_id}/${face.face_id}`;
      const was = before.get(key);
      const now = after.get(key);
      if (was == null || now == null || was === now) continue;
      // 달지 않은 면(볼 사람이 없는 쪽)은 바뀌어도 볼 수 없다.
      const place = installs.get(sign.sign_id)?.faces.get(face.face_id);
      if (place === undefined) continue;
      // 눈높이에서 위아래로 벗어난 만큼. 높이 걸린 천장형도, 낮게 붙은 벽부형도 바짝 다가서면 화면 밖이다.
      const tooClose = (Math.abs(place.y - EYE) + place.tall / 2) / Math.tan((SIGN_LIFT * Math.PI) / 180);
      const dx = place.x - viewer.x;
      const dz = place.z - viewer.z;
      const distance = Math.hypot(dx, dz);
      if (distance < tooClose || distance > SIGN_SIGHT) continue;
      if ((dx * viewer.headingX + dz * viewer.headingZ) / distance < SIGN_AHEAD) continue;
      // 면이 보는 사람 쪽을 향해 있어야 한다(면의 앞쪽에서, 너무 비스듬하지 않게).
      if ((-dx * place.normalX - dz * place.normalZ) / distance < place.facing) continue;
      if (walls.some((wall) => segmentHitsWall(wall, viewer.x, viewer.z, place.x, place.z))) continue;
      seen.push(key);
    }
  }
  return seen;
}

/** 머리 위 표시. 단계마다 다른 그림이라 멀리서도 지금 무엇을 하는지 구분된다. */
export function yeongnamEmote(phase: YeongnamPhase, looking: boolean, phone: boolean): string | null {
  if (phase === "SLEEP") return "💤 Zzz";
  if (phase === "NOTICE") return "❗";
  if (phase === "PANIC") return "😨";
  // 출발 전에 본 것은 바뀐 안내의 확인이고, 걷다가 본 것이 방향 변경의 목격이다.
  if (looking) return phase === "EVACUATE" ? "❗ 유도등 변경" : "👀 안내 확인";
  if (phase === "RISE") return "❗";
  if (phase === "LISTEN") return "📢 방송 확인";
  return phone ? "📱" : null;
}

export const YEONGNAM_PHASE_LABEL: Record<YeongnamPhase, string> = {
  SLEEP: "이어폰을 끼고 자는 중",
  NOTICE: "뒤늦게 알아챔",
  RISE: "일어나 복도로 나오는 중",
  PANIC: "복도 끝의 연기를 보고 당황",
  LISTEN: "이어폰을 빼고 안내방송을 듣는 중",
  EVACUATE: "유도등을 따라 대피 중",
};

/**
 * 재난 방송에 무엇을 내보낼지 정하는 순수 로직. 소리를 내지 않고, 경로나 방향을 계산하지 않는다.
 * 서버가 확정한 경보와 경로만 말로 옮긴다. AI 상황 설명은 여기 들어오지 않는다.
 */
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";

export type AlarmLevel = "NONE" | "SMOKE" | "FIRE";

export const BROADCAST_TEXT = {
  FIRE: "화재가 발생하였습니다. 대피 안내를 확인해 주십시오.",
  SMOKE: "연기가 감지되었습니다. 대피 안내를 확인해 주십시오.",
  STALE: "제어기와 연결이 끊겨 방향 안내를 확인할 수 없습니다. 경보는 유지되고 있습니다.",
  PARTIAL: "일부 경보가 해제되었습니다. 남은 경보가 있으니 대피 안내를 계속 확인해 주십시오.",
  ALL_CLEAR: "모든 경보가 해제되었습니다. 평상시 안내로 돌아갑니다.",
  EXIT: "이쪽 출구로 대피하십시오.",
} as const;

/**
 * 자리를 아는 방송. 어디서 났는지 알 때만 쓰고, 모르면 위의 자리 없는 문장으로 돌아간다.
 * 처음 한 번(once)은 짧게 알리고, 되풀이(loop)에서 QR 안내까지 말한다. 첫 문장이 길면 뒤따르는 확산 안내가 늦는다.
 */
export const LOCATED_TEXT = {
  fireOnce: (place: string) => `${place}에서 화재가 발생하였습니다. 인근에 계신 분은 즉시 대피하십시오.`,
  fireLoop: (place: string) => `${place}에서 화재가 발생하였습니다. 인근에 계신 분은 즉시 대피하시고, 거리가 있는 곳에 계신 분은 가까운 QR로 대피 경로를 확인해 주십시오.`,
  smoke: (place: string) => `${place}에서 연기가 감지되었습니다. 대피 안내를 확인해 주십시오.`,
  spread: (place: string) => `불이 ${place}까지 번졌습니다. 아직 대피하지 못하셨다면 즉시 대피하십시오.`,
} as const;

/** 경보가 난 자리를 말로 옮길 때 쓰는 이름표. 어느 한쪽이라도 없으면 자리를 부르지 않는다. */
export type Places = { readonly building: Building | null; readonly display: BuildingDisplay | null };

const unique = (values: readonly string[]) => [...new Set(values)];

function zoneLabel(places: Places | null, zoneId: string): string | null {
  const label = places?.display?.zone_labels[zoneId];
  return typeof label === "string" && label.length > 0 ? label : null;
}

/**
 * 여러 곳이면 한 곳만 부르고 나머지는 센다. 방송 문장이 길어지면 다음 안내가 그만큼 늦는다.
 * 이름표를 모르는 구역은 말할 수 없으므로 뺀다.
 */
function placePhrase(places: Places | null, zoneIds: readonly string[]): string | null {
  const labels = zoneIds.map((zoneId) => zoneLabel(places, zoneId)).filter((label): label is string => label !== null);
  if (labels.length === 0) return null;
  return labels.length === 1 ? labels[0] : `${labels[0]} 외 ${labels.length - 1}곳`;
}

/**
 * 지금 경보가 난 구역. 화재면 화재 원인만, 연기 단계면 남은 원인 모두를 본다.
 * 확산 자료가 있으면 그쪽이 정확하다(도면에서 고른 자리). 없으면 원인 설비가 맡은 구역으로 본다.
 * 이름표를 모르는 구역은 빼므로, 표시 자료가 늦게 와도 그때 처음으로 부른다.
 */
function originZones(state: StateSnapshot, places: Places | null, level: AlarmLevel): string[] {
  if (level === "NONE") return [];
  const causes = level === "FIRE" ? state.active_causes.filter((cause) => cause.hazard_type === "FIRE" || cause.ignition_position != null) : state.active_causes;
  const simulated = new Map((state.fire_simulation?.fires ?? []).map((fire) => [fire.source_id, fire.zone_id]));
  const zones = causes.map((cause) => simulated.get(cause.source_id)
    ?? places?.building?.sources.find((source) => source.source_id === cause.source_id)?.zone_id);
  return unique(zones.filter((zoneId): zoneId is string => zoneId !== undefined && zoneLabel(places, zoneId) !== null));
}

/** 불이 닿은 구역 가운데 발화 구역이 아닌 곳. 번졌다고 알릴 대상이다. */
function spreadZones(state: StateSnapshot, places: Places | null, origins: readonly string[]): string[] {
  const reached = (state.fire_simulation?.cells ?? []).filter((cell) => cell.fire > 0).map((cell) => cell.zone_id);
  return unique(reached).filter((zoneId) => !origins.includes(zoneId) && zoneLabel(places, zoneId) !== null);
}

const stateKey = (state: StateSnapshot, zones: readonly string[]) => [
  state.run_id,
  state.active_causes.map((cause) => `${cause.source_id}:${cause.hazard_type}`).sort().join(","),
  [...zones].sort().join(","),
].join("/");

/**
 * 방송을 다시 정해야 하는 때를 나타내는 열쇠. 경보 구성·연결 상태·불이 닿은 구역·이름표가 바뀔 때만 달라진다.
 * 1초마다 오는 상태 갱신만으로 같은 문장이 처음부터 되풀이되지 않게 하는 것이 목적이다.
 */
/** 지금 경보가 난 자리를 한 마디로("3층 307호", "3층 307호 외 2곳"). 모르면 null이고 화면에서도 자리를 숨긴다. */
export function alarmPlace(state: StateSnapshot, places: Places | null): string | null {
  return placePhrase(places, originZones(state, places, alarmLevel(state)));
}

export function broadcastKey(state: StateSnapshot, stale: boolean, places: Places | null = null): string {
  const origins = originZones(state, places, alarmLevel(state));
  return `${stateKey(state, [...origins, ...spreadZones(state, places, origins)])}/${stale}`;
}

/** 화재가 하나라도 있으면 화재, 연기·스프링클러만 있으면 연기 방송이다. */
export function alarmLevel(state: StateSnapshot): AlarmLevel {
  if (state.active_causes.some((cause) => cause.hazard_type === "FIRE" || cause.ignition_position != null)) return "FIRE";
  return state.active_causes.length > 0 ? "SMOKE" : "NONE";
}

export type BroadcastMemory = {
  readonly runId: string;
  readonly count: number;
  /** 자리를 이미 불러 준 구역. 같은 곳을 되풀이해 알리지 않는다. 경보가 모두 풀리면 비운다. */
  readonly spoken?: readonly string[];
};
export type Announcement = {
  /**
   * 이 방송이 만들어진 경보 상태(실행 + 활성 경보 구성). 한 번짜리 문장은 이 상태에서만 유효하다.
   * 연결 끊김 여부는 넣지 않는다. 끊겼다 이어져도 경보 구성이 같으면 같은 상태다.
   */
  readonly key: string;
  /** 경보가 하나라도 남아 있으면 사이렌을 유지한다. 방향 정보가 사라져도 경보를 정상으로 치지 않는다. */
  readonly siren: boolean;
  /** 경보가 이어지는 동안 일정 간격으로 되풀이하는 문장. */
  readonly loop: string | null;
  /** 이번 변화에서 한 번만 내보내는 문장(일부 해제·전체 해제). */
  readonly once: string | null;
};

/**
 * 직전 상태와 비교해 이번에 내보낼 방송을 정한다.
 * 화면이 다시 그려져도 경보 수가 그대로면 once가 없어 같은 문장이 처음부터 되풀이되지 않는다.
 * stale: 제어기 상태를 제때 읽지 못함. 마지막으로 확인한 경보는 유지하되 방향 대신 연결 끊김을 알린다.
 *
 * places를 주면 어디서 났는지까지 말한다. 순서는 해제 → 새 발화 → 확산이다.
 * 해제가 먼저인 것은 이미 난 불보다 "안전해졌다"가 급하기 때문이고, 발화가 확산보다 먼저인 것은
 * 불이 번지기 전에 어디서 났는지부터 알려야 하기 때문이다. 한 번 부른 구역은 기억해 두고 다시 부르지 않는다.
 */
export function announce(
  previous: BroadcastMemory | null,
  state: StateSnapshot,
  stale: boolean,
  places: Places | null = null,
): { memory: BroadcastMemory; announcement: Announcement } {
  const count = state.active_causes.length;
  const level = alarmLevel(state);
  const same = previous !== null && previous.runId === state.run_id;
  const before = same ? previous.count : 0;

  const origins = originZones(state, places, level);
  const spread = spreadZones(state, places, origins);
  const known = new Set(same ? previous.spoken ?? [] : []);
  const freshOrigins = origins.filter((zoneId) => !known.has(zoneId));
  const freshSpread = spread.filter((zoneId) => !known.has(zoneId));

  const here = placePhrase(places, origins);
  const loop = level === "NONE" ? null
    : stale ? BROADCAST_TEXT.STALE
    : here === null ? BROADCAST_TEXT[level]
    : level === "FIRE" ? LOCATED_TEXT.fireLoop(here) : LOCATED_TEXT.smoke(here);

  const startPlace = placePhrase(places, freshOrigins);
  const spreadPlace = placePhrase(places, freshSpread);
  const once = stale ? null
    : before > count ? (count === 0 ? BROADCAST_TEXT.ALL_CLEAR : BROADCAST_TEXT.PARTIAL)
    : startPlace !== null ? (level === "FIRE" ? LOCATED_TEXT.fireOnce(startPlace) : LOCATED_TEXT.smoke(startPlace))
    : spreadPlace !== null ? LOCATED_TEXT.spread(spreadPlace)
    : null;

  return {
    // 연결이 끊긴 동안에는 기억을 바꾸지 않는다. 다시 이어졌을 때의 변화를 놓치지 않기 위해서다.
    memory: stale && previous !== null ? previous
      : { runId: state.run_id, count, spoken: count === 0 ? [] : [...known, ...freshOrigins, ...freshSpread] },
    announcement: { key: stateKey(state, [...origins, ...spread]), siren: level !== "NONE", loop, once },
  };
}

export type ExitCall = { readonly exitId: string; readonly x: number; readonly z: number };

/** 1인칭으로 따라가는 사람. evacuating: 경보로 대피를 시작했고 아직 탈출하지 않았다. */
export type Walker = { readonly nodeId: string; readonly evacuating: boolean };

/**
 * 1인칭으로 서 있는 지점에서 불러 줄 출구. 그 지점의 서버 경로가 가리키는 출구 하나뿐이라 여러 출구가 서로 다른 말을 하지 않는다.
 *
 * 전체 방송·사이렌은 경보 상태를 따르고, 출구 유도음은 남아 있는 대피 상태를 따른다.
 * - 대피를 시작했고 아직 탈출하지 않은 사람에게만 부른다. 경보가 해제돼도 대피 중이면 계속 부르고,
 *   처음부터 평상시라 대피를 시작하지 않은 사람·탈출한 사람에게는 부르지 않는다.
 * - 연결이 끊겼거나 그 지점에 유효한 경로가 없으면(출구 차단·감지 정보 만료 포함) 부르지 않는다.
 * - 출구와 같은 층에 있을 때만 부른다. 다른 층의 출구는 평면에서 가까워 보여도 계단을 거쳐야 하므로 "이쪽 출구"가 아니다.
 *   층은 건물 자료의 지점 층으로 판단한다. 화면의 층 간격 설정과 무관하다.
 */
export function exitCall(state: StateSnapshot, building: Building, walker: Walker | null, stale: boolean): ExitCall | null {
  if (stale || walker === null || !walker.evacuating) return null;
  const route = state.routes.find((item) => item.node_id === walker.nodeId);
  if (route === undefined || route.reason_codes.length > 0 || route.exit_id === null) return null;
  const exit = building.exits.find((item) => item.exit_id === route.exit_id);
  const node = building.nodes.find((item) => item.node_id === exit?.node_id);
  const here = building.nodes.find((item) => item.node_id === walker.nodeId);
  if (exit === undefined || !exit.enabled || node === undefined || here === undefined || here.floor_id !== node.floor_id) return null;
  return { exitId: exit.exit_id, x: node.position.x, z: node.position.z };
}

export type Listener = { readonly x: number; readonly z: number; readonly yaw: number };

/**
 * 듣는 사람 기준으로 출구 소리의 좌우 위치(-1 왼쪽 ~ 1 오른쪽)와 크기(0~1).
 * 가까울수록 크고 range를 넘으면 들리지 않는다. yaw는 3D 장면의 진행 방향 각도(atan2(x, z))다.
 */
export function exitSound(listener: Listener, exit: { x: number; z: number }, range = 18): { pan: number; gain: number; metres: number } {
  const dx = exit.x - listener.x;
  const dz = exit.z - listener.z;
  const metres = Math.hypot(dx, dz);
  const gain = Math.max(0, 1 - metres / range) ** 2;
  if (metres < 0.5) return { pan: 0, gain, metres };
  // 진행 방향에서 본 출구의 각도. 장면에서 +x가 +z를 향한 사람의 왼쪽이라 부호를 뒤집는다.
  const angle = Math.atan2(dx, dz) - listener.yaw;
  return { pan: -Math.sin(angle), gain, metres };
}

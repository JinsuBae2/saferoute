/**
 * 재난 방송에 무엇을 내보낼지 정하는 순수 로직. 소리를 내지 않고, 경로나 방향을 계산하지 않는다.
 * 서버가 확정한 경보와 경로만 말로 옮긴다. AI 상황 설명은 여기 들어오지 않는다.
 */
import type { Building, StateSnapshot } from "@contracts";

export type AlarmLevel = "NONE" | "SMOKE" | "FIRE";

export const BROADCAST_TEXT = {
  FIRE: "화재가 발생하였습니다. 대피 안내를 확인해 주십시오.",
  SMOKE: "연기가 감지되었습니다. 대피 안내를 확인해 주십시오.",
  STALE: "제어기와 연결이 끊겨 방향 안내를 확인할 수 없습니다. 경보는 유지되고 있습니다.",
  PARTIAL: "일부 경보가 해제되었습니다. 남은 경보가 있으니 대피 안내를 계속 확인해 주십시오.",
  ALL_CLEAR: "모든 경보가 해제되었습니다. 평상시 안내로 돌아갑니다.",
  EXIT: "이쪽 출구로 대피하십시오.",
} as const;

/** 화재가 하나라도 있으면 화재, 연기·스프링클러만 있으면 연기 방송이다. */
export function alarmLevel(state: StateSnapshot): AlarmLevel {
  if (state.active_causes.some((cause) => cause.hazard_type === "FIRE")) return "FIRE";
  return state.active_causes.length > 0 ? "SMOKE" : "NONE";
}

export type BroadcastMemory = { readonly runId: string; readonly count: number };
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
 */
export function announce(previous: BroadcastMemory | null, state: StateSnapshot, stale: boolean): { memory: BroadcastMemory; announcement: Announcement } {
  const count = state.active_causes.length;
  const level = alarmLevel(state);
  const before = previous !== null && previous.runId === state.run_id ? previous.count : 0;
  const once = stale || before <= count ? null : count === 0 ? BROADCAST_TEXT.ALL_CLEAR : BROADCAST_TEXT.PARTIAL;
  return {
    // 연결이 끊긴 동안에는 기억을 바꾸지 않는다. 다시 이어졌을 때의 변화를 놓치지 않기 위해서다.
    memory: stale && previous !== null ? previous : { runId: state.run_id, count },
    announcement: { key: `${state.run_id}/${state.active_causes.map((cause) => `${cause.source_id}:${cause.hazard_type}`).sort().join(",")}`,
      siren: level !== "NONE", loop: level === "NONE" ? null : stale ? BROADCAST_TEXT.STALE : BROADCAST_TEXT[level], once },
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

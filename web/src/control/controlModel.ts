/**
 * 관제 화면이 서버 상태를 읽어 집계하는 순수 로직.
 * 네트워크·DOM을 쓰지 않으며, 경로나 방향을 다시 계산하지 않는다.
 *
 * 기준: 05번 명세 4·6·11절, 04번 설계 6.2절.
 * 원칙은 하나다. 미적용·단절·오래된 버전을 정상으로 숨기지 않는다.
 */
import type { SimulationState, StateSnapshot } from "@contracts";

import type { Explanation } from "./explanation";

type SignState = StateSnapshot["signs"][number];
type ApplicationStatus = SignState["application_status"];
type RouteReason = StateSnapshot["routes"][number]["reason_codes"][number];

/** 서버가 준 UTC 문자열만 해석한다. 브라우저 시계로 만료를 추정하지 않는다. */
export function utcMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type SignSummary = {
  readonly total: number;
  readonly byStatus: Readonly<Record<ApplicationStatus, number>>;
  /** 최신 명령을 받았지만 현재 안내 버전이 아닌 단말 수. */
  readonly behindGuidance: number;
  /** 단말들이 서로 다른 안내 버전을 표시 중인 상태. 04번 6.2절의 MIXED_VERSION. */
  readonly mixedVersion: boolean;
  /** 현재 안내가 확인된 단말 수(APPLIED). */
  readonly confirmedCurrent: number;
  /** 아직 현재 안내가 확인되지 않은 단말 수. */
  readonly unconfirmed: number;
};

const EMPTY_STATUS: Record<ApplicationStatus, number> = {
  NOT_ISSUED: 0,
  PENDING: 0,
  APPLIED: 0,
  REJECTED: 0,
  EXPIRED: 0,
  DUPLICATE_TERMINAL: 0,
};

export function summarizeSigns(state: StateSnapshot): SignSummary {
  const byStatus: Record<ApplicationStatus, number> = { ...EMPTY_STATUS };
  const issuedVersions = new Set<number>();
  let behindGuidance = 0;

  for (const sign of state.signs) {
    byStatus[sign.application_status] += 1;
    const command = sign.latest_command;
    if (command === null) continue;
    issuedVersions.add(command.guidance_version);
    if (command.guidance_version !== state.guidance_version) behindGuidance += 1;
  }

  const confirmedCurrent = byStatus.APPLIED;
  return {
    total: state.signs.length,
    byStatus,
    behindGuidance,
    mixedVersion: issuedVersions.size > 1,
    confirmedCurrent,
    unconfirmed: state.signs.length - confirmedCurrent,
  };
}

export type RouteSummary = {
  readonly total: number;
  readonly guided: number;
  readonly unavailable: number;
  /** 안내 불가 사유별 건수. 한 경로가 여러 사유를 가질 수 있다. */
  readonly reasons: ReadonlyArray<readonly [RouteReason, number]>;
};

export function summarizeRoutes(state: StateSnapshot): RouteSummary {
  const tally = new Map<RouteReason, number>();
  let unavailable = 0;

  for (const route of state.routes) {
    if (route.reason_codes.length === 0) continue;
    unavailable += 1;
    for (const reason of route.reason_codes) {
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
  }

  return {
    total: state.routes.length,
    guided: state.routes.length - unavailable,
    unavailable,
    reasons: [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

export type SourceSummary = {
  readonly total: number;
  readonly valid: number;
  readonly stale: number;
  readonly unavailable: number;
  readonly initializing: number;
  /** 확인되지 않은 관측원이 하나라도 있는지. */
  readonly anyUnconfirmed: boolean;
};

export function summarizeSources(state: StateSnapshot): SourceSummary {
  let valid = 0;
  let stale = 0;
  let unavailable = 0;
  let initializing = 0;

  for (const source of state.sources) {
    if (source.validity === "VALID") valid += 1;
    else if (source.validity === "STALE") stale += 1;
    else if (source.validity === "UNAVAILABLE") unavailable += 1;
    else initializing += 1;
  }

  return {
    total: state.sources.length,
    valid,
    stale,
    unavailable,
    initializing,
    anyUnconfirmed: valid !== state.sources.length,
  };
}

export type ExplanationBlockReason =
  | "NOT_LOADED"
  | "NOT_READY"
  | "RUN_MISMATCH"
  | "BUILDING_MISMATCH"
  | "GUIDANCE_MISMATCH"
  | "EXPIRED"
  | "MISSING_FIELDS";

export type ExplanationCheck =
  | { readonly usable: true; readonly explanation: Explanation }
  | { readonly usable: false; readonly reason: ExplanationBlockReason };

/**
 * 설명 문장을 보여도 되는지 판정한다(05번 11절).
 * 실행·건물·안내 버전이 현재 상태와 전부 같고 기한이 남은 READY만 통과한다.
 * 기한 비교는 같은 서버가 만든 두 UTC 시각끼리만 한다.
 */
export function checkExplanation(
  explanation: Explanation | null,
  state: StateSnapshot,
): ExplanationCheck {
  if (explanation === null) return { usable: false, reason: "NOT_LOADED" };
  if (explanation.status !== "READY") return { usable: false, reason: "NOT_READY" };
  if (explanation.run_id !== state.run_id) return { usable: false, reason: "RUN_MISMATCH" };
  if (
    explanation.building_id !== state.building_id ||
    explanation.building_version !== state.building_version
  ) {
    return { usable: false, reason: "BUILDING_MISMATCH" };
  }
  if (explanation.guidance_version !== state.guidance_version) {
    return { usable: false, reason: "GUIDANCE_MISMATCH" };
  }

  const summary = explanation.summary;
  if (summary === null || summary.trim().length === 0 || explanation.fact_refs.length === 0) {
    return { usable: false, reason: "MISSING_FIELDS" };
  }

  const expiresAt = utcMs(explanation.expires_at);
  const basisAt = utcMs(state.generated_at);
  if (expiresAt === null || basisAt === null) return { usable: false, reason: "MISSING_FIELDS" };
  if (expiresAt <= basisAt) return { usable: false, reason: "EXPIRED" };

  return { usable: true, explanation };
}

/**
 * 시나리오 정답을 화면에 띄워도 되는지. 다른 실행·건물의 정답은 쓰지 않는다.
 * 이 값은 표시 전용이며 경로·방향 판단에 넣지 않는다(04번 7.2절).
 */
export function simulationMatchesRun(
  simulation: SimulationState | null,
  state: StateSnapshot,
): boolean {
  if (simulation === null) return false;
  return (
    simulation.run_id === state.run_id &&
    simulation.building_id === state.building_id &&
    simulation.building_version === state.building_version
  );
}

/** 현재 실행의 재시도 가능한 연결만 판정한다. 영구 실패·종료·다른 실행은 복구가 아니다. */
export function simulationConnectionLost(simulation: SimulationState | null, state: StateSnapshot | null): boolean | null {
  if (state === null || simulation === null || !simulationMatchesRun(simulation, state)) return null;
  if (simulation.status !== "RUNNING" && simulation.status !== "WAITING_FOR_ARM") return null;
  if (simulation.error_code === "CONTROLLER_UNAVAILABLE") return true;
  return simulation.error_code === null ? false : null;
}

export type ConnectionHealth = {
  /** 마지막 성공 조회 이후 경과(ms). 한 번도 성공하지 못했으면 null. */
  readonly ageMs: number | null;
  /** 표시 중인 값이 지금 상태라고 보기 어려운지. */
  readonly stale: boolean;
};

/** 조회 간격을 기준으로 한 신선도. 실패해도 마지막 값을 지우지 않고 오래됐다고 알린다. */
export function connectionHealth(
  lastSuccessAtMs: number | null,
  nowMs: number,
  staleAfterMs: number,
): ConnectionHealth {
  if (lastSuccessAtMs === null) return { ageMs: null, stale: true };
  const ageMs = Math.max(0, nowMs - lastSuccessAtMs);
  return { ageMs, stale: ageMs >= staleAfterMs };
}

export type SourceStatus = "NEVER" | "FRESH" | "EXPIRED" | "UNAVAILABLE";

/**
 * 감지 정보의 수신 상태. 위험 여부가 아니다. 최신 정보를 받고 있어도 그 내용이 경보일 수 있다.
 * 만료 판정은 제어기가 한 것을 그대로 읽는다. 화면이 기준 시간을 따로 두지 않는다.
 */
export function sourceStatus(validity: StateSnapshot["sources"][number]["validity"]): SourceStatus {
  if (validity === "VALID") return "FRESH";
  if (validity === "STALE") return "EXPIRED";
  return validity === "UNAVAILABLE" ? "UNAVAILABLE" : "NEVER";
}

/** 마지막 관측에서 상태 기준 시각까지 지난 시간. 둘 다 서버가 준 시각이라 브라우저 시계와 무관하다. */
export function observedAgeMs(state: StateSnapshot, source: StateSnapshot["sources"][number]): number | null {
  const at = utcMs(source.last_observed_at);
  const now = utcMs(state.generated_at);
  return at === null || now === null ? null : Math.max(0, now - at);
}

export type SignChangeSummary = {
  /** 유도등 대수. 양면 유도등도 한 대로 센다. */
  readonly total: number;
  /** 현재 안내를 화면에 반영했다고 단말이 응답한 대수. 같은 방향을 다시 받은 경우도 포함한다. */
  readonly confirmed: number;
  /** 응답이 없거나 실패해 현재 안내의 반영을 확인하지 못한 대수. */
  readonly unconfirmed: number;
  /** 서버 계산 기준, 평상시 방향과 지금 방향이 다른 대수(안내 중단 제외). 누적 변경 횟수가 아니다. */
  readonly changed: number;
  /** changed 가운데 단말이 반영을 응답한 대수. */
  readonly changedConfirmed: number;
  /** 서버 계산 기준, 방향을 표시하지 못하는 면이 있는 대수. */
  readonly stopped: number;
  readonly stoppedConfirmed: number;
};

/**
 * 유도등별 반영 확인·방향 변경·안내 중단을 나눠 센다.
 * 평상시 방향은 건물 자료의 면별 기본 방향이다. 건물 자료가 없으면 변경 수를 셀 수 없어 null을 준다.
 */
export function summarizeSignChanges(
  state: StateSnapshot,
  defaults: ReadonlyMap<string, ReadonlyMap<string, string>> | null,
): SignChangeSummary | null {
  if (defaults === null) return null;
  let confirmed = 0;
  let changed = 0;
  let changedConfirmed = 0;
  let stopped = 0;
  let stoppedConfirmed = 0;
  for (const sign of state.signs) {
    const applied = sign.application_status === "APPLIED";
    if (applied) confirmed += 1;
    const base = defaults.get(sign.sign_id);
    if (sign.faces.some((face) => face.display === null)) {
      stopped += 1;
      if (applied) stoppedConfirmed += 1;
    } else if (base !== undefined && sign.faces.some((face) => base.get(face.face_id) !== face.display)) {
      changed += 1;
      if (applied) changedConfirmed += 1;
    }
  }
  return { total: state.signs.length, confirmed, unconfirmed: state.signs.length - confirmed, changed, changedConfirmed, stopped, stoppedConfirmed };
}

/** 건물 자료에서 유도등 면별 평상시 방향을 뽑는다. */
export function defaultDisplays(
  signs: ReadonlyArray<{ sign_id: string; faces: ReadonlyArray<{ face_id: string; default_next_node_id: string; next_node_to_display: Readonly<Record<string, string>> }> }>,
): Map<string, Map<string, string>> {
  return new Map(signs.map((sign) => [sign.sign_id, new Map(sign.faces.map((face) => [face.face_id, face.next_node_to_display[face.default_next_node_id]]))]));
}

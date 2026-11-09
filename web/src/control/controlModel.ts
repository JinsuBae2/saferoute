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

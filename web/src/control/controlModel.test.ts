/**
 * 관제 집계 로직 시험. 입력은 2번이 생성한 공통 샘플(contracts/samples.generated.ts)이다.
 * 기준: 05번 명세 4·6·11절, 04번 설계 6.2절.
 */
import { describe, expect, it } from "vitest";

import type { SimulationState, StateSnapshot } from "@contracts";
import { emergency_state as emergencySample, state as initializingSample } from "@samples";
import { explanation_ready, explanation_pending, explanation_unavailable } from "@samples";

import {
  checkExplanation,
  connectionHealth,
  simulationMatchesRun,
  summarizeRoutes,
  summarizeSigns,
  summarizeSources,
  utcMs,
} from "./controlModel";
import type { Explanation } from "./explanation";

const EMERGENCY: StateSnapshot = emergencySample;
const INITIALIZING: StateSnapshot = initializingSample;

it("공통 설명 샘플에서 현재 READY만 표시한다", () => {
  expect(checkExplanation(explanation_ready, EMERGENCY).usable).toBe(true);
  expect(checkExplanation(explanation_pending, EMERGENCY).usable).toBe(false);
  expect(checkExplanation(explanation_unavailable, EMERGENCY).usable).toBe(false);
});

function readyExplanation(patch: Partial<Explanation> = {}): Explanation {
  return {
    schema_version: 1,
    run_id: EMERGENCY.run_id,
    building_id: EMERGENCY.building_id,
    building_version: EMERGENCY.building_version,
    guidance_version: EMERGENCY.guidance_version,
    status: "READY",
    basis_generated_at: EMERGENCY.generated_at,
    generated_at: "2026-11-10T01:00:01.000Z",
    // 근거 시각(generated_at 01:00:00.300Z)보다 뒤라 아직 유효하다.
    expires_at: "2026-11-10T01:00:15.000Z",
    summary: "북쪽 구역 화재로 A 지점을 제외한 경로를 안내 중입니다.",
    fact_refs: ["cause:CAM-A:FIRE", "blocked-node:A", "route:S"],
    model_id: "test-model",
    prompt_version: "v1",
    error_code: null,
    ...patch,
  };
}

describe("단말 적용 현황 집계", () => {
  it("비상 샘플에서 적용·미발행을 구분한다", () => {
    const summary = summarizeSigns(EMERGENCY);

    expect(summary.total).toBe(2);
    expect(summary.byStatus.APPLIED).toBe(1);
    expect(summary.byStatus.NOT_ISSUED).toBe(1);
    expect(summary.confirmedCurrent).toBe(1);
    // 미적용을 정상으로 숨기지 않는다(이슈 #21 완료 조건).
    expect(summary.unconfirmed).toBe(1);
    expect(summary.behindGuidance).toBe(0);
    expect(summary.mixedVersion).toBe(false);
  });

  it("단말이 서로 다른 안내 버전을 표시하면 혼합 버전으로 본다", () => {
    const current = EMERGENCY.signs[0];
    const behind: StateSnapshot["signs"][number] = {
      ...current,
      sign_id: "SIGN-OLD",
      application_status: "PENDING",
      terminals: [],
      latest_command:
        current.latest_command === null
          ? null
          : { ...current.latest_command, sign_id: "SIGN-OLD", guidance_version: 2 },
    };
    const mixed: StateSnapshot = { ...EMERGENCY, signs: [current, behind] };

    const summary = summarizeSigns(mixed);
    expect(summary.mixedVersion).toBe(true);
    expect(summary.behindGuidance).toBe(1);
    expect(summary.confirmedCurrent).toBe(1);
    expect(summary.unconfirmed).toBe(1);
  });

  it("아무 명령도 발행되지 않은 상태는 혼합 버전이 아니다", () => {
    const summary = summarizeSigns(INITIALIZING);
    expect(summary.byStatus.NOT_ISSUED).toBe(2);
    expect(summary.mixedVersion).toBe(false);
    expect(summary.confirmedCurrent).toBe(0);
  });
});

describe("경로 집계", () => {
  it("안내 가능·불가를 사유별로 나눈다", () => {
    const summary = summarizeRoutes(EMERGENCY);

    expect(summary.total).toBe(6);
    expect(summary.guided).toBe(4);
    expect(summary.unavailable).toBe(2);
    expect(Object.fromEntries(summary.reasons)).toEqual({
      ORIGIN_BLOCKED: 1,
      NO_REACHABLE_EXIT: 1,
    });
  });

  it("준비 중에는 전부 안내 불가로 집계한다", () => {
    const summary = summarizeRoutes(INITIALIZING);
    expect(summary.guided).toBe(0);
    expect(summary.unavailable).toBe(6);
    expect(Object.fromEntries(summary.reasons)).toEqual({ INITIALIZING: 6 });
  });
});

describe("관측원 집계", () => {
  it("전부 유효하면 확인되지 않은 관측원이 없다", () => {
    const summary = summarizeSources(EMERGENCY);
    expect(summary.valid).toBe(4);
    expect(summary.anyUnconfirmed).toBe(false);
  });

  it("준비 중 관측원은 확인된 것으로 치지 않는다", () => {
    const summary = summarizeSources(INITIALIZING);
    expect(summary.initializing).toBe(4);
    expect(summary.valid).toBe(0);
    expect(summary.anyUnconfirmed).toBe(true);
  });
});

describe("설명 표시 판정 (명세 11절)", () => {
  it("현재 실행·건물·안내 버전과 모두 같고 기한이 남은 READY만 표시한다", () => {
    const check = checkExplanation(readyExplanation(), EMERGENCY);
    expect(check.usable).toBe(true);
  });

  it("불러오지 못했으면 표시하지 않는다", () => {
    expect(checkExplanation(null, EMERGENCY)).toEqual({ usable: false, reason: "NOT_LOADED" });
  });

  it("READY가 아니면 문장을 숨긴다", () => {
    for (const status of ["PENDING", "UNAVAILABLE"] as const) {
      expect(checkExplanation(readyExplanation({ status }), EMERGENCY)).toEqual({
        usable: false,
        reason: "NOT_READY",
      });
    }
  });

  it("실행·건물·안내 버전이 하나라도 다르면 숨긴다", () => {
    expect(
      checkExplanation(readyExplanation({ run_id: "99999999-9999-4999-8999-999999999999" }), EMERGENCY),
    ).toEqual({ usable: false, reason: "RUN_MISMATCH" });

    expect(
      checkExplanation(
        readyExplanation({ building_version: EMERGENCY.building_version + 1 }),
        EMERGENCY,
      ),
    ).toEqual({ usable: false, reason: "BUILDING_MISMATCH" });

    expect(
      checkExplanation(
        readyExplanation({ guidance_version: EMERGENCY.guidance_version - 1 }),
        EMERGENCY,
      ),
    ).toEqual({ usable: false, reason: "GUIDANCE_MISMATCH" });
  });

  it("근거 시각을 지난 기한은 만료로 본다. 수신 시 기한을 새로 시작하지 않는다", () => {
    expect(
      checkExplanation(readyExplanation({ expires_at: EMERGENCY.generated_at }), EMERGENCY),
    ).toEqual({ usable: false, reason: "EXPIRED" });

    expect(
      checkExplanation(readyExplanation({ expires_at: "2026-11-10T00:59:59.000Z" }), EMERGENCY),
    ).toEqual({ usable: false, reason: "EXPIRED" });
  });

  it("문장이나 근거가 비어 있으면 표시하지 않는다", () => {
    expect(checkExplanation(readyExplanation({ summary: "   " }), EMERGENCY)).toEqual({
      usable: false,
      reason: "MISSING_FIELDS",
    });
    expect(checkExplanation(readyExplanation({ fact_refs: [] }), EMERGENCY)).toEqual({
      usable: false,
      reason: "MISSING_FIELDS",
    });
    expect(checkExplanation(readyExplanation({ expires_at: null }), EMERGENCY)).toEqual({
      usable: false,
      reason: "MISSING_FIELDS",
    });
  });
});

describe("시나리오 정답 표시 판정", () => {
  const simulation: SimulationState = {
    schema_version: 1,
    building_id: EMERGENCY.building_id,
    building_version: EMERGENCY.building_version,
    scenario_id: "two-route-smoke",
    run_id: EMERGENCY.run_id,
    simulation_time_ms: 4200,
    simulation_sequence: 7,
    status: "RUNNING",
    zones: [{ zone_id: "Z-A", smoke: 0.6 }],
    error_code: null,
  };

  it("같은 실행·건물의 정답만 사용한다", () => {
    expect(simulationMatchesRun(simulation, EMERGENCY)).toBe(true);
    expect(simulationMatchesRun(null, EMERGENCY)).toBe(false);
    expect(
      simulationMatchesRun({ ...simulation, run_id: "99999999-9999-4999-8999-999999999999" }, EMERGENCY),
    ).toBe(false);
    expect(
      simulationMatchesRun({ ...simulation, building_version: EMERGENCY.building_version + 1 }, EMERGENCY),
    ).toBe(false);
  });
});

describe("연결 신선도", () => {
  it("한 번도 성공하지 못했으면 오래된 것으로 본다", () => {
    expect(connectionHealth(null, 10_000, 3_000)).toEqual({ ageMs: null, stale: true });
  });

  it("조회 간격을 넘기면 표시 중인 값을 현재로 취급하지 않는다", () => {
    expect(connectionHealth(9_000, 10_000, 3_000)).toEqual({ ageMs: 1_000, stale: false });
    expect(connectionHealth(7_000, 10_000, 3_000)).toEqual({ ageMs: 3_000, stale: true });
  });
});

describe("UTC 해석", () => {
  it("잘못된 시각은 null로 돌려준다", () => {
    expect(utcMs(null)).toBeNull();
    expect(utcMs("not-a-time")).toBeNull();
    expect(utcMs("2026-11-10T01:00:00.000Z")).toBe(Date.parse("2026-11-10T01:00:00.000Z"));
  });
});

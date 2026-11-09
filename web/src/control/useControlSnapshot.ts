/**
 * 관제 화면의 조회 루프. GET만 사용하므로 제어기 상태를 바꾸지 않는다.
 * `/api/state`는 명령을 발행하지 않으니 이 화면을 열어두거나 닫아도
 * 별도 단말의 명령 조회·ACK에 영향이 없다(이슈 #21 완료 조건).
 *
 * 설명(A05 미구현)과 시나리오 실행기(별도 8001 프로세스)는 없을 수 있다.
 * 둘 중 무엇이 실패해도 제어 결과 표시는 그대로 유지한다.
 */
import { useEffect, useState } from "react";

import type { SimulationState, StateSnapshot } from "@contracts";

import { ApiError, fetchExplanation, fetchSimulationState, fetchState } from "../api/client";
import type { Explanation } from "./explanation";

const POLL_INTERVAL_MS = 1000;
/** 설명은 제어 결과보다 느리게 조회한다. 05번 11절의 호출 간격 하한을 넘지 않는다. */
const EXPLANATION_EVERY = 5;

export type ControlView = {
  readonly state: StateSnapshot | null;
  readonly simulation: SimulationState | null;
  readonly explanation: Explanation | null;
  readonly stateError: string | null;
  readonly simulationError: string | null;
  readonly explanationError: string | null;
  /** performance.now() 기준. 마지막으로 state 조회에 성공한 시각. */
  readonly lastStateSuccessAtMs: number | null;
  readonly nowMs: number;
  readonly pollIntervalMs: number;
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.code === null ? `HTTP ${error.status}` : `${error.message} (${error.code})`;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useControlSnapshot(): ControlView {
  const [view, setView] = useState<ControlView>(() => ({
    state: null,
    simulation: null,
    explanation: null,
    stateError: null,
    simulationError: null,
    explanationError: null,
    lastStateSuccessAtMs: null,
    nowMs: performance.now(),
    pollIntervalMs: POLL_INTERVAL_MS,
  }));

  useEffect(() => {
    const abort = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticks = 0;

    let state: StateSnapshot | null = null;
    let simulation: SimulationState | null = null;
    let explanation: Explanation | null = null;
    let stateError: string | null = null;
    let simulationError: string | null = null;
    let explanationError: string | null = null;
    let lastStateSuccessAtMs: number | null = null;

    const publish = () => {
      if (stopped) return;
      setView({
        state,
        simulation,
        explanation,
        stateError,
        simulationError,
        explanationError,
        lastStateSuccessAtMs,
        nowMs: performance.now(),
        pollIntervalMs: POLL_INTERVAL_MS,
      });
    };

    const tick = async () => {
      if (stopped) return;
      const wantsExplanation = ticks % EXPLANATION_EVERY === 0;
      ticks += 1;

      const [stateResult, simulationResult, explanationResult] = await Promise.allSettled([
        fetchState(abort.signal),
        fetchSimulationState(abort.signal),
        wantsExplanation ? fetchExplanation(abort.signal) : Promise.resolve(null),
      ]);
      if (stopped) return;

      if (stateResult.status === "fulfilled") {
        // 제어 결과는 마지막으로 읽은 값을 지우지 않는다. 오래됐다는 것만 알린다.
        state = stateResult.value;
        stateError = null;
        lastStateSuccessAtMs = performance.now();
      } else if (!isAbort(stateResult.reason)) {
        stateError = messageOf(stateResult.reason, "제어 상태를 읽지 못했습니다");
      }

      if (simulationResult.status === "fulfilled") {
        simulation = simulationResult.value;
        simulationError = null;
      } else if (!isAbort(simulationResult.reason)) {
        simulation = null;
        simulationError = messageOf(simulationResult.reason, "시나리오 실행기를 읽지 못했습니다");
      }

      if (wantsExplanation) {
        if (explanationResult.status === "fulfilled") {
          explanation = explanationResult.value;
          explanationError = null;
        } else if (!isAbort(explanationResult.reason)) {
          explanation = null;
          explanationError = messageOf(explanationResult.reason, "설명을 읽지 못했습니다");
        }
      }

      publish();
      if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, []);

  return view;
}

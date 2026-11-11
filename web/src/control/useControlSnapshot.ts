/** Independent read-only loops for controller, simulation and explanation. */
import { useEffect, useState } from "react";
import type { SimulationState, StateSnapshot } from "@contracts";
import { ApiError, fetchExplanation, fetchSimulationState, fetchState } from "../api/client";
import type { Explanation } from "./explanation";
import { startPolling } from "./poll";

const POLL_INTERVAL_MS = 1000;

export type ControlView = {
  readonly state: StateSnapshot | null;
  readonly simulation: SimulationState | null;
  readonly explanation: Explanation | null;
  readonly stateError: string | null;
  readonly simulationError: string | null;
  readonly explanationError: string | null;
  readonly lastStateSuccessAtMs: number | null;
  readonly nowMs: number;
  readonly pollIntervalMs: number;
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.code === null ? `HTTP ${error.status}` : `${error.message} (${error.code})`;
  if (error instanceof DOMException && error.name === "TimeoutError") return "응답 시간이 초과됐습니다";
  return error instanceof Error ? error.message : fallback;
}

export function useControlSnapshot(): ControlView {
  const [view, setView] = useState<ControlView>(() => ({
    state: null, simulation: null, explanation: null,
    stateError: null, simulationError: null, explanationError: null,
    lastStateSuccessAtMs: null, nowMs: performance.now(), pollIntervalMs: POLL_INTERVAL_MS,
  }));
  useEffect(() => {
    let state: StateSnapshot | null = null;
    let simulation: SimulationState | null = null;
    let explanation: Explanation | null = null;
    let stateError: string | null = null;
    let simulationError: string | null = null;
    let explanationError: string | null = null;
    let lastStateSuccessAtMs: number | null = null;
    let expiresAtMs: number | null = null;
    const publish = () => {
      const nowMs = performance.now();
      const stateFresh = stateError === null && lastStateSuccessAtMs !== null && nowMs - lastStateSuccessAtMs < 2000;
      const unexpired = explanation?.status !== "READY" || (expiresAtMs !== null && nowMs < expiresAtMs);
      setView({ state, simulation, explanation: stateFresh && unexpired ? explanation : null,
        stateError, simulationError, explanationError, lastStateSuccessAtMs, nowMs, pollIntervalMs: POLL_INTERVAL_MS });
    };
    const stopState = startPolling(fetchState, (value) => {
      state = value; stateError = null; lastStateSuccessAtMs = performance.now(); publish();
    }, (error) => {
      stateError = messageOf(error, "제어 상태를 읽지 못했습니다"); explanation = null; publish();
    }, POLL_INTERVAL_MS);
    const stopSimulation = startPolling(fetchSimulationState, (value) => {
      simulation = value; simulationError = null; publish();
    }, (error) => {
      simulation = null; simulationError = messageOf(error, "시나리오 실행기를 읽지 못했습니다"); publish();
    }, POLL_INTERVAL_MS);
    const stopExplanation = startPolling(fetchExplanation, (value) => {
      explanation = value.explanation; expiresAtMs = value.expiresAtMs; explanationError = null; publish();
    }, (error) => {
      explanation = null; expiresAtMs = null; explanationError = messageOf(error, "설명을 읽지 못했습니다"); publish();
    }, 5000);
    // Expiry and connection loss hide the text even while a fetch is pending.
    const clock = setInterval(publish, 250);
    return () => { stopState(); stopSimulation(); stopExplanation(); clearInterval(clock); };
  }, []);
  return view;
}

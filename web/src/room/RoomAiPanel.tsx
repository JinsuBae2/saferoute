/**
 * 내 방의 영상 AI 분석 요청과 진행 상태. 서버 전체에서 한 번에 한 방만 분석하므로 나머지는 줄을 선다.
 * 대기·미연결·실패를 "감지 중"처럼 보이게 하지 않는다. 기다리는 동안에도 수동 화재와 대피 시연은 그대로 쓸 수 있다.
 */
import { useEffect, useState } from "react";

import type { StateSnapshot } from "@contracts";
import { CameraPreviewPanel } from "../control/CameraPreviewPanel";
import { ApiError, fetchRoomAi, requestRoomAi } from "../api/client";
import type { RoomAi } from "../api/client";
import { startPolling } from "../control/poll";

const LABEL: Record<RoomAi["state"], string> = {
  UNAVAILABLE: "미연결 · 이 서버에는 영상 AI 분석이 연결되어 있지 않습니다. 수동 화재 시연은 그대로 쓸 수 있습니다.",
  IDLE: "요청 전 · 아직 이 실행에서 영상 분석을 요청하지 않았습니다.",
  QUEUED: "대기 중 · 다른 방의 분석이 끝나면 시작합니다.",
  RUNNING: "분석 중 · 준비된 영상을 분석하고 있습니다. 검출 위치와 신뢰도를 표시합니다.",
  DONE: "분석 종료 · 영상 끝까지 분석했습니다. 영상만 다시 분석할 수 있습니다.",
  FAILED: "분석 실패 · 분석을 끝내지 못했습니다. 감지 결과로 쓰지 않습니다.",
};

export function RoomAiPanel({ state }: { state: StateSnapshot }) {
  const [ai, setAi] = useState<RoomAi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => startPolling(fetchRoomAi, (value) => { setAi(value); }, () => { setAi(null); }, 2000), []);

  async function request() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      setAi(await requestRoomAi(AbortSignal.timeout(8000)));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "요청이 전달되지 않았습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>영상 AI 분석</h2>
      </header>
      <p className="panel__empty" aria-live="polite">
        {ai === null ? "상태를 확인하는 중입니다." : LABEL[ai.state]}
        {ai?.state === "QUEUED" && ai.position !== null && ` (내 순서 ${ai.position}번째)`}
        {error !== null && ` · ${error}`}
      </p>
      {ai !== null && (ai.state === "IDLE" || ai.state === "FAILED" || ai.state === "DONE") && (
        <button type="button" className="chip" disabled={busy} onClick={() => void request()}>{ai.state === "IDLE" ? "영상 분석 시작" : "영상 다시 분석"}</button>
      )}
      {ai?.state === "RUNNING" && ai.source_id && ai.run_id === state.run_id &&
        <CameraPreviewPanel state={state} sourceId={ai.source_id} />}
    </section>
  );
}

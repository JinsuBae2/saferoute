/**
 * 내 방의 영상 AI 분석 요청과 진행 상태. 서버 전체에서 한 번에 한 방만 분석하므로 나머지는 줄을 선다.
 * 대기·미연결·실패를 "감지 중"처럼 보이게 하지 않는다. 기다리는 동안에도 수동 화재와 대피 시연은 그대로 쓸 수 있다.
 */
import { useEffect, useRef, useState } from "react";

import type { StateSnapshot } from "@contracts";
import { CameraPreviewPanel } from "../control/CameraPreviewPanel";
import { ApiError, fetchRoomAi, requestRoomAi } from "../api/client";
import type { RoomAi, RoomAiResult } from "../api/client";
import { startPolling } from "../control/poll";

const LABEL: Record<RoomAi["state"], string> = {
  UNAVAILABLE: "미연결 · 이 서버에는 영상 AI 분석이 연결되어 있지 않습니다. 수동 화재 시연은 그대로 쓸 수 있습니다.",
  IDLE: "요청 전 · 아직 이 실행에서 영상 분석을 요청하지 않았습니다.",
  QUEUED: "대기 중 · 다른 방의 분석이 끝나면 시작합니다.",
  RUNNING: "분석 중 · 준비된 영상을 분석하고 있습니다. 검출 위치와 신뢰도를 표시합니다.",
  DONE: "분석 완료 · 영상 끝까지 분석했습니다.",
  FAILED: "분석 실패 · 분석을 끝내지 못했습니다. 감지 결과로 쓰지 않습니다.",
};

export function RoomAiPanel({ state }: { state: StateSnapshot }) {
  const [ai, setAi] = useState<RoomAi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [shown, setShown] = useState<{ analysis: string; frame: RoomAiResult["metadata"]; url: string } | null>(null);
  const lastFrame = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  useEffect(() => {
    return startPolling(async (signal) => {
      const version = revision.current;
      const current = await fetchRoomAi(signal, lastFrame.current);
      if (signal.aborted || version !== revision.current) return;
      setAi(current);
      setRetrying(false);
      const { result, analysis_id } = current;
      if (!result || !analysis_id || current.run_id !== state.run_id) return;
      const image = new Image();
      image.src = `data:image/jpeg;base64,${result.jpeg_base64}`;
      await image.decode();
      if (signal.aborted || version !== revision.current) return;
      setShown({ analysis: analysis_id, frame: result.metadata, url: image.src });
      lastFrame.current = result.metadata.frame_id;
    }, () => {}, () => setRetrying(true), 650);
  }, [state.run_id]);

  async function request() {
    if (busy) return;
    setBusy(true); setError(null);
    revision.current++;
    try {
      const next = await requestRoomAi(AbortSignal.timeout(8000));
      revision.current++;
      lastFrame.current = undefined;
      setShown(null);
      setAi(next);
      setRetrying(false);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "요청이 전달되지 않았습니다");
    } finally {
      setBusy(false);
    }
  }

  const display = ai?.run_id === state.run_id && ai.analysis_id === shown?.analysis &&
    (ai.state === "RUNNING" || ai.state === "DONE") ? shown : null;
  return (
    <section className="panel">
      <header className="panel__head">
        <h2>영상 AI 분석</h2>
      </header>
      <p className="panel__empty" aria-live="polite">
        {retrying ? "분석 상태를 다시 확인하고 있습니다." : ai === null ? "상태를 확인하는 중입니다." : LABEL[ai.state]}
        {ai?.state === "QUEUED" && ai.position !== null && ` (내 순서 ${ai.position}번째)`}
        {error !== null && ` · ${error}`}
      </p>
      {ai !== null && (ai.state === "IDLE" || ai.state === "FAILED" || ai.state === "DONE") && (
        <button type="button" className="chip" disabled={busy} onClick={() => void request()}>{ai.state === "IDLE" ? "영상 분석 시작" : "영상 다시 분석"}</button>
      )}
      {display ? <>
        <p className="panel__note">{ai?.state === "DONE" ? "마지막 분석 결과" : "최근 분석 결과"}</p>
        <CameraPreviewPanel frame={display.frame} url={display.url} />
      </> : ai?.state === "RUNNING" ? <p className="camera__blank">첫 분석 결과를 기다리는 중입니다.</p>
        : ai?.state === "DONE" && !ai.result ? <p className="panel__note">표시할 분석 프레임이 없습니다.</p> : null}
    </section>
  );
}

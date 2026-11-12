import { useEffect, useRef, useState } from "react";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { inRoom } from "../api/scope";
import { cctvPose } from "../building/cctv";
import { RoomAiPanel } from "../room/RoomAiPanel";
import { cameraSources } from "./previewModel";

const replayUrl = import.meta.env.VITE_AI_DEMO_REPLAY_URL;

type Props = {
  state: StateSnapshot;
  building: Building | null;
  display: BuildingDisplay | null;
  selectedSourceId: string | null;
  stale: boolean;
  onSelect: (id: string | null) => void;
};

export function CameraStation({ state, building, display, selectedSourceId, onSelect, stale }: Props) {
  const cameras = cameraSources(building);
  const selected = cameras.find(source => source.source_id === selectedSourceId);
  const zoneFire = selected && state.active_causes.some(cause => cause.hazard_type === "FIRE" &&
    building?.sources.some(source => source.source_id === cause.source_id && source.zone_id === selected.zone_id));
  const [analysis, setAnalysis] = useState<"replay" | "live" | null>(null);
  const [replayError, setReplayError] = useState(false);
  const open = analysis !== null;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.showModal();
    return () => element.close();
  }, [open]);

  return <>
    <section className="panel cctv-station">
    <header className="panel__head"><h2>CCTV</h2><span className="panel__note">3D 시뮬레이션 · 가상 카메라</span></header>
    <div className="camera__picker">
      {cameras.map(source => {
        const id = source.source_id;
        return <button key={id} type="button" title={id} aria-pressed={selectedSourceId === id}
          className={selectedSourceId === id ? "chip chip--on" : "chip"} onClick={() => onSelect(id)}>
          {display?.sources[id]?.label ?? id}
        </button>;
      })}
    </div>
    {selected && <p role="status" className={zoneFire && !stale ? "badge badge--fire" : "panel__note"}>
      {stale ? "구역 상태 갱신 대기" : zoneFire ? "시나리오상 화재 감지" : "선택 구역의 활성 화재 경보 없음"}
    </p>}
    {selectedSourceId && !cctvPose(building, display, selectedSourceId) &&
      <p className="panel__note">이 카메라에는 3D 시점 설정이 없습니다.</p>}
    </section>
    <section className="panel">
      <header className="panel__head"><h2>불꽃·연기 AI 분석</h2>
        <button className="chip" type="button" onClick={() => { setReplayError(false); setAnalysis(replayUrl ? "replay" : "live"); }}>예시 영상으로 AI 분석 보기</button>
      </header>
    </section>
    {analysis && <dialog className="camera-analysis" ref={dialog} aria-labelledby="camera-analysis-title"
      onCancel={() => setAnalysis(null)}>
      <header className="panel__head"><h2 id="camera-analysis-title">불꽃·연기 AI 분석</h2>
        <button type="button" className="chip" onClick={() => setAnalysis(null)}>닫기</button>
      </header>
      {replayUrl && <div className="camera__picker">
        <button type="button" className="chip" aria-pressed={analysis === "replay"}
          onClick={() => { setReplayError(false); setAnalysis("replay"); }}>분석 결과 재생</button>
        <button type="button" className="chip" aria-pressed={analysis === "live"}
          onClick={() => setAnalysis("live")}>새로 추론하기</button>
      </div>}
      {analysis === "replay" ? <>
        <p className="panel__note">NIST 실내 화재 실험 영상 · 모델이 미리 검출한 위치와 신뢰도</p>
        <video className="demo-replay" src={replayUrl} controls autoPlay muted playsInline
          aria-label="실내 화재 예시 영상의 AI 분석 결과" onError={() => setReplayError(true)} />
        {replayError && <p role="alert">분석 영상을 재생할 수 없습니다. 새로 추론하기에서 예시 영상을 분석할 수 있습니다.</p>}
      </> : inRoom() ? <RoomAiPanel state={state} /> :
        <a className="chip" href="#/room">개인 체험에서 예시 영상 분석하기</a>}
      <a href={`https://github.com/JinsuBae2/saferoute/blob/${__SOURCE_COMMIT__}/docs/ai/final-evaluation-closeout.md`}
        target="_blank" rel="noopener noreferrer">모델 평가 보고서 보기</a>
    </dialog>}
  </>;
}

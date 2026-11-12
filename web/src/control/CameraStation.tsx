import { useEffect, useRef, useState } from "react";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { inRoom } from "../api/scope";
import { cctvPose } from "../building/cctv";
import { RoomAiPanel } from "../room/RoomAiPanel";
import { cameraSources } from "./previewModel";

type Props = {
  state: StateSnapshot;
  building: Building | null;
  display: BuildingDisplay | null;
  selectedSourceId: string | null;
  onSelect: (id: string | null) => void;
};

export function CameraStation({ state, building, display, selectedSourceId, onSelect }: Props) {
  const cameras = cameraSources(building);
  const [analysis, setAnalysis] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!analysis || !element) return;
    element.showModal();
    return () => element.close();
  }, [analysis]);

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
    {selectedSourceId && !cctvPose(building, display, selectedSourceId) &&
      <p className="panel__note">이 카메라에는 3D 시점 설정이 없습니다.</p>}
    </section>
    <section className="panel">
      <header className="panel__head"><h2>불꽃·연기 AI 분석</h2>
        <button className="chip" type="button" onClick={() => setAnalysis(true)}>예시 영상으로 AI 분석 보기</button>
      </header>
    </section>
    {analysis && <dialog className="camera-analysis" ref={dialog} aria-labelledby="camera-analysis-title"
      onCancel={() => setAnalysis(false)}>
      <header className="panel__head"><h2 id="camera-analysis-title">불꽃·연기 AI 분석</h2>
        <button type="button" className="chip" onClick={() => setAnalysis(false)}>닫기</button>
      </header>
      <p className="panel__note">예시 영상에서 실제 모델이 찾은 불꽃과 연기를 표시합니다.</p>
      {inRoom() ? <RoomAiPanel state={state} /> :
        <a className="chip" href="#/room">개인 체험에서 예시 영상 분석하기</a>}
      <a href={`https://github.com/JinsuBae2/saferoute/blob/${__SOURCE_COMMIT__}/docs/ai/final-evaluation-closeout.md`}
        target="_blank" rel="noopener noreferrer">모델 평가 보고서 보기</a>
    </dialog>}
  </>;
}

import { useEffect, useRef, useState } from "react";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { inRoom } from "../api/scope";
import { cctvPose } from "../building/cctv";
import { RoomAiPanel } from "../room/RoomAiPanel";
import { CameraPreviewPanel } from "./CameraPreviewPanel";
import { cameraSources } from "./previewModel";

type Props = {
  state: StateSnapshot;
  building: Building | null;
  display: BuildingDisplay | null;
  selectedSourceId: string | null;
  onSelect: (id: string | null) => void;
  onLocate: (id: string) => void;
};

export function CameraStation({ state, building, display, selectedSourceId, onSelect, onLocate }: Props) {
  const cameras = cameraSources(building);
  const [analysis, setAnalysis] = useState(false);
  const [input, setInput] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!analysis || !element) return;
    element.showModal();
    return () => element.close();
  }, [analysis]);

  function openAnalysis(sourceId: string | null) {
    setInput(sourceId ?? cameras[0]?.source_id ?? null);
    setAnalysis(true);
  }

  return <>
    <section className="panel cctv-station">
    <header className="panel__head"><h2>CCTV</h2><span className="panel__note">3D 시뮬레이션</span></header>
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
    {selectedSourceId && <button className="chip analysis-open" type="button"
      onClick={() => openAnalysis(selectedSourceId)}>이 카메라의 AI 분석 보기</button>}
    </section>
    <section className="panel">
      <header className="panel__head"><h2>불꽃·연기 AI 분석</h2>
        <button className="chip" type="button" onClick={() => openAnalysis(selectedSourceId)}>AI 분석 열기</button>
      </header>
    </section>
    {analysis && <dialog className="camera-analysis" ref={dialog} aria-labelledby="camera-analysis-title"
      onCancel={() => setAnalysis(false)}>
      <header className="panel__head"><h2 id="camera-analysis-title">불꽃·연기 AI 분석</h2>
        <button type="button" className="chip" onClick={() => setAnalysis(false)}>닫기</button>
      </header>
      {inRoom() && <RoomAiPanel />}
      <CameraPreviewPanel key={input} state={state} building={building} display={display}
        selectedSourceId={input} onSelect={setInput} onLocate={id => { setAnalysis(false); onLocate(id); }} />
      <p>별도 성능 평가 · 동결 ONNX 모델 · 영상 5개<br />
        <strong>전체 판정 · 기준 미달 (FAIL)</strong> · 목표 정밀도 80% 이상 · 재현율 90% 이상</p>
      <p>불꽃 정밀도 4.55% · 재현율 66.67%<br />연기 정밀도 5.88% · 재현율 100%</p>
      <a href={`https://github.com/JinsuBae2/saferoute/blob/${__SOURCE_COMMIT__}/docs/ai/final-evaluation-closeout.md`}
        target="_blank" rel="noopener noreferrer">평가 조건과 판정 보기</a>
    </dialog>}
  </>;
}

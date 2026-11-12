import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { summarizeRoutes, summarizeSigns } from "./controlModel";

type Props = {
  state: StateSnapshot;
  building: Building | null;
  display: BuildingDisplay | null;
  sourceId: string | null;
  stale: boolean;
};

const VALIDITY_LABEL = { VALID: "관측 수신 중", STALE: "관측 오래됨", UNAVAILABLE: "관측 불가", INITIALIZING: "관측 준비 중" };

export function AiDemoSummary({ state, building, display, sourceId, stale }: Props) {
  const camera = building?.sources.find((item) => item.source_id === sourceId && item.source_type === "VIDEO_AI");
  const source = camera === undefined ? undefined : state.sources.find((item) => item.source_id === camera.source_id);
  const causes = camera === undefined ? [] : state.active_causes.filter((item) => item.source_id === camera.source_id);
  const blocks = camera === undefined ? 0 : state.blocked_edges.filter((item) => item.source_ids.includes(camera.source_id)).length;
  const routes = summarizeRoutes(state);
  const signs = summarizeSigns(state);
  const waiting = camera === undefined;

  return (
    <section className="ai-demo" aria-label="AI 시연 상태">
      <header className="ai-demo__head">
        <div>
          <p className="ai-demo__eyebrow">SAFE ROUTE · AI DEMO</p>
          <h2>영상에서 대피 안내까지</h2>
          <p>영상 AI 감지 · 제어기 경로 판단 · 유도등 화면 응답</p>
        </div>
        <span className={`badge badge--${stale ? "warn" : "muted"}`}>
          {stale ? "제어 연결 지연 · 현재 결과 확인 불가" : `제어 상태 수신 · 안내 v${state.guidance_version}`}
        </span>
      </header>
      <ol className="ai-demo__steps">
        <li>
          <span className="ai-demo__step">01 · 선택 카메라 관측</span>
          <strong>{stale ? "확인 불가" : waiting ? "카메라 선택" : source === undefined ? "관측 미확인" : VALIDITY_LABEL[source.validity]}</strong>
          <small>{camera === undefined ? "아래에서 시연할 CAM을 고르세요" : display?.sources[camera.source_id]?.label ?? camera.source_id}</small>
        </li>
        <li>
          <span className="ai-demo__step">02 · 해당 카메라의 제어 결과</span>
          <strong>{stale ? "확인 불가" : waiting ? "—" : `경보 ${causes.length} · 차단 통로 ${blocks}`}</strong>
          <small>{camera === undefined ? "선택한 카메라 기준" : `관측 구역: ${display?.zone_labels[camera.zone_id] ?? camera.zone_id}`}</small>
          <small>경보는 영상 종료 후에도 확인 해제 전까지 유지</small>
        </li>
        <li>
          <span className="ai-demo__step">03 · 건물 전체 경로</span>
          <strong>{stale ? "확인 불가" : `안내 ${routes.guided} / ${routes.total} 지점`}</strong>
          <small>{stale ? "연결 복구 후 확인" : `안내 불가 ${routes.unavailable}곳 · 모든 감지기·카메라 반영`}</small>
        </li>
        <li>
          <span className="ai-demo__step">04 · 건물 전체 유도등</span>
          <strong>{stale ? "확인 불가" : `적용 ${signs.confirmedCurrent} / ${signs.total}대`}</strong>
          <small>{stale ? "연결 복구 후 확인" : `미확인 ${signs.unconfirmed}대${signs.mixedVersion ? " · 혼합 버전" : ""} · 유도등 화면 응답 기준`}</small>
        </li>
      </ol>
      <p className="ai-demo__note">
        검출 상자의 %는 모델 신뢰도이며 정확도가 아닙니다. 3D·대피 인원·연기는 가상 표현입니다.{" "}
        <a href="https://github.com/JinsuBae2/saferoute/blob/5e059f610b46cfffce93b6b3a6580809c1f8d4cd/docs/ai/final-evaluation-closeout.md" target="_blank" rel="noreferrer">
          별도 설정의 평가 결과·한계 보기 (기준 미달)
        </a>
      </p>
    </section>
  );
}

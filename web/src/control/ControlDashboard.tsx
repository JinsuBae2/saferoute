/**
 * 관제 화면. 서버가 확정한 한 안내 버전의 상태·위험·경로·단말 현황을 표시한다.
 * 경로나 방향을 여기서 계산하지 않고, 미적용·단절·오래된 버전을 숨기지 않는다.
 */
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { SourceNotice } from "../SourceNotice";

import type { StateSnapshot } from "@contracts";


import {
  checkExplanation,
  connectionHealth,
  simulationMatchesRun,
  summarizeRoutes,
  summarizeSigns,
  summarizeSources,
} from "./controlModel";
import type { ExplanationBlockReason } from "./controlModel";
import { EXPLANATION_ERROR_LABEL } from "./explanation";
import { useControlSnapshot } from "./useControlSnapshot";
import { ManualFirePanel } from "./ManualFirePanel";
import { CameraPreviewPanel } from "./CameraPreviewPanel";
import { AiDemoSummary } from "./AiDemoSummary";
import { useBuildingData } from "../building/useBuildingData";

// three.js는 관제에서만 쓴다. 단말 화면 묶음에 들어가지 않도록 따로 불러온다.
const BuildingPanel = lazy(() => import("../building/BuildingPanel"));

type Mode = StateSnapshot["controller_mode"];
type Validity = StateSnapshot["sources"][number]["validity"];
type Hazard = StateSnapshot["active_causes"][number]["hazard_type"];
type ApplicationStatus = StateSnapshot["signs"][number]["application_status"];

const MODE_LABEL: Record<Mode, string> = {
  INITIALIZING: "준비 중",
  NORMAL: "평상시",
  EMERGENCY: "화재 대응",
  DEGRADED: "관측 장애",
};

const MODE_TONE: Record<Mode, string> = {
  INITIALIZING: "muted",
  NORMAL: "route",
  EMERGENCY: "fire",
  DEGRADED: "warn",
};

const VALIDITY_LABEL: Record<Validity, string> = {
  VALID: "유효",
  STALE: "오래됨",
  UNAVAILABLE: "관측 불가",
  INITIALIZING: "준비 중",
};

const VALIDITY_TONE: Record<Validity, string> = {
  VALID: "route",
  STALE: "warn",
  UNAVAILABLE: "fire",
  INITIALIZING: "muted",
};

const HAZARD_LABEL: Record<Hazard, string> = {
  FIRE: "화재",
  SMOKE: "연기",
  SPRINKLER: "스프링클러",
};

const HAZARD_TONE: Record<Hazard, string> = {
  FIRE: "fire",
  SMOKE: "warn",
  SPRINKLER: "warn",
};

const BLOCK_REASON_LABEL: Record<StateSnapshot["blocked_edges"][number]["reason_codes"][number], string> = {
  ACTIVE_ALARM: "경보로 차단",
  REQUIRED_OBSERVATION_UNKNOWN: "필수 관측 확인 불가",
  NOT_TRAVERSABLE: "설정상 통행 불가",
};

const APPLICATION_LABEL: Record<ApplicationStatus, string> = {
  NOT_ISSUED: "미발행",
  PENDING: "확인 대기",
  APPLIED: "적용 확인",
  REJECTED: "적용 실패",
  EXPIRED: "기한 만료",
  DUPLICATE_TERMINAL: "중복 단말",
};

const APPLICATION_TONE: Record<ApplicationStatus, string> = {
  NOT_ISSUED: "muted",
  PENDING: "warn",
  APPLIED: "route",
  REJECTED: "fire",
  EXPIRED: "warn",
  DUPLICATE_TERMINAL: "fire",
};

const EXPLANATION_BLOCK_LABEL: Record<ExplanationBlockReason, string> = {
  NOT_LOADED: "설명을 아직 받지 못했습니다",
  NOT_READY: "설명을 준비 중이거나 제공할 수 없습니다",
  RUN_MISMATCH: "다른 실행의 설명이라 숨겼습니다",
  BUILDING_MISMATCH: "다른 건물 자료의 설명이라 숨겼습니다",
  GUIDANCE_MISMATCH: "안내가 바뀌어 이전 설명을 숨겼습니다",
  EXPIRED: "설명 유효기간이 지나 숨겼습니다",
  MISSING_FIELDS: "설명 내용이나 근거가 비어 있습니다",
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <strong className={tone === undefined ? "tile__value" : `tile__value tile__value--${tone}`}>{value}</strong>
      {note !== undefined && <span className="tile__note">{note}</span>}
    </div>
  );
}

/**
 * folding을 주면 평소에는 제목만 보이고 눌러야 펼쳐진다 (이슈 #21).
 * 한 화면에 표가 네 개나 펼쳐져 있으면 지금 중요한 것이 무엇인지 묻히기 때문이다.
 * 숫자 요약은 위쪽 타일에 그대로 남아 있어, 접어도 현황을 놓치지 않는다.
 */
function Panel({
  title,
  note,
  folding = false,
  children,
}: {
  title: string;
  note?: string;
  folding?: boolean;
  children: React.ReactNode;
}) {
  const head = (
    <>
      <h2>{title}</h2>
      {note !== undefined && <span className="panel__note">{note}</span>}
    </>
  );
  if (!folding) {
    return (
      <section className="panel">
        <header className="panel__head">{head}</header>
        {children}
      </section>
    );
  }
  return (
    <details className="panel panel--folding">
      <summary className="panel__head">{head}</summary>
      {children}
    </details>
  );
}

export function ControlDashboard() {
  const view = useControlSnapshot();
  const [onlyUnavailable, setOnlyUnavailable] = useState(false);
  const [presentation, setPresentation] = useState(false);
  // 고른 카메라는 미리보기와 3D 강조가 함께 쓴다.
  const [camera, setCamera] = useState<{ sourceId: string | null; locate: number }>({
    sourceId: null,
    locate: 0,
  });
  const state = view.state;
  const space = useBuildingData(state);
  const display = space.display;

  const health = connectionHealth(view.lastStateSuccessAtMs, view.nowMs, view.pollIntervalMs * 3);

  if (state === null) {
    return (
      <main className="control">
        <Panel title="제어기에 연결하는 중">
          <p className="panel__empty">
            {view.stateError ?? "상태를 기다리는 중입니다."}
            <br />
            제어 백엔드가 떠 있는지 확인하세요.
          </p>
        </Panel>
        <footer className="control__footer"><SourceNotice /></footer>
      </main>
    );
  }

  const signs = summarizeSigns(state);
  const routes = summarizeRoutes(state);
  const sources = summarizeSources(state);
  const explanation = checkExplanation(view.explanation, state);
  const simulation = simulationMatchesRun(view.simulation, state) ? view.simulation : null;
  const visibleRoutes = onlyUnavailable
    ? state.routes.filter((route) => route.reason_codes.length > 0)
    : state.routes;

  return (
    <main className={presentation ? "control control--presentation" : "control"}>
      <header className="control__header">
        <div>
          <h1>saferoute 관제</h1>
          <p className="control__ids">
            실행 <code>{state.run_id}</code> · {state.building_id} v{state.building_version} · 안내 버전{" "}
            <strong>{state.guidance_version}</strong> · 기준 시각 {state.generated_at}
          </p>
        </div>
        <div className="control__actions">
          <button type="button" className={presentation ? "chip chip--on" : "chip"}
            aria-pressed={presentation} onClick={() => setPresentation((previous) => !previous)}>
            {presentation ? "기본 관제로 돌아가기" : "AI 시연 보기"}
          </button>
          <Badge tone={MODE_TONE[state.controller_mode]}>{MODE_LABEL[state.controller_mode]}</Badge>
        </div>
      </header>

      {(health.stale || view.stateError !== null) && (
        <p className="control__alert">
          {view.stateError ?? "제어 상태 조회가 지연되고 있습니다."}{" "}
          {health.ageMs === null
            ? "아직 한 번도 읽지 못했습니다."
            : `마지막 조회 ${(health.ageMs / 1000).toFixed(1)}초 전. 아래 값은 그때 기준입니다.`}
        </p>
      )}

      <div className="tiles control__overview">
        <Tile
          label="활성 경보"
          value={`${state.active_causes.length}건`}
          tone={state.active_causes.length > 0 ? "fire" : undefined}
          note={state.active_causes.length === 0 ? "원인별 해제만 가능" : "확인 해제 전까지 유지"}
        />
        <Tile
          label="차단"
          value={`지점 ${state.blocked_nodes.length} · 통로 ${state.blocked_edges.length}`}
          tone={state.blocked_nodes.length > 0 ? "warn" : undefined}
        />
        <Tile
          label="안내"
          value={`${routes.guided} / ${routes.total} 지점`}
          tone={routes.unavailable > 0 ? "warn" : "route"}
          note={(() => {
            // 그 자리가 차단된 곳과, 자리는 멀쩡하지만 출구에 닿지 못하는 곳은 성격이 다르다. 사람이 있는지는 알 수 없다.
            const count = Object.fromEntries(routes.reasons);
            const inside = count.ORIGIN_BLOCKED ?? 0;
            const cutOff = count.NO_REACHABLE_EXIT ?? 0;
            return inside + cutOff > 0
              ? `안내 불가 ${routes.unavailable}곳 (차단 구역 안 ${inside} · 고립 가능 ${cutOff})`
              : `안내 불가 ${routes.unavailable}곳`;
          })()}
        />
        <Tile
          label="관측원"
          value={`${sources.valid} / ${sources.total} 유효`}
          tone={sources.anyUnconfirmed ? "warn" : "route"}
        />
        <Tile
          label="단말 적용"
          value={`${signs.confirmedCurrent} / ${signs.total}`}
          tone={signs.unconfirmed > 0 ? "warn" : "route"}
          note={signs.mixedVersion ? "혼합 버전 표시 중" : `미확인 ${signs.unconfirmed}대`}
        />
      </div>

      {signs.mixedVersion && (
        <p className="control__alert control__alert--warn">
          단말들이 서로 다른 안내 버전을 표시하고 있습니다. 이전 버전 {signs.behindGuidance}대.
        </p>
      )}

      {space.displayError !== null && <p className="panel__note">위치 이름 표시: {space.displayError} · 기본 ID로 표시합니다.</p>}

      {presentation && <AiDemoSummary state={state} building={space.building} display={display}
        sourceId={camera.sourceId} stale={health.stale || view.stateError !== null} />}

      <div className="control__visuals">
        <div className="control__building">
          <Suspense
            fallback={
              <section className="panel">
                <p className="panel__empty">건물 3D를 불러오는 중입니다.</p>
              </section>
            }
          >
            <BuildingPanel
              state={state}
              simulation={simulation}
              building={space.building}
              display={display}
              buildingError={space.buildingError}
              highlightSourceId={camera.sourceId}
              locateRequest={camera.locate}
              stale={health.stale || view.stateError !== null}
              demo={(startPicker, hasStart) => space.building !== null && <ManualFirePanel key={`${state.run_id}/${state.building_id}/${state.building_version}`}
                building={space.building} display={display} state={state} connected={!health.stale && view.stateError === null}
                startPicker={startPicker} hasStart={hasStart} />}
            />
          </Suspense>
        </div>

        <div className="control__camera">
          <CameraPreviewPanel
            key={`${state.run_id}/${state.building_id}/${state.building_version}/${camera.sourceId}`}
            state={state}
            building={space.building}
            display={display}
            selectedSourceId={camera.sourceId}
            onSelect={(sourceId) => setCamera((previous) => ({ ...previous, sourceId }))}
            onLocate={(sourceId) =>
              setCamera((previous) => ({ sourceId, locate: previous.locate + 1 }))
            }
          />
        </div>
      </div>

      <Panel
        title="상황 설명"
        note="Bedrock 작성 · 제어 판단과 별개이며 새 행동 지시를 만들지 않습니다"
      >
        {explanation.usable ? (
          <div className="explanation">
            <p className="explanation__text">{explanation.explanation.summary}</p>
            <p className="explanation__meta">
              AI 작성 · 근거 시각 {explanation.explanation.basis_generated_at} · 안내 버전{" "}
              {explanation.explanation.guidance_version} · 모델 {explanation.explanation.model_id ?? "미기재"}
            </p>
            <ul className="explanation__facts">
              {explanation.explanation.fact_refs.map((ref) => (
                <li key={ref}>
                  <code>{ref}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="panel__empty">
            {EXPLANATION_BLOCK_LABEL[explanation.reason]}
            {view.explanation?.error_code != null && ` — ${EXPLANATION_ERROR_LABEL[view.explanation.error_code]}`}
            {view.explanationError !== null && ` (${view.explanationError})`}
            <br />
            경로·방향·적용 현황은 아래 제어 결과로 계속 표시됩니다.
          </p>
        )}
      </Panel>

      <div className="columns">
        <Panel title="관측원" note="경보 상태와 관측 유효성은 별개입니다" folding>
          <table className="grid">
            <thead>
              <tr>
                <th>관측원</th>
                <th>유효성</th>
                <th>마지막 관측</th>
                <th>순번</th>
              </tr>
            </thead>
            <tbody>
              {state.sources.map((source) => (
                <tr key={source.source_id}>
                  <td>
                    <span title={source.source_id}>{display?.sources[source.source_id]?.label ?? source.source_id}</span>
                    {display !== null && <small className="location-detail">
                      관측: {display.zone_labels[space.building?.sources.find((item) => item.source_id === source.source_id)?.zone_id ?? ""] ?? "미확인"}
                      {display.sources[source.source_id]?.installation?.basis === "SIMULATED" ? " · 가상 설치 위치" : display.sources[source.source_id]?.installation === null ? " · 설치 위치 미확인" : " · 실측 설치 위치"}
                    </small>}
                  </td>
                  <td>
                    <Badge tone={VALIDITY_TONE[source.validity]}>{VALIDITY_LABEL[source.validity]}</Badge>
                  </td>
                  <td className="grid__dim">{source.last_observed_at ?? "—"}</td>
                  <td className="grid__dim">{source.last_source_sequence ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="활성 경보" note="다른 관측원의 정상 신호로 지워지지 않습니다">
          {state.active_causes.length === 0 ? (
            <p className="panel__empty">활성 경보가 없습니다.</p>
          ) : (
            <ul className="causes">
              {state.active_causes.map((cause) => (
                <li key={`${cause.source_id}:${cause.hazard_type}`}>
                  <Badge tone={HAZARD_TONE[cause.hazard_type]}>{HAZARD_LABEL[cause.hazard_type]}</Badge>
                  <span title={cause.source_id}>{display?.sources[cause.source_id]?.label ?? cause.source_id}</span>
                  <span className="grid__dim">{cause.activated_at}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="차단 구간"
        note="경보·필수 관측 미확인·설정상 통행 제한을 표시합니다"
        folding
      >
        {state.blocked_nodes.length === 0 && state.blocked_edges.length === 0 ? (
          <p className="panel__empty">차단된 지점·통로가 없습니다.</p>
        ) : (
          <div className="blocked">
            <div>
              <h3>지점 {state.blocked_nodes.length}</h3>
              <ul>
                {state.blocked_nodes.map((node) => (
                  <li key={node.node_id}>
                    <span title={node.node_id}>{display?.node_labels[node.node_id] ?? node.node_id}</span> · <span className="grid__dim" title={node.reason_codes.join(", ")}>{node.reason_codes.map((code) => BLOCK_REASON_LABEL[code]).join(" · ")}</span>
                    {node.source_ids.length > 0 && <small className="location-detail">원인: {node.source_ids.map((id) => display?.sources[id]?.label ?? id).join(", ")}</small>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>통로 {state.blocked_edges.length}</h3>
              <ul>
                {state.blocked_edges.map((edge) => {
                  const path = space.building?.edges.find((item) => item.edge_id === edge.edge_id);
                  const label = path === undefined ? edge.edge_id
                    : `${display?.node_labels[path.from_node_id] ?? path.from_node_id} → ${display?.node_labels[path.to_node_id] ?? path.to_node_id}`;
                  return (
                    <li key={edge.edge_id}>
                      <span title={edge.edge_id}>{label}</span>{" · "}
                      <span className="grid__dim" title={edge.reason_codes.join(", ")}>{edge.reason_codes.map((code) => BLOCK_REASON_LABEL[code]).join(" · ")}</span>
                      {edge.source_ids.length > 0 && <small className="location-detail">원인: {edge.source_ids.map((id) => display?.sources[id]?.label ?? id).join(", ")}</small>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="유도등 단말 적용 현황"
        note="적용 확인은 단말이 화면에 반영하고 응답한 것만 셉니다"
        folding
      >
        <table className="grid">
          <thead>
            <tr>
              <th>유도등</th>
              <th>현재 안내</th>
              <th>적용 상태</th>
              <th>명령</th>
              <th>단말</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.signs.map((sign) => {
              const command = sign.latest_command;
              const behind = command !== null && command.guidance_version !== state.guidance_version;
              return (
                <tr key={sign.sign_id}>
                  <td>
                    <span title={sign.sign_id}>{display?.signs[sign.sign_id]?.label ?? sign.sign_id}</span>
                    {display !== null && <small className="location-detail">{display.signs[sign.sign_id]?.kind === "EXIT_LOCATION" ? "출구 위치 표지" : "가변 방향 안내"}</small>}
                  </td>
                  <td>
                    {sign.faces.map((face) => (
                      <span key={face.face_id} className="face-chip">
                        {face.face_id} {face.display ?? face.mode}
                      </span>
                    ))}
                  </td>
                  <td>
                    <Badge tone={APPLICATION_TONE[sign.application_status]}>
                      {APPLICATION_LABEL[sign.application_status]}
                    </Badge>
                  </td>
                  <td className="grid__dim">
                    {command === null ? (
                      "—"
                    ) : (
                      <>
                        #{command.command_sequence} · v{command.guidance_version}
                        {behind && <span className="grid__behind"> 이전 버전</span>}
                      </>
                    )}
                  </td>
                  <td className="grid__dim">
                    {sign.terminals.length === 0
                      ? "없음"
                      : sign.terminals
                          .map((terminal) => `${terminal.terminal_instance_id.slice(0, 8)}${terminal.verified ? "" : "(미검증)"}`)
                          .join(", ")}
                  </td>
                  <td>
                    <Link className="grid__link" to={`/sign/${encodeURIComponent(sign.sign_id)}`}>
                      단말 열기
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="경로"
        note="cost는 경로 선택용 모델 비용입니다. 거리나 피난 시간이 아닙니다"
        folding
      >
        <label className="filter">
          <input
            type="checkbox"
            checked={onlyUnavailable}
            onChange={(event) => setOnlyUnavailable(event.target.checked)}
          />
          안내 불가만 보기 ({routes.unavailable}곳)
        </label>

        {routes.reasons.length > 0 && (
          <p className="panel__note">
            사유: {routes.reasons.map(([reason, count]) => `${reason} ${count}`).join(" · ")}
          </p>
        )}

        <div className="grid__scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>지점</th>
                <th>다음</th>
                <th>목적지</th>
                <th>모델 비용</th>
                <th>사유</th>
              </tr>
            </thead>
            <tbody>
              {visibleRoutes.map((route) => (
                <tr key={route.node_id}>
                  <td>
                    <span title={route.node_id}>{display?.node_labels[route.node_id] ?? route.node_id}</span>
                  </td>
                  <td>{route.next_node_id === null ? "—" : display?.node_labels[route.next_node_id] ?? route.next_node_id}</td>
                  <td>{route.exit_id === null ? "—" : display?.exit_labels[route.exit_id] ?? route.exit_id}</td>
                  <td className="grid__dim">{route.cost ?? "—"}</td>
                  <td className="grid__reason">{route.reason_codes.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="연기"
        note="시뮬레이션의 구역별 연기 농도입니다. 제어기는 이 값이 아니라 감지기 관측으로 판단합니다"
        folding
      >
        {simulation === null ? (
          <p className="panel__empty">
            시나리오 실행기가 연결되지 않았습니다.
            {view.simulationError !== null && ` (${view.simulationError})`}
            <br />
            제어 결과 표시에는 영향이 없습니다.
          </p>
        ) : (
          <>
            <p className="panel__note">
              <code>{simulation.scenario_id}</code> · {simulation.status} · 진행 {simulation.simulation_time_ms}ms
            </p>
            <ul className="smoke">
              {simulation.zones.map((zone) => (
                <li key={zone.zone_id}>
                  <span title={zone.zone_id}>{display?.zone_labels[zone.zone_id] ?? zone.zone_id}</span>
                  <span className="smoke__bar" aria-hidden>
                    <span style={{ width: `${Math.round(zone.smoke * 100)}%` }} />
                  </span>
                  <span className="grid__dim">{zone.smoke.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <footer className="control__footer">
        시험 조작 패널 외에는 조회만 합니다. 화면을 닫아도 활성 경보와 제어기·유도등 단말은 그대로 유지됩니다.
        <SourceNotice />
      </footer>
    </main>
  );
}

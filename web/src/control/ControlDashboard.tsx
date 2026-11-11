/**
 * 관제 화면. 서버가 확정한 한 안내 버전의 상태·위험·경로·단말 현황을 표시한다.
 * 경로나 방향을 여기서 계산하지 않고, 미적용·단절·오래된 버전을 숨기지 않는다.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SourceNotice } from "../SourceNotice";

import type { StateSnapshot } from "@contracts";


import {
  checkExplanation,
  connectionHealth,
  simulationMatchesRun,
  simulationConnectionLost,
  defaultDisplays,
  observedAgeMs,
  sourceStatus,
  summarizeRoutes,
  summarizeSignChanges,
  summarizeSigns,
  summarizeSources,
} from "./controlModel";
import { agoText, AlarmPanel, SOURCE_STATUS_LABEL, SOURCE_STATUS_TONE } from "./AlarmPanel";
import type { ExplanationBlockReason } from "./controlModel";
import { EXPLANATION_ERROR_LABEL } from "./explanation";
import { useControlSnapshot } from "./useControlSnapshot";
import { ManualFirePanel } from "./ManualFirePanel";
import { CameraPreviewPanel } from "./CameraPreviewPanel";
import { AiDemoSummary } from "./AiDemoSummary";
import { AlarmSoundBar } from "./AlarmSoundBar";
import { useBuildingData } from "../building/useBuildingData";

// three.js는 관제에서만 쓴다. 단말 화면 묶음에 들어가지 않도록 따로 불러온다.
const BuildingPanel = lazy(() => import("../building/BuildingPanel"));

type Mode = StateSnapshot["controller_mode"];
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

const BLOCK_REASON_LABEL: Record<StateSnapshot["blocked_edges"][number]["reason_codes"][number], string> = {
  ACTIVE_ALARM: "경보로 차단",
  REQUIRED_OBSERVATION_UNKNOWN: "필수 관측 확인 불가",
  NOT_TRAVERSABLE: "설정상 통행 불가",
};

const APPLICATION_LABEL: Record<ApplicationStatus, string> = {
  NOT_ISSUED: "안내를 아직 보내지 않음",
  PENDING: "응답 대기",
  APPLIED: "반영 확인",
  REJECTED: "반영 실패",
  EXPIRED: "응답 없음(기한 지남)",
  DUPLICATE_TERMINAL: "같은 유도등 화면이 둘 이상",
};

/** 시뮬레이션이 완전히 멈춘 사유. 일시적인 연결 끊김은 여기 오지 않고 스스로 다시 시도한다. */
const SIMULATION_FAILURE_LABEL: Record<string, string> = {
  CONTROLLER_UNAVAILABLE: "제어기가 오류를 돌려줬습니다",
  INVALID_RESPONSE: "제어기 응답을 해석하지 못했습니다",
  RUN_MISMATCH: "제어기가 다른 실행으로 바뀌었습니다",
  BUILDING_MISMATCH: "제어기의 건물 자료가 다릅니다",
  SOURCE_CONFLICT: "같은 감지기를 쓰는 다른 실행기가 있습니다",
  LOG_WRITE_FAILED: "실행 기록을 저장하지 못했습니다",
  CONTROLLER_NOT_READY: "제어기가 실행 기록 오류로 멈췄습니다",
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

/** 끊겼다가 다시 이어진 직후 10초 동안만 참이다. */
function useRecoveryNotice(lost: boolean | null, runId: string | null): boolean {
  const wasLost = useRef(false);
  const previousRun = useRef(runId);
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (previousRun.current !== runId) {
      previousRun.current = runId;
      wasLost.current = false;
      setRecovered(false);
    }
    if (lost === null) {
      wasLost.current = false;
      setRecovered(false);
      return;
    }
    if (lost) {
      wasLost.current = true;
      setRecovered(false);
      return;
    }
    if (!wasLost.current) return;
    wasLost.current = false;
    setRecovered(true);
    const timer = setTimeout(() => setRecovered(false), 10_000);
    return () => clearTimeout(timer);
  }, [lost, runId]);
  return previousRun.current === runId && recovered;
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

  const defaults = useMemo(() => (space.building === null ? null : defaultDisplays(space.building.signs)), [space.building]);
  // 실행 중이거나 시작을 기다리는 동안의 연결 끊김. 실행기가 스스로 다시 시도한다.
  // 다른 실행·영구 실패·종료는 복구로 표시하지 않는다.
  const simulationLink = simulationConnectionLost(view.simulation, state);
  const recovered = useRecoveryNotice(simulationLink, state?.run_id ?? null);
  const simulationLost = simulationLink === true;

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
  const signChanges = summarizeSignChanges(state, defaults);
  const stale = health.stale || view.stateError !== null;
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

      <AlarmSoundBar state={state} stale={stale} />

      {simulationLost && (
        <p className="control__alert" role="alert">
          시뮬레이션이 제어기에 감지 정보를 전달하지 못하고 있습니다. 1초마다 다시 시도하며, 연결되면 초기화 없이 이어집니다.
          {" "}전달이 끊긴 동안 감지 정보가 만료되면 제어기는 해당 구간의 경로 안내를 멈춥니다.
        </p>
      )}
      {!simulationLost && recovered && (
        <p className="control__alert control__alert--ok" role="status">
          시뮬레이션과 제어기의 연결이 복구됐습니다. 끊긴 동안 밀린 옛 감지 정보는 쓰지 않고 새 정보부터 반영합니다.
        </p>
      )}
      {simulation?.status === "FAILED" && (
        <p className="control__alert" role="alert">
          시뮬레이션이 멈췄습니다. {SIMULATION_FAILURE_LABEL[simulation.error_code ?? ""] ?? "원인을 확인하지 못했습니다"}
          {simulation.error_code !== null && <> (<code>{simulation.error_code}</code>)</>}. 새 감지 정보가 오지 않아 경로 안내가 멈춥니다. 시연 패널의 초기화로 다시 시작하세요.
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
          label="경로 안내 가능 위치"
          value={`${routes.guided} / ${routes.total}곳`}
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
          label="감지 정보"
          value={`${sources.total}개 중 ${sources.valid}개`}
          tone={sources.anyUnconfirmed ? "warn" : "route"}
          note={`최신 정보 수신 ${sources.valid}개 · 받지 못함 ${sources.initializing} · 만료 ${sources.stale} · 관측 불가 ${sources.unavailable} · 최신 정보가 위험 없음을 뜻하지는 않습니다`}
        />
        <Tile
          label="유도등 반영 확인"
          value={`${signs.total}개 중 ${signs.confirmedCurrent}개`}
          tone={signs.unconfirmed > 0 ? "warn" : "route"}
          note={signs.mixedVersion ? "서로 다른 안내 버전 표시 중" : `응답 없어 미확인 ${signs.unconfirmed}대`}
        />
        <Tile
          label="방향 변경 확인"
          value={signChanges === null ? "확인 불가" : `${signChanges.changedConfirmed}대`}
          tone={signChanges !== null && signChanges.changed > signChanges.changedConfirmed ? "warn" : undefined}
          note={signChanges === null ? "건물 자료를 읽지 못했습니다"
            : `평상시와 방향이 달라진 유도등 ${signChanges.changed}대 중 반영 응답 ${signChanges.changedConfirmed}대 · 안내 중단 ${signChanges.stopped}대(응답 ${signChanges.stoppedConfirmed}대)`}
        />
      </div>

      {signs.mixedVersion && (
        <p className="control__alert control__alert--warn">
          유도등들이 서로 다른 안내 버전을 표시하고 있습니다. 이전 버전 {signs.behindGuidance}대.
        </p>
      )}

      {space.displayError !== null && <p className="panel__note">위치 이름 표시: {space.displayError} · 기본 ID로 표시합니다.</p>}

      {presentation && <AiDemoSummary state={state} building={space.building} display={display}
        sourceId={camera.sourceId} stale={stale} />}

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
              stale={stale}
              demo={(startPicker, hasStart) => space.building !== null && <ManualFirePanel key={`${state.run_id}/${state.building_id}/${state.building_version}`}
                building={space.building} display={display} state={state} connected={!health.stale && view.stateError === null}
                startPicker={startPicker} hasStart={hasStart} />}
            />
          </Suspense>
        </div>

        <div className="control__camera">
          <CameraPreviewPanel
            key={`${state.run_id}/${state.building_id}/${state.building_version}`}
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
            {/* 연결 실패·실행 대기·생성 실패를 나눠 말한다. HTTP 상태값만 보여 주지 않는다. */}
            {view.explanationError !== null ? (
              <span title={view.explanationError}>연결 실패 · 상황 설명 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인하세요.</span>
            ) : view.explanation?.status === "PENDING" ? (
              "실행 대기 · 현재 안내에 대한 설명을 만들고 있습니다."
            ) : view.explanation?.error_code != null ? (
              <span title={view.explanation.error_code}>생성 실패 · {EXPLANATION_ERROR_LABEL[view.explanation.error_code]}.</span>
            ) : (
              EXPLANATION_BLOCK_LABEL[explanation.reason]
            )}
            <br />
            설명이 없어도 경로·방향·유도등 반영 현황은 아래 제어 결과로 계속 표시됩니다.
          </p>
        )}
      </Panel>

      <div className="columns">
        <Panel title="감지 정보" note="정보를 받고 있는지만 보여 줍니다. 최신 정보를 받아도 그 내용이 경보일 수 있습니다" folding>
          <table className="grid">
            <thead>
              <tr>
                <th>감지기·카메라</th>
                <th>수신 상태</th>
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
                    <span title={source.validity}><Badge tone={SOURCE_STATUS_TONE[sourceStatus(source.validity)]}>{SOURCE_STATUS_LABEL[sourceStatus(source.validity)]}</Badge></span>
                  </td>
                  <td className="grid__dim" title={source.last_observed_at ?? undefined}>{agoText(observedAgeMs(state, source))}</td>
                  <td className="grid__dim">{source.last_source_sequence ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="활성 경보" note="화재·연기 모두 원인별로 확인한 뒤 해제합니다">
          <AlarmPanel key={`${state.run_id}/${state.building_id}/${state.building_version}`} state={state} building={space.building} display={display} connected={!stale} />
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
        title="유도등 반영 확인"
        note="반영 확인은 유도등 화면이 안내를 표시하고 스스로 응답한 것만 셉니다. 서버가 방향을 계산한 것과는 다릅니다"
        folding
      >
        <table className="grid">
          <thead>
            <tr>
              <th>유도등</th>
              <th>현재 안내</th>
              <th>반영 상태</th>
              <th>명령</th>
              <th>유도등 화면</th>
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
                    <span title={sign.application_status}><Badge tone={APPLICATION_TONE[sign.application_status]}>
                      {APPLICATION_LABEL[sign.application_status]}
                    </Badge></span>
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
                      유도등 화면 열기
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

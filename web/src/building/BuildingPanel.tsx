/**
 * 관제의 3D 패널. 공간 자료는 서버에서, 형상 자료는 정적 파일에서 따로 받아
 * 건물 ID·자료 버전이 같을 때만 함께 쓴다(05번 2.3절).
 * 버전이 다르면 3D를 그리지 않고, 경로·유도등 안내는 서버 결과로 계속 표시한다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Building, BuildingDisplay, Position, SimulationState, StateSnapshot } from "@contracts";

import { BuildingScene } from "./BuildingScene";
import { matchesBuilding } from "./geometry";
import type { JourneyTrack } from "./journey";
import type { PeopleCount } from "./people";
import { advanceTrack, describeJourney, trackContext } from "./journey";
import { JourneyPanel, StartPicker } from "./JourneyPanel";
import { useBuildingGeometry } from "./useBuildingGeometry";
import type { ViewMode } from "./view";
import { SPREAD_MAX, SPREAD_MIN } from "./view";

type SceneView = {
  mode: ViewMode;
  nonce: number;
  focus: { position: Position; floorId: string } | null;
};

type Props = {
  readonly state: StateSnapshot;
  readonly building: Building | null;
  readonly display: BuildingDisplay | null;
  readonly buildingError: string | null;
  /** 실행이 일치하는 시나리오 정답만 넘어온다. 없으면 연기를 그리지 않는다. */
  readonly simulation: SimulationState | null;
  /** 관제에서 고른 카메라. 3D에서 설치 위치를 강조한다(이슈 #74). */
  readonly highlightSourceId: string | null;
  /**
   * 그 카메라를 찾아 달라는 요청. 값이 바뀔 때마다 숨긴 층을 열고 설치 위치를 비춘다.
   * 고르기만 해서는 시점을 움직이지 않는다. 보던 화면이 멋대로 돌아가면 더 헷갈린다.
   */
  readonly locateRequest: number;
  /** 제어 상태 조회가 끊기거나 늦은지. 그동안 선택 경로를 현재 안내로 보여 주지 않는다(M06). */
  readonly stale?: boolean;
  /** 시연 조작을 3D 바로 아래에 그린다. 출발점 고르기와 골랐는지 여부를 넘겨받아 한 패널로 묶는다. */
  readonly demo?: (startPicker: ReactNode, hasStart: boolean) => ReactNode;
};

const MISMATCH_LABEL = {
  BUILDING_ID: "형상 자료와 공간 자료의 건물이 다릅니다",
  BUILDING_VERSION: "형상 자료와 공간 자료의 자료 버전이 다릅니다",
  MISSING_FLOOR: "형상 자료에 없는 층이 공간 자료에 있습니다",
} as const;

export function BuildingPanel({ state, simulation, building, display, buildingError, highlightSourceId, locateRequest, stale = false, demo }: Props) {
  const { geometry, error: geometryError, loading } = useBuildingGeometry();
  const [showNames, setShowNames] = useState(true);
  // 전체 안내(초록 화살표·선). 현재 위치를 고르면 그 경로만 보이게 끄고, 버튼으로 다시 켤 수 있다.
  const [showGuidance, setShowGuidance] = useState(true);
  // 시연용 대피 인원. 방 입구마다 한 명이 서 있다가 화재 대응이 되면 서버 경로를 따라 걷는다.
  const [showPeople, setShowPeople] = useState(true);
  const [people, setPeople] = useState<PeopleCount | null>(null);
  // 1인칭으로 따라갈 사람. 3D에서 사람을 누르면 들어가고, 그 사람이 빠져나가면 저절로 나온다.
  const [follow, setFollow] = useState<number | null>(null);
  const firstPerson = follow !== null && showPeople;
  const [hiddenFloors, setHiddenFloors] = useState<ReadonlySet<string>>(new Set());
  // 층 간격은 처음부터 조금 벌려 위층 바닥이 아래층 복도를 덮지 않게 한다.
  const [spread, setSpread] = useState(6);
  const [view, setView] = useState<SceneView>({ mode: "ANGLE", nonce: 0, focus: null });
  const requestView = (mode: ViewMode) =>
    setView((previous) => ({ mode, nonce: previous.nonce + 1, focus: null }));

  // "3D에서 찾기"를 누르면 그 층을 열고 설치 위치를 비춘다.
  // 요청 번호를 기억해 두어, 표시 자료가 늦게 와도 같은 요청으로 두 번 움직이지 않는다.
  const handledLocate = useRef(0);
  useEffect(() => {
    if (locateRequest === 0 || locateRequest === handledLocate.current) return;
    const installation = highlightSourceId === null
      ? null
      : display?.sources[highlightSourceId]?.installation ?? null;
    if (installation === null) return;
    handledLocate.current = locateRequest;
    setHiddenFloors((previous) => {
      if (!previous.has(installation.floor_id)) return previous;
      const next = new Set(previous);
      next.delete(installation.floor_id);
      return next;
    });
    setView((previous) => ({
      mode: previous.mode,
      nonce: previous.nonce + 1,
      focus: { position: installation.position, floorId: installation.floor_id },
    }));
  }, [locateRequest, highlightSourceId, display]);

  // M06 출발점. 실행·건물이 바뀌면 이전 선택을 쓰지 않는다(같은 node_id라도 다른 실행의 위치다).
  const runKey = `${state.run_id}/${state.building_id}/${state.building_version}`;
  const [start, setStart] = useState<{ runKey: string; nodeId: string } | null>(null);
  const [selectedSign, setSelectedSign] = useState<string | null>(null);
  const startId = start !== null && start.runKey === runKey ? start.nodeId : null;
  const chooseStart = (nodeId: string | null) => {
    setStart(nodeId === null ? null : { runKey, nodeId });
    setShowGuidance(nodeId === null);
    setSelectedSign(null);
  };

  const journey = useMemo(
    () => (building === null || startId === null ? null : describeJourney(building, display, state, startId)),
    [building, display, state, startId],
  );

  // 같은 실행·건물·출발점에서 경로가 바뀌면 직전 경로를 비교용으로 남긴다.
  const [track, setTrack] = useState<JourneyTrack | null>(null);
  useEffect(() => {
    setTrack((previous) => (journey === null ? null : advanceTrack(previous, state, journey)));
  }, [journey, state]);
  const currentTrack = track !== null && startId !== null && track.context === trackContext(state, startId) ? track : null;

  const signNodeId = useMemo(
    () => building?.signs.find((sign) => sign.sign_id === selectedSign)?.node_id ?? null,
    [building, selectedSign],
  );
  const sceneJourney = useMemo(() => {
    if (startId === null) return null;
    // 조회가 늦으면 현재 경로를 그리지 않는다. 출발점 표시만 남긴다.
    const path = !stale && journey?.kind === "ROUTE" ? journey.path : [];
    return { startId, path, previousPath: stale ? null : currentTrack?.previous?.path ?? null, signNodeId: stale ? null : signNodeId };
  }, [startId, journey, stale, currentTrack, signNodeId]);

  const smokeByZone = useMemo(() => {
    if (simulation === null) return null;
    return new Map(simulation.zones.map((zone) => [zone.zone_id, zone.smoke]));
  }, [simulation]);

  const match = useMemo(
    () => (geometry === null || building === null ? null : matchesBuilding(geometry, building)),
    [geometry, building],
  );

  const allFloors = useMemo(() => new Set(geometry?.floors.map((floor) => floor.floor_id) ?? []), [geometry]);
  const visibleFloors = useMemo(() => {
    const all = geometry?.floors.map((floor) => floor.floor_id) ?? [];
    return new Set(all.filter((id) => !hiddenFloors.has(id)));
  }, [geometry, hiddenFloors]);

  const toggleFloor = (floorId: string) => {
    setHiddenFloors((previous) => {
      const next = new Set(previous);
      if (next.has(floorId)) next.delete(floorId);
      else next.add(floorId);
      return next;
    });
  };

  /** 한 층만 보기. 다른 층은 모두 숨긴다. */
  const onlyFloor = (floorId: string) => {
    setHiddenFloors(new Set((geometry?.floors ?? []).map((floor) => floor.floor_id).filter((id) => id !== floorId)));
  };

  const floorLabel = useMemo(
    () => new Map((building?.floors ?? []).map((floor) => [floor.floor_id, display?.floor_labels[floor.floor_id] ?? floor.label])),
    [building, display],
  );

  const problem =
    geometryError ??
    buildingError ??
    (loading ? "형상 자료를 읽는 중입니다." : building === null ? "공간 자료를 읽는 중입니다." : null) ??
    (match !== null && !match.matched ? `${MISMATCH_LABEL[match.reason]} (${match.detail})` : null);

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>건물 3D</h2>
        <span className="panel__note">
          형상은 표시 전용입니다. 경로와 방향은 서버 결과를 그대로 그립니다
        </span>
      </header>

      {problem !== null || geometry === null || building === null || match === null || !match.matched ? (
        <p className="panel__empty">
          {problem ?? "3D를 표시할 수 없습니다."}
          <br />
          경로·방향·적용 현황은 아래 제어 결과로 계속 표시됩니다.
        </p>
      ) : (
        <>
          <div className="scene__bar">
            <span className="scene__floors" title="누르면 층을 켜고 끕니다. 두 번 누르면 그 층만 봅니다">
              {geometry.floors.map((floor) => (
                <button
                  key={floor.floor_id}
                  type="button"
                  className={visibleFloors.has(floor.floor_id) ? "chip chip--on" : "chip"}
                  onClick={() => toggleFloor(floor.floor_id)}
                  onDoubleClick={() => onlyFloor(floor.floor_id)}
                >
                  {floorLabel.get(floor.floor_id) ?? floor.floor_id}
                </button>
              ))}
              <button
                type="button"
                className={hiddenFloors.size === 0 ? "chip chip--on" : "chip"}
                onClick={() => setHiddenFloors(new Set())}
              >
                전체
              </button>
            </span>
            <span className="scene__tools">
              <button type="button" className={showNames ? "chip chip--on" : "chip"} aria-pressed={showNames} onClick={() => setShowNames((previous) => !previous)}>공간 이름</button>
              <button type="button" className={showGuidance ? "chip chip--on" : "chip"} aria-pressed={showGuidance} onClick={() => setShowGuidance((previous) => !previous)}>전체 안내</button>
              {showPeople && people !== null && people.total > 0 && (
                // 작은 사람을 정확히 누르기 어려우므로 버튼으로도 들어간다. 누를 때마다 다음 사람으로 넘어간다.
                <button type="button" className="chip" onClick={() => setFollow((previous) => ((previous ?? -1) + 1) % people.total)}>
                  {firstPerson ? "다음 사람" : "1인칭 보기"}
                </button>
              )}
              {firstPerson && (
                <button type="button" className="chip chip--on" onClick={() => { setFollow(null); requestView(view.mode); }}>1인칭 나가기</button>
              )}
              <button type="button" className={showPeople ? "chip chip--on" : "chip"} aria-pressed={showPeople} onClick={() => setShowPeople((previous) => !previous)}>대피 인원</button>
              <label className="scene__spread">
                층 간격
                <input
                  type="range"
                  min={SPREAD_MIN}
                  max={SPREAD_MAX}
                  step={1}
                  value={spread}
                  onChange={(event) => setSpread(Number(event.target.value))}
                  aria-label="층 간격"
                />
              </label>
              <button
                type="button"
                className={view.mode === "ANGLE" ? "chip chip--on" : "chip"}
                onClick={() => requestView("ANGLE")}
              >
                시점 초기화
              </button>
              <button
                type="button"
                className={view.mode === "TOP" ? "chip chip--on" : "chip"}
                onClick={() => requestView("TOP")}
              >
                위에서 보기
              </button>
            </span>
            <span className="scene__legend">
              <span className="key key--guided" /> 안내 경로
              <span className="key key--fire" /> 관측 위험(바닥 판)
              <span className="key key--smoke" /> 연기
              <span className="key key--muted" /> 안내 불가
              <span className="key key--sign-exit" /> 출구 유도등
              <span className="key key--sign-dir" /> 방향 유도등(방향은 바닥 화살표)
              <span className="key key--camera" /> CCTV
              {showPeople && people !== null && (
                <>
                  <span className="key key--person" /> 사람 {people.total}명 (이동 {people.moving} · 탈출 {people.out})
                  <span className="key key--person-stuck" /> 멈춤 {people.stuck}
                  <small> · 사람을 누르면 1인칭</small>
                </>
              )}
              {startId !== null && (
                <>
                  <span className="key key--journey" /> 선택 위치 경로
                  <span className="key key--journey-prev" /> 직전 경로(비교용, 회색)
                </>
              )}
            </span>
          </div>

          <BuildingScene
            geometry={geometry}
            building={building}
            display={display}
            showNames={showNames}
            showGuidance={showGuidance}
            showPeople={showPeople}
            stale={stale}
            onPeople={setPeople}
            followIndex={firstPerson ? follow : null}
            onFollow={(index) => {
              setFollow(index);
              // 나올 때는 보던 시점 모드로 화면을 다시 맞춘다.
              if (index === null) requestView(view.mode);
            }}
            state={state}
            smokeByZone={smokeByZone}
            visibleFloors={firstPerson ? allFloors : visibleFloors}
            spread={firstPerson ? 0 : spread}
            view={view}
            highlightSourceId={highlightSourceId}
            journey={sceneJourney}
            onPickNode={chooseStart}
          />

          {demo?.(<StartPicker building={building} display={display} startId={startId} onStart={chooseStart} />, startId !== null)}

          <JourneyPanel
            picker={demo === undefined}
            building={building}
            display={display}
            startId={startId}
            onStart={chooseStart}
            journey={journey}
            track={currentTrack}
            stale={stale}
            selectedSignId={selectedSign}
            onSelectSign={setSelectedSign}
          />

          <p className="panel__note">
            공간 {building.building_id} v{building.building_version} · 형상 {geometry.building_id} v
            {geometry.building_version} · 계단 A·B 밀폐, C·D 열림(평상시 안내에 쓰지 않음) · 층 간격은 보기용이며
            실제 층 높이와 경로는 바뀌지 않음
            {display !== null && " · CAM은 가상 설치 위치, 관측 구역과 별도 · 한 층만 보면 방 입구 이름도 표시 · 겹친 이름은 확대하면 확인 가능"}
            {smokeByZone === null && " · 연기 정보 없음"}
          </p>
        </>
      )}
    </section>
  );
}

// 지연 로딩(React.lazy)으로 불러오므로 기본 내보내기를 둔다.
// 유도등 단말에는 3D가 필요 없어 three.js가 단말 화면 묶음에 들어가지 않는다.
export default BuildingPanel;

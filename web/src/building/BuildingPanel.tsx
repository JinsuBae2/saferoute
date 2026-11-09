/**
 * 관제의 3D 패널. 공간 자료는 서버에서, 형상 자료는 정적 파일에서 따로 받아
 * 건물 ID·자료 버전이 같을 때만 함께 쓴다(05번 2.3절).
 * 버전이 다르면 3D를 그리지 않고, 경로·유도등 안내는 서버 결과로 계속 표시한다.
 */
import { useEffect, useMemo, useState } from "react";

import type { Building, SimulationState, StateSnapshot } from "@contracts";

import { fetchBuilding } from "../api/client";
import { BuildingScene } from "./BuildingScene";
import { matchesBuilding } from "./geometry";
import { useBuildingGeometry } from "./useBuildingGeometry";

type Props = {
  readonly state: StateSnapshot;
  /** 실행이 일치하는 시나리오 정답만 넘어온다. 없으면 연기를 그리지 않는다. */
  readonly simulation: SimulationState | null;
};

const MISMATCH_LABEL = {
  BUILDING_ID: "형상 자료와 공간 자료의 건물이 다릅니다",
  BUILDING_VERSION: "형상 자료와 공간 자료의 자료 버전이 다릅니다",
  MISSING_FLOOR: "형상 자료에 없는 층이 공간 자료에 있습니다",
} as const;

export function BuildingPanel({ state, simulation }: Props) {
  const { geometry, error: geometryError, loading } = useBuildingGeometry();
  const [building, setBuilding] = useState<Building | null>(null);
  const [buildingError, setBuildingError] = useState<string | null>(null);
  const [hiddenFloors, setHiddenFloors] = useState<ReadonlySet<string>>(new Set());

  // 공간 자료는 실행이나 건물 자료 버전이 바뀔 때만 다시 읽는다.
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        setBuilding(await fetchBuilding(abort.signal));
        setBuildingError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setBuildingError(error instanceof Error ? error.message : "공간 자료를 읽지 못했습니다");
      }
    })();
    return () => abort.abort();
  }, [state.run_id, state.building_id, state.building_version]);

  const smokeByZone = useMemo(() => {
    if (simulation === null) return null;
    return new Map(simulation.zones.map((zone) => [zone.zone_id, zone.smoke]));
  }, [simulation]);

  const match = useMemo(
    () => (geometry === null || building === null ? null : matchesBuilding(geometry, building)),
    [geometry, building],
  );

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

  const problem =
    geometryError ??
    buildingError ??
    (loading ? "형상 자료를 읽는 중입니다." : null) ??
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
            <span className="scene__floors">
              {geometry.floors.map((floor) => (
                <button
                  key={floor.floor_id}
                  type="button"
                  className={visibleFloors.has(floor.floor_id) ? "chip chip--on" : "chip"}
                  onClick={() => toggleFloor(floor.floor_id)}
                >
                  {floor.floor_id}
                </button>
              ))}
            </span>
            <span className="scene__legend">
              <span className="key key--guided" /> 안내 경로
              <span className="key key--fire" /> 관측 위험(바닥 판)
              <span className="key key--smoke" /> 시험 연기 정답(차오름)
              <span className="key key--muted" /> 안내 불가
            </span>
          </div>

          <BuildingScene
            geometry={geometry}
            building={building}
            state={state}
            smokeByZone={smokeByZone}
            visibleFloors={visibleFloors}
          />

          <p className="panel__note">
            공간 {building.building_id} v{building.building_version} · 형상 {geometry.building_id} v
            {geometry.building_version} · 계단 A·B 밀폐, C·D 열림(평상시 안내에 쓰지 않음)
            {smokeByZone === null && " · 연기 정답 없음"}
          </p>
        </>
      )}
    </section>
  );
}

// 지연 로딩(React.lazy)으로 불러오므로 기본 내보내기를 둔다.
// 유도등 단말에는 3D가 필요 없어 three.js가 단말 화면 묶음에 들어가지 않는다.
export default BuildingPanel;

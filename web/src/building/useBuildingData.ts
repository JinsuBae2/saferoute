import { useEffect, useState } from "react";
import type { Building, BuildingDisplay } from "@contracts";
import displayUrl from "@space/wfi-display-v1.json?url";
import { fetchBuilding } from "../api/client";
import { parseDisplay } from "./display";

type Load = {
  key: string | null;
  building: Building | null;
  display: BuildingDisplay | null;
  buildingError: string | null;
  displayError: string | null;
};
const EMPTY: Load = { key: null, building: null, display: null, buildingError: null, displayError: null };

/**
 * 실행과 건물 자료 버전만 있으면 된다. 관제는 StateSnapshot, 단말은 Session을 넘긴다.
 * 둘 다 같은 식별 필드를 가지므로 더 좁은 형식으로 받는다.
 */
export type RunIdentity = {
  readonly run_id: string;
  readonly building_id: string;
  readonly building_version: number;
};

export function useBuildingData(state: RunIdentity | null): Load {
  const buildingId = state?.building_id;
  const version = state?.building_version;
  const key = state === null ? null : `${state.run_id}/${buildingId}/${version}`;
  const [load, setLoad] = useState<Load>(EMPTY);
  useEffect(() => {
    if (key === null) return;
    const abort = new AbortController();
    void (async () => {
      let building: Building;
      try {
        building = await fetchBuilding(abort.signal);
        if (abort.signal.aborted) return;
        if (building.building_id !== buildingId || building.building_version !== version) throw new Error("공간 자료와 현재 제어 상태의 건물·버전이 다릅니다");
        setLoad({ ...EMPTY, key, building });
      } catch (error) {
        if (!abort.signal.aborted) setLoad({ ...EMPTY, key, buildingError: error instanceof Error ? error.message : "공간 자료를 읽지 못했습니다" });
        return;
      }
      try {
        const response = await fetch(displayUrl, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error(`표시 자료를 읽지 못했습니다 (HTTP ${response.status})`);
        const display = parseDisplay(await response.json(), building);
        if (!abort.signal.aborted) setLoad({ ...EMPTY, key, building, display });
      } catch (error) {
        if (!abort.signal.aborted) setLoad({ ...EMPTY, key, building, displayError: error instanceof Error ? error.message : "표시 자료를 읽지 못했습니다" });
      }
    })();
    return () => abort.abort();
  }, [key, buildingId, version]);
  // Do not expose the previous run's data while the next effect is loading.
  return load.key === key ? load : EMPTY;
}

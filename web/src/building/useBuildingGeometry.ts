/**
 * 3D 형상 자료를 정적 파일로 받는다. 서버의 Building 계약과 합치지 않는다(05번 2.3절).
 * 빌드 산출물에 포함되므로 별도 Nginx 경로 설정이 필요 없다.
 */
import { useEffect, useState } from "react";

// ?url: JSON을 묶지 않고 정적 자산으로 내보낸 뒤 주소만 받는다.
import geometryUrl from "@space/wfi-geometry-v1.json?url";

import type { BuildingGeometry } from "./geometry";
import { parseGeometry } from "./geometry";

export type GeometryLoad = {
  readonly geometry: BuildingGeometry | null;
  readonly error: string | null;
  readonly loading: boolean;
};

export function useBuildingGeometry(): GeometryLoad {
  const [load, setLoad] = useState<GeometryLoad>({ geometry: null, error: null, loading: true });

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(geometryUrl, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error(`형상 파일을 받지 못했습니다 (HTTP ${response.status})`);
        const parsed = parseGeometry(await response.json());
        setLoad({ geometry: parsed, error: null, loading: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoad({
          geometry: null,
          error: error instanceof Error ? error.message : "형상 자료를 읽지 못했습니다",
          loading: false,
        });
      }
    })();
    return () => abort.abort();
  }, []);

  return load;
}

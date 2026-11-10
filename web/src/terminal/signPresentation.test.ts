/**
 * 표지 종류별 표시 판정 시험 (이슈 #70, P05).
 * 출구 위치 표지와 가변 방향 안내가 정상·화재·안내 불가에서 각각 구분되는지 본다.
 */
import { describe, expect, it } from "vitest";

import type { FaceResult } from "@contracts";

import { presentFace, signKindOf } from "./signPresentation";

function face(patch: Partial<FaceResult> = {}): FaceResult {
  return {
    face_id: "FRONT",
    mode: "DYNAMIC",
    display: "RIGHT",
    next_node_id: "B",
    exit_id: "EXIT-Y",
    reason_codes: [],
    ...patch,
  };
}

const UNAVAILABLE = face({
  mode: "NO_ROUTE",
  display: null,
  next_node_id: null,
  exit_id: null,
  reason_codes: ["NO_REACHABLE_EXIT"],
});

const AT_EXIT = face({ mode: "DEFAULT", display: "EXIT", next_node_id: null, exit_id: "EXIT-N" });

describe("출구 위치 표지", () => {
  it("출구 표시를 받으면 위치 표지로 보여준다", () => {
    const shown = presentFace("EXIT_LOCATION", AT_EXIT);
    expect(shown.role).toBe("EXIT_LOCATION");
    expect(shown.available).toBe(true);
    // 위치 표지는 방향을 그리지 않는다.
    expect(shown.display).toBeNull();
    expect(shown.mismatch).toBeNull();
  });

  it("평상시와 화재 상태 모두에서 같은 역할로 보여준다", () => {
    const normal = presentFace("EXIT_LOCATION", face({ ...AT_EXIT, mode: "DEFAULT" }));
    const emergency = presentFace("EXIT_LOCATION", face({ ...AT_EXIT, mode: "DYNAMIC" }));
    expect(normal.role).toBe("EXIT_LOCATION");
    expect(emergency.role).toBe("EXIT_LOCATION");
    expect(normal.available).toBe(true);
    expect(emergency.available).toBe(true);
  });

  it("안내 불가면 사유를 남기고 표시하지 않는다", () => {
    const shown = presentFace("EXIT_LOCATION", UNAVAILABLE);
    expect(shown.role).toBe("EXIT_LOCATION");
    expect(shown.available).toBe(false);
    expect(shown.reasonCodes).toEqual(["NO_REACHABLE_EXIT"]);
    expect(shown.mismatch).toBeNull();
  });

  it("방향 명령을 받으면 불일치로 드러낸다", () => {
    const shown = presentFace("EXIT_LOCATION", face({ display: "LEFT" }));
    expect(shown.available).toBe(false);
    expect(shown.mismatch).not.toBeNull();
  });
});

describe("가변 방향 안내", () => {
  it("서버가 준 방향을 그대로 보여준다", () => {
    const shown = presentFace("DIRECTIONAL", face({ display: "LEFT" }));
    expect(shown.role).toBe("DIRECTION");
    expect(shown.available).toBe(true);
    expect(shown.display).toBe("LEFT");
  });

  it("화재로 방향이 바뀌어도 역할은 그대로다", () => {
    const before = presentFace("DIRECTIONAL", face({ mode: "DEFAULT", display: "FORWARD" }));
    const after = presentFace("DIRECTIONAL", face({ mode: "DYNAMIC", display: "RIGHT" }));
    expect(before.role).toBe("DIRECTION");
    expect(after.role).toBe("DIRECTION");
    expect(before.display).not.toBe(after.display);
  });

  it("안내 불가면 방향을 지우고 사유를 남긴다", () => {
    const shown = presentFace("DIRECTIONAL", UNAVAILABLE);
    expect(shown.available).toBe(false);
    expect(shown.display).toBeNull();
    expect(shown.reasonCodes).toEqual(["NO_REACHABLE_EXIT"]);
  });

  it("출구 위치 표시를 받으면 불일치로 드러낸다", () => {
    const shown = presentFace("DIRECTIONAL", AT_EXIT);
    expect(shown.available).toBe(false);
    expect(shown.mismatch).not.toBeNull();
  });
});

describe("표시 자료가 없을 때", () => {
  it("방향 안내로 보고 화살표를 숨기지 않는다", () => {
    const shown = presentFace(null, face({ display: "LEFT" }));
    expect(shown.role).toBe("DIRECTION");
    expect(shown.available).toBe(true);
    expect(shown.display).toBe("LEFT");
  });

  it("종류를 찾지 못하면 null을 돌려준다", () => {
    expect(signKindOf(null, "SIGN-F1-X-N")).toBeNull();
  });
});

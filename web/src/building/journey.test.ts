/**
 * 출발점 안내 정리 시험. 실제 WFI 공간·표시 자료에 서버 경로 형태의 상태를 넣어 확인한다.
 * 경로는 이전 실행(1층 북쪽 통로 경보)에서 서버가 낸 값을 그대로 옮겼다.
 */
import { describe, expect, it } from "vitest";

import type { Building, BuildingDisplay, Route, SignState, StateSnapshot } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawDisplay from "@space/wfi-display-v1.json";

import { parseDisplay } from "./display";
import { advanceTrack, describeJourney } from "./journey";

const BUILDING = rawBuilding as unknown as Building;
const DISPLAY: BuildingDisplay = parseDisplay(rawDisplay, BUILDING);

const FROM_3F = ["F3-J-W2", "F3-J-W1", "F3-S-A", "F2-S-A", "F1-S-A", "F1-J-LA", "F1-J-LE", "F1-J-LC", "F1-J-LM", "F1-J-LS", "F1-J-PS", "F1-X-S"];

function route(nodeId: string, path: string[], exitId: string | null, reasons: Route["reason_codes"] = []): Route {
  return { node_id: nodeId, next_node_id: path[1] ?? null, exit_id: exitId, path_node_ids: path, cost: path.length > 0 ? 10 : null, reason_codes: reasons };
}

function sign(signId: string, status: SignState["application_status"], version: number | null): SignState {
  return {
    sign_id: signId,
    faces: [{ face_id: "FRONT", mode: "DYNAMIC", display: "LEFT", next_node_id: null, exit_id: null, reason_codes: [] }],
    latest_command: version === null ? null : ({ guidance_version: version } as SignState["latest_command"]),
    application_status: status,
    terminals: [],
  };
}

function snapshot(routes: Route[], signs: SignState[] = [], guidance = 14, runId = "run-1"): StateSnapshot {
  return {
    run_id: runId,
    building_id: BUILDING.building_id,
    building_version: BUILDING.building_version,
    guidance_version: guidance,
    routes,
    signs,
  } as unknown as StateSnapshot;
}

describe("출발점 안내 정리", () => {
  it("서버 경로를 층별 이동·계단·출구 순서로 나눈다", () => {
    const journey = describeJourney(BUILDING, DISPLAY, snapshot([route("F3-J-W2", FROM_3F, "EXIT-S")]), "F3-J-W2");
    expect(journey.kind).toBe("ROUTE");
    if (journey.kind !== "ROUTE") return;
    expect(journey.path).toEqual(FROM_3F);
    expect(journey.steps.map((step) => step.kind)).toEqual(["WALK", "STAIRS", "STAIRS", "WALK", "EXIT"]);
    const [walk3, down32, down21, walk1, exit] = journey.steps;
    expect(walk3).toMatchObject({ kind: "WALK", floorLabel: DISPLAY.floor_labels.F3, stops: 2 });
    expect(down32).toMatchObject({ kind: "STAIRS", stair: DISPLAY.node_labels["F3-S-A"], down: true });
    expect(down21).toMatchObject({ kind: "STAIRS", stair: DISPLAY.node_labels["F2-S-A"], down: true });
    expect(walk1).toMatchObject({ kind: "WALK", floorLabel: DISPLAY.floor_labels.F1, to: DISPLAY.node_labels["F1-X-S"] });
    expect(exit).toEqual({ kind: "EXIT", label: DISPLAY.exit_labels["EXIT-S"] });
  });

  it("경로를 새로 계산하지 않고 서버가 준 지점만 쓴다", () => {
    const odd = ["F3-J-W2", "F3-J-W1", "F3-S-A", "F2-S-A", "F1-S-A", "F1-J-LA", "F1-J-LNW", "F1-J-PN", "F1-X-N"];
    const journey = describeJourney(BUILDING, DISPLAY, snapshot([route("F3-J-W2", odd, "EXIT-N")]), "F3-J-W2");
    expect(journey.kind === "ROUTE" && journey.path).toEqual(odd);
  });

  it("경로 위 유도등의 표시면과 실제 적용 상태를 붙이고, 이전 버전 명령은 현재가 아니라고 표시한다", () => {
    const state = snapshot(
      [route("F3-J-W2", FROM_3F, "EXIT-S")],
      [sign("SIGN-F3-J-W2", "APPLIED", 14), sign("SIGN-F2-S-A", "PENDING", 13)],
    );
    const journey = describeJourney(BUILDING, DISPLAY, state, "F3-J-W2");
    if (journey.kind !== "ROUTE") throw new Error("경로가 있어야 한다");
    const ids = journey.signs.map((item) => item.signId);
    expect(ids[0]).toBe("SIGN-F3-J-W2");
    expect(ids).toContain("SIGN-F1-X-S");
    expect(ids.every((id) => FROM_3F.includes(id.replace("SIGN-", "")))).toBe(true);
    const first = journey.signs[0];
    expect(first).toMatchObject({ status: "APPLIED", commandVersion: 14, current: true, label: DISPLAY.signs["SIGN-F3-J-W2"].label });
    expect(first.faces).toEqual([{ faceId: "FRONT", mode: "DYNAMIC", display: "LEFT" }]);
    expect(journey.signs.find((item) => item.signId === "SIGN-F2-S-A")).toMatchObject({ status: "PENDING", current: false });
    expect(journey.signs.find((item) => item.signId === "SIGN-F1-X-S")).toMatchObject({ exitLocation: true, status: null });
  });

  it("안내 불가는 이유를 그대로 돌려주고 경로를 만들지 않는다", () => {
    const journey = describeJourney(BUILDING, DISPLAY, snapshot([route("F2-D-INDUSTRY", [], null, ["NO_REACHABLE_EXIT"])]), "F2-D-INDUSTRY");
    expect(journey).toEqual({ kind: "NO_ROUTE", startId: "F2-D-INDUSTRY", reasons: ["NO_REACHABLE_EXIT"] });
  });

  it("출구에서 출발하면 [출구] 하나짜리 정상 경로다", () => {
    const journey = describeJourney(BUILDING, DISPLAY, snapshot([route("F1-X-N", ["F1-X-N"], "EXIT-N")]), "F1-X-N");
    expect(journey.kind === "ROUTE" && journey.atExit).toBe(true);
    expect(journey.kind === "ROUTE" && journey.steps).toEqual([{ kind: "EXIT", label: DISPLAY.exit_labels["EXIT-N"] }]);
  });

  it("모르는 지점이나 서버 경로가 없는 지점은 출발점으로 쓰지 않는다", () => {
    expect(describeJourney(BUILDING, DISPLAY, snapshot([]), "F9-J-X").kind).toBe("UNKNOWN_START");
    expect(describeJourney(BUILDING, DISPLAY, snapshot([]), "F3-J-W2").kind).toBe("UNKNOWN_START");
  });

  it("표시 자료가 없으면 ID로 보여 준다", () => {
    const journey = describeJourney(BUILDING, null, snapshot([route("F3-J-W2", FROM_3F, "EXIT-S")]), "F3-J-W2");
    expect(journey.kind === "ROUTE" && journey.exitLabel).toBe("EXIT-S");
  });
});

describe("변경 전후 비교", () => {
  const before = describeJourney(BUILDING, DISPLAY, snapshot([route("F3-J-W2", FROM_3F, "EXIT-S")]), "F3-J-W2");
  const afterPath = ["F3-J-W2", "F3-J-W1", "F3-S-A", "F2-S-A", "F1-S-A", "F1-J-LA", "F1-J-LE", "F1-J-LNW", "F1-J-PN", "F1-X-N"];
  const after = describeJourney(BUILDING, DISPLAY, snapshot([route("F3-J-W2", afterPath, "EXIT-N")], [], 15), "F3-J-W2");

  it("경로가 그대로면 이전 경로를 만들지 않는다", () => {
    const first = advanceTrack(null, snapshot([], [], 14), before);
    const same = advanceTrack(first, snapshot([], [], 15), before);
    expect(same.previous).toBeNull();
    expect(same.guidanceVersion).toBe(15);
  });

  it("같은 출발점에서 경로가 바뀌면 직전 경로와 그 안내 버전을 비교용으로 남긴다", () => {
    const first = advanceTrack(null, snapshot([], [], 14), before);
    const changed = advanceTrack(first, snapshot([], [], 15), after);
    expect(changed.path).toEqual(afterPath);
    expect(changed.previous).toEqual({ guidanceVersion: 14, path: FROM_3F, exitId: "EXIT-S" });
  });

  it("안내 불가로 바뀌어도 직전 경로를 비교용으로 남기고 현재 경로는 비운다", () => {
    const first = advanceTrack(null, snapshot([], [], 14), before);
    const blocked = describeJourney(BUILDING, DISPLAY, snapshot([route("F3-J-W2", [], null, ["ORIGIN_BLOCKED"])], [], 15), "F3-J-W2");
    const next = advanceTrack(first, snapshot([], [], 15), blocked);
    expect(next.path).toEqual([]);
    expect(next.previous?.path).toEqual(FROM_3F);
  });

  it("실행이 바뀌면 이전 실행의 경로를 비교에 섞지 않는다", () => {
    const first = advanceTrack(null, snapshot([], [], 14, "run-1"), before);
    const reset = advanceTrack(first, snapshot([], [], 1, "run-2"), after);
    expect(reset.previous).toBeNull();
  });

  it("출발점이 바뀌면 이전 출발점의 경로를 비교에 섞지 않는다", () => {
    const first = advanceTrack(null, snapshot([], [], 14), before);
    const other = describeJourney(BUILDING, DISPLAY, snapshot([route("F1-J-LM", ["F1-J-LM", "F1-J-LS", "F1-J-PS", "F1-X-S"], "EXIT-S")], [], 15), "F1-J-LM");
    expect(advanceTrack(first, snapshot([], [], 15), other).previous).toBeNull();
  });
});

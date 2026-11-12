/** 방송 문장·사이렌·출구 호출 판단이 서버 상태만 따르는지 확인한다. */
import { describe, expect, it } from "vitest";

import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { emergency_state as emergencySample } from "@samples";
import rawBuilding from "@space/wfi-v1.json";
import rawDisplay from "@space/wfi-display-v1.json";

import { alarmLevel, alarmPlace, announce, BROADCAST_TEXT, broadcastKey, exitCall, exitSound, LOCATED_TEXT } from "./broadcast";

const BASE: StateSnapshot = emergencySample;
const cause = (source: string, hazard: "FIRE" | "SMOKE") => ({ ...BASE.active_causes[0], source_id: source, hazard_type: hazard });
const withCauses = (...causes: ReturnType<typeof cause>[]): StateSnapshot => ({ ...BASE, active_causes: causes });

describe("재난 방송", () => {
  it("화재가 있으면 화재 문장, 연기만 있으면 연기 문장을 되풀이한다", () => {
    expect(alarmLevel(withCauses(cause("A", "SMOKE"), cause("B", "FIRE")))).toBe("FIRE");
    expect(announce(null, withCauses(cause("B", "FIRE")), false).announcement).toMatchObject({ siren: true, loop: BROADCAST_TEXT.FIRE, once: null });
    expect(announce(null, withCauses(cause("A", "SMOKE")), false).announcement).toMatchObject({ siren: true, loop: BROADCAST_TEXT.SMOKE, once: null });
  });

  it("상태가 그대로면 화면이 다시 그려져도 한 번짜리 문장을 다시 내지 않는다", () => {
    const state = withCauses(cause("A", "SMOKE"));
    const first = announce(null, state, false);
    expect(announce(first.memory, state, false).announcement.once).toBeNull();
  });

  it("일부 해제와 전체 해제를 구분한다", () => {
    const two = announce(null, withCauses(cause("A", "SMOKE"), cause("B", "FIRE")), false);
    const one = announce(two.memory, withCauses(cause("A", "SMOKE")), false);
    expect(one.announcement).toMatchObject({ siren: true, loop: BROADCAST_TEXT.SMOKE, once: BROADCAST_TEXT.PARTIAL });
    const none = announce(one.memory, withCauses(), false);
    expect(none.announcement).toMatchObject({ siren: false, loop: null, once: BROADCAST_TEXT.ALL_CLEAR });
    // 새 실행의 경보 0건은 '해제'가 아니다.
    expect(announce(one.memory, { ...withCauses(), run_id: "99999999-9999-4999-8999-999999999999" }, false).announcement.once).toBeNull();
  });

  it("방송의 상태 키는 실행과 경보 구성으로만 정해지고, 연결 끊김으로는 바뀌지 않는다", () => {
    const state = withCauses(cause("B", "FIRE"), cause("A", "SMOKE"));
    const key = announce(null, state, false).announcement.key;
    expect(announce(null, state, true).announcement.key).toBe(key);
    expect(announce(null, withCauses(cause("A", "SMOKE"), cause("B", "FIRE")), false).announcement.key).toBe(key);
    expect(announce(null, withCauses(cause("B", "FIRE")), false).announcement.key).not.toBe(key);
    expect(announce(null, { ...state, run_id: "99999999-9999-4999-8999-999999999999" }, false).announcement.key).not.toBe(key);
  });

  it("연결이 끊기면 경보와 사이렌은 유지하고 방향 대신 끊김을 알린다", () => {
    const active = announce(null, withCauses(cause("B", "FIRE")), false);
    const lost = announce(active.memory, withCauses(cause("B", "FIRE")), true);
    expect(lost.announcement).toMatchObject({ siren: true, loop: BROADCAST_TEXT.STALE, once: null });
    expect(lost.memory).toBe(active.memory);
  });
});

describe("자리를 부르는 재난 방송", () => {
  const places = { building: rawBuilding as unknown as Building, display: rawDisplay as unknown as BuildingDisplay };
  /** 도면에서 고른 시험 화재. 구역 F3-R307의 표시 이름이 그대로 방송에 나와야 한다. */
  const R307 = "MANUAL-F3-R307";
  const cell = (zoneId: string, floorId: string, fire: number) => ({
    cell_id: `cell:${zoneId}`, zone_id: zoneId, floor_id: floorId, position: { x: 0, y: 0, z: 0 }, fire, smoke: 0,
  });
  const burning = (zones: readonly (readonly [string, string])[]): StateSnapshot => ({
    ...withCauses(cause(R307, "FIRE")),
    fire_simulation: {
      fires: [{ source_id: R307, zone_id: "F3-R307", position: { x: 0, y: 0, z: 0 }, elapsed_ms: 1000 }],
      cells: [cell("F3-R307", "F3", 0.2), ...zones.map(([zoneId, floorId]) => cell(zoneId, floorId, 0.2))],
    },
  });

  it("도면에서 고른 자리를 불러 준다. 표시 자료가 없으면 예전 문장으로 돌아간다", () => {
    const located = announce(null, burning([]), false, places).announcement;
    expect(located.once).toBe(LOCATED_TEXT.fireOnce("3층 307호"));
    expect(located.loop).toBe(LOCATED_TEXT.fireLoop("3층 307호"));
    expect(located.loop).toContain("QR");
    expect(announce(null, burning([]), false).announcement).toMatchObject({ loop: BROADCAST_TEXT.FIRE, once: null });
    expect(alarmPlace(burning([]), places)).toBe("3층 307호");
  });

  it("같은 자리를 되풀이해 부르지 않는다", () => {
    const first = announce(null, burning([]), false, places);
    expect(announce(first.memory, burning([]), false, places).announcement.once).toBeNull();
  });

  it("불이 다른 구역에 닿으면 번졌다고 한 번 알린다", () => {
    const start = announce(null, burning([]), false, places);
    const spread = announce(start.memory, burning([["F3-CORR-W", "F3"]]), false, places);
    expect(spread.announcement.once).toBe(LOCATED_TEXT.spread("3층 좌측 복도"));
    // 같은 구역으로는 다시 알리지 않고, 새 구역이 생기면 그 구역만 부른다.
    expect(announce(spread.memory, burning([["F3-CORR-W", "F3"]]), false, places).announcement.once).toBeNull();
    const more = announce(spread.memory, burning([["F3-CORR-W", "F3"], ["F3-STAIR-A", "F3"]]), false, places);
    expect(more.announcement.once).toBe(LOCATED_TEXT.spread("3층 좌측 계단 A"));
  });

  it("여러 곳이면 한 곳만 부르고 나머지는 센다", () => {
    const start = announce(null, burning([]), false, places);
    const spread = announce(start.memory, burning([["F3-CORR-W", "F3"], ["F3-STAIR-A", "F3"]]), false, places);
    expect(spread.announcement.once).toBe(LOCATED_TEXT.spread("3층 좌측 복도 외 1곳"));
  });

  it("해제 안내가 발화·확산 안내보다 먼저다", () => {
    const start = announce(null, burning([]), false, places);
    const cleared = announce(start.memory, { ...withCauses(), fire_simulation: null }, false, places);
    expect(cleared.announcement.once).toBe(BROADCAST_TEXT.ALL_CLEAR);
    // 모두 풀리면 기억도 비운다. 같은 실행에서 다시 불이 나면 처음처럼 부른다.
    expect(announce(cleared.memory, burning([]), false, places).announcement.once).toBe(LOCATED_TEXT.fireOnce("3층 307호"));
  });

  it("불이 닿은 구역이 늘면 방송을 다시 정한다", () => {
    const key = broadcastKey(burning([]), false, places);
    expect(broadcastKey(burning([]), false, places)).toBe(key);
    expect(broadcastKey(burning([["F3-CORR-W", "F3"]]), false, places)).not.toBe(key);
    // 연결이 끊기면 자리 대신 끊김을 알리므로 열쇠도 달라야 한다.
    expect(broadcastKey(burning([]), true, places)).not.toBe(key);
  });
});

describe("출구 유도 음성", () => {
  const building = rawBuilding as Building;
  const routed = (nodeId: string, exitId: string | null, reasons: StateSnapshot["routes"][number]["reason_codes"] = [], mode: StateSnapshot["controller_mode"] = "EMERGENCY"): StateSnapshot => ({
    ...BASE, controller_mode: mode,
    routes: [{ ...BASE.routes[0], node_id: nodeId, exit_id: exitId, reason_codes: reasons }],
  });
  const fleeing = (nodeId: string) => ({ nodeId, evacuating: true });

  it("서 있는 지점의 서버 경로가 가리키는 출구 하나만 부르고, 경로가 바뀌면 부르는 출구도 바뀐다", () => {
    expect(exitCall(routed("F1-J-PM", "EXIT-S"), building, fleeing("F1-J-PM"), false)).toMatchObject({ exitId: "EXIT-S" });
    expect(exitCall(routed("F1-J-PM", "EXIT-N"), building, fleeing("F1-J-PM"), false)).toMatchObject({ exitId: "EXIT-N" });
  });

  it("처음부터 평상시이고 대피를 시작하지 않은 사람에게는 부르지 않는다", () => {
    expect(exitCall(routed("F1-J-PM", "EXIT-S", [], "NORMAL"), building, { nodeId: "F1-J-PM", evacuating: false }, false)).toBeNull();
  });

  it("대피를 시작한 뒤 경보만 해제됐고 아직 대피 중이면 유효한 경로의 출구를 계속 부른다", () => {
    expect(exitCall(routed("F1-J-PM", "EXIT-S", [], "NORMAL"), building, fleeing("F1-J-PM"), false)).toMatchObject({ exitId: "EXIT-S" });
  });

  it("탈출했거나 1인칭이 끝난 사람에게는 부르지 않는다", () => {
    expect(exitCall(routed("F1-X-S", "EXIT-S"), building, { nodeId: "F1-X-S", evacuating: false }, false)).toBeNull();
    expect(exitCall(routed("F1-J-PM", "EXIT-S"), building, null, false)).toBeNull();
  });

  it("출구가 막혀 경로가 없거나, 감지 정보가 만료됐거나, 연결이 끊기면 멈추고, 경로가 돌아오면 다시 부른다", () => {
    const walker = fleeing("F1-J-PM");
    expect(exitCall(routed("F1-J-PM", null, ["NO_REACHABLE_EXIT"]), building, walker, false)).toBeNull();
    expect(exitCall(routed("F1-J-PM", null, ["REQUIRED_OBSERVATION_UNKNOWN"], "DEGRADED"), building, walker, false)).toBeNull();
    expect(exitCall(routed("F1-J-PM", "EXIT-S"), building, walker, true)).toBeNull();
    expect(exitCall(routed("F1-J-PM", "EXIT-S"), building, walker, false)).toMatchObject({ exitId: "EXIT-S" });
    // 대피 출구로 쓰지 않는 문은 부르지 않는다.
    const closed = { ...building, exits: building.exits.map((exit) => ({ ...exit, enabled: exit.exit_id !== "EXIT-NW" })) };
    expect(exitCall(routed("F1-J-PM", "EXIT-NW"), closed, walker, false)).toBeNull();
    expect(exitCall(routed("F1-J-PM", "EXIT-NW"), building, walker, false)).toMatchObject({ exitId: "EXIT-NW" });
  });

  it("다른 층의 출구는 평면에서 바로 옆이어도 부르지 않는다 (3층 F3-J-N4와 1층 EXIT-N)", () => {
    const node = (id: string) => building.nodes.find((item) => item.node_id === id)!;
    const above = node("F3-J-N4");
    const exit = node("F1-X-N");
    // 재현 조건: 평면 거리는 2m도 안 되지만 높이가 8m 다르다.
    expect(Math.hypot(above.position.x - exit.position.x, above.position.z - exit.position.z)).toBeLessThan(2);
    expect(above.position.y - exit.position.y).toBe(8);
    expect(exitCall(routed("F3-J-N4", "EXIT-N"), building, fleeing("F3-J-N4"), false)).toBeNull();
    // 계단을 내려오는 동안(떠나온 2층 계단 지점)에도 부르지 않고, 1층에 닿으면 부른다.
    expect(exitCall(routed("F2-S-B", "EXIT-N"), building, fleeing("F2-S-B"), false)).toBeNull();
    expect(exitCall(routed("F1-S-B", "EXIT-N"), building, fleeing("F1-S-B"), false)).toMatchObject({ exitId: "EXIT-N" });
  });

  it("같은 층에서 접근 가능한 출구는 부르고, 판단에 화면용 높이가 들어가지 않는다", () => {
    const call = exitCall(routed("F1-J-PN", "EXIT-N"), building, fleeing("F1-J-PN"), false);
    const exit = building.nodes.find((item) => item.node_id === "F1-X-N")!;
    // 층은 건물 자료의 지점 층으로만 정하고, 돌려주는 위치도 평면 좌표뿐이라 층 간격을 바꿔도 결과가 같다.
    expect(call).toEqual({ exitId: "EXIT-N", x: exit.position.x, z: exit.position.z });
  });

  it("출구가 있는 쪽에서 들리고 가까울수록 크다", () => {
    // +z를 보고 선 사람. 장면에서 +x는 왼쪽이다.
    const facing = { x: 0, z: 0, yaw: 0 };
    expect(exitSound(facing, { x: 0, z: 5 }).pan).toBeCloseTo(0);
    expect(exitSound(facing, { x: 5, z: 0 }).pan).toBeCloseTo(-1);
    expect(exitSound(facing, { x: -5, z: 0 }).pan).toBeCloseTo(1);
    expect(exitSound(facing, { x: 0, z: 3 }).gain).toBeGreaterThan(exitSound(facing, { x: 0, z: 12 }).gain);
    expect(exitSound(facing, { x: 0, z: 30 }).gain).toBe(0);
  });
});

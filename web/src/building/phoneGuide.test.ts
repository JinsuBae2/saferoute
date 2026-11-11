import { describe, expect, it } from "vitest";
import type { Building, StateSnapshot } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import { spawnPeople, stepPeople } from "./people";
import { nearestPerson, nearbyQr, phoneGuidance } from "./phoneGuide";
import type { FollowPose } from "./phoneGuide";

const building = rawBuilding as unknown as Building;
const at = (id: string) => building.nodes.find(n => n.node_id === id)!;
const pose = (id = "F3-S-A"): FollowPose => ({ ...at(id).position, yaw: 0, nodeId: id, toNodeId: null, routeNodeId: id, personIndex: 15, runId: "r1", progress: 0, moving: true, evacuating: true });
const state = (path = ["F3-S-A", "F2-S-A", "F1-S-A", "F1-X-N"]): StateSnapshot => ({
  run_id: "r1", building_id: building.building_id, building_version: building.building_version,
  routes: [{ node_id: path[0], next_node_id: path[1], exit_id: "EXIT-N", path_node_ids: path, reason_codes: [], cost: 1 }],
  signs: [],
} as unknown as StateSnapshot);

describe("휴대폰 대피 안내", () => {
  it("선택한 3층 301호 사람을 고르고 탈출 인원은 제외한다", () => {
    const people = spawnPeople(building);
    expect(nearestPerson(building, people, "F3-D-R301")).toBe(15);
    people[15].status = "OUT";
    const next = nearestPerson(building, people, "F3-D-R301");
    expect(next).not.toBe(15);
    expect(at(people[next!].from).floor_id).toBe("F3");
    people.forEach(p => { if (at(p.from).floor_id === "F3") p.status = "OUT"; });
    expect(nearestPerson(building, people, "F3-D-R301")).toBeNull();
  });
  it("계단을 따라 내려가는 최신 서버 경로와 다음 층을 보여 준다", () => {
    const guide = phoneGuidance(building, null, state(), pose(), false);
    expect(guide.kind).toBe("ROUTE");
    if (guide.kind !== "ROUTE") return;
    expect(guide.path).toEqual(state().routes[0].path_node_ids);
    expect(guide.instruction).toContain("2층");
    expect(guide.instruction).toContain("내려");
  });
  it("계단 이동 중에는 출발층 지도와 도착층을 구분하고 도착하면 지도를 바꾼다", () => {
    const path = ["F3-S-A", "F2-S-A", "F1-S-A", "F1-X-N"];
    const onStairs = phoneGuidance(building, null, state(path), { ...pose(), toNodeId: "F2-S-A" }, false);
    expect(onStairs).toMatchObject({ floorId: "F3", floorTransition: "3층 → 2층", mapHint: "2층 도착하면 지도 전환" });
    const secondFloor = phoneGuidance(building, null, state(path.slice(1)), { ...pose("F2-S-A"), toNodeId: "F1-S-A" }, false);
    expect(secondFloor).toMatchObject({ floorId: "F2", floorTransition: "2층 → 1층", mapHint: "1층 도착하면 지도 전환" });
    const firstFloor = phoneGuidance(building, null, state(path.slice(2)), pose("F1-S-A"), false);
    expect(firstFloor).toMatchObject({ floorId: "F1", floorTransition: null });
    const waiting = phoneGuidance(building, null, state(path), { ...pose(), moving: false }, false);
    expect(waiting).toMatchObject({ floorId: "F3", floorTransition: null });
  });
  it("통신 끊김·새 실행·차단 상태에는 옛 경로를 주지 않는다", () => {
    expect(phoneGuidance(building, null, state(), pose(), true).kind).toBe("UNAVAILABLE");
    expect(phoneGuidance(building, null, { ...state(), run_id: "r2" }, pose(), false).kind).toBe("UNAVAILABLE");
    expect(phoneGuidance(building, null, state(), { ...pose(), progress: undefined as unknown as number }, false).kind).toBe("UNAVAILABLE");
    const blocked = state();
    blocked.routes[0].reason_codes = ["NO_REACHABLE_EXIT"];
    expect(phoneGuidance(building, null, blocked, pose(), false).kind).toBe("BLOCKED");
  });
  it("되돌아갈 때는 위험한 직전 지점이 아닌 돌아갈 지점의 최신 경로를 읽는다", () => {
    const p = { ...pose("F3-J-W2"), toNodeId: "F3-S-A", routeNodeId: "F3-S-A" };
    const guide = phoneGuidance(building, null, state(), p, false);
    expect(guide.kind).toBe("ROUTE");
    if (guide.kind === "ROUTE") expect(guide.instruction).toContain("돌아");
  });
  it("계단 중간에서 되돌아도 아직 도착하지 않은 아래층으로 표시하거나 선택하지 않는다", () => {
    const people = [{ from: "F3-S-A", to: "F2-S-A", progress: .1, status: "MOVING" as const, started: true }];
    const route = { ...state().routes[0], next_node_id: "F3-J-W1" };
    stepPeople(people, new Map([["F3-S-A", route]]), true, () => 10, 0);
    expect(nearestPerson(building, people, "F3-S-A")).toBe(0);
    expect(nearestPerson(building, people, "F2-S-A")).toBeNull();
    const p = { ...pose("F2-S-A"), toNodeId: "F3-S-A", routeNodeId: "F3-S-A" };
    const guide = phoneGuidance(building, null, state(), p, false);
    expect(guide.kind).toBe("ROUTE");
    if (guide.kind === "ROUTE") expect(guide.floorId).toBe("F3");
  });
  it("QR은 같은 층에서 실제 인물이 지나가는 가까운 지점만 인식한다", () => {
    const sign = building.signs.find(s => at(s.node_id).floor_id === "F1")!;
    expect(nearbyQr(building, pose(sign.node_id))?.sign_id).toBe(sign.sign_id);
    expect(nearbyQr(building, { ...pose("F3-D-R301"), x: at(sign.node_id).position.x, z: at(sign.node_id).position.z })).toBeNull();
  });
});

describe("몇 m 앞 회전 안내", () => {
  const points = [["A", 0, 0], ["B", 0, 4], ["C", 0, 10], ["D", -8, 10], ["E", -8, 18]] as const;
  const navBuilding: Building = { ...building, nodes: points.map(([id,x,z]) => ({ ...at("F3-S-A"), node_id:id, position:{x,y:8,z} })) };
  const navPose: FollowPose = { ...pose(), nodeId:"A", routeNodeId:"A", toNodeId:"B", progress:.5, x:0, z:2 };
  const path = points.map(([id]) => id);

  it("직진 중간 지점은 건너뛰고 실제 남은 경로 길이로 8m 앞 우회전을 안내한다", () => {
    expect(phoneGuidance(navBuilding, null, state(path), navPose, false)).toMatchObject({ instruction:"약 8m 앞에서 우회전", distanceMetres:8, icon:"↱" });
  });
  it("이동하면 거리가 줄고 갈림길 직전에는 지금 우회전으로 바뀐다", () => {
    const nearing = { ...navPose, nodeId:"B", routeNodeId:"B", toNodeId:"C", progress:.9, z:9.4 };
    expect(phoneGuidance(navBuilding, null, state(path.slice(1)), nearing, false)).toMatchObject({ instruction:"지금 우회전", icon:"↱" });
    const afterTurn = { ...navPose, nodeId:"C", routeNodeId:"C", toNodeId:"D", progress:0, z:10 };
    expect(phoneGuidance(navBuilding, null, state(path.slice(2)), afterTurn, false)).toMatchObject({ instruction:"약 8m 앞에서 좌회전", icon:"↰" });
  });
  it("주위를 둘러보거나 화면 인물에 좌우 간격이 있어도 회전 방향과 거리는 바뀌지 않는다", () => {
    expect(phoneGuidance(navBuilding, null, state(path), { ...navPose, yaw:Math.PI, x:.35, z:2.25 }, false)).toMatchObject({ instruction:"약 8m 앞에서 우회전", distanceMetres:8 });
  });
  it("다음 층 노드까지 직선으로 재지 않고 계단 입구까지의 거리와 내려갈 층을 안내한다", () => {
    const down = { ...navBuilding, nodes:navBuilding.nodes.map(n => n.node_id === "D" ? { ...n, floor_id:"F2", position:{...n.position,y:4} } : n) };
    expect(phoneGuidance(down, null, state(path.slice(0,4)), navPose, false)).toMatchObject({ instruction:"약 8m 직진 후 계단", detail:"2층으로 내려가세요", distanceMetres:8, icon:"↘" });
  });
  it("회전 없는 경로에서는 출구까지 남은 거리를 안내한다", () => {
    expect(phoneGuidance(navBuilding, null, state(path.slice(0,3)), navPose, false)).toMatchObject({ instruction:"약 8m 앞 출구", distanceMetres:8 });
  });
  it("이동 중 경로가 바뀌면 이전 우회전 안내를 남기지 않는다", () => {
    const changed = state(["A", "D", "E"]);
    expect(phoneGuidance(navBuilding, null, changed, navPose, false)).toMatchObject({ instruction:"경로 변경 확인 중", distanceMetres:null });
    expect(phoneGuidance(navBuilding, null, changed, navPose, true).kind).toBe("UNAVAILABLE");
  });
});

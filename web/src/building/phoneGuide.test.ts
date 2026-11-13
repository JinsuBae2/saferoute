import { describe, expect, it } from "vitest";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import { spawnPeople, stepPeople } from "./people";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { parseGeometry } from "./geometry";
import { BLOCKED_HELP, nearestPerson, nearbyQr, phoneGuidance, qrAssetsMatch, reportPlace, routeLoss, shouldAutoScan } from "./phoneGuide";
import { qrMounts } from "./signMount";
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
});

describe("QR 모의 인식", () => {
  const geometry = parseGeometry(rawGeometry);
  const mounts = qrMounts(building, geometry.floors, geometry.stairs);
  const walls = geometry.floors.find(floor => floor.floor_id === "F3")!.walls;
  const sign = building.signs.find(item => item.node_id === "F3-J-N5")!;
  const mount = mounts.get(sign.sign_id)!;
  /** 판 앞쪽으로 ahead만큼, 판을 따라 옆으로 side만큼 떨어진 자리에서 판을 마주 본다(turn만큼 고개를 돌림). */
  const from = (ahead: number, side = 0, turn = 0): FollowPose => ({ ...pose("F3-J-N5"),
    x: mount.x + mount.normalX * ahead - mount.normalZ * side, z: mount.z + mount.normalZ * ahead + mount.normalX * side,
    yaw: Math.atan2(-mount.normalX, -mount.normalZ) + turn });

  it("벽면에 붙은 QR을 앞에서 바라보면 잡고, 3D와 같은 자리로 판정한다", () => {
    expect(qrAssetsMatch(building)).toBe(true);
    expect(nearbyQr(building, from(1.2), mounts, walls)?.sign_id).toBe(sign.sign_id);
    expect(nearbyQr(building, from(1.2, 0.5), mounts, walls)?.sign_id).toBe(sign.sign_id);
  });

  it("등 뒤, 먼 곳, 다른 구간, 다른 층의 QR은 잡지 않는다", () => {
    expect(nearbyQr(building, from(1.2, 0, Math.PI), mounts, walls)).toBeNull();
    expect(nearbyQr(building, { ...from(1.2), nodeId: "F3-D-R301", routeNodeId: "F3-D-R301" }, mounts, walls)).toBeNull();
    expect(nearbyQr(building, { ...from(1.2), routeNodeId: "F2-S-A" }, mounts, walls)).toBeNull();
    expect(nearbyQr(building, from(5.5), mounts, [])).toBeNull();
  });

  it("벽 너머(판의 뒷면 쪽)나 판과 거의 나란한 옆에서는 잡지 않는다", () => {
    // 판 뒤쪽은 벽 속·벽 너머다. 고개를 판 쪽으로 돌려도 잡히지 않는다.
    expect(nearbyQr(building, { ...from(-0.8), yaw: Math.atan2(mount.normalX, mount.normalZ) }, mounts, walls)).toBeNull();
    expect(nearbyQr(building, { ...from(-0.8), yaw: Math.atan2(mount.normalX, mount.normalZ) }, mounts, [])).toBeNull();
    expect(nearbyQr(building, from(0.1, 2.5, -Math.PI / 2), mounts, [])).toBeNull();
  });

  it("사이에 벽이 있으면 잡지 않는다", () => {
    const here = from(2);
    const between = [Math.min(here.x, mount.x) - 0.5, Math.min(here.z, mount.z) + 0.01, Math.max(here.x, mount.x) + 0.5, Math.max(here.z, mount.z) - 0.01] as const;
    const wall = mount.normalX !== 0 ? [mount.x + mount.normalX * 0.8 - 0.05, here.z - 1, mount.x + mount.normalX * 0.8 + 0.05, here.z + 1] as const : [here.x - 1, mount.z + mount.normalZ * 0.8 - 0.05, here.x + 1, mount.z + mount.normalZ * 0.8 + 0.05] as const;
    expect(between).toHaveLength(4);
    expect(nearbyQr(building, here, mounts, [wall])).toBeNull();
  });

  it("붙일 벽이 없는 지점이나 자산과 버전이 다른 건물에서는 QR이 없다", () => {
    const bare = building.signs.find(item => !mounts.has(item.sign_id))!;
    expect(nearbyQr(building, { ...pose(bare.node_id), yaw: 0 }, mounts, [])).toBeNull();
    expect(qrAssetsMatch({ building_id: "WFI", building_version: 5 })).toBe(false);
    expect(nearbyQr({ ...building, building_version: 5 }, from(1.2), mounts, walls)).toBeNull();
  });
});

describe("QR 자동 인식은 처음 한 번", () => {
  const ready = { acting: true, open: true, scanning: false, qrSignId: "SIGN-F3-J-N5", confirmed: null };
  it("시연 인물이 휴대폰을 꺼냈고 보이는 QR이 있고 아직 확인 전일 때만 스스로 비춘다", () => {
    expect(shouldAutoScan(ready)).toBe(true);
    expect(shouldAutoScan({ ...ready, acting: false })).toBe(false);
    expect(shouldAutoScan({ ...ready, open: false })).toBe(false);
    expect(shouldAutoScan({ ...ready, scanning: true })).toBe(false);
    expect(shouldAutoScan({ ...ready, qrSignId: null })).toBe(false);
  });
  it("한 번 확인한 뒤에는 다른 QR이 보여도 다시 비추지 않는다", () => {
    // 다른 QR 옆을 지남, 층이 바뀜, 휴대폰을 내렸다 다시 꺼냄: 모두 confirmed가 남아 있어 자동 인식이 없다.
    for (const qrSignId of ["SIGN-F3-J-N5", "SIGN-F3-J-N4", "SIGN-F2-S-A", "SIGN-F1-J-LE"]) expect(shouldAutoScan({ ...ready, qrSignId, confirmed: "SIGN-F3-J-N5" })).toBe(false);
  });
  it("첫 인식이 취소되면(확인 전) 다음에 보이는 QR에서 다시 시도한다", () => {
    // 비추던 QR이 시야에서 벗어나면 scanning만 꺼지고 confirmed는 null로 남는다.
    expect(shouldAutoScan({ ...ready, qrSignId: null })).toBe(false);
    expect(shouldAutoScan({ ...ready, qrSignId: "SIGN-F3-J-N4" })).toBe(true);
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

  describe("경로를 안내하지 못할 때", () => {
    const lost = (reasons: string[]) => ({ ...state(), routes: [{ node_id: "F3-S-A", next_node_id: null, exit_id: null, path_node_ids: [], reason_codes: reasons, cost: null }] }) as unknown as StateSnapshot;
    const labels = { floor_labels: { F3: "3층" }, node_labels: { "F3-S-A": "계단 A 앞" } } as unknown as BuildingDisplay;
    it("출구 경로가 없는 것과 확인하지 못한 것을 다른 문구로 알린다", () => {
      expect(routeLoss(["NO_REACHABLE_EXIT"])).toBe("NO_ROUTE");
      expect(routeLoss(["ORIGIN_BLOCKED"])).toBe("NO_ROUTE");
      expect(routeLoss(["NO_REACHABLE_EXIT", "REQUIRED_OBSERVATION_UNKNOWN"])).toBe("UNCONFIRMED");
      expect(routeLoss(["CONTROLLER_UNAVAILABLE"])).toBe("UNCONFIRMED");
      const none = phoneGuidance(building, labels, lost(["NO_REACHABLE_EXIT"]), pose(), false);
      const unknown = phoneGuidance(building, labels, lost(["REQUIRED_OBSERVATION_UNKNOWN"]), pose(), false);
      expect(none.kind).toBe("BLOCKED");
      expect(unknown.kind).toBe("UNCONFIRMED");
      expect(none.instruction).not.toBe(unknown.instruction);
      if (none.kind !== "BLOCKED" || unknown.kind !== "UNCONFIRMED") return;
      expect(none.actions.join(" ")).toContain("119");
      expect(none.actions.join(" ")).toContain("무리하게");
      expect(unknown.actions.join(" ")).toContain("경로가 없다는 뜻이 아닙니다");
    });
    it("확인한 층과 위치만 신고용으로 보여 주고, 연결이 늦으면 위치를 내밀지 않는다", () => {
      const none = phoneGuidance(building, labels, lost(["NO_REACHABLE_EXIT"]), pose(), false);
      expect(none.kind === "BLOCKED" && none.place).toBe("3층 · 계단 A 앞 부근");
      const stale = phoneGuidance(building, labels, lost(["NO_REACHABLE_EXIT"]), pose(), true);
      expect(stale.kind).toBe("UNAVAILABLE");
      expect(stale.kind === "UNAVAILABLE" && stale.place).toBeNull();
      expect(reportPlace(building, null, "없는-지점")).toBeNull();
      expect(reportPlace(building, { floor_labels: { F3: "3층" }, node_labels: { "F3-S-A": "3층 계단 A 앞" } } as unknown as BuildingDisplay, "F3-S-A")).toBe("3층 계단 A 앞 부근");
    });
    it("옥상은 대피 목적지가 아니라 조건이 붙은 도움말로만 둔다", () => {
      const none = phoneGuidance(building, labels, lost(["NO_REACHABLE_EXIT"]), pose(), false);
      expect(none.kind === "BLOCKED" && none.actions.join(" ")).not.toContain("옥상");
      expect(BLOCKED_HELP.roof).toContain("확인되지 않아");
      expect(BLOCKED_HELP.roof).toContain("직접 확인한 경우에만");
    });
  });
});

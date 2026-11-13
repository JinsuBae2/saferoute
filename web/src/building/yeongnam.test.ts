import { describe, expect, it } from "vitest";
import type { Building, StateSnapshot } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import wfiPeople from "@space/wfi-people-v1.json";
import { stepPeople } from "./people";
import type { Person } from "./people";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { parseGeometry } from "./geometry";
import { signInstalls } from "./signMount";
import { devWalk, shownFaces, witnessedSignChanges, YEONGNAM, yeongnamDelay, yeongnamEmote, yeongnamFire, yeongnamPhase, yeongnamSupported } from "./yeongnam";

const building = rawBuilding as Building;

describe("영남이 시연 설정", () => {
  it("기존 인원 한 명과 시험 화재를 낼 수 있는 구역을 가리킨다", () => {
    expect(yeongnamSupported(building)).toBe(true);
    expect(wfiPeople.start_node_ids).toContain(YEONGNAM.startNodeId);
    expect(building.sources.some((source) => source.source_type === "MANUAL_TEST" && source.zone_id === YEONGNAM.zoneId)).toBe(true);
    const zone = building.zones.find((item) => item.zone_id === YEONGNAM.zoneId)!;
    const xs = zone.polygon.map((point) => point.x);
    const zs = zone.polygon.map((point) => point.z);
    expect(YEONGNAM.ignition.x).toBeGreaterThan(Math.min(...xs));
    expect(YEONGNAM.ignition.x).toBeLessThan(Math.max(...xs));
    expect(YEONGNAM.ignition.z).toBeGreaterThan(Math.min(...zs));
    expect(YEONGNAM.ignition.z).toBeLessThan(Math.max(...zs));
  });

  it("단계가 수면 → 인지 → 복도로 나옴 → 당황 → 방송 → 대피 순서로만 넘어간다", () => {
    const { noticeAt, riseAt, panicAt, listenAt, departAt } = YEONGNAM;
    expect([noticeAt, riseAt, panicAt, listenAt, departAt]).toEqual([...[noticeAt, riseAt, panicAt, listenAt, departAt]].sort((a, b) => a - b));
    const phases = [null, 0, noticeAt - 0.1, noticeAt, riseAt, panicAt, listenAt - 0.1, listenAt, departAt - 0.1, departAt, 200].map(yeongnamPhase);
    expect(phases).toEqual(["SLEEP", "SLEEP", "SLEEP", "NOTICE", "RISE", "PANIC", "PANIC", "LISTEN", "LISTEN", "EVACUATE", "EVACUATE"]);
    expect(yeongnamEmote("SLEEP", false, false)).toContain("Zzz");
    expect(yeongnamEmote("NOTICE", false, false)).toBe("❗");
    expect(yeongnamEmote("PANIC", false, false)).toBe("😨");
    // 출발 전에 서서 본 것은 안내 확인, 걷다가 본 것이 유도등 변경 목격이다.
    expect(yeongnamEmote("LISTEN", true, false)).toContain("안내 확인");
    expect(yeongnamEmote("EVACUATE", true, true)).toContain("유도등");
    expect(yeongnamEmote("EVACUATE", false, true)).toBe("📱");
    expect(yeongnamEmote("EVACUATE", false, false)).toBeNull();
  });

  it("행동 지연은 검증용 주소 옵션이 있을 때만 적용된다", () => {
    expect(yeongnamDelay("http://localhost:5173/#/shared")).toBe(0);
    expect(yeongnamDelay("http://localhost:5173/#/shared?yeongnamDelay=10")).toBe(10);
    expect(yeongnamDelay("http://localhost:5173/#/shared?yeongnamDelay=9999")).toBe(120);
  });

  it("개발용 걷기는 주소 옵션에 지점이 둘 이상 있을 때만 켜진다", () => {
    expect(devWalk("http://localhost:5173/#/shared")).toBeNull();
    expect(devWalk("http://localhost:5173/#/shared?devWalk=F1-S-B")).toBeNull();
    expect(devWalk("http://localhost:5173/#/shared?devWalk=F1-J-PM,F1-S-B,F2-S-B")).toEqual(["F1-J-PM", "F1-S-B", "F2-S-B"]);
  });

  it("복도로 나와 서는 자리는 출발 지점에서 이어진 첫 구간의 끝이다", () => {
    expect(building.edges.some((edge) => edge.from_node_id === YEONGNAM.startNodeId && edge.to_node_id === YEONGNAM.watchNodeId)).toBe(true);
  });

  it("정해 둔 자리의 화재만 시연으로 본다", () => {
    const state = (position: { x: number; y: number; z: number } | null, sourceId = "MANUAL-F3-R302") => ({
      active_causes: [{ source_id: sourceId, hazard_type: "FIRE", ignition_position: position }],
      fire_simulation: { fires: [{ source_id: "MANUAL-F3-R302", elapsed_ms: 7000 }], cells: [] },
    }) as unknown as StateSnapshot;
    expect(yeongnamFire(state(YEONGNAM.ignition))).toEqual({ elapsedMs: 7000 });
    expect(yeongnamFire(state({ ...YEONGNAM.ignition, x: 41 }))).toBeNull();
    expect(yeongnamFire(state(null))).toBeNull();
    // 확산 자료가 다른 화재의 것이면 경과 시간을 지어내지 않는다.
    expect(yeongnamFire(state(YEONGNAM.ignition, "MANUAL-F3-R303"))).toBeNull();
  });

});

describe("유도등 변경 목격 판정", () => {
  const geometry = parseGeometry(rawGeometry);
  const walls = geometry.floors.find((floor) => floor.floor_id === "F3")!.walls;
  const installs = signInstalls(building, geometry.floors);
  const base = new Map<string, string | null>(building.signs.flatMap((sign) => sign.faces.map((face) => [`${sign.sign_id}/${face.face_id}`, "FORWARD" as string | null] as const)));
  const turn = (key: string, display: string | null) => new Map(base).set(key, display);
  // 300호 앞 복도(F3-J-R0)에서 남쪽을 본다. 정면 4.6 m에 갈림길 유도등(F3-J-N5)이 있다.
  const south = { x: 37.1, z: 1.6, floorId: "F3", headingX: 0, headingZ: 1 };
  const ahead = "SIGN-F3-J-N5/FRONT";

  it("정면에서 마주 보는 면의 화살표가 다른 화살표로 바뀌면 봤다고 한다", () => {
    expect(witnessedSignChanges(building, walls, base, turn(ahead, "RIGHT"), installs, south)).toEqual([ahead]);
    expect(witnessedSignChanges(building, walls, base, base, installs, south)).toEqual([]);
  });

  it("꺼지거나 켜진 것, 등진 면, 등 뒤, 다른 층, 먼 곳의 변경은 봤다고 하지 않는다", () => {
    expect(witnessedSignChanges(building, walls, base, turn(ahead, null), installs, south)).toEqual([]);
    expect(witnessedSignChanges(building, walls, turn(ahead, null), base, installs, south)).toEqual([]);
    expect(witnessedSignChanges(building, walls, base, turn("SIGN-F3-J-N5/REAR", "LEFT"), installs, south)).toEqual([]);
    expect(witnessedSignChanges(building, walls, base, turn(ahead, "RIGHT"), installs, { ...south, headingZ: -1 })).toEqual([]);
    expect(witnessedSignChanges(building, walls, base, turn(ahead, "RIGHT"), installs, { ...south, floorId: "F2" })).toEqual([]);
    // 서쪽 끝 계단 A 앞 유도등이 바뀌어도 동쪽 복도에 선 사람은 보지 못한다.
    const far = building.signs.find((sign) => sign.node_id === "F3-J-W1")!;
    expect(witnessedSignChanges(building, walls, base, turn(`${far.sign_id}/${far.faces[0].face_id}`, "LEFT"), installs, south)).toEqual([]);
  });

  it("바로 밑까지 다가가 화면 위로 벗어난 면의 변경은 봤다고 하지 않는다", () => {
    // 면은 2.45 m 높이에 걸려 있다. 1.2 m 앞에서는 1인칭 화면 위쪽 밖이다.
    expect(witnessedSignChanges(building, walls, base, turn(ahead, "RIGHT"), installs, { ...south, z: 6.2 - 0.6 - 1.2 })).toEqual([]);
    expect(witnessedSignChanges(building, walls, base, turn(ahead, "RIGHT"), installs, { ...south, z: 6.2 - 0.6 - 2.2 })).toEqual([ahead]);
  });

  it("옆 통로에서 다가오는 사람은 그쪽을 보는 면의 변경만 본다", () => {
    // 북쪽 복도를 서쪽으로 걷는 사람 정면에는 F3-J-N4의 서쪽 접근면이 있다. 남북을 보는 면(FRONT·REAR)은 옆면이라 보이지 않는다.
    const west = { x: 34, z: 6.2, floorId: "F3", headingX: -1, headingZ: 0 };
    const side = "SIGN-F3-J-N4/FROM-F3-J-N6";
    expect(witnessedSignChanges(building, walls, base, turn(side, "LEFT"), installs, west)).toEqual([side]);
    expect(witnessedSignChanges(building, walls, base, turn("SIGN-F3-J-N4/FRONT", "LEFT"), installs, west)).toEqual([]);
  });

  it("벽에 가린 유도등의 변경은 봤다고 하지 않는다", () => {
    const wall = [[36, 3, 38, 3.2]] as const;
    expect(witnessedSignChanges(building, wall, base, turn(ahead, "RIGHT"), installs, south)).toEqual([]);
  });

  it("서버 상태에서 면별 표시값을 그대로 읽는다", () => {
    const state = { signs: [{ sign_id: "S", faces: [{ face_id: "FRONT", display: "LEFT" }, { face_id: "REAR", display: null }] }] } as unknown as StateSnapshot;
    expect([...shownFaces(state)]).toEqual([["S/FRONT", "LEFT"], ["S/REAR", null]]);
  });
});

describe("세워 둔 사람", () => {
  const route = (node: string, next: string | null) => ({ node_id: node, next_node_id: next, exit_id: "E", path_node_ids: [], cost: 1, reason_codes: [] });
  const routes = new Map([["a", route("a", "b")], ["b", route("b", null)]]) as never;

  it("경보가 나도 풀릴 때까지 제자리에서 기다리고, 풀리면 그때의 서버 경로를 따른다", () => {
    const people: Person[] = [
      { from: "a", to: null, progress: 0, status: "WAITING", hold: true },
      { from: "a", to: null, progress: 0, status: "WAITING" },
    ];
    stepPeople(people, routes, true, () => 2, 1);
    expect(people[0]).toMatchObject({ from: "a", to: null, status: "WAITING", started: true });
    expect(people[1]).toMatchObject({ to: "b", progress: 0.5, status: "MOVING" });
    people[0].hold = false;
    stepPeople(people, routes, true, () => 2, 1);
    expect(people[0]).toMatchObject({ to: "b", progress: 0.5, status: "MOVING" });
  });

  it("걷던 중에 세우면 그 자리에 서고 진행률이 그대로다", () => {
    const people: Person[] = [{ from: "a", to: "b", progress: 0.4, status: "MOVING", started: true, hold: true }];
    stepPeople(people, routes, true, () => 2, 1);
    expect(people[0]).toMatchObject({ from: "a", to: "b", progress: 0.4, status: "WAITING" });
  });
});

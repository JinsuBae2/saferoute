/** 대피 인원이 서버 경로만 따라 걷는지 확인한다. */
import { describe, expect, it } from "vitest";

import type { Building, Route } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";

import type { Person } from "./people";
import { countPeople, spawnPeople, stepPeople, MAX_CATCH_UP_SECONDS, walkTime } from "./people";

const route = (node: string, next: string | null, reasons: Route["reason_codes"] = []): Route => ({
  node_id: node,
  next_node_id: next,
  exit_id: reasons.length > 0 ? null : "EXIT",
  path_node_ids: [],
  cost: reasons.length > 0 ? null : 1,
  reason_codes: reasons,
});

const routes = (...items: Route[]) => new Map(items.map((item) => [item.node_id, item]));
const person = (from: string): Person => ({ from, to: null, progress: 0, status: "WAITING" });
const TEN_METRES = () => 10;

describe("대피 인원 이동", () => {
  it("대피 중이 아니면 제자리에 선다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", null)), false, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ from: "A", to: null, status: "WAITING" });
  });

  it("연결이 끊겨 상태가 유효하지 않으면 즉시 멈추고, 돌아오면 같은 위치에서 이어 간다", () => {
    const people = [person("A")];
    const map = routes(route("A", "B"), route("B", null));
    stepPeople(people, map, true, TEN_METRES, 5);
    stepPeople(people, map, true, TEN_METRES, 20, false);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5, status: "STUCK" });
    stepPeople(people, map, true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.7, status: "MOVING" });
  });

  it("대피를 시작한 사람은 경보가 해제돼도 최신 경로를 따라 탈출할 때까지 걷는다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", "X"), route("X", null)), true, TEN_METRES, 5);
    // 경보 해제(평상시). 해제 뒤 안내가 B에서 Y 출구로 바뀌었다. 그때의 최신 경로를 따른다.
    const normal = routes(route("A", "B"), route("B", "Y"), route("Y", null), route("X", null));
    stepPeople(people, normal, false, TEN_METRES, 8);
    expect(people[0]).toMatchObject({ from: "B", to: "Y", status: "MOVING" });
    stepPeople(people, normal, false, TEN_METRES, 10);
    expect(people[0].status).toBe("OUT");
    // 탈출한 사람은 다시 경보가 나도 움직이지 않는다.
    stepPeople(people, normal, true, TEN_METRES, 50);
    expect(people[0]).toMatchObject({ from: "Y", status: "OUT" });
  });

  it("처음부터 평상시면 기다리고, 오래된 상태의 경보로는 대피를 시작하지 않는다", () => {
    const people = [person("A")];
    const map = routes(route("A", "B"), route("B", null));
    stepPeople(people, map, false, TEN_METRES, 5);
    stepPeople(people, map, true, TEN_METRES, 5, false);
    expect(people[0]).toMatchObject({ from: "A", to: null, status: "WAITING" });
    expect(countPeople(people)).toMatchObject({ waiting: 1, done: false });
  });

  it("해제 뒤 걷다가 경로가 막히면 멈추고, 안내가 복구되면 남은 대피를 이어 가 전원 탈출로 끝난다", () => {
    const people = [person("A"), person("C")];
    const open = routes(route("A", "B"), route("C", "B"), route("B", null));
    stepPeople(people, open, true, TEN_METRES, 5);
    const blocked = routes(route("A", null, ["NO_REACHABLE_EXIT"]), route("C", null, ["NO_REACHABLE_EXIT"]), route("B", null, ["ORIGIN_BLOCKED"]));
    stepPeople(people, blocked, false, TEN_METRES, 5);
    expect(countPeople(people)).toMatchObject({ moving: 0, stuck: 2, out: 0, done: false });
    stepPeople(people, open, false, TEN_METRES, 10);
    expect(countPeople(people)).toEqual({ total: 2, moving: 0, out: 2, stuck: 0, waiting: 0, done: true, lostSeconds: 0 });
    // 대피 완료는 그대로 남는다.
    stepPeople(people, open, false, TEN_METRES, 10);
    expect(countPeople(people).done).toBe(true);
  });

  it("서버가 준 다음 지점으로만 걷고 출구에 닿으면 빠져나간다", () => {
    const people = [person("A")];
    const map = routes(route("A", "B"), route("B", "X"), route("X", null));
    stepPeople(people, map, true, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5, status: "MOVING" });
    stepPeople(people, map, true, TEN_METRES, 20);
    expect(people[0].status).toBe("OUT");
    expect(countPeople(people)).toEqual({ total: 1, moving: 0, out: 1, stuck: 0, waiting: 0, done: true, lostSeconds: 0 });
  });

  it("걷는 중에 안내가 바뀌면 다음 지점에서 바뀐 방향으로 간다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", "X")), true, TEN_METRES, 5);
    stepPeople(people, routes(route("A", "B"), route("B", "Y"), route("Y", null)), true, TEN_METRES, 6);
    expect(people[0]).toMatchObject({ from: "B", to: "Y" });
  });

  it("경로가 없으면 멈추고, 안내가 돌아오면 다시 걷는다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", null, ["NO_REACHABLE_EXIT"])), true, TEN_METRES, 5);
    expect(people[0].status).toBe("STUCK");
    stepPeople(people, routes(route("A", "B")), true, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ to: "B", status: "MOVING" });
  });

  it("걷는 중에 가던 길이 막혀 안내가 바뀌면 바로 돌아서서 새 방향으로 간다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", null), route("C", null)), true, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5 });
    // A의 안내가 C로 바뀌었다. B 쪽으로 더 가지 않고 A로 되돌아간다.
    const changed = routes(route("A", "C"), route("B", null, ["ORIGIN_BLOCKED"]), route("C", null));
    stepPeople(people, changed, true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "B", to: "A", returning: true });
    expect(people[0].progress).toBeCloseTo(0.7);
    // A에 닿으면 새 안내를 따라 C로 간다.
    stepPeople(people, changed, true, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ from: "A", to: "C", status: "MOVING" });
    expect(people[0].progress).toBeCloseTo(0.2);
  });

  it("지나온 지점이 막혀도 가던 쪽에 경로가 있으면 멈추지 않고 계속 간다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", null)), true, TEN_METRES, 5);
    stepPeople(people, routes(route("A", null, ["ORIGIN_BLOCKED"]), route("B", null)), true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "A", to: "B", status: "MOVING" });
    expect(people[0].progress).toBeCloseTo(0.7);
  });

  it.each(["ORIGIN_BLOCKED", "NO_REACHABLE_EXIT"] as const)("이동 중 %s가 되면 멈추고 복구되면 이어 걷는다", (reason) => {
    const people = [person("A")];
    const safe = routes(route("A", "B"), route("B", null));
    stepPeople(people, safe, true, TEN_METRES, 5);
    stepPeople(people, routes(route("A", null, [reason])), true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5, status: "STUCK" });
    stepPeople(people, safe, true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.7, status: "MOVING" });
  });

  it("이동 중 경로가 누락되면 옛 안내를 계속 따라가지 않는다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B")), true, TEN_METRES, 5);
    stepPeople(people, routes(), true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ progress: 0.5, status: "STUCK" });
  });

  it("되돌아갈 지점의 안내도 사라지면 멈추고 복구를 기다린다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B")), true, TEN_METRES, 5);
    const changed = routes(route("A", "C"), route("B", null, ["ORIGIN_BLOCKED"]), route("C", null));
    stepPeople(people, changed, true, TEN_METRES, 1);
    stepPeople(people, routes(route("A", null, ["NO_REACHABLE_EXIT"])), true, TEN_METRES, 2);
    expect(people[0]).toMatchObject({ from: "B", to: "A", progress: 0.6, returning: true, status: "STUCK" });
    stepPeople(people, changed, true, TEN_METRES, 1);
    expect(people[0]).toMatchObject({ from: "B", to: "A", progress: 0.7, status: "MOVING" });
  });
});

describe("대피 인원 배치는 문 목록과 분리돼 있다", () => {
  const wfi = rawBuilding as Building;

  it("WFI는 문이 26개로 늘어도 23명이고, 추가된 문·방 안 지점·출구에는 사람을 세우지 않는다", () => {
    const people = spawnPeople(wfi);
    expect(wfi.nodes.filter((node) => node.kind === "DOOR").length).toBe(26);
    expect(people).toHaveLength(23);
    const starts = people.map((person) => person.from);
    expect(new Set(starts).size).toBe(23);
    for (const added of ["F3-D-R307-N", "F3-D-R304-E", "F2-D-INDUSTRY-E", "F1-J-CONF-N", "F1-J-R101", "F1-X-NW", "F1-X-SE"]) {
      expect(starts).not.toContain(added);
    }
    expect(people.every((person) => person.to === null && person.status === "WAITING")).toBe(true);
  });

  it("지점 순서를 뒤집거나 문을 더 넣어도 같은 사람이 같은 자리에서 같은 순서로 선다", () => {
    const base = spawnPeople(wfi).map((person) => person.from);
    const extraDoor = { ...wfi.nodes.find((node) => node.node_id === "F3-D-R308")!, node_id: "F3-D-EXTRA" };
    const changed = { ...wfi, nodes: [extraDoor, ...[...wfi.nodes].reverse()] };
    expect(spawnPeople(changed).map((person) => person.from)).toEqual(base);
    // 1인칭 대상(번호)이 가리키는 사람이 바뀌지 않는다.
    expect(base[22]).toBe("F3-D-R305");
    expect(base[0]).toBe("F1-D-R102");
  });

  it("배치 목록이 없는 건물은 예전처럼 방 입구마다 한 명이다", () => {
    const other = { ...wfi, building_id: "OTHER" };
    expect(spawnPeople(other)).toHaveLength(26);
  });
});

describe("walkTime (#202)", () => {
  it("화면을 드물게 그려도 실제 지난 시간이 걷는 시간에서 빠지지 않는다", () => {
    // 전에는 한 프레임을 0.2초로 묶어 1fps에서 10초 동안 2초만 걸었다.
    let walked = 0;
    for (let frame = 0; frame < 10; frame += 1) walked += walkTime(1).walk;
    expect(walked).toBeCloseTo(10);
    expect(walkTime(0.1)).toEqual({ walk: 0.1, lost: 0 });
  });

  it("오래 멈췄다 돌아오면 상한까지만 걷고 나머지는 반영하지 못한 시간으로 돌려준다", () => {
    expect(walkTime(60)).toEqual({ walk: MAX_CATCH_UP_SECONDS, lost: 60 - MAX_CATCH_UP_SECONDS });
    expect(walkTime(MAX_CATCH_UP_SECONDS)).toEqual({ walk: MAX_CATCH_UP_SECONDS, lost: 0 });
  });

  it("시계가 뒤로 가거나 값이 이상해도 뒤로 걷지 않는다", () => {
    expect(walkTime(-5)).toEqual({ walk: 0, lost: 0 });
    expect(walkTime(Number.NaN)).toEqual({ walk: 0, lost: 0 });
  });

  it("같은 시간을 한 번에 걷든 잘게 나눠 걷든 같은 자리에 선다", () => {
    const table = routes(route("A", "B"), route("B", "C"), route("C", null));
    const coarse = [person("A")];
    const fine = [person("A")];
    for (let i = 0; i < 4; i += 1) stepPeople(coarse, table, true, TEN_METRES, walkTime(1).walk * 3);
    for (let i = 0; i < 40; i += 1) stepPeople(fine, table, true, TEN_METRES, walkTime(0.1).walk * 3);
    expect(coarse[0]).toMatchObject({ from: fine[0].from, to: fine[0].to, status: fine[0].status });
    expect(coarse[0].progress).toBeCloseTo(fine[0].progress);
  });

  it("돌아온 직후 상태가 오래됐으면 따라잡는 시간도 걷지 않는다", () => {
    const people = [person("A")];
    stepPeople(people, routes(route("A", "B"), route("B", null)), true, TEN_METRES, 5);
    stepPeople(people, routes(route("A", "B"), route("B", null)), true, TEN_METRES, walkTime(60).walk * 3, false);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5, status: "STUCK" });
    expect(countPeople(people, 58.7).lostSeconds).toBe(58);
  });
});

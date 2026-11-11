/** 대피 인원이 서버 경로만 따라 걷는지 확인한다. */
import { describe, expect, it } from "vitest";

import type { Route } from "@contracts";

import type { Person } from "./people";
import { countPeople, stepPeople } from "./people";

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
    expect(countPeople(people)).toEqual({ total: 2, moving: 0, out: 2, stuck: 0, waiting: 0, done: true });
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
    expect(countPeople(people)).toEqual({ total: 1, moving: 0, out: 1, stuck: 0, waiting: 0, done: true });
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

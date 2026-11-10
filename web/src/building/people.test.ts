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

  it("서버가 준 다음 지점으로만 걷고 출구에 닿으면 빠져나간다", () => {
    const people = [person("A")];
    const map = routes(route("A", "B"), route("B", "X"), route("X", null));
    stepPeople(people, map, true, TEN_METRES, 5);
    expect(people[0]).toMatchObject({ from: "A", to: "B", progress: 0.5, status: "MOVING" });
    stepPeople(people, map, true, TEN_METRES, 20);
    expect(people[0].status).toBe("OUT");
    expect(countPeople(people)).toEqual({ total: 1, moving: 0, out: 1, stuck: 0 });
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
});

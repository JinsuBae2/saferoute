/** 새로고침 뒤 같은 방·같은 실행의 대피 상태만 되살리는지 확인한다. */
import { describe, expect, it } from "vitest";

import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";

import { spawnPeople } from "./people";
import { loadPeople, peopleKey, savePeople } from "./peopleStore";

const building = rawBuilding as Building;
const RUN = "11111111-1111-4111-8111-111111111111";

function memory(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, value); },
  };
}

describe("대피 상태 저장·복원", () => {
  it("같은 방·같은 실행·같은 건물 버전이면 사람 위치·대피 시작·탈출·선택한 사람이 되돌아온다", () => {
    const storage = memory();
    const people = spawnPeople(building);
    people[0] = { ...people[0], to: "F1-J-LW", progress: 0.4, status: "MOVING", started: true };
    people[1] = { ...people[1], status: "OUT", started: true };
    savePeople(storage, "room-a", RUN, building, people, 0);
    const restored = loadPeople(storage, "room-a", RUN, building);
    expect(restored?.follow).toBe(0);
    expect(restored?.people[0]).toMatchObject({ to: "F1-J-LW", progress: 0.4, status: "MOVING", started: true });
    expect(restored?.people[1]).toMatchObject({ status: "OUT", started: true });
    expect(restored?.people).toHaveLength(people.length);
  });

  it("초기화된 실행·다른 방·다른 건물 버전의 상태는 되살리지 않는다", () => {
    const storage = memory();
    const people = spawnPeople(building).map((person) => ({ ...person, status: "OUT" as const, started: true }));
    savePeople(storage, "room-a", RUN, building, people, null);
    expect(loadPeople(storage, "room-a", "22222222-2222-4222-8222-222222222222", building)).toBeNull();
    expect(loadPeople(storage, "room-b", RUN, building)).toBeNull();
    expect(loadPeople(storage, "room-a", RUN, { ...building, building_version: building.building_version + 1 })).toBeNull();
    expect(peopleKey("room-a", RUN, building)).not.toBe(peopleKey("shared", RUN, building));
  });

  it("새 실행을 저장하면 그 방의 이전 실행 기록은 지워지고 다른 방의 기록은 남는다", () => {
    const storage = memory();
    const people = spawnPeople(building);
    savePeople(storage, "room-a", RUN, building, people, null);
    savePeople(storage, "room-b", RUN, building, people, null);
    savePeople(storage, "room-a", "22222222-2222-4222-8222-222222222222", building, people, null);
    expect(loadPeople(storage, "room-a", RUN, building)).toBeNull();
    expect(loadPeople(storage, "room-b", RUN, building)).not.toBeNull();
  });

  it("깨졌거나 지금 건물과 맞지 않는 기록은 버리고 처음 상태로 시작한다", () => {
    const storage = memory();
    const key = peopleKey("room-a", RUN, building);
    storage.setItem(key, "{not json");
    expect(loadPeople(storage, "room-a", RUN, building)).toBeNull();
    storage.setItem(key, JSON.stringify({ follow: null, people: [{ from: "NOPE", to: null, progress: 0, status: "WAITING" }] }));
    expect(loadPeople(storage, "room-a", RUN, building)).toBeNull();
    const people = spawnPeople(building);
    storage.setItem(key, JSON.stringify({ follow: 999, people: people.map((person) => ({ ...person, progress: 7, status: "FLYING" })) }));
    expect(loadPeople(storage, "room-a", RUN, building)).toBeNull();
  });
});

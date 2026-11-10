/**
 * 시연용 대피 인원. 방 입구마다 한 명을 세우고, 화재 대응이 되면 서버 Route의 next_node_id만 따라 걷게 한다.
 *
 * 화면이 경로를 계산하지 않는다. 지점에 닿을 때마다 그 지점의 최신 서버 경로를 다시 읽는다.
 * 걷는 중에 떠나온 지점의 안내가 다른 쪽으로 바뀌면(가던 길이 막힘) 바로 돌아서서 그 지점으로 되돌아간다.
 * 실제 재실 인원이나 위치 추적이 아니며, 서버에 아무것도 보내지 않는다.
 */
import type { Building, Route } from "@contracts";

export type PersonStatus = "WAITING" | "MOVING" | "OUT" | "STUCK";

export type Person = {
  from: string;
  to: string | null;
  /** from에서 to까지 간 비율(0~1). */
  progress: number;
  status: PersonStatus;
  /** 안내가 바뀌어 직전 지점으로 되돌아가는 중. 닿을 때까지는 다시 돌아서지 않는다. */
  returning?: boolean;
};

/** 방 입구(DOOR)마다 한 명. 방 안에 있던 사람이 문으로 나오는 것으로 본다. */
export function spawnPeople(building: Building): Person[] {
  return building.nodes
    .filter((node) => node.kind === "DOOR")
    .map((node) => ({ from: node.node_id, to: null, progress: 0, status: "WAITING" as const }));
}

/**
 * metres만큼 걷는다. 대피 중이 아니면 제자리에 선다.
 * 경로가 없는 지점에서는 멈추고(STUCK), 안내가 돌아오면 다시 걷는다. 출구에 닿으면 OUT이다.
 */
export function stepPeople(
  people: Person[],
  routes: ReadonlyMap<string, Route>,
  evacuating: boolean,
  lengthOf: (from: string, to: string) => number,
  metres: number,
): void {
  for (const person of people) {
    if (person.status === "OUT") continue;
    let budget = metres;
    // 한 번에 여러 지점을 지나칠 수 있어 반복한다. 잘못된 자료로 무한히 돌지 않게 횟수를 묶는다.
    for (let hop = 0; hop < 16; hop += 1) {
      if (person.to === null) {
        if (!evacuating) {
          person.status = "WAITING";
          break;
        }
        const route = routes.get(person.from);
        if (route === undefined || route.reason_codes.length > 0) {
          person.status = "STUCK";
          break;
        }
        if (route.next_node_id === null) {
          person.status = "OUT";
          break;
        }
        person.to = route.next_node_id;
        person.progress = 0;
        person.status = "MOVING";
      }
      // 걷는 중에도 떠나온 지점의 안내를 다시 본다. 다른 쪽을 가리키면 가던 길을 버리고 돌아선다.
      const behind = routes.get(person.from);
      if (evacuating && person.returning !== true && behind !== undefined && behind.reason_codes.length === 0
        && behind.next_node_id !== null && behind.next_node_id !== person.to) {
        [person.from, person.to] = [person.to, person.from];
        person.progress = 1 - person.progress;
        person.returning = true;
      }
      const length = Math.max(lengthOf(person.from, person.to), 0.01);
      const remaining = (1 - person.progress) * length;
      if (budget < remaining) {
        person.progress += budget / length;
        break;
      }
      budget -= remaining;
      person.from = person.to;
      person.to = null;
      person.progress = 0;
      person.returning = false;
    }
  }
}

export type PeopleCount = { readonly total: number; readonly moving: number; readonly out: number; readonly stuck: number };

export function countPeople(people: readonly Person[]): PeopleCount {
  const count = (status: PersonStatus) => people.filter((person) => person.status === status).length;
  return { total: people.length, moving: count("MOVING"), out: count("OUT"), stuck: count("STUCK") };
}

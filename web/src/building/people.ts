/**
 * 시연용 대피 인원. 정해 둔 시작 위치마다 한 명을 세우고, 화재 대응이 되면 서버 Route의 next_node_id만 따라 걷게 한다.
 *
 * 화면이 경로를 계산하지 않는다. 지점에 닿을 때마다 그 지점의 최신 서버 경로를 다시 읽는다.
 * 걷는 중에 떠나온 지점의 안내가 다른 쪽으로 바뀌면(가던 길이 막힘) 바로 돌아서서 그 지점으로 되돌아간다.
 * 실제 재실 인원이나 위치 추적이 아니며, 서버에 아무것도 보내지 않는다.
 */
import type { Building, Route } from "@contracts";
import wfiPeople from "@space/wfi-people-v1.json";

export type PersonStatus = "WAITING" | "MOVING" | "OUT" | "STUCK";

export type Person = {
  from: string;
  to: string | null;
  /** from에서 to까지 간 비율(0~1). */
  progress: number;
  status: PersonStatus;
  /** 안내가 바뀌어 직전 지점으로 되돌아가는 중. 닿을 때까지는 다시 돌아서지 않는다. */
  returning?: boolean;
  /** 시연 연출로 잠시 세워 둔다(자는 중·유도등 확인 중). 저장하지 않고 장면이 매번 정한다. 서버 경로·위험 판정은 그대로다. */
  hold?: boolean;
  /** 경보로 대피를 시작했다. 한 번 시작하면 경보가 해제돼도 탈출할 때까지 이어 간다. 초기화(새 실행)에서만 처음으로 돌아간다. */
  started?: boolean;
};

/**
 * 건물별 시연 인원의 시작 위치. 문 목록에서 뽑지 않고 따로 적어 둔 자료(data/space/*-people-*.json)를 쓴다.
 * 문·방 안 지점·출구가 늘어도 인원과 사람 번호(1인칭 대상, 새로고침 복원)는 바뀌지 않는다.
 */
const STARTS: Readonly<Record<string, readonly string[]>> = { [wfiPeople.building_id]: wfiPeople.start_node_ids };

/** 시작 위치마다 한 명. 배치 자료가 없는 건물만 예전처럼 방 입구(DOOR)마다 한 명을 세운다. */
export function spawnPeople(building: Building): Person[] {
  const known = new Set(building.nodes.map((node) => node.node_id));
  const starts = STARTS[building.building_id]?.filter((nodeId) => known.has(nodeId))
    ?? building.nodes.filter((node) => node.kind === "DOOR").map((node) => node.node_id);
  return starts.map((nodeId) => ({ from: nodeId, to: null, progress: 0, status: "WAITING" as const }));
}

/**
 * metres만큼 걷는다.
 * - 경보(alarm)가 난 적이 없으면 제자리에서 기다린다(WAITING). 처음부터 평상시면 아무도 움직이지 않는다.
 * - 경보로 대피를 시작한 사람은 경보가 해제돼도 탈출할 때까지 계속 걷는다. 걸음마다 그때의 최신 서버 경로를 따른다.
 * - 경로가 없는 지점이거나 연결이 끊겨 상태가 유효하지 않으면(valid=false) 멈추고(STUCK), 돌아오면 이어 간다.
 * - 출구에 닿으면 OUT이고 다시 움직이지 않는다.
 */
export function stepPeople(
  people: Person[],
  routes: ReadonlyMap<string, Route>,
  alarm: boolean,
  lengthOf: (from: string, to: string) => number,
  metres: number,
  valid = true,
): void {
  for (const person of people) {
    if (person.status === "OUT") continue;
    // 오래된 상태의 경보로 대피를 시작하지 않는다.
    if (alarm && valid) person.started = true;
    if (person.started !== true) {
      person.status = "WAITING";
      continue;
    }
    if (person.hold === true) {
      person.status = "WAITING";
      continue;
    }
    if (!valid) {
      person.status = "STUCK";
      continue;
    }
    let budget = metres;
    // 한 번에 여러 지점을 지나칠 수 있어 반복한다. 잘못된 자료로 무한히 돌지 않게 횟수를 묶는다.
    for (let hop = 0; hop < 16; hop += 1) {
      if (person.to === null) {
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
      // 돌아가는 동안에는 돌아갈 지점의 안내를 확인한다. 방금 떠난 위험 지점의 안내는 쓰지 않는다.
      const guidance = routes.get(person.returning === true ? person.to : person.from);
      const lost = guidance === undefined || guidance.reason_codes.length > 0;
      // 지나온 지점이 막혀도 가던 쪽에 경로가 있으면 계속 걷는다. 위험해진 자리 옆 통로에 서 있지 않는다.
      const ahead = person.returning === true ? undefined : routes.get(person.to);
      if (lost && (ahead === undefined || ahead.reason_codes.length > 0)) {
        person.status = "STUCK";
        break;
      }
      if (!lost && person.returning !== true && guidance.next_node_id !== null && guidance.next_node_id !== person.to) {
        [person.from, person.to] = [person.to, person.from];
        person.progress = 1 - person.progress;
        person.returning = true;
      }
      person.status = "MOVING";
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

/**
 * 한 번에 따라잡는 실제 시간의 상한(초). 상태 조회를 최신으로 치는 시간(2초)과 같다.
 * 이보다 오래 멈춰 있었다면 그 사이의 서버 경로를 모르므로, 밀린 시간을 지금 경로로 한꺼번에 걷지 않는다.
 */
export const MAX_CATCH_UP_SECONDS = 2;

/**
 * 지난 실제 시간 중 이번에 걸을 시간과 반영하지 못하는 시간.
 * 화면을 그리는 횟수와 무관하게 실제 지난 시간만큼 걷는다. 전에는 한 프레임을 0.2초로 묶어,
 * 1fps에서는 10초 동안 2초 분량만 걸었고 그 사이 서버의 화재만 진행했다(#202).
 */
export function walkTime(elapsedSeconds: number): { walk: number; lost: number } {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const walk = Math.min(elapsed, MAX_CATCH_UP_SECONDS);
  return { walk, lost: elapsed - walk };
}

export type PeopleCount = {
  readonly total: number;
  readonly moving: number;
  readonly out: number;
  readonly stuck: number;
  readonly waiting: number;
  /** 전원이 탈출했다. 초기화 전까지 유지된다. */
  readonly done: boolean;
  /** 화면이 오래 멈춰 대피 중 이동에 반영하지 못한 시간(초). 0이면 실제 시간과 맞는다. */
  readonly lostSeconds: number;
};

export function countPeople(people: readonly Person[], lostSeconds = 0): PeopleCount {
  const count = (status: PersonStatus) => people.filter((person) => person.status === status).length;
  const out = count("OUT");
  return { total: people.length, moving: count("MOVING"), out, stuck: count("STUCK"), waiting: count("WAITING"), done: people.length > 0 && out === people.length, lostSeconds: Math.floor(lostSeconds) };
}

/**
 * 대피 인원의 진행 상태를 이 브라우저에 저장해 새로고침 뒤에 이어 간다.
 * 사람의 위치는 서버가 아니라 이 브라우저만 알고 있다. 방·실행·건물 버전이 모두 같을 때만 되살린다.
 * 화면이 닫혀 있던 동안의 이동은 계산하지 않는다. 저장된 자리에서 최신 서버 경로를 보고 다시 걷는다.
 * shortcut: 한 브라우저 안에서만 유지된다, 기기 사이에 같은 위치를 보여야 하면 서버가 위치를 가져야 한다.
 */
import type { Building } from "@contracts";

import type { Person, PersonStatus } from "./people";
import { spawnPeople } from "./people";

const PREFIX = "saferoute-people/";
const STATUSES: readonly PersonStatus[] = ["WAITING", "MOVING", "OUT", "STUCK"];

export type SavedPeople = { readonly people: Person[]; readonly follow: number | null };

export function peopleKey(scope: string, runId: string, building: Building): string {
  return `${PREFIX}${scope}/${runId}/${building.building_id}@${building.building_version}`;
}

export function savePeople(storage: Storage, scope: string, runId: string, building: Building, people: readonly Person[], follow: number | null): void {
  const key = peopleKey(scope, runId, building);
  // 그 방의 이전 실행 기록은 다시 쓸 일이 없다. 초기화할 때마다 쌓이지 않게 지운다.
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const other = storage.key(index);
    if (other !== null && other !== key && other.startsWith(`${PREFIX}${scope}/`)) storage.removeItem(other);
  }
  storage.setItem(key, JSON.stringify({ people, follow }));
}

/** 저장된 상태. 없거나, 깨졌거나, 지금 건물과 맞지 않으면 null이다. */
export function loadPeople(storage: Storage, scope: string, runId: string, building: Building): SavedPeople | null {
  const raw = storage.getItem(peopleKey(scope, runId, building));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { people?: unknown; follow?: unknown };
    const nodes = new Set(building.nodes.map((node) => node.node_id));
    const expected = spawnPeople(building).length;
    if (!Array.isArray(value.people) || value.people.length !== expected) return null;
    const people: Person[] = [];
    for (const item of value.people as Partial<Person>[]) {
      const valid = typeof item.from === "string" && nodes.has(item.from)
        && (item.to === null || (typeof item.to === "string" && nodes.has(item.to)))
        && typeof item.progress === "number" && item.progress >= 0 && item.progress <= 1
        && STATUSES.includes(item.status as PersonStatus);
      if (!valid) return null;
      people.push({ from: item.from as string, to: item.to as string | null, progress: item.progress as number,
        status: item.status as PersonStatus, returning: item.returning === true, started: item.started === true });
    }
    const follow = typeof value.follow === "number" && Number.isInteger(value.follow) && value.follow >= 0 && value.follow < expected ? value.follow : null;
    return value.follow !== null && follow === null ? null : { people, follow };
  } catch {
    return null;
  }
}

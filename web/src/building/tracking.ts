/**
 * 추적하는 사람의 지금 위치에서 출구까지 남은 길(노란 선). 카메라 시점과 무관하다.
 * 경로를 계산하지 않는다. 걷고 있는 구간의 남은 부분에, 향하는 지점의 서버 경로를 이어 붙일 뿐이다.
 * 계단은 사람이 실제로 걷는 꺾은선을 그대로 쓴다.
 */
import type * as THREE from "three";
import type { Route } from "@contracts";
import type { Person } from "./people";
import type { StairTravel } from "./stairs";
import { alongStair } from "./stairs";

export type TrackNode = { readonly floor_id: string; readonly position: { readonly x: number; readonly y: number; readonly z: number } };
export type TrackPiece = { readonly from: THREE.Vector3; readonly to: THREE.Vector3; readonly floors: readonly [string, string] };
export type Track = {
  readonly pieces: readonly TrackPiece[];
  /** 향하는 지점에 출구까지 가는 서버 경로가 있다. 없으면 걷던 구간까지만 그린다. */
  readonly reachesExit: boolean;
};

export function remainingTrack(
  person: Pick<Person, "from" | "to" | "progress" | "status">,
  routes: ReadonlyMap<string, Route>,
  nodeOf: (nodeId: string) => TrackNode | undefined,
  pointOf: (node: TrackNode) => THREE.Vector3,
  stairOf: (fromId: string, toId: string) => StairTravel | null,
  height = 1.1,
): Track {
  const pieces: TrackPiece[] = [];
  if (person.status === "OUT") return { pieces, reachesExit: true };
  const lifted = (point: THREE.Vector3) => point.clone().setY(point.y + height);
  const link = (fromId: string, toId: string, progress: number) => {
    const from = nodeOf(fromId);
    const to = nodeOf(toId);
    if (from === undefined || to === undefined) return;
    const floors = [from.floor_id, to.floor_id] as const;
    const stair = stairOf(fromId, toId);
    if (stair === null) {
      pieces.push({ from: lifted(pointOf(from).lerp(pointOf(to), progress)), to: lifted(pointOf(to)), floors });
      return;
    }
    const here = alongStair(stair, progress);
    let last = lifted(here.point);
    for (let index = here.index + 1; index < stair.points.length; index += 1) {
      const next = lifted(stair.points[index]);
      pieces.push({ from: last, to: next, floors });
      last = next;
    }
  };
  if (person.to !== null) link(person.from, person.to, person.progress);
  const route = routes.get(person.to ?? person.from);
  if (route === undefined || route.reason_codes.length > 0) return { pieces, reachesExit: false };
  for (let index = 1; index < route.path_node_ids.length; index += 1) link(route.path_node_ids[index - 1], route.path_node_ids[index], 0);
  return { pieces: pieces.filter((piece) => piece.from.distanceToSquared(piece.to) > 1e-6), reachesExit: true };
}

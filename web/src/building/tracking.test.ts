import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Building, Route } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { parseGeometry } from "./geometry";
import { alongStair, stairTravel } from "./stairs";
import { remainingTrack } from "./tracking";
import { floorLift } from "./view";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
const route = (path: string[], reasons: string[] = []): Route => ({ node_id: path[0], next_node_id: path[1] ?? null, exit_id: reasons.length ? null : "EXIT-NW", path_node_ids: reasons.length ? [] : path, cost: 1, reason_codes: reasons } as Route);

function track(person: Parameters<typeof remainingTrack>[0], routes: Route[], spread = 0) {
  const lift = floorLift(geometry, spread);
  const point = (node: { floor_id: string; position: { x: number; y: number; z: number } }) => new THREE.Vector3(node.position.x, node.position.y + lift(node.floor_id), node.position.z);
  const stair = (a: string, b: string) => stairTravel(building, geometry, lift, nodes.get(a)!, nodes.get(b)!);
  return { result: remainingTrack(person, new Map(routes.map((item) => [item.node_id, item])), (id) => nodes.get(id), point, stair, 0), stair, point };
}

describe("추적 인물의 남은 경로", () => {
  it("출발 지점이 아니라 지금 걷는 자리에서 시작해 서버 경로로 출구까지 이어진다", () => {
    const { result } = track({ from: "F1-J-LA", to: "F1-J-LE", progress: 0.5, status: "MOVING" }, [route(["F1-J-LE", "F1-J-LNW", "F1-X-NW"])]);
    const a = nodes.get("F1-J-LA")!.position;
    const b = nodes.get("F1-J-LE")!.position;
    expect(result.reachesExit).toBe(true);
    expect(result.pieces[0].from.x).toBeCloseTo((a.x + b.x) / 2);
    expect(result.pieces[0].from.z).toBeCloseTo((a.z + b.z) / 2);
    expect(result.pieces.at(-1)!.to.x).toBeCloseTo(nodes.get("F1-X-NW")!.position.x);
    // 끊긴 데 없이 이어진다.
    result.pieces.slice(1).forEach((piece, index) => expect(piece.from.distanceTo(result.pieces[index].to)).toBeCloseTo(0));
  });

  it.each([0, 6])("층 간격 %s: 계단 중간에서도 사람이 선 자리부터 디딤판을 따라 이어진다", (spread) => {
    const person = { from: "F3-S-A", to: "F2-S-A", progress: 0.4, status: "MOVING" as const };
    const { result, stair } = track(person, [route(["F2-S-A", "F1-S-A", "F1-J-LA"])], spread);
    const here = alongStair(stair("F3-S-A", "F2-S-A")!, 0.4).point;
    expect(result.pieces[0].from.distanceTo(here)).toBeCloseTo(0);
    result.pieces.slice(1).forEach((piece, index) => expect(piece.from.distanceTo(result.pieces[index].to)).toBeCloseTo(0));
    // 계단 구간은 곧은 선 하나가 아니라 여러 조각이다.
    expect(result.pieces.filter((piece) => piece.floors[0] !== piece.floors[1]).length).toBeGreaterThan(20);
  });

  it("서버 경로가 바뀌면 바뀐 경로를 따르고, 경로가 없으면 걷던 구간에서 끝난다", () => {
    const person = { from: "F3-J-R0", to: "F3-J-N5", progress: 0.2, status: "MOVING" as const };
    const south = track(person, [route(["F3-J-N5", "F3-J-R1", "F3-J-R2"])]).result;
    const west = track(person, [route(["F3-J-N5", "F3-J-N6", "F3-J-N4"])]).result;
    expect(south.pieces.at(-1)!.to.z).toBeCloseTo(nodes.get("F3-J-R2")!.position.z);
    expect(west.pieces.at(-1)!.to.x).toBeCloseTo(nodes.get("F3-J-N4")!.position.x);
    const none = track(person, [route(["F3-J-N5"], ["NO_REACHABLE_EXIT"])]).result;
    expect(none.reachesExit).toBe(false);
    expect(none.pieces).toHaveLength(1);
  });

  it("탈출한 사람에게는 그릴 길이 없다", () => {
    expect(track({ from: "F1-X-NW", to: null, progress: 0, status: "OUT" }, []).result.pieces).toHaveLength(0);
  });
});

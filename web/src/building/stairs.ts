/** 계단 디딤판·계단참과 사람·안내 선이 함께 쓰는 이동 경로. */
import * as THREE from "three";
import type { Building } from "@contracts";
import type { BuildingGeometry, GeometryStair, StairStepAlong } from "./geometry";
import { nearestStair, stairCenterline, stairRun } from "./geometry";
import type { FloorLift } from "./view";
import { displayY } from "./view";

/**
 * 계단 한 구간(아래층→위층)의 디딤판. 그릴 때와 사람이 걸을 때 같은 값을 써서 발이 디딤판 위에 놓이게 한다.
 */
function flightEndpoints(building: Building, geometry: BuildingGeometry, stair: GeometryStair, lowerId: string, upperId: string) {
  // 들어서는 지점: 두 층을 잇는 통로 가운데 이 계단으로 이어지는 것의 아래쪽 끝.
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  for (const edge of building.edges) {
    const from = nodes.get(edge.from_node_id);
    const to = nodes.get(edge.to_node_id);
    if (from === undefined || to === undefined || from.floor_id !== lowerId || to.floor_id !== upperId) continue;
    const point = { x: from.position.x, z: from.position.z };
    if (nearestStair(geometry.stairs, lowerId, upperId, point) !== stair) continue;
    return { lower: from, upper: to };
  }
  return null;
}

export function flightSteps(building: Building, geometry: BuildingGeometry, stair: GeometryStair, lowerId: string, upperId: string, lift: FloorLift): readonly StairStepAlong[] {
  const elevation = (id: string) => geometry.floors.find((floor) => floor.floor_id === id)?.elevation ?? 0;
  const entry = flightEndpoints(building, geometry, stair, lowerId, upperId)?.lower.position ?? null;
  // 자료에 이 구간의 중심선이 있으면 그것을 쓴다. 범위만으로 추정한 길은 계단실 가운데 벽과 겹칠 수 있다.
  const flight = stair.flights?.find((item) => item.lower === lowerId && item.upper === upperId);
  const { points, width } = flight === undefined ? stairCenterline(stair, entry) : { points: flight.centerline, width: flight.width };
  return stairRun(points, width, displayY(elevation(lowerId), lowerId, lift), displayY(elevation(upperId), upperId, lift));
}

/** 마지막 디딤판에서 위층 지점까지의 연결 길을 받치는 수평 계단참. */
export function stairLanding(building: Building, geometry: BuildingGeometry, stair: GeometryStair, lowerId: string, upperId: string, lift: FloorLift): StairStepAlong | null {
  const upper = flightEndpoints(building, geometry, stair, lowerId, upperId)?.upper;
  const last = flightSteps(building, geometry, stair, lowerId, upperId, lift).at(-1);
  if (upper === undefined || last === undefined) return null;
  const end = upper.position;
  return {
    x: (last.x + end.x) / 2,
    y: displayY(end.y, upperId, lift),
    z: (last.z + end.z) / 2,
    yaw: Math.atan2(end.x - last.x, end.z - last.z),
    width: last.width,
    run: Math.hypot(end.x - last.x, end.z - last.z) + last.run,
  };
}

type PlacedNode = { readonly floor_id: string; readonly position: { readonly x: number; readonly y: number; readonly z: number } };

/**
 * 층이 다른 두 지점을 잇는 길(a에서 b로). 계단 디딤판을 따라간다. 같은 층이거나 계단을 못 찾으면 null.
 * 사람이 걷는 길과 화면에 그리는 경로 선이 이 값을 함께 써서, 선이 바닥을 뚫거나 사람이 허공으로 떨어지지 않는다.
 */
export function stairLink(building: Building, geometry: BuildingGeometry, lift: FloorLift, a: PlacedNode, b: PlacedNode, height = 0): THREE.Vector3[] | null {
  if (a.floor_id === b.floor_id) return null;
  const [lower, upper] = a.position.y < b.position.y ? [a, b] : [b, a];
  const stair = nearestStair(geometry.stairs, lower.floor_id, upper.floor_id, { x: lower.position.x, z: lower.position.z });
  if (stair === null) return null;
  const point = (node: PlacedNode) => new THREE.Vector3(node.position.x, displayY(node.position.y, node.floor_id, lift) + height, node.position.z);
  const path = [
    point(lower),
    ...flightSteps(building, geometry, stair, lower.floor_id, upper.floor_id, lift).map((step) => new THREE.Vector3(step.x, step.y + height, step.z)),
    point(upper),
  ];
  return a === lower ? path : path.reverse();
}

export type StairTravel = {
  readonly points: readonly THREE.Vector3[];
  readonly lengths: readonly number[];
  readonly length: number;
};

/** 화면 높이와 별개로 실제 계단 길이를 보관한다. 층을 펼쳐도 대피 시간·평면 위치는 바뀌지 않는다. */
export function stairTravel(building: Building, geometry: BuildingGeometry, lift: FloorLift, a: PlacedNode, b: PlacedNode): StairTravel | null {
  const actual = stairLink(building, geometry, () => 0, a, b);
  const points = stairLink(building, geometry, lift, a, b);
  if (actual === null || points === null) return null;
  const lengths = actual.slice(1).map((point, index) => point.distanceTo(actual[index]));
  return { points, lengths, length: lengths.reduce((sum, value) => sum + value, 0) };
}

/** 실제 거리로 정한 진행률을 표시 경로의 같은 구간에 옮긴다. */
export function alongStair(path: StairTravel, ratio: number): { point: THREE.Vector3; heading: THREE.Vector3; index: number } {
  let left = path.length * Math.min(Math.max(ratio, 0), 1);
  for (let index = 0; index < path.lengths.length; index += 1) {
    if (left <= path.lengths[index] || index === path.lengths.length - 1) {
      const share = path.lengths[index] === 0 ? 0 : Math.min(left / path.lengths[index], 1);
      return {
        point: path.points[index].clone().lerp(path.points[index + 1], share),
        heading: path.points[index + 1].clone().sub(path.points[index]),
        index,
      };
    }
    left -= path.lengths[index];
  }
  return { point: path.points[0].clone(), heading: new THREE.Vector3(), index: 0 };
}

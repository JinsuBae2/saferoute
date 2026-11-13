import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import stairLengths from "@space/wfi-stair-travel-v1.json";
import { insidePolygon, nearestStair, parseGeometry, visibleWalls } from "./geometry";
import { alongStair, flightSteps, stairLanding, stairLink, stairTravel } from "./stairs";
import { floorLift } from "./view";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
const links = building.edges.flatMap((edge) => {
  const from = nodes.get(edge.from_node_id)!;
  const to = nodes.get(edge.to_node_id)!;
  return from.position.y < to.position.y ? [{ from, to }] : [];
});

describe("실제 건물 계단참", () => {
  it.each([0, 6])("층 간격 %s에서도 6개 층간 통로의 위층 연결 길 전체를 받친다", (spread) => {
    expect(links).toHaveLength(6);
    const lift = floorLift(geometry, spread);
    for (const { from, to } of links) {
      const stair = nearestStair(geometry.stairs, from.floor_id, to.floor_id, from.position)!;
      const steps = flightSteps(building, geometry, stair, from.floor_id, to.floor_id, lift);
      const landing = stairLanding(building, geometry, stair, from.floor_id, to.floor_id, lift);
      expect(landing, stair.stair_id).not.toBeNull();
      if (landing === null) continue;
      const material = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(landing.width, 0.18, landing.run), material);
      mesh.position.set(landing.x, landing.y - 0.09, landing.z);
      mesh.rotation.y = landing.yaw;
      mesh.updateMatrixWorld();
      const path = stairLink(building, geometry, lift, from, to)!;
      expect(path.at(-2)?.y).toBeCloseTo(to.position.y + lift(to.floor_id));
      expect(path.at(-2)?.x).toBe(steps.at(-1)?.x);
      for (let sample = 0; sample <= 10; sample += 1) {
        const point = path[path.length - 2].clone().lerp(path[path.length - 1], sample / 10);
        const ray = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 0.3, 0)), new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObject(mesh)[0];
        expect(hit, `${from.node_id}→${to.node_id} sample ${sample}`).toBeDefined();
        expect(hit.distance).toBeCloseTo(0.3);
      }
      mesh.geometry.dispose();
      material.dispose();
      expect(stairLink(building, geometry, lift, to, from)).toEqual([...path].reverse());
    }
  });
});

describe("계단 이동과 층 펼침 분리", () => {
  it.each([6, 12])("층 간격 %s에서도 거리·진행률별 평면 위치가 실제 높이일 때와 같다", (spread) => {
    for (const { from, to } of links) {
      for (const [a, b] of [[from, to], [to, from]]) {
        const actual = stairTravel(building, geometry, floorLift(geometry, 0), a, b)!;
        const displayed = stairTravel(building, geometry, floorLift(geometry, spread), a, b)!;
        expect(displayed.length).toBeCloseTo(actual.length);
        expect(displayed.lengths).toEqual(actual.lengths);
        // 같은 속도로 5초 이동한 위치도, 시점 전환 후의 모든 진행률도 같아야 한다.
        for (const ratio of [1.2 * 5 / actual.length, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const original = alongStair(actual, ratio).point;
          const expanded = alongStair(displayed, ratio).point;
          expect(expanded.x).toBeCloseTo(original.x);
          expect(expanded.z).toBeCloseTo(original.z);
        }
        expect(displayed.points.at(-1)?.y).toBeCloseTo(b.position.y + floorLift(geometry, spread)(b.floor_id));
      }
    }
  });
});

describe("계단 이동 경로와 벽·바닥", () => {
  // 1인칭에서 벽은 천장까지 선다. 발과 눈(1.6 m)이 그 높이에 있을 때 벽·바닥 안에 들어가면 관통으로 보인다.
  const wallTop = geometry.floor_height - geometry.slab_thickness;
  const MARGIN = 0.1; // 1인칭 카메라의 가까운 절단면
  const clash = (x: number, y: number, z: number, margin: number): string | null => {
    for (const floor of geometry.floors) {
      if (y > floor.elevation - geometry.slab_thickness + 0.01 && y < floor.elevation - 0.01) {
        const open = [...floor.slab_holes.map((hole) => hole.polygon), ...geometry.stairs.filter((stair) => stair.floors.includes(floor.floor_id)).map((stair) => stair.footprint)];
        if (!open.some((polygon) => insidePolygon({ x, z }, polygon))) return `${floor.floor_id} 바닥`;
      }
      if (y < floor.elevation + 0.01 || y > floor.elevation + wallTop - 0.01) continue;
      const wall = visibleWalls(floor, geometry.stairs).find(([x0, z0, x1, z1]) => x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin);
      if (wall !== undefined) return `${floor.floor_id} 벽 [${wall.join(", ")}]`;
    }
    return null;
  };
  it.each(links.map(({ from, to }) => [`${from.node_id}→${to.node_id}`, from, to] as const))("%s 구간에서 발과 눈이 벽·바닥에 여유(0.1 m) 안으로 들어가지 않는다", (_, from, to) => {
    // 지점에 닿는 끝까지 같은 여유로 본다. 층 지점이 벽 면 위에 있으면 여기서 걸린다(버전 5의 F1-S-B가 그랬다).
    const path = stairTravel(building, geometry, floorLift(geometry, 0), from, to)!;
    const hits = new Set<string>();
    for (let step = 0; step <= 600; step += 1) {
      const { point } = alongStair(path, step / 600);
      // 층 바닥에 선 발은 그 층의 벽 높이 안에 있다.
      for (const y of [point.y + 0.02, point.y + 1.6]) {
        const hit = clash(point.x, y, point.z, MARGIN);
        if (hit !== null) hits.add(hit);
      }
    }
    expect([...hits]).toEqual([]);
  });

  it("계단 아래 지점까지 갔다가 되돌아오는 거리가 짧다", () => {
    // 1층 계단 B: 계단 아래 끝에서 지점까지의 평평한 구간. 내려온 사람은 이만큼 갔다가 통로 쪽으로 돌아 나온다.
    const { from, to } = links.find((link) => link.from.node_id === "F1-S-B")!;
    const path = stairTravel(building, geometry, floorLift(geometry, 0), from, to)!;
    expect(path.lengths[0]).toBeLessThan(0.5);
  });
});

describe("계단 이동 길이 자료", () => {
  // 서버 쪽 재검증 스크립트(tools/yeongnam_check.py)가 사람이 실제로 걷는 계단 길이로 이 파일을 읽는다.
  // 형상이나 중심선을 바꾸면 이 시험이 실패하므로, 아래 값으로 파일을 갱신하고 시연 검증을 다시 돌린다.
  it("data/space/wfi-stair-travel-v1.json이 지금 계단 경로의 길이와 같다", () => {
    const now = Object.fromEntries(building.edges.flatMap((edge) => {
      const from = nodes.get(edge.from_node_id)!;
      const to = nodes.get(edge.to_node_id)!;
      const travel = from.floor_id === to.floor_id ? null : stairTravel(building, geometry, floorLift(geometry, 0), from, to);
      return travel === null ? [] : [[`${from.node_id}>${to.node_id}`, Math.round(travel.length * 100) / 100]];
    }));
    expect(stairLengths.metres).toEqual(now);
    expect([stairLengths.building_id, stairLengths.building_version]).toEqual([building.building_id, building.building_version]);
  });
});

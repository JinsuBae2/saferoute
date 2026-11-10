import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { nearestStair, parseGeometry } from "./geometry";
import { flightSteps, stairLanding, stairLink } from "./stairs";
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

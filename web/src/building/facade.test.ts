import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { EXIT_RUN_LENGTH, facadeColumns, facadeParts } from "./facade";
import { parseGeometry } from "./geometry";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const floor = geometry.floors[0];
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));

describe("출구 외벽 통로", () => {
  it("활성 출구 두 곳에서 사람과 미끄럼판이 유리·창틀·하단 띠를 관통하지 않는다", () => {
    const parts = facadeParts(building, floor, 3.8);
    const material = new THREE.MeshBasicMaterial();
    const columns = facadeColumns(building, geometry.floors[1], floor, geometry.floor_height - geometry.slab_thickness);
    const meshes = [...parts.glass, ...parts.frames, ...parts.band, ...columns].map((part) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(part.width, part.height, part.depth), material);
      mesh.position.set(part.x, part.y, part.z);
      mesh.updateMatrixWorld();
      return mesh;
    });
    const exits = building.exits.filter((exit) => exit.enabled && nodes.get(exit.node_id)?.floor_id === floor.floor_id);
    expect(exits).toHaveLength(2);
    for (const exit of exits) {
      const node = nodes.get(exit.node_id)!;
      const inner = nodes.get(building.edges.find((edge) => edge.to_node_id === exit.node_id)!.from_node_id)!;
      const direction = new THREE.Vector3(node.position.x - inner.position.x, 0, node.position.z - inner.position.z).normalize();
      const sideways = new THREE.Vector3(direction.z, 0, -direction.x);
      for (const y of [-0.2, 0.5, 1.6, 2.0]) {
        for (const offset of [-0.6, 0, 0.6]) {
          const start = new THREE.Vector3(node.position.x, y, node.position.z).addScaledVector(sideways, offset).addScaledVector(direction, -0.5);
          const ray = new THREE.Raycaster(start, direction, 0, EXIT_RUN_LENGTH + 0.5);
          expect(ray.intersectObjects(meshes), `${exit.exit_id}, y=${y}, offset=${offset}`).toHaveLength(0);
        }
      }
      const above = new THREE.Raycaster(new THREE.Vector3(node.position.x, 3, node.position.z).addScaledVector(direction, -0.5), direction, 0, 2);
      expect(above.intersectObjects(meshes).length).toBeGreaterThan(0);
    }
    meshes.forEach((mesh) => mesh.geometry.dispose());
    material.dispose();
  });

  it("비활성 출구는 통로를 열지 않고 기존 외벽의 유리 면적을 유지한다", () => {
    const parts = facadeParts({ ...building, exits: building.exits.map((exit) => ({ ...exit, enabled: false })) }, floor, 3.8);
    const xs = floor.slab.map((point) => point.x);
    const zs = floor.slab.map((point) => point.z);
    const perimeter = 2 * (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs));
    expect(parts.glass.reduce((area, panel) => area + Math.max(panel.width, panel.depth) * panel.height, 0)).toBeCloseTo(perimeter * 3.8);
  });
});

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { doorFacing, EXIT_RUN_LENGTH, facadeColumns, facadeParts } from "./facade";
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

  it("대피 출구로 쓰지 않는 후보도 문 자리는 남기되 닫힌 문으로 막아 통로를 열지 않는다", () => {
    const allClosed = facadeParts({ ...building, exits: building.exits.map((exit) => ({ ...exit, enabled: false })) }, floor, 3.8);
    const xs = floor.slab.map((point) => point.x);
    const zs = floor.slab.map((point) => point.z);
    const perimeter = 2 * (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs));
    const area = (boxes: { width: number; depth: number; height: number }[]) => boxes.reduce((sum, panel) => sum + Math.max(panel.width, panel.depth) * panel.height, 0);
    // 유리와 닫힌 문이 외벽을 빈틈없이 덮는다. 출구를 꺼도 문 형상이 사라지거나 뚫리지 않는다.
    expect(area(allClosed.glass) + area(allClosed.closedDoors)).toBeCloseTo(perimeter * 3.8);
    expect(allClosed.closedDoors).toHaveLength(building.exits.length);
    // 실제 자료: 활성 2곳은 열린 통로, 비활성 후보 2곳(EXIT-NW·EXIT-SE)은 닫힌 문.
    const real = facadeParts(building, floor, 3.8);
    expect(real.closedDoors).toHaveLength(building.exits.filter((exit) => !exit.enabled).length);
    expect(real.closedDoors).toHaveLength(2);
  });
});

describe("방 입구 문 방향", () => {
  it("23개 입구 모두 복도 쪽을 향하고, 101호는 외부 출구 후보가 아니라 아래쪽 통로를 향한다", () => {
    const facing = doorFacing(building);
    expect(facing.size).toBe(building.nodes.filter((node) => node.kind === "DOOR").length);
    expect(facing.size).toBe(23);
    expect(facing.get("F1-D-R101")).toBe("F1-J-PS");
    for (const target of facing.values()) expect(nodes.get(target)?.kind).not.toBe("EXIT");
  });

  it("연결 순서가 바뀌거나 출구 쪽 연결이 먼저 와도 101호 문 방향은 그대로다", () => {
    const reordered = { ...building, edges: [...building.edges].reverse() };
    expect(doorFacing(reordered).get("F1-D-R101")).toBe("F1-J-PS");
  });
});

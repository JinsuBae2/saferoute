import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { insidePolygon, parseGeometry, segmentHitsWall, visibleWalls } from "./geometry";
import { facePlace, QR_SIZE, qrMounts, SIGN_HEIGHT, singleBoard } from "./signMount";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
const mounts = qrMounts(building, geometry.floors, geometry.stairs);

describe("유도등 면의 설치 자리", () => {
  it("어느 통로에서 다가와도 마주 보는 면이 있다(출구 표지 제외)", () => {
    const blind: string[] = [];
    for (const sign of building.signs) {
      const here = nodes.get(sign.node_id)!;
      if (here.kind === "EXIT") continue;
      for (const edge of building.edges) {
        const from = nodes.get(edge.from_node_id)!;
        if (edge.to_node_id !== sign.node_id || !edge.traversable || from.floor_id !== here.floor_id) continue;
        const dx = here.position.x - from.position.x;
        const dz = here.position.z - from.position.z;
        const size = Math.hypot(dx, dz);
        if (!sign.faces.some((face) => (face.view_direction.x * dx + face.view_direction.z * dz) / size >= 0.7)) blind.push(`${sign.sign_id} ← ${from.node_id}`);
      }
    }
    expect(blind).toEqual([]);
  });

  it("면은 보는 사람 쪽을 향하고, 다면형은 가운데에서 그쪽으로 나와 있다", () => {
    for (const sign of building.signs) {
      const node = nodes.get(sign.node_id)!;
      for (const face of sign.faces) {
        const place = facePlace(sign, node, face);
        expect(place.normalX * face.view_direction.x + place.normalZ * face.view_direction.z).toBeLessThan(-0.99);
        const out = (place.x - node.position.x) * place.normalX + (place.z - node.position.z) * place.normalZ;
        expect(out).toBeCloseTo(singleBoard(sign) ? 0.052 : 0.55);
      }
    }
    expect(SIGN_HEIGHT - 0.2).toBeGreaterThan(1.9);
  });

  it("앞뒤 두 면뿐인 표지는 판 하나, 옆 방향 면이 있으면 다면형이다", () => {
    const byNode = (nodeId: string) => building.signs.find((sign) => sign.node_id === nodeId)!;
    expect(singleBoard(byNode("F3-S-A"))).toBe(true);
    expect(singleBoard(byNode("F3-J-N5"))).toBe(false);
  });
});

describe("위치 QR 부착 자리", () => {
  it("붙인 QR은 모두 벽면 바로 앞에 있고, 그 지점의 구역 안에서 지점과 서로 보인다", () => {
    expect(mounts.size).toBeGreaterThan(30);
    for (const [signId, mount] of mounts) {
      const sign = building.signs.find((item) => item.sign_id === signId)!;
      const node = nodes.get(sign.node_id)!;
      const floor = geometry.floors.find((item) => item.floor_id === node.floor_id)!;
      const walls = visibleWalls(floor, geometry.stairs);
      const zone = building.zones.find((item) => item.zone_id === node.zone_id)!;
      // 판 바로 뒤(3 cm)는 벽 안이다. 공중에 떠 있지 않다.
      const behind = { x: mount.x - mount.normalX * 0.06, z: mount.z - mount.normalZ * 0.06 };
      expect(walls.some(([x0, z0, x1, z1]) => behind.x >= x0 && behind.x <= x1 && behind.z >= z0 && behind.z <= z1), signId).toBe(true);
      const front = { x: mount.x + mount.normalX * 0.12, z: mount.z + mount.normalZ * 0.12 };
      expect(walls.some(([x0, z0, x1, z1]) => front.x > x0 && front.x < x1 && front.z > z0 && front.z < z1), signId).toBe(false);
      expect(insidePolygon(front, zone.polygon), signId).toBe(true);
      expect(walls.some((wall) => segmentHitsWall(wall, node.position.x, node.position.z, front.x, front.z)), signId).toBe(false);
      expect(Math.hypot(mount.x - node.position.x, mount.z - node.position.z), signId).toBeLessThanOrEqual(3.5);
      // 판 양 끝도 같은 벽면 위에 있다(문틈이나 모서리 밖으로 나가지 않는다).
      for (const side of [-1, 1]) {
        const edge = { x: behind.x - mount.normalZ * (QR_SIZE / 2) * side, z: behind.z + mount.normalX * (QR_SIZE / 2) * side };
        expect(walls.some(([x0, z0, x1, z1]) => edge.x >= x0 && edge.x <= x1 && edge.z >= z0 && edge.z <= z1), signId).toBe(true);
      }
    }
  });

  it("붙일 벽이 없는 지점에는 QR을 두지 않는다(목록에 없음)", () => {
    const without = building.signs.filter((sign) => !mounts.has(sign.sign_id)).map((sign) => sign.node_id);
    // 넓은 로비 한가운데처럼 3.5 m 안에 붙일 안쪽 벽이 없는 지점이다. 바뀌면 문서(yeongnam-demo.md 6절)를 고친다.
    expect(without).toMatchInlineSnapshot(`
      [
        "F1-X-SE",
        "F1-J-LC",
        "F1-J-LM",
      ]
    `);
  });
});

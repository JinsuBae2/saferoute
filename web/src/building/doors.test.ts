import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { doorFacing } from "./facade";
import { doorOpening, parseGeometry, wallBox } from "./geometry";

const building = rawBuilding as unknown as Building;
const geometry = parseGeometry(rawGeometry);

describe("문틀 자리", () => {
  const facing = doorFacing(building);
  const doors = building.nodes.filter((node) => node.kind === "DOOR" && facing.has(node.node_id)).map((node) => {
    const toward = building.nodes.find((item) => item.node_id === facing.get(node.node_id))!;
    const walls = geometry.floors.find((floor) => floor.floor_id === node.floor_id)!.walls;
    return { node, toward, walls, opening: doorOpening(node.position.x, node.position.z, toward.position.x, toward.position.z, walls) };
  });

  it("벽의 개구부를 찾은 문은 틈 가운데에 벽과 같은 줄로 서고, 문틀 폭 안에 벽이 없다", () => {
    for (const { node, walls, opening } of doors.filter((door) => door.opening.found)) {
      const half = opening.width / 2 - 0.02;
      const [x0, x1, z0, z1] = opening.along === "X"
        ? [opening.x - half, opening.x + half, opening.z - 0.05, opening.z + 0.05]
        : [opening.x - 0.05, opening.x + 0.05, opening.z - half, opening.z + half];
      const hit = walls.map(wallBox).some((box) => box.centerX - box.sizeX / 2 < x1 && box.centerX + box.sizeX / 2 > x0 && box.centerZ - box.sizeZ / 2 < z1 && box.centerZ + box.sizeZ / 2 > z0);
      expect(hit, node.node_id).toBe(false);
      expect(Math.hypot(opening.x - node.position.x, opening.z - node.position.z), node.node_id).toBeLessThanOrEqual(1.3);
    }
  });

  it("문틀은 통로 지점이 비스듬히 있어도 축에 맞는다", () => {
    const r302 = doors.find((door) => door.node.node_id === "F3-D-R302")!;
    expect(r302.toward.position.z).not.toBe(r302.node.position.z);
    expect(r302.opening).toMatchObject({ along: "Z", found: true });
  });

  it("개구부를 찾지 못한 문은 정해진 목록뿐이다", () => {
    expect(doors.filter((door) => !door.opening.found).map((door) => door.node.node_id)).toMatchInlineSnapshot(`
      [
        "F1-D-CONF-S",
        "F1-D-R101",
        "F2-D-R202",
        "F3-D-COMMUNITY",
        "F3-D-R305",
      ]
    `);
    expect(doors.map((door) => `${door.node.node_id} ${door.opening.along} ${door.opening.width.toFixed(1)}`)).toMatchInlineSnapshot(`
      [
        "F1-D-R102 X 1.3",
        "F1-D-NURSING X 1.3",
        "F1-D-CONF-N Z 1.3",
        "F1-D-CONF-S Z 1.1",
        "F1-D-R101 Z 1.1",
        "F2-D-SERVER Z 1.1",
        "F2-D-R201 X 1.1",
        "F2-D-R202 X 1.1",
        "F2-D-R203 Z 1.2",
        "F2-D-ADMIN Z 1.1",
        "F2-D-DIRECTOR Z 1.1",
        "F2-D-INDUSTRY X 1.1",
        "F3-D-R308 Z 1.6",
        "F3-D-ROOM-NE X 1.3",
        "F3-D-R300 Z 1.1",
        "F3-D-R301 Z 1.1",
        "F3-D-R302 Z 1.0",
        "F3-D-R303 Z 1.0",
        "F3-D-R304 X 1.2",
        "F3-D-R307 X 1.3",
        "F3-D-R306 Z 0.9",
        "F3-D-COMMUNITY Z 1.1",
        "F3-D-R305 Z 1.1",
        "F2-D-INDUSTRY-E X 1.1",
        "F3-D-R307-N X 1.1",
        "F3-D-R304-E Z 1.1",
      ]
    `);
  });
});

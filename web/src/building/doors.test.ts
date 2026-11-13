import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { doorEnds, doorFacing } from "./facade";
import { doorOpening, doorParts, parseGeometry, wallBox } from "./geometry";

const building = rawBuilding as unknown as Building;
const geometry = parseGeometry(rawGeometry);

describe("문틀 자리", () => {
  const facing = doorFacing(building);
  const doors = building.nodes.filter((node) => node.kind === "DOOR" && facing.has(node.node_id)).map((node) => {
    const toward = building.nodes.find((item) => item.node_id === facing.get(node.node_id))!;
    const walls = geometry.floors.find((floor) => floor.floor_id === node.floor_id)!.walls;
    const ends = doorEnds(building, node.node_id);
    const opening = doorOpening(node.position.x, node.position.z, toward.position.x, toward.position.z, walls);
    return { node, toward, walls, opening, parts: doorParts(opening, node.position.x, node.position.z, toward.position.x, toward.position.z, ends) };
  });

  it("벽의 개구부를 찾은 문은 틈 가운데에 벽과 같은 줄로 서고, 문틀 폭 안에 벽이 없다", () => {
    for (const { node, walls, opening } of doors.filter((door) => door.opening.found)) {
      const half = opening.width / 2 - 0.02;
      const [x0, x1, z0, z1] = opening.along === "X"
        ? [opening.x - half, opening.x + half, opening.z - 0.05, opening.z + 0.05]
        : [opening.x - 0.05, opening.x + 0.05, opening.z - half, opening.z + half];
      const hit = walls.map(wallBox).some((box) => box.centerX - box.sizeX / 2 < x1 && box.centerX + box.sizeX / 2 > x0 && box.centerZ - box.sizeZ / 2 < z1 && box.centerZ + box.sizeZ / 2 > z0);
      expect(hit, node.node_id).toBe(false);
    }
  });

  it("문틀은 통로 지점이 비스듬히 있어도 축에 맞는다", () => {
    const r302 = doors.find((door) => door.node.node_id === "F3-D-R302")!;
    expect(r302.toward.position.z).not.toBe(r302.node.position.z);
    expect(r302.opening).toMatchObject({ along: "Z", found: true });
  });

  // 사람 모형의 몸통(assets.ts createFigure, 반지름 0.17 m)이 걷는 선을 따라갈 때 도형까지의 가장 짧은 거리. 2 cm 간격으로 잰다.
  const BODY = 0.17;
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  const clearance = (from: { x: number; z: number }, to: { x: number; z: number }, rects: readonly (readonly [number, number, number, number])[]) => {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    let least = Infinity;
    for (let gone = 0; gone <= length; gone += 0.02) {
      const [px, pz] = [from.x + (to.x - from.x) * gone / length, from.z + (to.z - from.z) * gone / length];
      for (const [x0, z0, x1, z1] of rects) least = Math.min(least, Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(z0 - pz, 0, pz - z1)));
    }
    return least;
  };
  const flat = building.edges.flatMap((edge) => {
    const [from, to] = [nodes.get(edge.from_node_id)!, nodes.get(edge.to_node_id)!];
    return from.floor_id === to.floor_id && edge.kind !== "STAIR" ? [{ edge, from, to, atDoor: from.kind === "DOOR" || to.kind === "DOOR" }] : [];
  });
  const wallsOf = (floorId: string) => geometry.floors.find((floor) => floor.floor_id === floorId)!.walls;
  const partsOf = (floorId: string) => doors.filter((door) => door.node.floor_id === floorId).flatMap((door) => [...door.parts.jambs, door.parts.leaf]);

  // 문 지점이 끝인 구간에서는 사람을 옆으로 비켜 세우지 않으므로(BuildingScene) 걷는 선이 곧 몸통이 지나는 자리다.
  // 벽 검사와 문틀·문짝 검사는 서로 건너뛰지 않고 따로 한다. 문틀·문짝은 자기 문뿐 아니라 그 층의 모든 문과 잰다.
  it("문을 지나는 모든 구간에서 몸통(반지름 0.17 m)이 벽에 닿지 않는다", () => {
    const hits = flat.filter((leg) => leg.atDoor).flatMap(({ edge, from, to }) => {
      const gap = clearance(from.position, to.position, wallsOf(from.floor_id));
      return gap < BODY ? [`${edge.edge_id} ${gap.toFixed(3)}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("문을 지나는 모든 구간에서 몸통이 그 층 어느 문의 문틀 기둥·열린 문짝에도 닿지 않는다", () => {
    const hits = flat.filter((leg) => leg.atDoor).flatMap(({ edge, from, to }) => {
      const gap = clearance(from.position, to.position, partsOf(from.floor_id));
      return gap < BODY ? [`${edge.edge_id} ${gap.toFixed(3)}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("307호 북쪽 문에서 복도까지 양방향 모두 벽·문틀·문짝과 0.3 m 넘게 떨어져 지난다", () => {
    const path = ["F3-D-R307-N", "F3-D-R308", "F3-J-N1"].map((id) => nodes.get(id)!.position);
    for (const [from, to] of [[path[0], path[1]], [path[1], path[2]], [path[2], path[1]], [path[1], path[0]]]) {
      expect(clearance(from, to, wallsOf("F3"))).toBeGreaterThan(0.3);
      expect(clearance(from, to, partsOf("F3"))).toBeGreaterThan(0.3);
    }
  });

  it("복도 구간의 중심선이 벽·문틀에서 몸통 반지름보다 가까운 곳은 적어 둔 둘뿐이다", () => {
    // 복도 구간에서는 사람을 옆으로 비켜 세우므로 중심선이 실제 자리가 아니다. 줄 세우기와 함께 따로 고칠 일이라 늘지 않게만 지킨다.
    const near = flat.filter((leg) => !leg.atDoor).flatMap(({ edge, from, to }) => {
      const [wall, part] = [clearance(from.position, to.position, wallsOf(from.floor_id)), clearance(from.position, to.position, partsOf(from.floor_id))];
      return Math.min(wall, part) < BODY ? [`${edge.edge_id} ${wall < BODY ? "벽" : "문틀"} ${Math.min(wall, part).toFixed(2)}`] : [];
    });
    expect(near).toEqual(["E-F3-J-W2-F3-J-SW 문틀 0.14", "E-F3-J-SW-F3-J-W2 문틀 0.14", "E-F3-J-R4-F3-J-R2 벽 0.13", "E-F3-J-R2-F3-J-R4 벽 0.13"]);
  });

  it("문틀 기둥은 벽 줄 위에 있고 문짝은 그와 직각으로 방 안쪽에 열려 있다", () => {
    for (const { node, toward, opening, parts: { jambs, leaf } } of doors) {
      const [lx, lz] = [(leaf[0] + leaf[2]) / 2, (leaf[1] + leaf[3]) / 2];
      const [line, towardC, leafC] = opening.along === "X" ? [opening.z, toward.position.z, lz] : [opening.x, toward.position.x, lx];
      for (const jamb of jambs) expect(opening.along === "X" ? (jamb[1] + jamb[3]) / 2 : (jamb[0] + jamb[2]) / 2, node.node_id).toBeCloseTo(line);
      // 문짝은 벽 줄을 기준으로 통로 지점의 반대쪽에 있다.
      expect(Math.sign(leafC - line), node.node_id).toBe(-Math.sign(towardC - line) || 1);
      expect(opening.along === "X" ? leaf[3] - leaf[1] > leaf[2] - leaf[0] : leaf[2] - leaf[0] > leaf[3] - leaf[1], node.node_id).toBe(true);
    }
  });

  it("개구부를 찾지 못한 문은 없다", () => {
    expect(doors.filter((door) => !door.opening.found).map((door) => door.node.node_id)).toEqual([]);
    expect(doors.map((door) => `${door.node.node_id} ${door.opening.along} ${door.opening.width.toFixed(1)} @${door.opening.x.toFixed(2)},${door.opening.z.toFixed(2)}`)).toMatchInlineSnapshot(`
      [
        "F1-D-R102 X 1.3 @13.75,10.85",
        "F1-D-NURSING X 1.3 @11.85,12.80",
        "F1-D-CONF-N Z 1.3 @9.95,11.65",
        "F1-D-CONF-S Z 2.7 @9.95,24.65",
        "F1-D-R101 Z 2.9 @35.35,23.25",
        "F2-D-SERVER Z 1.1 @8.95,6.55",
        "F2-D-R201 X 1.1 @16.65,5.15",
        "F2-D-R202 X 1.5 @37.05,5.65",
        "F2-D-R203 Z 1.2 @37.85,7.70",
        "F2-D-ADMIN Z 1.1 @37.85,16.45",
        "F2-D-DIRECTOR Z 1.1 @37.85,22.15",
        "F2-D-INDUSTRY X 1.1 @14.55,21.15",
        "F3-D-R308 Z 1.6 @9.00,6.30",
        "F3-D-ROOM-NE X 1.3 @34.55,5.35",
        "F3-D-R300 Z 1.1 @37.90,1.65",
        "F3-D-R301 Z 1.1 @37.90,8.65",
        "F3-D-R302 Z 1.0 @37.90,15.60",
        "F3-D-R303 Z 1.0 @37.90,23.90",
        "F3-D-R304 X 1.2 @31.70,21.20",
        "F3-D-R307 X 1.3 @8.15,21.40",
        "F3-D-R306 Z 0.9 @7.40,22.25",
        "F3-D-COMMUNITY Z 1.2 @8.85,22.40",
        "F3-D-R305 Z 1.5 @13.95,22.43",
        "F2-D-INDUSTRY-E Z 1.2 @32.40,22.10",
        "F3-D-R307-N X 1.1 @8.35,7.35",
        "F3-D-R304-E Z 1.1 @35.95,22.15",
      ]
    `);
  });
});

/**
 * 형상 자료 읽기·짝맞춤 시험. 실제 4번이 만든 wfi-geometry-v1.json을 그대로 읽어
 * 형식과 좌표 규칙을 확인한다. 기준은 05번 명세 2.3절과 data/space/README.md 10.1절이다.
 */
import { describe, expect, it } from "vitest";

import type { Building } from "@contracts";
import { building as buildingSample } from "@samples";
import rawGeometry from "@space/wfi-geometry-v1.json";
import rawBuilding from "@space/wfi-v1.json";

import {
  GeometryFormatError,
  insidePolygon,
  isInsideOpenStair,
  matchesBuilding,
  nearestStair,
  parseGeometry,
  stairCenterline,
  stairRun,
  stairSteps,
  visibleWalls,
  wallBox,
} from "./geometry";

describe("계단 디딤판", () => {
  it("긴 변을 따라 아래층에서 위층 바닥까지 오르고, 뒤집으면 반대쪽에서 시작한다", () => {
    const footprint = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 6 }, { x: 0, z: 6 }];
    const steps = stairSteps(footprint, 0, 4, false, 4);
    expect(steps.map((step) => step.centerZ)).toEqual([0.75, 2.25, 3.75, 5.25]);
    expect(steps.map((step) => step.centerY)).toEqual([1, 2, 3, 4]);
    expect(steps[0]).toMatchObject({ centerX: 1, sizeX: 2, sizeZ: 1.5 });
    expect(stairSteps(footprint, 0, 4, true, 4).map((step) => step.centerZ)).toEqual([5.25, 3.75, 2.25, 0.75]);
  });
});

const GEOMETRY = parseGeometry(rawGeometry);

function buildingLike(patch: Partial<Building>): Building {
  return { ...(buildingSample as Building), ...patch };
}

describe("실제 형상 파일 읽기", () => {
  it("1~3층과 계단 4개를 읽는다", () => {
    expect(GEOMETRY.building_id).toBe("WFI");
    expect(GEOMETRY.floors.map((floor) => floor.floor_id)).toEqual(["F1", "F2", "F3"]);
    expect(GEOMETRY.stairs.map((stair) => stair.stair_id).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("층 높이는 4m 간격이고 벽 높이·바닥 두께가 들어 있다", () => {
    expect(GEOMETRY.floors.map((floor) => floor.elevation)).toEqual([0, 4, 8]);
    expect(GEOMETRY.wall_height).toBeGreaterThan(0);
    expect(GEOMETRY.slab_thickness).toBeGreaterThan(0);
  });

  it("2층에만 뚫린 공간이 있다", () => {
    const holes = GEOMETRY.floors.map((floor) => floor.slab_holes.length);
    expect(holes).toEqual([0, 1, 0]);
    const voidHole = GEOMETRY.floors[1].slab_holes[0];
    expect(voidHole.zone_id).toBe("F2-VOID");
    expect(voidHole.polygon.length).toBeGreaterThanOrEqual(3);
  });

  it("계단 A·B는 밀폐, C·D는 열린 계단이다", () => {
    const kinds = Object.fromEntries(GEOMETRY.stairs.map((stair) => [stair.stair_id, stair.kind]));
    expect(kinds).toEqual({ A: "ENCLOSED", B: "ENCLOSED", C: "OPEN", D: "OPEN" });
  });
});

describe("형식 거부", () => {
  it("다른 형식이나 지원하지 않는 형식 버전은 거부한다", () => {
    expect(() => parseGeometry({ ...rawGeometry, format: "something-else" })).toThrow(GeometryFormatError);
    expect(() => parseGeometry({ ...rawGeometry, format_version: 2 })).toThrow(GeometryFormatError);
  });

  it("좌표가 수가 아니면 거부한다", () => {
    const broken = {
      ...rawGeometry,
      floors: [{ ...rawGeometry.floors[0], slab: [{ x: "0", z: 0 }] }, ...rawGeometry.floors.slice(1)],
    };
    expect(() => parseGeometry(broken)).toThrow(GeometryFormatError);
  });

  it("벽이 네 숫자가 아니면 거부한다", () => {
    const broken = {
      ...rawGeometry,
      floors: [{ ...rawGeometry.floors[0], walls: [[0, 0, 1]] }, ...rawGeometry.floors.slice(1)],
    };
    expect(() => parseGeometry(broken)).toThrow(GeometryFormatError);
  });
});

describe("건물 짝맞춤 (명세 2.3절)", () => {
  it("건물 ID와 자료 버전이 모두 같아야 함께 쓴다", () => {
    const building = buildingLike({
      building_id: GEOMETRY.building_id,
      building_version: GEOMETRY.building_version,
      floors: GEOMETRY.floors.map((floor) => ({
        floor_id: floor.floor_id,
        label: floor.floor_id,
        elevation: floor.elevation,
      })),
    });
    expect(matchesBuilding(GEOMETRY, building)).toEqual({ matched: true });
  });

  it("자료 버전이 다르면 3D를 그리지 않는다", () => {
    const building = buildingLike({
      building_id: GEOMETRY.building_id,
      building_version: GEOMETRY.building_version + 1,
    });
    expect(matchesBuilding(GEOMETRY, building)).toMatchObject({
      matched: false,
      reason: "BUILDING_VERSION",
    });
  });

  it("건물 ID가 다르면 3D를 그리지 않는다", () => {
    const building = buildingLike({ building_id: "TWO_ROUTE" });
    expect(matchesBuilding(GEOMETRY, building)).toMatchObject({
      matched: false,
      reason: "BUILDING_ID",
    });
  });

  it("형상에 없는 층이 공간 자료에 있으면 거부한다", () => {
    const building = buildingLike({
      building_id: GEOMETRY.building_id,
      building_version: GEOMETRY.building_version,
      floors: [{ floor_id: "B1", label: "지하 1층", elevation: -4 }],
    });
    expect(matchesBuilding(GEOMETRY, building)).toMatchObject({
      matched: false,
      reason: "MISSING_FLOOR",
      detail: "B1",
    });
  });
});

describe("벽 상자 변환", () => {
  it("좌표 순서가 뒤집혀도 같은 직사각형으로 읽는다", () => {
    expect(wallBox([10, 2, 4, 8])).toEqual(wallBox([4, 8, 10, 2]));
  });

  it("두께가 0인 벽도 보이도록 최소 폭을 준다", () => {
    const box = wallBox([1, 5, 9, 5]);
    expect(box.sizeX).toBe(8);
    expect(box.sizeZ).toBeGreaterThan(0);
    expect(box.centerX).toBe(5);
    expect(box.centerZ).toBe(5);
  });
});

describe("열린 계단 안의 난간 선 숨기기 (README 10.1절)", () => {
  const openStair = GEOMETRY.stairs.find((stair) => stair.stair_id === "C");

  it("계단 C는 열린 계단으로 읽힌다", () => {
    expect(openStair?.kind).toBe("OPEN");
  });

  it("열린 계단 범위 안의 벽은 그리지 않는다", () => {
    const stair = openStair;
    if (stair === undefined) throw new Error("계단 C가 없습니다");
    const xs = stair.footprint.map((point) => point.x);
    const zs = stair.footprint.map((point) => point.z);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midZ = (Math.min(...zs) + Math.max(...zs)) / 2;

    expect(isInsideOpenStair([midX - 0.2, midZ, midX + 0.2, midZ + 0.1], "F1", GEOMETRY.stairs)).toBe(true);
    // 계단 C는 F1·F2만 잇는다. 3층의 같은 자리 벽은 숨기지 않는다.
    expect(isInsideOpenStair([midX - 0.2, midZ, midX + 0.2, midZ + 0.1], "F3", GEOMETRY.stairs)).toBe(false);
  });

  it("밀폐 계단 안의 벽은 그대로 그린다", () => {
    const enclosed = GEOMETRY.stairs.find((stair) => stair.stair_id === "A");
    if (enclosed === undefined) throw new Error("계단 A가 없습니다");
    const xs = enclosed.footprint.map((point) => point.x);
    const zs = enclosed.footprint.map((point) => point.z);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midZ = (Math.min(...zs) + Math.max(...zs)) / 2;
    expect(isInsideOpenStair([midX, midZ, midX + 0.1, midZ + 0.1], "F1", GEOMETRY.stairs)).toBe(false);
  });

  it("숨긴 뒤에도 각 층에 그릴 벽이 남는다", () => {
    for (const floor of GEOMETRY.floors) {
      const kept = visibleWalls(floor, GEOMETRY.stairs);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThanOrEqual(floor.walls.length);
    }
  });
});

describe("다각형 포함 판정", () => {
  const square = [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
    { x: 0, z: 10 },
  ];

  it("안과 밖을 구분한다", () => {
    expect(insidePolygon({ x: 5, z: 5 }, square)).toBe(true);
    expect(insidePolygon({ x: 15, z: 5 }, square)).toBe(false);
    expect(insidePolygon({ x: 5, z: -1 }, square)).toBe(false);
  });
});

describe("안내도 모양의 계단", () => {
  const stair = (id: string) => GEOMETRY.stairs.find((item) => item.stair_id === id)!;

  it("밀폐 계단은 들어선 쪽으로 되돌아오는 꺾인 계단이다", () => {
    const { points } = stairCenterline(stair("A"), null);
    expect(points).toHaveLength(4);
    // 올라가는 줄과 되돌아오는 줄이 나란하고, 시작과 끝이 같은 쪽에 있다.
    expect(points[0].z).toBeCloseTo(points[3].z);
    expect(points[0].x).not.toBeCloseTo(points[3].x);
  });

  it("들어서는 지점 쪽에서 시작하도록 방향을 맞춘다", () => {
    const base = stairCenterline(stair("D"), null).points;
    const flipped = stairCenterline(stair("D"), base[base.length - 1]).points;
    expect(flipped[0]).toEqual(base[base.length - 1]);
  });

  it("밀폐 계단은 두 줄 가운데 들어서는 지점에 가까운 줄에서 시작한다", () => {
    const base = stairCenterline(stair("A"), null).points;
    expect(stairCenterline(stair("A"), base[3]).points[0]).toEqual(base[3]);
  });

  it("계단 지점이 계단 범위 밖(앞 복도)에 있어도 두 층을 잇는 가장 가까운 계단을 고른다", () => {
    const stairs = [stair("A"), stair("B"), stair("C"), stair("D")];
    // 실제 자료의 계단 지점 좌표. 대부분 계단 범위 바깥이다.
    expect(nearestStair(stairs, "F1", "F2", { x: 14.0, z: 16.2 })?.stair_id).toBe("A");
    expect(nearestStair(stairs, "F1", "F2", { x: 37.2, z: 15.9 })?.stair_id).toBe("B");
    expect(nearestStair(stairs, "F2", "F3", { x: 34.1, z: 15.2 })?.stair_id).toBe("B");
    expect(nearestStair(stairs, "F1", "F2", { x: 23.0, z: 16.0 })?.stair_id).toBe("C");
    // C가 더 가깝더라도 2·3층을 잇지 않으므로 D를 고른다.
    expect(nearestStair(stairs, "F2", "F3", { x: 27.8, z: 16.5 })?.stair_id).toBe("D");
    expect(nearestStair(stairs, "F1", "F9", { x: 0, z: 0 })).toBeNull();
  });

  it("실제 건물의 층간 통로는 모두 계단을 찾고, 계단 길이 그 통로의 양 끝 지점 가까이에서 시작하고 끝난다", () => {
    const building = rawBuilding as unknown as Building;
    const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
    const links = building.edges.flatMap((edge) => {
      const from = nodes.get(edge.from_node_id)!;
      const to = nodes.get(edge.to_node_id)!;
      return from.floor_id !== to.floor_id && from.position.y < to.position.y ? [{ from, to }] : [];
    });
    expect(links).toHaveLength(6);
    for (const { from, to } of links) {
      const entry = { x: from.position.x, z: from.position.z };
      const found = nearestStair(GEOMETRY.stairs, from.floor_id, to.floor_id, entry);
      expect(found, from.node_id).not.toBeNull();
      const { points } = stairCenterline(found!, entry);
      const gap = (point: { x: number; z: number }, node: typeof from) => Math.hypot(point.x - node.position.x, point.z - node.position.z);
      // 계단 앞 복도에서 첫 디딤판까지, 마지막 디딤판에서 위층 지점까지 몇 걸음 이내여야 한다.
      // 꺾인 계단은 올라간 줄의 옆줄로 내려서므로 위쪽은 계단참 폭만큼 여유를 둔다.
      expect(gap(points[0], from), `${from.node_id} 시작`).toBeLessThan(2.5);
      expect(gap(points[points.length - 1], to), `${to.node_id} 끝`).toBeLessThan(3);
    }
  });

  it("디딤판은 중심선을 따라 아래층에서 위층 바닥까지 고르게 오른다", () => {
    const { points, width } = stairCenterline(stair("C"), null);
    const steps = stairRun(points, width, 0, 4);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(steps[steps.length - 1].y).toBeCloseTo(4);
    for (let index = 1; index < steps.length; index += 1) expect(steps[index].y).toBeGreaterThan(steps[index - 1].y);
  });
});

/**
 * 형상 자료 읽기·짝맞춤 시험. 실제 4번이 만든 wfi-geometry-v1.json을 그대로 읽어
 * 형식과 좌표 규칙을 확인한다. 기준은 05번 명세 2.3절과 data/space/README.md 10.1절이다.
 */
import { describe, expect, it } from "vitest";

import type { Building } from "@contracts";
import { building as buildingSample } from "@samples";
import rawGeometry from "@space/wfi-geometry-v1.json";

import {
  GeometryFormatError,
  insidePolygon,
  isInsideOpenStair,
  matchesBuilding,
  parseGeometry,
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

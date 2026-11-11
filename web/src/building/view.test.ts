/**
 * 3D 화면 배치 계산 시험. 실제 wfi-geometry-v1.json으로 층 펼침과 화면 맞춤을 확인한다.
 */
import { describe, expect, it } from "vitest";

import rawGeometry from "@space/wfi-geometry-v1.json";

import { parseGeometry } from "./geometry";
import { clampTarget, displayY, fitPose, floorLift, planYaw, pointBox, SPREAD_MAX, visibleBox } from "./view";

const GEOMETRY = parseGeometry(rawGeometry);
const ALL = new Set(["F1", "F2", "F3"]);

describe("층 펼침", () => {
  it("간격 0이면 실제 높이 그대로다", () => {
    const lift = floorLift(GEOMETRY, 0);
    expect(["F1", "F2", "F3"].map((id) => displayY(4 * Number(id[1]) - 4, id, lift))).toEqual([0, 4, 8]);
  });

  it("아래층부터 순서대로 간격만큼 더 올린다", () => {
    const lift = floorLift(GEOMETRY, 6);
    expect([lift("F1"), lift("F2"), lift("F3")]).toEqual([0, 6, 12]);
  });

  it("같은 층의 지점과 바닥은 같은 만큼 올라가 층 안에 남는다", () => {
    const lift = floorLift(GEOMETRY, 8);
    const floor = GEOMETRY.floors[1];
    const slabY = displayY(floor.elevation, floor.floor_id, lift);
    const nodeY = displayY(floor.elevation + 1.1, floor.floor_id, lift);
    expect(nodeY - slabY).toBeCloseTo(1.1);
  });

  it("범위 밖 간격은 잘라서 쓴다", () => {
    expect(floorLift(GEOMETRY, 99)("F2")).toBe(SPREAD_MAX);
    expect(floorLift(GEOMETRY, -5)("F3")).toBe(0);
    expect(floorLift(GEOMETRY, Number.NaN)("F3")).toBe(0);
  });

  it("모르는 층은 올리지 않는다", () => {
    expect(floorLift(GEOMETRY, 6)("F9")).toBe(0);
  });
});

describe("바닥 화살표 방향", () => {
  // 기본 화살표 (0, 0, -1)을 y축으로 θ 돌린 방향
  const turned = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

  it.each([
    ["안내도 위쪽", 0, -1],
    ["안내도 아래쪽", 0, 1],
    ["오른쪽", 1, 0],
    ["왼쪽", -1, 0],
    ["오른쪽 위", 3, -4],
  ])("%s으로 가는 통로를 그대로 가리킨다", (_name, dx, dz) => {
    const length = Math.hypot(dx, dz);
    const result = turned(planYaw(dx, dz));
    expect(result.x).toBeCloseTo(dx / length);
    expect(result.z).toBeCloseTo(dz / length);
  });
});

describe("화면 맞춤", () => {
  it("보이는 층이 없으면 상자가 없다", () => {
    expect(visibleBox(GEOMETRY, new Set(), floorLift(GEOMETRY, 0))).toBeNull();
  });

  it("층을 벌리면 상자가 그만큼 높아진다", () => {
    const flat = visibleBox(GEOMETRY, ALL, floorLift(GEOMETRY, 0));
    const spread = visibleBox(GEOMETRY, ALL, floorLift(GEOMETRY, 6));
    expect(flat).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(spread!.maxY - flat!.maxY).toBeCloseTo(12);
  });

  it("한 층만 보면 그 층 높이만 감싼다", () => {
    const box = visibleBox(GEOMETRY, new Set(["F2"]), floorLift(GEOMETRY, 6));
    expect(box!.minY).toBeCloseTo(4 + 6);
    expect(box!.maxY).toBeCloseTo(4 + 6 + GEOMETRY.wall_height);
  });

  it("위에서 보기는 상자 중심 거의 바로 위에 서고, 화면 위쪽이 안내도 위쪽이 되게 아래쪽으로 조금 비켜 선다", () => {
    const box = visibleBox(GEOMETRY, ALL, floorLift(GEOMETRY, 0))!;
    const pose = fitPose(box, "TOP", 50, 1.6);
    expect(pose.position.x).toBeCloseTo(pose.target.x);
    expect(pose.position.z).toBeGreaterThan(pose.target.z);
    expect(pose.position.z - pose.target.z).toBeLessThan(pose.distance * 0.05);
    expect(pose.position.y).toBeGreaterThan(box.maxY);
  });

  it("기본 시점은 바닥보다 위에서 내려다본다", () => {
    const box = visibleBox(GEOMETRY, ALL, floorLift(GEOMETRY, 6))!;
    const pose = fitPose(box, "ANGLE", 50, 1.6);
    expect(pose.position.y).toBeGreaterThan(pose.target.y);
    expect(pose.distance).toBeGreaterThan(0);
  });

  it("회전 중심은 건물 근처로 묶인다", () => {
    const box = visibleBox(GEOMETRY, ALL, floorLift(GEOMETRY, 0))!;
    const clamped = clampTarget({ x: 500, y: -50, z: -500 }, box);
    expect(clamped.x).toBeLessThanOrEqual(box.maxX + 4);
    expect(clamped.y).toBeGreaterThanOrEqual(box.minY);
    expect(clamped.z).toBeGreaterThanOrEqual(box.minZ - 4);
  });
});

describe("한 지점 비추기", () => {
  const point = { x: 10, y: 3, z: -4 };

  it("지점을 가운데 둔 상자를 만든다", () => {
    const box = pointBox(point, 5);
    expect((box.minX + box.maxX) / 2).toBe(point.x);
    expect((box.minY + box.maxY) / 2).toBe(point.y);
    expect((box.minZ + box.maxZ) / 2).toBe(point.z);
  });

  it("전체 보기보다 가깝게 선다", () => {
    const wide = { minX: -50, maxX: 50, minY: 0, maxY: 12, minZ: -50, maxZ: 50 };
    const near = fitPose(pointBox(point, 5), "ANGLE", 50, 1.6);
    expect(near.distance).toBeLessThan(fitPose(wide, "ANGLE", 50, 1.6).distance);
    expect(near.target).toEqual(point);
  });

  it("너비가 0이어도 상자가 찌그러지지 않는다", () => {
    const box = pointBox(point, 0);
    expect(box.maxX - box.minX).toBeGreaterThan(0);
  });
});

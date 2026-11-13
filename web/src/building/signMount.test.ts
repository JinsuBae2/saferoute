import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { insidePolygon, parseGeometry, segmentHitsWall, visibleWalls } from "./geometry";
import rawInstall from "@space/wfi-sign-install-v1.json";
import { faceHidden, fixtureHitsWall, fixtureParts, QR_SIZE, qrMounts, signInstalls } from "./signMount";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
const mounts = qrMounts(building, geometry.floors, geometry.stairs);
const installs = signInstalls(building, geometry.floors);
const wallsOf = (signId: string) => geometry.floors.find((floor) => floor.floor_id === nodes.get(building.signs.find((sign) => sign.sign_id === signId)!.node_id)!.floor_id)!.walls;

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
        // 그쪽을 보는 사람용 면(자료의 view_direction)이 실제로 달려 있어야 한다. 옆벽의 벽부형 한 장이 맡은 면도 달린 것이다.
        if (!sign.faces.some((face) => installs.get(sign.sign_id)!.faces.has(face.face_id) && (face.view_direction.x * dx + face.view_direction.z * dz) / size >= 0.7)) blind.push(`${sign.sign_id} ← ${from.node_id}`);
      }
    }
    expect(blind).toEqual([]);
  });

  it("표시면은 외함 앞면에 있고, 3D가 세우는 도형과 검사하는 도형이 같다", () => {
    for (const install of installs.values()) {
      for (const fixture of install.fixtures) {
        const housings = fixtureParts(fixture, 0.3).filter((part) => part.role === "HOUSING");
        expect(housings.length).toBe(fixture.form === "SOLID" ? fixture.panels.length : 1);
        for (const panel of fixture.panels) {
          // 표시면에서 뒤로 두께 절반만큼 간 자리가 그 면의 외함 가운데다(양면 판은 가운데가 같다).
          const near = Math.min(...housings.map((part) => Math.hypot(panel.x - part.normalX * 0 - part.x, panel.z - part.z)));
          expect(near).toBeCloseTo(fixture.deep / 2);
        }
      }
    }
  });

  it("판 전체와 지지 구조가 벽과 겹치지 않는다", () => {
    const hits = [...installs].flatMap(([signId, install]) => install.fixtures.filter((fixture) => fixtureHitsWall(fixture, wallsOf(signId))).map((fixture) => `${signId} ${fixture.form}`));
    expect(hits).toEqual([]);
    expect(installs.get("SIGN-F3-J-W2")!.fixtures.length).toBeGreaterThan(0);
    // 검사가 실제로 겹침을 잡는지: 벽 위로 옮기면 겹친다.
    const fixture = installs.get("SIGN-F3-J-N5")!.fixtures[0];
    const [x0, z0] = wallsOf("SIGN-F3-J-N5")[0];
    expect(fixtureHitsWall({ ...fixture, x: x0 + 0.01, z: z0 + 0.01, panels: fixture.panels.map((panel) => ({ ...panel, x: panel.x - fixture.x + x0 + 0.01, z: panel.z - fixture.z + z0 + 0.01 })) }, wallsOf("SIGN-F3-J-N5"))).toBe(true);
  });

  it("단 면은 정면 1.5 m 앞에서 벽에 가리지 않는다. 가린 면과 달지 않은 면은 정해진 목록뿐이다", () => {
    const hidden = [...installs].flatMap(([signId, install]) => [...install.faces.values()].filter((face) => faceHidden(face, wallsOf(signId))).map((face) => `${signId}/${face.faceId}`));
    expect(hidden).toMatchInlineSnapshot(`[]`);
    const skipped = building.signs.flatMap((sign) => sign.faces.filter((face) => !installs.get(sign.sign_id)!.faces.has(face.face_id)).map((face) => `${sign.sign_id}/${face.face_id}`));
    expect(skipped).toMatchInlineSnapshot(`
      [
        "SIGN-F2-J-N2/FRONT",
        "SIGN-F2-J-N6/FRONT",
        "SIGN-F2-J-R2/FRONT",
        "SIGN-F2-J-R3/FRONT",
        "SIGN-F2-J-W1/FRONT",
        "SIGN-F2-J-E2/FRONT",
        "SIGN-F2-J-E4/FRONT",
        "SIGN-F3-J-N2/FRONT",
        "SIGN-F3-J-N4/FRONT",
        "SIGN-F3-J-R3/FRONT",
        "SIGN-F3-J-E1/FRONT",
        "SIGN-F3-J-W1/FRONT",
      ]
    `);
  });

  it("검증 스크립트가 읽는 설치 표(data/space/wfi-sign-install-v1.json)가 같은 값이다", () => {
    const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
    const faces = Object.fromEntries([...installs].flatMap(([signId, install]) => [...install.faces.values()].map((face) =>
      [`${signId}/${face.faceId}`, { form: face.form, x: round(face.x), z: round(face.z), y: face.y, tall: face.tall, facing: face.facing, normal_x: round(face.normalX), normal_z: round(face.normalZ) }])));
    expect({ building_id: building.building_id, building_version: building.building_version, faces }).toEqual(rawInstall);
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

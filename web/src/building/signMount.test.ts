import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import rawBuilding from "@space/wfi-v1.json";
import rawGeometry from "@space/wfi-geometry-v1.json";
import { insidePolygon, parseGeometry, segmentHitsWall, visibleWalls } from "./geometry";
import rawInstall from "@space/wfi-sign-install-v1.json";
import { faceHidden, fixtureHitsWall, fixtureParts, QR_SIZE, qrMounts, shownDisplay, signInstalls } from "./signMount";

const building = rawBuilding as Building;
const geometry = parseGeometry(rawGeometry);
const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
const mounts = qrMounts(building, geometry.floors, geometry.stairs);
const installs = signInstalls(building, geometry.floors, geometry.stairs);
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

  it("종류마다 높이·형태·치수가 다르다(NFTC 303, 제품 외형 치수)", () => {
    const count: Record<string, number> = {};
    for (const [signId, install] of installs) {
      const node = nodes.get(building.signs.find((sign) => sign.sign_id === signId)!.node_id)!;
      for (const fixture of install.fixtures) {
        count[`${fixture.kind}/${fixture.form}`] = (count[`${fixture.kind}/${fixture.form}`] ?? 0) + 1;
        const [bottom, top] = [fixture.y - fixture.tall / 2, fixture.y + fixture.tall / 2];
        // 피난구·천장형 통로유도등은 바닥에서 1.5 m 이상, 복도통로유도등은 1 m 이하다.
        if (fixture.kind === "CORRIDOR") expect(top).toBeLessThanOrEqual(1);
        else expect(bottom).toBeGreaterThanOrEqual(1.5);
        expect(fixture.form === "WALL").toBe(fixture.kind === "CORRIDOR");
        // 공간 용도로 나눈다. 복도 구역이 아닌 곳에 복도통로유도등을 두지 않고, 복도에 거실통로유도등을 두지 않는다.
        if (node.kind !== "JUNCTION") expect(fixture.kind).toBe("EXIT");
        else expect(fixture.kind === "HALL").toBe(!node.zone_id.includes("-CORR-"));
        expect([fixture.wide, fixture.tall]).toEqual(fixture.kind === "EXIT" ? [0.51, 0.1625] : fixture.kind === "CORRIDOR" ? [0.147, 0.185] : [0.3, 0.26]);
        const first = fixture.panels[0];
        expect(fixture.form === "SOLID").toBe(!fixture.panels.every((panel) => Math.abs(panel.normalX * first.normalX + panel.normalZ * first.normalZ) > 0.98));
      }
    }
    expect(count).toMatchInlineSnapshot(`
      {
        "CORRIDOR/WALL": 27,
        "CROSSING/CEILING": 9,
        "CROSSING/SOLID": 8,
        "EXIT/CEILING": 8,
        "HALL/SOLID": 9,
      }
    `);
  });

  it("외함은 벽면 앞에 있다: 벽부형 외함의 뒷면이 벽 안으로 들어가지 않는다", () => {
    let walled = 0;
    for (const [signId, install] of installs) {
      for (const fixture of install.fixtures.filter((item) => item.form === "WALL")) {
        walled += 1;
        const [housing] = fixtureParts(fixture, 0.3);
        // 표시면은 외함 앞면에, 외함 뒷면은 벽에서 2 mm 앞에 있다.
        const panel = fixture.panels[0];
        expect(Math.hypot(panel.x - housing.x, panel.z - housing.z)).toBeCloseTo(housing.deep / 2);
        const back = { x: housing.x - housing.normalX * (housing.deep / 2 + 0.004), z: housing.z - housing.normalZ * (housing.deep / 2 + 0.004) };
        const front = { x: housing.x - housing.normalX * (housing.deep / 2 - 0.001), z: housing.z - housing.normalZ * (housing.deep / 2 - 0.001) };
        const inside = (point: { x: number; z: number }) => wallsOf(signId).some(([x0, z0, x1, z1]) => point.x > x0 && point.x < x1 && point.z > z0 && point.z < z1);
        expect(inside(back), signId).toBe(true);
        expect(inside(front), signId).toBe(false);
      }
    }
    expect(walled).toBeGreaterThan(20);
  });

  it("옆벽의 벽부형은 같은 방향을 그 판에서 본 화살표로 그린다", () => {
    // 동쪽(+x)으로 걷는 사람에게 '직진'인 방향은, 북쪽 벽(판이 +z를 향함)의 판을 마주 본 사람에게는 오른쪽이다.
    expect(shownDisplay("FORWARD", 1, 0, 0, 1)).toBe("RIGHT");
    expect(shownDisplay("BACK", 1, 0, 0, 1)).toBe("LEFT");
    // 반대로 걷는 사람(-x)에게 '뒤로'인 같은 방향도 같은 화살표가 된다. 앞뒤 두 면을 판 한 장이 맡을 수 있는 이유다.
    expect(shownDisplay("BACK", -1, 0, 0, 1)).toBe("RIGHT");
    expect(shownDisplay("RIGHT", 1, 0, -1, 0)).toBe("RIGHT");
    expect(shownDisplay("EXIT", 1, 0, 0, 1)).toBe("EXIT");
    for (const [signId, install] of installs) {
      const sign = building.signs.find((item) => item.sign_id === signId)!;
      for (const fixture of install.fixtures.filter((item) => item.faces.length > item.panels.length)) {
        // 한 장이 맡은 면들은, 다음 지점이 무엇이든 그 판에서 같은 화살표가 된다.
        const views = fixture.faces.map((face) => sign.faces.find((item) => item.face_id === face.faceId)!);
        for (const next of Object.keys(views[0].next_node_to_display)) {
          const arrows = views.map((face) => shownDisplay(face.next_node_to_display[next], face.view_direction.x, face.view_direction.z, fixture.panels[0].normalX, fixture.panels[0].normalZ));
          expect(new Set(arrows).size, `${signId} ${next}`).toBe(1);
        }
      }
    }
  });

  it("판 전체와 지지 구조가 벽과 겹치지 않는다", () => {
    const hits = [...installs].flatMap(([signId, install]) => install.fixtures.filter((fixture) => fixtureHitsWall(fixture, wallsOf(signId))).map((fixture) => `${signId} ${fixture.form}`));
    expect(hits).toEqual([]);
    expect(installs.get("SIGN-F3-J-W2")!.fixtures.length).toBeGreaterThan(0);
    // 검사가 실제로 겹침을 잡는지: 벽부형 외함을 벽 쪽으로 1 cm 밀면 겹친다.
    const walled = installs.get("SIGN-F3-J-N5")!.fixtures.find((fixture) => fixture.form === "WALL")!;
    const panel = walled.panels[0];
    expect(fixtureHitsWall({ ...walled, x: walled.x - panel.normalX * 0.01, z: walled.z - panel.normalZ * 0.01 }, wallsOf("SIGN-F3-J-N5"))).toBe(true);
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
      [`${signId}/${face.faceId}`, { kind: face.kind, form: face.form, x: round(face.x), z: round(face.z), y: face.y, tall: face.tall, facing: face.facing, normal_x: round(face.normalX), normal_z: round(face.normalZ) }])));
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

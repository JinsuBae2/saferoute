/**
 * 1~3층 건물 3D 표시. 형상은 wfi-geometry-v1.json, 공간·안내는 서버 결과를 쓴다.
 *
 * 지키는 것
 * - 경로나 방향을 여기서 계산하지 않는다. 서버 Route의 next_node_id로만 화살표를 그린다.
 * - 시험용 연기 정답과 제어기가 관측한 위험을 다른 모양·범례로 표시한다(04번 7.2절).
 * - 열린 계단 C·D 범위 안의 난간 선은 벽으로 그리지 않는다(README 10.1절).
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { Building, StateSnapshot } from "@contracts";

import type { BuildingGeometry } from "./geometry";
import { visibleWalls, wallBox } from "./geometry";

const COLOR = {
  slab: 0x161c24,
  wall: 0x3d4a5a,
  stairEnclosed: 0x3f6b55,
  stairOpen: 0x55504a,
  node: 0x6b7a8c,
  guided: 0x22c55e,
  noRoute: 0x9ca3af,
  blockedAlarm: 0xef4444,
  blockedUnknown: 0xf59e0b,
  sign: 0xe7edf4,
  smoke: 0xf59e0b,
  hazardFire: 0xef4444,
  hazardOther: 0xf59e0b,
} as const;

type Props = {
  readonly geometry: BuildingGeometry;
  readonly building: Building;
  readonly state: StateSnapshot;
  /** 시나리오 실행기의 구역별 연기 정답. 제어 판단과 분리된 시험값이다. */
  readonly smokeByZone: ReadonlyMap<string, number> | null;
  readonly visibleFloors: ReadonlySet<string>;
};

type Handles = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  staticGroup: THREE.Group;
  dynamicGroup: THREE.Group;
  zoneMeshes: Map<string, THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshBasicMaterial>>;
  smokeMeshes: Map<string, THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshBasicMaterial>>;
  disposables: Set<{ dispose(): void }>;
};

function shapeFrom(points: readonly { x: number; z: number }[]): THREE.Shape {
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, point.z);
    else shape.lineTo(point.x, point.z);
  });
  shape.closePath();
  return shape;
}

/**
 * 평면 Shape를 바닥에 눕힌다. Shape의 y가 모델의 z가 된다.
 * 이때 압출 방향은 -y가 되므로, 위로 세우려면 두께만큼 올려 놓아야 한다.
 */
function layFlat(mesh: THREE.Mesh, topY: number) {
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = topY;
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
  }
}

export function BuildingScene({ geometry, building, state, smokeByZone, visibleFloors }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<Handles | null>(null);

  const nodeById = useMemo(
    () => new Map(building.nodes.map((node) => [node.node_id, node])),
    [building],
  );
  const zoneById = useMemo(
    () => new Map(building.zones.map((zone) => [zone.zone_id, zone])),
    [building],
  );
  const sourceById = useMemo(
    () => new Map(building.sources.map((source) => [source.source_id, source])),
    [building],
  );

  // 1) 렌더러·카메라·조작. 한 번만 만든다.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 500);
    camera.position.set(58, 46, 58);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(22, 6, 14);

    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(40, 60, 30);
    scene.add(key);

    const staticGroup = new THREE.Group();
    const dynamicGroup = new THREE.Group();
    scene.add(staticGroup, dynamicGroup);

    const handles: Handles = {
      renderer,
      scene,
      camera,
      controls,
      staticGroup,
      dynamicGroup,
      zoneMeshes: new Map(),
      smokeMeshes: new Map(),
      disposables: new Set(),
    };
    handlesRef.current = handles;

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      clearGroup(staticGroup);
      clearGroup(dynamicGroup);
      for (const item of handles.disposables) item.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      handlesRef.current = null;
    };
  }, []);

  // 2) 정적 형상: 바닥·벽·계단·구역 판. 형상이나 층 표시가 바뀔 때만 다시 만든다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const { staticGroup } = handles;
    clearGroup(staticGroup);
    handles.zoneMeshes.clear();
    handles.smokeMeshes.clear();

    for (const floor of geometry.floors) {
      if (!visibleFloors.has(floor.floor_id)) continue;

      // 바닥. 뚫린 공간은 구멍으로 판다.
      const slabShape = shapeFrom(floor.slab);
      for (const hole of floor.slab_holes) slabShape.holes.push(shapeFrom(hole.polygon));
      const slab = new THREE.Mesh(
        new THREE.ExtrudeGeometry(slabShape, { depth: geometry.slab_thickness, bevelEnabled: false }),
        new THREE.MeshLambertMaterial({ color: COLOR.slab }),
      );
      layFlat(slab, floor.elevation);
      staticGroup.add(slab);

      // 벽. 열린 계단 안의 난간 선은 빼고 하나의 인스턴스 메시로 그린다.
      const walls = visibleWalls(floor, geometry.stairs);
      if (walls.length > 0) {
        const mesh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshLambertMaterial({ color: COLOR.wall }),
          walls.length,
        );
        const matrix = new THREE.Matrix4();
        walls.forEach((wall, index) => {
          const box = wallBox(wall);
          matrix.compose(
            new THREE.Vector3(box.centerX, floor.elevation + geometry.wall_height / 2, box.centerZ),
            new THREE.Quaternion(),
            new THREE.Vector3(box.sizeX, geometry.wall_height, box.sizeZ),
          );
          mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        staticGroup.add(mesh);
      }

      // 구역 판. 관측 위험 표시에 재사용하므로 평소에는 숨겨 둔다.
      for (const zone of building.zones) {
        if (zone.floor_id !== floor.floor_id) continue;
        // 복도 구역은 폭이 2 m 안팎이라 얇은 판으로는 잘 보이지 않는다.
        // 낮은 띠로 두껍게 깔아 위에서도 눈에 들어오게 한다.
        const mesh = new THREE.Mesh(
          new THREE.ExtrudeGeometry(shapeFrom(zone.polygon), { depth: 0.4, bevelEnabled: false }),
          new THREE.MeshBasicMaterial({ color: COLOR.hazardFire, transparent: true, opacity: 0.65 }),
        );
        layFlat(mesh, floor.elevation + 0.42);
        mesh.visible = false;
        staticGroup.add(mesh);
        handles.zoneMeshes.set(zone.zone_id, mesh);

        // 시험용 연기는 차오르는 부피로 그려 관측 위험(바닥 판)과 모양부터 구분한다.
        const smoke = new THREE.Mesh(
          new THREE.ExtrudeGeometry(shapeFrom(zone.polygon), { depth: 1, bevelEnabled: false }),
          new THREE.MeshBasicMaterial({
            color: COLOR.smoke,
            transparent: true,
            opacity: 0.18,
            depthWrite: false,
          }),
        );
        // 압출이 -y로 가므로 두께만큼 올려야 바닥에서 위로 자란다.
        layFlat(smoke, floor.elevation + 1);
        smoke.userData.baseY = floor.elevation;
        smoke.visible = false;
        staticGroup.add(smoke);
        handles.smokeMeshes.set(zone.zone_id, smoke);
      }
    }

    // 계단. 밀폐와 열린 계단을 색으로 구분한다.
    for (const stair of geometry.stairs) {
      const shown = stair.floors.filter((id) => visibleFloors.has(id));
      if (shown.length === 0) continue;
      const elevations = stair.floors
        .map((id) => geometry.floors.find((floor) => floor.floor_id === id)?.elevation)
        .filter((value): value is number => value !== undefined);
      if (elevations.length === 0) continue;
      const bottom = Math.min(...elevations);
      const top = Math.max(...elevations) + geometry.wall_height;
      const mesh = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shapeFrom(stair.footprint), { depth: top - bottom, bevelEnabled: false }),
        new THREE.MeshLambertMaterial({
          color: stair.kind === "ENCLOSED" ? COLOR.stairEnclosed : COLOR.stairOpen,
          transparent: true,
          opacity: stair.kind === "ENCLOSED" ? 0.35 : 0.2,
        }),
      );
      layFlat(mesh, bottom);
      staticGroup.add(mesh);
    }
  }, [geometry, building, visibleFloors]);

  // 3) 서버 결과: 지점 상태·다음 이동 방향·유도등·관측 위험·연기 정답.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const { dynamicGroup } = handles;
    clearGroup(dynamicGroup);

    const blockedReason = new Map(state.blocked_nodes.map((node) => [node.node_id, node.reason_codes]));
    const routeByNode = new Map(state.routes.map((route) => [route.node_id, route]));
    const signNodes = new Map(building.signs.map((sign) => [sign.node_id, sign.sign_id]));
    const signState = new Map(state.signs.map((sign) => [sign.sign_id, sign]));

    const shownNodes = building.nodes.filter((node) => visibleFloors.has(node.floor_id));

    // 지점 표시. 차단·안내 가능·안내 불가를 색으로 나눈다.
    if (shownNodes.length > 0) {
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.45, 12, 10),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
        shownNodes.length,
      );
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      shownNodes.forEach((node, index) => {
        matrix.setPosition(node.position.x, node.position.y + 1.1, node.position.z);
        mesh.setMatrixAt(index, matrix);
        const reasons = blockedReason.get(node.node_id);
        const route = routeByNode.get(node.node_id);
        if (reasons !== undefined) {
          color.setHex(reasons.includes("ACTIVE_ALARM") ? COLOR.blockedAlarm : COLOR.blockedUnknown);
        } else if (route !== undefined && route.reason_codes.length === 0) {
          color.setHex(signNodes.has(node.node_id) ? COLOR.guided : COLOR.node);
        } else {
          color.setHex(COLOR.noRoute);
        }
        mesh.setColorAt(index, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      dynamicGroup.add(mesh);
    }

    // 다음 이동 방향. 서버 Route의 next_node_id만 사용한다.
    const segments: number[] = [];
    const arrows: THREE.Matrix4[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const route of state.routes) {
      if (route.next_node_id === null || route.reason_codes.length > 0) continue;
      const from = nodeById.get(route.node_id);
      const to = nodeById.get(route.next_node_id);
      if (from === undefined || to === undefined) continue;
      if (!visibleFloors.has(from.floor_id) || !visibleFloors.has(to.floor_id)) continue;

      const start = new THREE.Vector3(from.position.x, from.position.y + 1.1, from.position.z);
      const end = new THREE.Vector3(to.position.x, to.position.y + 1.1, to.position.z);
      segments.push(start.x, start.y, start.z, end.x, end.y, end.z);

      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 0.001) continue;
      direction.normalize();
      const tip = start.clone().add(direction.clone().multiplyScalar(Math.min(length * 0.55, length - 0.3)));
      arrows.push(
        new THREE.Matrix4().compose(
          tip,
          new THREE.Quaternion().setFromUnitVectors(up, direction),
          new THREE.Vector3(1, 1, 1),
        ),
      );
    }

    if (segments.length > 0) {
      const geometryLines = new THREE.BufferGeometry();
      geometryLines.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
      dynamicGroup.add(
        new THREE.LineSegments(
          geometryLines,
          new THREE.LineBasicMaterial({ color: COLOR.guided, transparent: true, opacity: 0.5 }),
        ),
      );
    }

    if (arrows.length > 0) {
      const cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.42, 1.1, 10),
        new THREE.MeshLambertMaterial({ color: COLOR.guided }),
        arrows.length,
      );
      arrows.forEach((matrix, index) => cones.setMatrixAt(index, matrix));
      cones.instanceMatrix.needsUpdate = true;
      dynamicGroup.add(cones);
    }

    // 유도등 기둥. 현재 표시면이 안내 중이면 초록, 안내 불가면 회색이다.
    const shownSigns = building.signs.filter((sign) => {
      const node = nodeById.get(sign.node_id);
      return node !== undefined && visibleFloors.has(node.floor_id);
    });
    if (shownSigns.length > 0) {
      const posts = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.16, 0.16, 2.4, 8),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
        shownSigns.length,
      );
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      shownSigns.forEach((sign, index) => {
        const node = nodeById.get(sign.node_id);
        if (node === undefined) return;
        matrix.setPosition(node.position.x, node.position.y + 1.2, node.position.z);
        posts.setMatrixAt(index, matrix);
        const current = signState.get(sign.sign_id);
        const guiding = current?.faces.some((face) => face.display !== null) ?? false;
        color.setHex(guiding ? COLOR.sign : COLOR.noRoute);
        posts.setColorAt(index, color);
      });
      posts.instanceMatrix.needsUpdate = true;
      if (posts.instanceColor !== null) posts.instanceColor.needsUpdate = true;
      dynamicGroup.add(posts);
    }

    // 관측 위험 구역: 활성 경보 원인의 담당 구역을 바닥 판으로 칠한다.
    for (const mesh of handles.zoneMeshes.values()) mesh.visible = false;
    for (const cause of state.active_causes) {
      const source = sourceById.get(cause.source_id);
      if (source === undefined) continue;
      const mesh = handles.zoneMeshes.get(source.zone_id);
      const zone = zoneById.get(source.zone_id);
      if (mesh === undefined || zone === undefined || !visibleFloors.has(zone.floor_id)) continue;
      mesh.material.color.setHex(cause.hazard_type === "FIRE" ? COLOR.hazardFire : COLOR.hazardOther);
      mesh.visible = true;
    }

    // 시험용 연기 정답: 차오르는 부피. 관측 위험과 다른 모양이라 섞이지 않는다.
    for (const [zoneId, mesh] of handles.smokeMeshes) {
      const smoke = smokeByZone?.get(zoneId) ?? 0;
      if (smoke <= 0.01) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      // 평면을 눕혀 압출 방향이 -y이므로, 높이를 키우면서 그만큼 위로 올려야
      // 바닥에서 위로 차오르는 것처럼 보인다.
      const height = Math.max(0.1, smoke * geometry.wall_height);
      const baseY = typeof mesh.userData.baseY === "number" ? mesh.userData.baseY : 0;
      mesh.scale.z = height;
      mesh.position.y = baseY + height;
      mesh.material.opacity = 0.14 + smoke * 0.32;
    }
  }, [state, smokeByZone, visibleFloors, building, geometry, nodeById, zoneById, sourceById]);

  return <div className="scene" ref={mountRef} />;
}

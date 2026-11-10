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

import type { Building, BuildingDisplay, Position, StateSnapshot } from "@contracts";

import type { BuildingGeometry } from "./geometry";
import { visibleWalls, wallBox } from "./geometry";
import { sceneLabels, visibleLabelIndexes } from "./display";
import type { ViewBox, ViewMode } from "./view";
import { clampTarget, displayY, fitPose, floorLift, planYaw, pointBox, visibleBox } from "./view";

// M05: 바닥과 벽의 명암 차이를 키워 어두운 배경에서도 방·복도 윤곽이 보이게 한다.
const COLOR = {
  slab: 0x2a3442,
  wall: 0x7d8da3,
  stairEnclosed: 0x3f6b55,
  stairOpen: 0x55504a,
  node: 0x6b7a8c,
  guided: 0x22c55e,
  noRoute: 0x9ca3af,
  blockedAlarm: 0xef4444,
  blockedUnknown: 0xf59e0b,
  sign: 0xe7edf4,
  // 카메라 표시는 3D 안의 하늘색 구와 같은 색이라 고른 카메라를 바로 찾는다.
  camera: 0x7dd3fc,
  // 고른 카메라는 더 밝게. 표시용 하늘색 구와 구분된다.
  cameraPick: 0x22d3ee,
  smoke: 0xf59e0b,
  // 관측 위험은 원인(FIRE·SMOKE·SPRINKLER)과 관계없이 범례대로 빨강이다.
  // 주황은 시험용 연기 정답 전용이라 섞이면 정답을 보고 판단하는 것처럼 보인다.
  hazard: 0xef4444,
} as const;

const FOV = 50;

/** 카메라 한 대를 찾을 때 함께 보이는 범위(m). 너무 좁으면 어디인지 알 수 없다. */
const FOCUS_REACH = 9;

type Props = {
  readonly geometry: BuildingGeometry;
  readonly building: Building;
  readonly display: BuildingDisplay | null;
  readonly state: StateSnapshot;
  /** 시나리오 실행기의 구역별 연기 정답. 제어 판단과 분리된 시험값이다. */
  readonly smokeByZone: ReadonlyMap<string, number> | null;
  readonly visibleFloors: ReadonlySet<string>;
  /** 층 사이를 더 벌리는 간격(m). 실제 좌표는 바꾸지 않고 그리는 높이만 바꾼다. */
  readonly spread: number;
  /**
   * 시점 요청. nonce가 바뀔 때마다 해당 모드로 화면을 맞춘다.
   * focus가 있으면 전체 대신 그 지점을 가깝게 비춘다(이슈 #74의 카메라 위치 찾기).
   */
  readonly view: {
    readonly mode: ViewMode;
    readonly nonce: number;
    readonly focus?: { readonly position: Position; readonly floorId: string } | null;
  };
  /** 3D에서 위치를 강조할 관측원. 관제에서 고른 카메라가 건물 어디인지 잇는다(이슈 #74). */
  readonly highlightSourceId: string | null;
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
  /** 현재 보이는 범위. 회전 중심을 이 안으로 묶는다. */
  box: ViewBox | null;
};

/**
 * 바닥에 눕힌 평면 화살표. 꼭짓점이 -z(안내도 위쪽)를 향하고 가운데가 원점이다.
 * 몸통 0.36 m·머리 폭 1.0 m·전체 길이 1.5 m로, 복도 폭(2 m 안팎) 안에 들어간다.
 */
function flatArrowGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.75); // 꼭짓점
  shape.lineTo(0.5, 0.1);
  shape.lineTo(0.18, 0.1);
  shape.lineTo(0.18, -0.75);
  shape.lineTo(-0.18, -0.75);
  shape.lineTo(-0.18, 0.1);
  shape.lineTo(-0.5, 0.1);
  shape.closePath();
  // Shape의 +y를 모델의 -z로 눕힌다.
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

/** 카메라를 상자에 맞추고, 그 크기에 맞춰 확대·축소 한계를 정한다. */
function applyPose(handles: Handles, box: ViewBox, mode: ViewMode) {
  const { camera, controls, renderer } = handles;
  const size = renderer.getSize(new THREE.Vector2());
  const pose = fitPose(box, mode, FOV, size.y > 0 ? size.x / size.y : 1.6);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  // 너무 가까이 들어가 벽 속에 갇히거나 너무 멀어져 건물을 잃지 않게 한다.
  controls.minDistance = Math.max(6, pose.distance * 0.15);
  controls.maxDistance = pose.distance * 2.5;
  controls.update();
}

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
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
  }
}

function sizeName(sprite: THREE.Sprite, viewportHeight: number) {
  const width: unknown = sprite.userData.labelWidth;
  const height: unknown = sprite.userData.labelHeight;
  if (typeof width !== "number" || typeof height !== "number") return;
  const scale = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / Math.max(1, viewportHeight);
  sprite.scale.set(width * 0.6 * scale, height * 0.6 * scale, 1);
}

function nameSprite(text: string, viewportHeight: number): THREE.Sprite | null {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.font = "22px sans-serif";
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > 210) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  canvas.width = Math.ceil(Math.max(...lines.map((value) => context.measureText(value).width))) + 20;
  canvas.height = lines.length * 28 + 12;
  context.font = "22px sans-serif";
  context.fillStyle = "rgba(12, 20, 30, 0.88)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#edf5ff";
  context.textBaseline = "middle";
  lines.forEach((value, index) => context.fillText(value, 10, 20 + index * 28));
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, sizeAttenuation: false }));
  sprite.userData.labelWidth = canvas.width;
  sprite.userData.labelHeight = canvas.height;
  sizeName(sprite, viewportHeight);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 20;
  return sprite;
}

export function BuildingScene({ geometry, building, display, state, smokeByZone, visibleFloors, spread, view, highlightSourceId }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<Handles | null>(null);
  const lift = useMemo(() => floorLift(geometry, spread), [geometry, spread]);

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

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 800);
    camera.position.set(58, 46, 58);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(22, 6, 14);
    // 바닥 아래로 내려가 건물을 밑에서 보는 각도는 막는다.
    controls.maxPolarAngle = Math.PI / 2 - 0.08;

    // 위아래 색이 다른 하늘빛으로 벽 윗면과 옆면을 구분하고, 두 방향 조명으로 그늘진 면도 밝힌다.
    scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x1a2230, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(40, 80, 50);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6);
    fill.position.set(-30, 40, -40);
    scene.add(fill);
    // 보는 쪽에서 비추는 빛. 위에서만 오는 빛으로는 낮은 시점에서 복도 안쪽 벽이 그늘에 묻힌다.
    // 카메라에 붙인 빛은 카메라가 장면에 들어 있어야 적용된다. 거리 감쇠 없이 고르게 비춘다.
    const headlight = new THREE.PointLight(0xffffff, 0.9, 0, 0);
    camera.add(headlight);
    scene.add(camera);

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
      box: null,
    };
    handlesRef.current = handles;

    // 화면을 끌어도 회전 중심이 건물 밖으로 멀리 나가지 않게 한다.
    const keepInside = () => {
      if (handles.box === null) return;
      const next = clampTarget(controls.target, handles.box);
      if (next.x !== controls.target.x || next.y !== controls.target.y || next.z !== controls.target.z) {
        controls.target.set(next.x, next.y, next.z);
      }
    };
    controls.addEventListener("change", keepInside);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      camera.updateMatrixWorld();
      const size = renderer.getSize(new THREE.Vector2());
      const labels = staticGroup.children.flatMap((child) => {
        if (!(child instanceof THREE.Sprite)) return [];
        child.visible = false;
        const point = child.position.clone().project(camera);
        if (point.z < -1 || point.z > 1) return [];
        const width: unknown = child.userData.labelWidth;
        const height: unknown = child.userData.labelHeight;
        const priority: unknown = child.userData.priority;
        if (typeof width !== "number" || typeof height !== "number" || typeof priority !== "number") return [];
        return [{ sprite: child, box: {
          left: (point.x + 1) * size.x / 2 - width * 0.6 * child.center.x,
          top: (1 - point.y) * size.y / 2 - height * 0.6 * (1 - child.center.y),
          width: width * 0.6, height: height * 0.6, priority,
        } }];
      });
      const visible = visibleLabelIndexes(labels.map((label) => label.box));
      labels.forEach((label, index) => { label.sprite.visible = visible.has(index); });
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
      for (const child of staticGroup.children) if (child instanceof THREE.Sprite) sizeName(child, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("change", keepInside);
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
      const base = displayY(floor.elevation, floor.floor_id, lift);
      layFlat(slab, base);
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
            new THREE.Vector3(box.centerX, base + geometry.wall_height / 2, box.centerZ),
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
          new THREE.MeshBasicMaterial({ color: COLOR.hazard, transparent: true, opacity: 0.7 }),
        );
        layFlat(mesh, base + 0.42);
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
        layFlat(smoke, base + 1);
        smoke.userData.baseY = base;
        smoke.visible = false;
        staticGroup.add(smoke);
        handles.smokeMeshes.set(zone.zone_id, smoke);
      }
    }

    // 계단. 밀폐와 열린 계단을 색으로 구분한다.
    for (const stair of geometry.stairs) {
      const shown = stair.floors.filter((id) => visibleFloors.has(id));
      if (shown.length === 0) continue;
      // 층을 벌리면 계단도 아래층 바닥부터 위층 바닥까지 같이 늘어난다.
      // 보이는 층 범위만 그린다. 한 층만 볼 때 숨긴 층 높이까지 기둥이 뻗어 나오지 않게 한다.
      const elevations = shown
        .map((id) => {
          const elevation = geometry.floors.find((floor) => floor.floor_id === id)?.elevation;
          return elevation === undefined ? undefined : displayY(elevation, id, lift);
        })
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
    for (const label of sceneLabels(building, display, visibleFloors)) {
      const sprite = nameSprite(label.text, handles.renderer.getSize(new THREE.Vector2()).y);
      if (sprite === null) continue;
      const y = displayY(label.position.y, label.floorId, lift);
      sprite.position.set(label.position.x, y + 0.5, label.position.z);
      if (label.camera) sprite.center.set(0.5, -0.8);
      sprite.userData.priority = label.priority;
      staticGroup.add(sprite);
      if (label.camera) {
        const camera = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({ color: 0x7dd3fc }));
        camera.position.set(label.position.x, y, label.position.z);
        staticGroup.add(camera);
      }
    }
  }, [geometry, building, display, visibleFloors, lift]);

  // 2-1) 화면 맞춤. 보이는 층이나 간격이 바뀌면 그 범위가 다 보이게 마지막 시점 모드로 맞추고,
  //      시점 버튼(view.nonce)을 누르면 같은 모드라도 다시 맞춘다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const box = visibleBox(geometry, visibleFloors, lift);
    handles.box = box;
    if (box === null) return;
    const focus = view.focus ?? null;
    if (focus === undefined || focus === null) {
      applyPose(handles, box, view.mode);
      return;
    }
    // 같은 fitPose로 작은 상자를 비춘다. 시점 제어를 따로 만들지 않는다(M05 공용 연결부).
    applyPose(
      handles,
      pointBox(
        { x: focus.position.x, y: displayY(focus.position.y, focus.floorId, lift), z: focus.position.z },
        FOCUS_REACH,
      ),
      view.mode,
    );
  }, [geometry, visibleFloors, lift, view]);

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
        new THREE.MeshLambertMaterial(),
        shownNodes.length,
      );
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      shownNodes.forEach((node, index) => {
        matrix.setPosition(node.position.x, displayY(node.position.y, node.floor_id, lift) + 1.1, node.position.z);
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
    // 같은 층 이동은 바닥에 눕힌 평면 화살표로 그린다. 원뿔은 위에서 보면 덩어리로만 보여
    // 방향을 읽기 어렵다. 층을 오르내리는 계단 이동만 위아래가 드러나는 원뿔로 남긴다.
    const segments: number[] = [];
    const flatArrows: THREE.Matrix4[] = [];
    const stairArrows: THREE.Matrix4[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const route of state.routes) {
      if (route.next_node_id === null || route.reason_codes.length > 0) continue;
      const from = nodeById.get(route.node_id);
      const to = nodeById.get(route.next_node_id);
      if (from === undefined || to === undefined) continue;
      if (!visibleFloors.has(from.floor_id) || !visibleFloors.has(to.floor_id)) continue;

      const start = new THREE.Vector3(
        from.position.x,
        displayY(from.position.y, from.floor_id, lift) + 1.1,
        from.position.z,
      );
      const end = new THREE.Vector3(to.position.x, displayY(to.position.y, to.floor_id, lift) + 1.1, to.position.z);
      segments.push(start.x, start.y, start.z, end.x, end.y, end.z);

      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 0.001) continue;
      direction.normalize();
      const tip = start.clone().add(direction.clone().multiplyScalar(Math.min(length * 0.55, length - 0.3)));
      if (from.floor_id === to.floor_id) {
        flatArrows.push(
          new THREE.Matrix4().compose(
            tip,
            new THREE.Quaternion().setFromAxisAngle(up, planYaw(end.x - start.x, end.z - start.z)),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      } else {
        stairArrows.push(
          new THREE.Matrix4().compose(
            tip,
            new THREE.Quaternion().setFromUnitVectors(up, direction),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      }
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

    if (flatArrows.length > 0) {
      const plates = new THREE.InstancedMesh(
        flatArrowGeometry(),
        new THREE.MeshBasicMaterial({ color: COLOR.guided, side: THREE.DoubleSide }),
        flatArrows.length,
      );
      flatArrows.forEach((matrix, index) => plates.setMatrixAt(index, matrix));
      plates.instanceMatrix.needsUpdate = true;
      dynamicGroup.add(plates);
    }

    if (stairArrows.length > 0) {
      const cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.42, 1.1, 10),
        new THREE.MeshLambertMaterial({ color: COLOR.guided }),
        stairArrows.length,
      );
      stairArrows.forEach((matrix, index) => cones.setMatrixAt(index, matrix));
      cones.instanceMatrix.needsUpdate = true;
      dynamicGroup.add(cones);
    }

    // 유도등. 표지 종류를 모양으로 구분한다(이슈 #70).
    // 출구 위치 표지는 고정된 위치를 알리는 납작한 표지판, 가변 방향 안내는 기둥이다.
    // 같은 모양으로 그리면 화재 때 모든 표지가 방향을 바꾸는 것처럼 보인다.
    const shownSigns = building.signs.filter((sign) => {
      const node = nodeById.get(sign.node_id);
      return node !== undefined && visibleFloors.has(node.floor_id);
    });
    const exitSigns = shownSigns.filter(
      (sign) => display?.signs[sign.sign_id]?.kind === "EXIT_LOCATION",
    );
    const directionalSigns = shownSigns.filter(
      (sign) => display?.signs[sign.sign_id]?.kind !== "EXIT_LOCATION",
    );

    const placeSigns = (
      signs: typeof shownSigns,
      geometryFor: () => THREE.BufferGeometry,
      height: number,
    ) => {
      if (signs.length === 0) return;
      const mesh = new THREE.InstancedMesh(
        geometryFor(),
        new THREE.MeshLambertMaterial(),
        signs.length,
      );
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      signs.forEach((sign, index) => {
        const node = nodeById.get(sign.node_id);
        if (node === undefined) return;
        matrix.setPosition(
          node.position.x,
          displayY(node.position.y, node.floor_id, lift) + height,
          node.position.z,
        );
        mesh.setMatrixAt(index, matrix);
        const current = signState.get(sign.sign_id);
        const guiding = current?.faces.some((face) => face.display !== null) ?? false;
        color.setHex(guiding ? COLOR.sign : COLOR.noRoute);
        mesh.setColorAt(index, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      dynamicGroup.add(mesh);
    };

    placeSigns(directionalSigns, () => new THREE.CylinderGeometry(0.16, 0.16, 2.4, 8), 1.2);
    placeSigns(exitSigns, () => new THREE.BoxGeometry(1.5, 0.75, 0.16), 2.3);

    // 관측 위험 구역: 활성 경보 원인의 담당 구역을 바닥 판으로 칠한다.
    for (const mesh of handles.zoneMeshes.values()) mesh.visible = false;
    for (const cause of state.active_causes) {
      const source = sourceById.get(cause.source_id);
      if (source === undefined) continue;
      const mesh = handles.zoneMeshes.get(source.zone_id);
      const zone = zoneById.get(source.zone_id);
      if (mesh === undefined || zone === undefined || !visibleFloors.has(zone.floor_id)) continue;
      mesh.material.color.setHex(COLOR.hazard);
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

    // 고른 카메라의 설치 위치 강조(이슈 #74). 관측 구역(바닥 판)과 달리 설치 지점만 가리킨다.
    const installation = highlightSourceId === null
      ? null
      : display?.sources[highlightSourceId]?.installation ?? null;
    if (installation !== null && visibleFloors.has(installation.floor_id)) {
      const y = displayY(installation.position.y, installation.floor_id, lift);
      const { x, z } = installation.position;
      const mark = (mesh: THREE.Mesh, height: number) => {
        mesh.position.set(x, y + height, z);
        dynamicGroup.add(mesh);
      };
      const paint = (opacity: number) =>
        new THREE.MeshBasicMaterial({
          color: COLOR.cameraPick,
          side: THREE.DoubleSide,
          transparent: true,
          opacity,
          // 벽이나 바닥에 가려도 어디인지 보여야 찾는 기능이 된다.
          depthTest: false,
        });
      // 바닥 고리 두 겹: 위에서 봐도 옆에서 봐도 눈에 띈다.
      for (const [inner, outer, opacity] of [[1.0, 1.35, 0.95] as const, [1.9, 2.1, 0.5] as const]) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 36), paint(opacity));
        ring.rotation.x = -Math.PI / 2;
        mark(ring, 0.06);
      }
      // 아래를 가리키는 깔때기. 주변 유도등 기둥과 모양이 달라 혼동되지 않는다.
      const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 14), paint(0.95));
      pointer.rotation.x = Math.PI;
      mark(pointer, 3.4);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.8, 6), paint(0.45));
      mark(beam, 1.4);
    }
  }, [state, smokeByZone, visibleFloors, building, display, geometry, nodeById, zoneById, sourceById, lift, highlightSourceId]);

  return <div className="scene" ref={mountRef} />;
}

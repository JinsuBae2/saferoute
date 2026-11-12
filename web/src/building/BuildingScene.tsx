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

import type { Building, BuildingDisplay, HazardCell, Position, StateSnapshot } from "@contracts";
import { localSmoke, simulationFireCells } from "./firePresentation";

import { cctvSmoke, type CctvPose } from "./cctv";
import type { BuildingGeometry, GeometryStair, StairStepAlong } from "./geometry";
import type { Figure, Fire, SignFaceMesh, SmokePuff } from "./assets";
import { buildHangingSign, createFigure, createFire, createSmokeSprite, disposeTree, placeSmoke, poseFigure, signFaceTexture, softDotTexture } from "./assets";
import { insidePolygon, visibleWalls, wallBox } from "./geometry";
import type { StairTravel } from "./stairs";
import { alongStair, flightSteps, stairLanding, stairLink, stairTravel } from "./stairs";
import { doorFacing, EXIT_RUN_LENGTH, facadeColumns, facadeParts } from "./facade";
import { sceneLabels, visibleLabelIndexes } from "./display";
import type { IconKind } from "./icons";
import type { PeopleCount, Person } from "./people";
import { countPeople, spawnPeople, stepPeople, walkTime } from "./people";
import { loadPeople, savePeople } from "./peopleStore";
import { nearestPerson } from "./phoneGuide";
import type { FollowPose } from "./phoneGuide";
import { storageScope } from "../api/scope";
import { drawIcon, ICON_PIXELS, signIcon } from "./icons";
import type { ViewBox, ViewMode } from "./view";
import { clampTarget, displayY, fitPose, floorLift, planYaw, pointBox, visibleBox } from "./view";

// M05: 바닥과 벽의 명암 차이를 키워 어두운 배경에서도 방·복도 윤곽이 보이게 한다.
const COLOR = {
  slab: 0x2a3442,
  wall: 0xc9d1dc,
  stairEnclosed: 0x3f6b55,
  stairOpen: 0x55504a,
  // 바닥 색. 안내(초록)·위험(빨강)·연기(주황)·선택 경로(노랑)와 겹치지 않게 채도를 낮췄다.
  floorPassage: 0x3f6184,
  floorRoom: 0x6a6152,
  floorStair: 0x2f7a5c,
  concrete: 0xe4e7ea,
  wallCap: 0x9aa7b8,
  slide: 0xfbbf24,
  door: 0x8a6b4a,
  glass: 0x3b8f99,
  frame: 0x1c2b33,
  stepEnclosed: 0x6fbf9a,
  stepOpen: 0xc2ab80,
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
  // M06: 고른 출발점의 경로. 전체 안내(초록)와 섞이지 않게 노랑, 직전 경로는 회색 점선.
  // 시연용 대피 인원. 안내·위험·연기·선택 경로·카메라 색과 겹치지 않게 분홍, 멈춘 사람은 짙은 보라.
  person: 0xff5fd2,
  personStuck: 0x7c3aed,
  journey: 0xfacc15,
  journeyPrevious: 0x94a3b8,
} as const;

/** 고른 출발점이 있을 때 나머지 안내 표시를 흐리게 하는 정도. */
const DIMMED = 0.18;

const FOV = 50;

/** 대피 인원이 걷는 속도(m/s). 보통 걸음에 가깝게 두어 연기가 번지는 동안 경로가 바뀌는 것이 보이게 한다. */
const PEOPLE_SPEED = 1.2;
/** 1인칭에서 계단을 걸을 때 시선이 향하는 앞쪽 거리(m). 계단참 폭(약 2m)보다 조금 길어야 꺾이기 전에 다음 줄이 보인다. */
const STAIR_LOOK_AHEAD = 2.4;

/** 출구에서 미끄럼틀을 타고 빠져나가는 시간(초)과 미끄럼틀의 길이·낙차(m). */
const SLIDE_SECONDS = 1.8;
const SLIDE_LENGTH = EXIT_RUN_LENGTH;
const SLIDE_DROP = 0.9;

/** 카메라 한 대를 찾을 때 함께 보이는 범위(m). 너무 좁으면 어디인지 알 수 없다. */
const FOCUS_REACH = 9;

type Props = {
  readonly cctv: CctvPose | null;
  readonly onCamera: (id: string) => void;
  readonly geometry: BuildingGeometry;
  readonly building: Building;
  readonly display: BuildingDisplay | null;
  /**
   * 공간 이름표를 띄울지. 끄더라도 표시 자료(표지 종류·카메라 설치 위치)는 그대로 써서
   * 출구 유도등·CCTV 아이콘은 남긴다.
   */
  readonly showNames?: boolean;
  /** 시연용 대피 인원을 그릴지. 서버 경로를 따라 걷는 표시일 뿐 실제 인원이 아니다. */
  readonly showPeople?: boolean;
  /** 연결이 끊겨 상태가 오래됨. 사람이 옛 경로로 걷지 않게 세운다. */
  readonly stale?: boolean;
  /** 이동 중·탈출·멈춤 인원 수가 바뀔 때. */
  readonly onPeople?: (count: PeopleCount) => void;
  /** 1인칭으로 따라갈 사람의 순번. null이면 평소 시점이다. */
  readonly followIndex?: number | null;
  readonly followRequest?: { nodeId: string; nonce: number } | null;
  readonly onFollowUnavailable?: () => void;
  /** 3D에서 사람을 눌렀거나(순번), 따라가던 사람이 빠져나갔을 때(null). */
  readonly onFollow?: (index: number | null) => void;
  /** 1인칭으로 따라가는 사람의 위치·시선·지금 경로를 읽는 지점. 출구 유도음이 쓴다. 1인칭이 아니면 null. */
  readonly onListener?: (pose: FollowPose | null) => void;
  /** 전체 안내(지점별 초록 화살표·선)를 그릴지. 꺼도 지점·유도등·위험·선택 경로는 남는다. */
  readonly showGuidance?: boolean;
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
  /**
   * 고른 출발점의 경로(M06). path는 서버 path_node_ids 그대로이며, 비었으면 안내 불가다.
   * previousPath는 비교용 직전 경로, signNodeId는 표에서 고른 유도등의 위치다.
   */
  readonly journey?: {
    readonly startId: string;
    readonly path: readonly string[];
    readonly previousPath: readonly string[] | null;
    readonly signNodeId: string | null;
  } | null;
  /** 3D에서 지점을 눌렀을 때. 끌어서 돌린 것은 누름으로 보지 않는다. */
  readonly onPickNode?: (nodeId: string) => void;
  /**
   * 3D에서 구역(방·복도)을 눌렀을 때. 도면에서 바로 화재 위치를 고르는 데 쓴다(이슈 #21).
   * 구역 판은 모든 구역에 깔려 있으므로 목록에 없는 방도 누를 수 있다.
   */
  readonly onPickZone?: (zoneId: string, position: Position) => void;
  /**
   * 한 번 누를 때 무엇을 고를지. 지점과 구역은 같은 자리에 겹쳐 있어 하나만 받는다.
   * "ZONE"이면 지점 구를 지나쳐 그 아래 구역을 고른다.
   */
  readonly pickTarget?: "NODE" | "ZONE";
};

type Handles = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  staticGroup: THREE.Group;
  dynamicGroup: THREE.Group;
  zoneMeshes: Map<string, THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshBasicMaterial>>;
  /** 연기 입자. 구역마다 천장 아래에 흩어 두고 농도에 따라 보이게 한다. */
  smokeGroup: THREE.Group;
  smokePuffs: SmokePuff[];
  fieldPuffs: Map<string, { puff: SmokePuff; smoke: number }>;
  /** 천장 표지판의 면. 서버 표시값이 바뀌면 그림만 바꾼다. */
  signFaces: Map<string, Map<string, SignFaceMesh>>;
  /** 화재 경보 구역의 불꽃. */
  fireGroup: THREE.Group;
  fires: Fire[];
  fireObjects: Map<string, Fire>;
  /** 1인칭에서 연기 속을 뿌옇게 하는 안개. */
  fog: THREE.FogExp2;
  /** 위아래 색이 다른 주변광. 1인칭에서는 천장 아랫면이 검게 죽지 않게 아래쪽 색을 밝힌다. */
  hemisphere: THREE.HemisphereLight;
  uplight: THREE.DirectionalLight;
  disposables: Set<{ dispose(): void }>;
  /** 설비 아이콘 그림. 종류별로 한 번만 그려 모든 아이콘이 함께 쓴다. */
  icons: Map<IconKind, THREE.Texture>;
  /** 건물 간판 그림. 층 표시를 바꿔 장면을 다시 만들어도 한 번만 그린다. */
  signboard?: THREE.Texture | null;
  /** 현재 보이는 범위. 회전 중심을 이 안으로 묶는다. */
  box: ViewBox | null;
  /** 눌러서 고를 수 있는 지점 표시와 그 순서의 node_id. */
  pick: { mesh: THREE.InstancedMesh; ids: readonly string[] } | null;
  /** CCTV 아이콘과 그 이름표. 이름표는 평소 숨기고 아이콘에 커서를 올렸을 때만 보인다. */
  cameraIcons: { sourceId: string; icon: THREE.Sprite; label: THREE.Sprite | null }[];
  /** 출구 유도등 아이콘(안내 상태에 따라 다시 그림)과 출구 이름표. CCTV와 같은 방식으로 커서를 올렸을 때만 보인다. */
  exitIcons: { icon: THREE.Sprite; nodeId: string }[];
  exitLabels: Map<string, THREE.Sprite>;
};

/** 아이콘 위로 이름표를 띄우는 기준점. 아이콘 위쪽 끝에서 6px 위에 이름표 아래쪽이 오게 한다. */
function liftLabelAbove(label: THREE.Sprite, iconPixelsAboveAnchor: number) {
  const labelPixels = (label.userData.labelHeight as number) * 0.6;
  label.center.set(0.5, -(iconPixelsAboveAnchor + 6) / labelPixels);
  label.userData.hoverLabel = true;
  label.renderOrder = 23;
  label.visible = false;
}

/** 바닥에 눕히는 흐린 방 이름. 읽을 수는 있지만 경로·위험 표시를 가리지 않게 옅게 그린다. */
function floorNameTexture(text: string): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const font = "600 64px sans-serif";
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 24;
  canvas.height = 88;
  context.font = font;
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.fillText(text, 12, 46);
  return new THREE.CanvasTexture(canvas);
}

/** 두 점을 잇는 굵은 막대. 선 굵기는 WebGL에서 1px로 고정돼 경로 강조에 쓸 수 없다. */
function rod(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh | null {
  const direction = to.clone().sub(from);
  const length = direction.length();
  if (length < 0.001) return null;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

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
      // 설비 아이콘 그림은 여러 아이콘이 같이 쓰므로 장면을 닫을 때만 정리한다.
      if (child.userData.iconKind === undefined) child.material.map?.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      const material = child.material;
      // 방 이름처럼 그 메시만 쓰는 그림은 함께 정리한다.
      if (child.userData.ownsMap === true && material instanceof THREE.MeshBasicMaterial) material.map?.dispose();
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    } else {
      // 표지판·문처럼 여러 메시를 묶은 그룹.
      disposeTree(child);
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

/** 아이콘을 화면에서 늘 같은 크기(px)로 보이게 한다. */
function sizeIcon(sprite: THREE.Sprite, viewportHeight: number) {
  const kind = sprite.userData.iconKind as IconKind | undefined;
  if (kind === undefined) return;
  const scale = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / Math.max(1, viewportHeight);
  sprite.scale.set(ICON_PIXELS[kind].width * scale, ICON_PIXELS[kind].height * scale, 1);
}

/**
 * 설비 아이콘. 그림을 만들 수 없으면 null이며, 그때는 아이콘 없이 기존 표시만 남는다.
 * alwaysOnTop이면 벽·바닥에 가려도 보인다(수가 적은 CCTV). 유도등은 37개라 모두 띄우면
 * 층이 겹쳐 어수선하므로 깊이 검사를 켜 위층 바닥에 가려지게 하고, 벽보다 높이 띄운다.
 */
function iconSprite(handles: Handles, kind: IconKind, alwaysOnTop = false): THREE.Sprite | null {
  let texture = handles.icons.get(kind);
  if (texture === undefined) {
    const canvas = drawIcon(kind);
    if (canvas === null) return null;
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    handles.icons.set(kind, texture);
  }
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: !alwaysOnTop, depthWrite: false, sizeAttenuation: false }),
  );
  sprite.userData.iconKind = kind;
  // CCTV는 이름표(20)에 가리지 않게 그 위에 그린다.
  sprite.renderOrder = alwaysOnTop ? 21 : 15;
  sizeIcon(sprite, handles.renderer.getSize(new THREE.Vector2()).y);
  return sprite;
}

/** 건물 간판 그림. 붉은 WFi와 흰 기관명. 그림을 만들 수 없으면 null이고 간판 없이 그린다. */
function signboardTexture(): THREE.Texture | null {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const font = "bold 88px sans-serif";
  const parts = [["WFi", "#e11d2e"], [" (재)원주미래산업진흥원", "#ffffff"]] as const;
  context.font = font;
  canvas.width = Math.ceil(parts.reduce((sum, [text]) => sum + context.measureText(text).width, 0)) + 16;
  canvas.height = 120;
  context.font = font;
  context.textBaseline = "middle";
  let x = 8;
  for (const [text, color] of parts) {
    context.fillStyle = color;
    context.fillText(text, x, 62);
    x += context.measureText(text).width;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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

export function BuildingScene({ cctv, onCamera, geometry, building, display, showNames = true, showGuidance = true, showPeople = false, stale = false, onPeople, followIndex = null, followRequest = null, onFollowUnavailable, onFollow, onListener, state, smokeByZone, visibleFloors, spread, view, highlightSourceId, journey = null, onPickNode, onPickZone, pickTarget = "NODE" }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<Handles | null>(null);
  // 장면은 한 번만 만들므로 최신 콜백을 참조로 넘긴다.
  const pickRef = useRef(onPickNode);
  useEffect(() => {
    pickRef.current = onPickNode;
  }, [onPickNode]);
  const zoneRef = useRef({ pick: onPickZone, target: pickTarget });
  useEffect(() => {
    zoneRef.current = { pick: onPickZone, target: pickTarget };
  }, [onPickZone, pickTarget]);
  const lift = useMemo(() => floorLift(geometry, spread), [geometry, spread]);
  const firstPersonView = followIndex !== null || cctv !== null;
  const peopleRef = useRef<{ list: Person[]; group: THREE.Group; figures: Figure[]; markers: THREE.Sprite[]; yaw: number[]; slope: number[]; slide: number[]; key: string; lost: number } | null>(null);

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

  const hazardByZone = useMemo(() => {
    const zones = new Map<string, HazardCell[]>();
    for (const cell of state.fire_simulation?.cells ?? []) {
      const list = zones.get(cell.zone_id) ?? [];
      list.push(cell); zones.set(cell.zone_id,list);
    }
    return zones;
  }, [state.fire_simulation]);
  // 그리기 반복은 한 번만 만들어지므로, 매번 바뀌는 값은 참조로 넘긴다.
  const liveRef = useRef({ state, cctv, onCamera, nodeById, lift, visibleFloors, onPeople, smokeByZone, hazardByZone, follow: followIndex, onFollow, onListener, showPeople, stale, geometry, building, wallHeight: firstPersonView ? geometry.floor_height - geometry.slab_thickness : geometry.wall_height });
  useEffect(() => {
    liveRef.current = { state, cctv, onCamera, nodeById, lift, visibleFloors, onPeople, smokeByZone, hazardByZone, follow: followIndex, onFollow, onListener, showPeople, stale, geometry, building, wallHeight: firstPersonView ? geometry.floor_height - geometry.slab_thickness : geometry.wall_height };
  });

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
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(22, 6, 14);
    // 바닥 아래로 내려가 건물을 밑에서 보는 각도는 막는다.
    controls.maxPolarAngle = Math.PI / 2 - 0.08;

    // 위아래 색이 다른 하늘빛으로 벽 윗면과 옆면을 구분하고, 두 방향 조명으로 그늘진 면도 밝힌다.
    const hemisphere = new THREE.HemisphereLight(0xdfe8f5, 0x1a2230, 1.6);
    scene.add(hemisphere);
    // 아래에서 위로 비추는 빛. 1인칭에서 천장(위층 바닥 아랫면)이 검게 죽지 않게 그때만 켠다.
    const uplight = new THREE.DirectionalLight(0xffffff, 0);
    uplight.position.set(0, -10, 0);
    scene.add(uplight);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(40, 80, 50);
    // 그림자. 위층 바닥이 아래층을 덮어 너무 어두워지지 않게 옅게 드리운다.
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
    key.shadow.bias = -0.0005;
    key.shadow.intensity = 0.55;
    key.target.position.set(22, 6, 14);
    scene.add(key, key.target);
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
    const smokeGroup = new THREE.Group();
    const fireGroup = new THREE.Group();
    scene.add(staticGroup, dynamicGroup, smokeGroup, fireGroup);
    // 불빛. 개수가 바뀌면 재질을 다시 엮느라 끊기므로 두 개를 미리 두고 불이 있을 때만 밝힌다.
    const fireLights = [0, 1].map(() => {
      const light = new THREE.PointLight(0xff7a2a, 0, 13, 2);
      scene.add(light);
      return light;
    });

    const handles: Handles = {
      renderer,
      scene,
      camera,
      controls,
      staticGroup,
      dynamicGroup,
      zoneMeshes: new Map(),
      smokeGroup,
      smokePuffs: [],
      fieldPuffs: new Map(),
      signFaces: new Map(),
      fireGroup,
      fires: [],
      fireObjects: new Map(),
      fog: new THREE.FogExp2(0x2b2f36, 0.012),
      hemisphere,
      uplight,
      disposables: new Set(),
      icons: new Map(),
      box: null,
      pick: null,
      cameraIcons: [],
      exitIcons: [],
      exitLabels: new Map(),
    };
    handlesRef.current = handles;

    // 지점 누르기(M06). 누른 자리에서 거의 움직이지 않고 뗀 것만 선택으로 본다.
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      const startedAt = downAt;
      downAt = null;
      if (startedAt === null) return;
      if (Math.hypot(event.clientX - startedAt.x, event.clientY - startedAt.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      // 1인칭으로 걷는 동안에는 도면을 고르지 않는다. 걷는 사람 눈에는 지점 구도 구역 판도 없다.
      if (liveRef.current.follow !== null || liveRef.current.cctv) return;
      const cameraHit = raycaster.intersectObjects(handles.cameraIcons.map(item => item.icon), false)[0];
      const source = cameraHit && handles.cameraIcons.find(item => item.icon === cameraHit.object);
      if (source) {
        liveRef.current.onCamera(source.sourceId);
        return;
      }
      const zone = zoneRef.current;
      if (zone.target === "ZONE") {
        // 도면에서 바로 화재 위치를 고른다(이슈 #21).
        //
        // 사람보다 먼저 본다. 화재 위치를 고르는 중에는 도면을 가리키는 것이지 사람을
        // 가리키는 것이 아니다. 사람을 먼저 보면 누르려는 방에 사람이 서 있을 때
        // 1인칭으로 끌려 들어가 화재 위치를 영영 고르지 못한다.
        //
        // 구역 판은 모든 구역에 깔려 있어 목록에 없던 방도 누를 수 있다. 평소에는
        // 숨겨 두지만 three.js의 교차 판정은 visible을 보지 않으므로 숨긴 채로 눌린다.
        if (zone.pick === undefined) return;
        const entries = [...handles.zoneMeshes.entries()];
        const hitZone = raycaster.intersectObjects(entries.map(([, mesh]) => mesh), false)[0];
        const zoneId = entries.find(([, mesh]) => mesh === hitZone?.object)?.[0];
        if (zoneId !== undefined && hitZone) {
          const area = liveRef.current.building.zones.find(z=>z.zone_id===zoneId)!;
          const elevation = liveRef.current.building.floors.find(f=>f.floor_id===area.floor_id)!.elevation;
          zone.pick(zoneId,{x:hitZone.point.x,y:elevation,z:hitZone.point.z});
        }
        return;
      }
      // 사람을 누르면 그 사람의 1인칭 시점으로 들어간다. 지점보다 먼저 본다.
      const people = peopleRef.current;
      if (people !== null) {
        const targets = [...people.markers, ...people.figures.map((figure) => figure.group)].filter((item) => item.visible);
        let picked: THREE.Object3D | null = raycaster.intersectObjects(targets, true)[0]?.object ?? null;
        while (picked !== null && picked.userData.personIndex === undefined) picked = picked.parent;
        if (picked !== null) {
          const index = picked.userData.personIndex as number;
          // 사람을 누르면 그 사람이 선 지점이 내 위치가 된다. 이것이 없으면 1인칭으로 들어가도 「시연 시작」이 열리지 않는다.
          pickRef.current?.(people.list[index].from);
          liveRef.current.onFollow?.(index);
          return;
        }
      }
      if (handles.pick === null || pickRef.current === undefined) return;
      const hit = raycaster.intersectObject(handles.pick.mesh, false)[0];
      const nodeId = hit?.instanceId === undefined ? undefined : handles.pick.ids[hit.instanceId];
      if (nodeId !== undefined) {
        pickRef.current(nodeId);
        return;
      }
      // 지점 점은 작아서 빗나가기 쉽다. 바닥을 누르면 같은 층에서 가장 가까운 지점을 고른다.
      const entries = [...handles.zoneMeshes.entries()];
      const floorHit = raycaster.intersectObjects(entries.map(([, mesh]) => mesh), false)[0];
      const floorId = liveRef.current.building.zones.find((z) => z.zone_id === entries.find(([, mesh]) => mesh === floorHit?.object)?.[0])?.floor_id;
      if (floorHit === undefined || floorId === undefined) return;
      const shown = new Set(handles.pick.ids);
      let nearest: string | null = null;
      let best = Infinity;
      for (const node of liveRef.current.building.nodes) {
        if (node.floor_id !== floorId || !shown.has(node.node_id)) continue;
        const d = Math.hypot(node.position.x - floorHit.point.x, node.position.z - floorHit.point.z);
        if (d < best) { best = d; nearest = node.node_id; }
      }
      if (nearest !== null) pickRef.current(nearest);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // CCTV·출구 이름표: 아이콘에 커서를 올린 동안만 보인다.
    const showHoverLabel = (target: THREE.Sprite | null) => {
      for (const { icon, label } of handles.cameraIcons) {
        if (label !== null) label.visible = icon === target;
      }
      const exitNode = handles.exitIcons.find((item) => item.icon === target)?.nodeId;
      for (const [nodeId, label] of handles.exitLabels) label.visible = nodeId === exitNode;
      renderer.domElement.style.cursor = target === null ? "" : "pointer";
    };
    const onMove = (event: PointerEvent) => {
      const targets = [...handles.cameraIcons.map((item) => item.icon), ...handles.exitIcons.map((item) => item.icon)];
      if (targets.length === 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1),
        camera,
      );
      const hit = raycaster.intersectObjects(targets, false)[0];
      showHoverLabel(hit?.object instanceof THREE.Sprite ? hit.object : null);
    };
    const onLeave = () => showHoverLabel(null);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);

    // 화면을 끌어도 회전 중심이 건물 밖으로 멀리 나가지 않게 한다.
    const keepInside = () => {
      if (handles.box === null) return;
      const next = clampTarget(controls.target, handles.box);
      if (next.x !== controls.target.x || next.y !== controls.target.y || next.z !== controls.target.z) {
        controls.target.set(next.x, next.y, next.z);
      }
    };
    controls.addEventListener("change", keepInside);

    // 대피 인원: 매 프레임 서버의 최신 경로를 읽어 한 걸음씩 옮긴다.
    let lastFrame = performance.now();
    let viewYaw = 0;
    let viewPitch = 0;
    let lastFollow: number | null = null;
    let lastListenerAt = 0;
    const stairCache: { lift: unknown; geometry: unknown; building: unknown; paths: Map<string, StairTravel | null> } = { lift: null, geometry: null, building: null, paths: new Map() };
    // 층을 오르내리는 구간은 계단 디딤판을 따라 걷는다. 두 지점을 곧게 이으면 허공으로 떨어지는 것처럼 보인다.
    const stairPath = (fromId: string, toId: string): StairTravel | null => {
      const live = liveRef.current;
      if (stairCache.lift !== live.lift || stairCache.geometry !== live.geometry || stairCache.building !== live.building) {
        stairCache.lift = live.lift;
        stairCache.geometry = live.geometry;
        stairCache.building = live.building;
        stairCache.paths.clear();
      }
      const key = `${fromId}>${toId}`;
      const cached = stairCache.paths.get(key);
      if (cached !== undefined) return cached;
      const a = live.nodeById.get(fromId);
      const b = live.nodeById.get(toId);
      const path = a === undefined || b === undefined ? null : stairTravel(live.building, live.geometry, live.lift, a, b);
      stairCache.paths.set(key, path);
      return path;
    };
    // 사람은 화면을 그리는 횟수가 아니라 실제 지난 시간만큼 걷는다(#202). 화면 갱신과 타이머 양쪽에서 부르며,
    // 같은 시계를 쓰므로 겹쳐 세지 않는다. 탭이 가려져 화면 갱신이 멈춰도 타이머가 이어 간다.
    let lastWalk = performance.now();
    const walkPeople = () => {
      const now = performance.now();
      const { walk, lost } = walkTime((now - lastWalk) / 1000);
      lastWalk = now;
      const people = peopleRef.current;
      if (people === null) return;
      const live = liveRef.current;
      // 대피 중에 반영하지 못한 시간만 센다. 연결이 끊긴 동안은 원래 서 있으므로 세지 않는다.
      if (lost > 0 && !live.stale && people.list.some((person) => person.started === true && person.status !== "OUT")) people.lost += lost;
      people.list.forEach((person, index) => {
        if (person.status === "OUT" && people.slide[index] < SLIDE_SECONDS && !live.stale) people.slide[index] += walk;
      });
      const routes = new Map(live.state.routes.map((route) => [route.node_id, route]));
      stepPeople(
        people.list,
        routes,
        live.state.controller_mode === "EMERGENCY",
        (from, to) => {
          // 계단은 실제로 걷는 꺾은선 길이로 잰다. 곧은 거리로 재면 계단에서만 몇 배 빨라진다.
          const stair = stairPath(from, to);
          if (stair !== null) return stair.length;
          const a = live.nodeById.get(from)?.position;
          const b = live.nodeById.get(to)?.position;
          return a === undefined || b === undefined ? 1 : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        },
        walk * PEOPLE_SPEED,
        // 연결이 끊겨 상태가 오래됐으면 옛 경로로 걷지 않고 선다.
        !live.stale,
      );
      const count = countPeople(people.list, people.lost);
      const key = `${count.moving}/${count.out}/${count.stuck}/${count.waiting}/${count.lostSeconds}`;
      if (key !== people.key) {
        people.key = key;
        live.onPeople?.(count);
      }
    };
    const walker = setInterval(walkPeople, 250);

    const movePeople = (seconds: number, time: number) => {
      walkPeople();
      const people = peopleRef.current;
      if (people === null) return;
      const live = liveRef.current;
      const at = (nodeId: string) => {
        const node = live.nodeById.get(nodeId);
        return node === undefined ? null : new THREE.Vector3(node.position.x, displayY(node.position.y, node.floor_id, live.lift), node.position.z);
      };
      let sliding = false;
      let gazeYaw: number | null = null;
      people.list.forEach((person, index) => {
        const figure = people.figures[index];
        const marker = people.markers[index];
        const from = at(person.from);
        const floorId = live.nodeById.get(person.from)?.floor_id;
        // 출구에 닿으면 바로 사라지지 않고 미끄럼틀을 타고 밖으로 빠져나간다.
        const exiting = person.status === "OUT" && people.slide[index] < SLIDE_SECONDS;
        const shown = live.showPeople && from !== null && floorId !== undefined && live.visibleFloors.has(floorId) && (person.status !== "OUT" || exiting);
        // 따라가는 사람 자신은 그리지 않는다. 눈앞에 자기 몸이 걸린다.
        figure.group.visible = shown && index !== live.follow;
        marker.visible = shown && live.follow === null && live.cctv === null;
        if (!shown || from === null) return;
        let point = from;
        let heading = new THREE.Vector3();
        if (exiting) {
          const ratio = Math.min(people.slide[index] / SLIDE_SECONDS, 1);
          // 처음엔 천천히, 갈수록 빨리. 앞으로 간 만큼만 내려가야 기울어진 판 위에 붙어 있다.
          const slid = ratio * (0.4 + 0.6 * ratio);
          heading = new THREE.Vector3(Math.sin(people.yaw[index]), 0, Math.cos(people.yaw[index]));
          point = from.clone().addScaledVector(heading, slid * SLIDE_LENGTH);
          // 판 높이에서 앉은 만큼 더 낮춘다.
          point.y -= slid * SLIDE_DROP + 0.45 * Math.min(ratio * 4, 1);
          if (index === live.follow) sliding = true;
        } else if (person.to !== null) {
          const path = stairPath(person.from, person.to);
          const to = at(person.to);
          if (path !== null) {
            ({ point, heading } = alongStair(path, person.progress));
            if (index === live.follow) {
              // 계단에서는 발밑 구간이 아니라 두어 걸음 앞을 본다. 계단참에 닿기 전에 미리 돌기 시작해
              // 꺾이는 동안 정면 벽만 보이는 시간을 줄인다. 걷는 길과 벽은 그대로다.
              const ahead = alongStair(path, person.progress + STAIR_LOOK_AHEAD / Math.max(path.length, 0.01)).point.sub(point);
              if (ahead.x * ahead.x + ahead.z * ahead.z > 0.04) gazeYaw = Math.atan2(ahead.x, ahead.z);
            }
          }
          else if (to !== null) {
            heading = to.clone().sub(from);
            point = from.clone().lerp(to, person.progress);
          }
        }
        // 같은 길을 걷는 사람이 한 점에 겹치지 않게 조금씩 비켜 세운다. 계단과 미끄럼틀에서는 한 줄로 간다.
        if (!exiting && heading.y === 0) {
          point.x += ((index % 3) - 1) * 0.35;
          point.z += ((index % 2) - 0.5) * 0.5;
        }
        figure.group.position.copy(point);
        if (heading.x * heading.x + heading.z * heading.z > 0.0001) people.yaw[index] = Math.atan2(heading.x, heading.z);
        // 걷는 길의 기울기. 계단에서는 내려가는 쪽(또는 올라가는 쪽)을 보게 하는 데 쓴다.
        people.slope[index] = person.to === null ? 0 : Math.atan2(heading.y, Math.hypot(heading.x, heading.z));
        figure.group.rotation.set(exiting ? -0.5 : 0, people.yaw[index], 0, "YXZ");
        poseFigure(figure, time * 6 + index, person.status === "MOVING");
        if (exiting) {
          // 앉아서 다리를 앞으로 뻗고 팔을 든다.
          figure.limbs[0].rotation.x = figure.limbs[1].rotation.x = -2.4;
          figure.limbs[2].rotation.x = figure.limbs[3].rotation.x = -1.3;
        }
        marker.position.set(point.x, point.y + 2.4, point.z);
        marker.material.color.setHex(person.status === "STUCK" ? COLOR.personStuck : COLOR.person);
      });
      // 1인칭: 고른 사람의 눈높이에서 걷는 방향을 본다.
      const justPicked = live.follow !== lastFollow;
      if (live.follow === null && lastFollow !== null) live.onListener?.(null);
      lastFollow = live.follow;
      if (live.follow === null) return;
      const followed = people.list[live.follow];
      const figure = people.figures[live.follow];
      if (followed === undefined || figure === undefined || (followed.status === "OUT" && !sliding)) {
        // 이미 탈출한 사람을 골랐으면 아직 안에 있는 다음 사람으로 넘어간다.
        // 따라가던 사람이 미끄럼틀을 다 내려가 빠져나간 경우에는 1인칭에서 나온다.
        const start = live.follow;
        const next = justPicked
          ? people.list.findIndex((_, offset) => people.list[(start + 1 + offset) % people.list.length].status !== "OUT")
          : -1;
        live.onFollow?.(next === -1 ? null : (start + 1 + next) % people.list.length);
        // 화면이 새 선택을 반영하기 전에 다음 프레임이 먼저 올 수 있다. 그때도 '방금 고름'으로 보도록 기록을 지운다.
        if (next !== -1) lastFollow = null;
        return;
      }
      // 처음 들어갈 때는 그 사람이 보는 쪽에서 바로 시작한다. 천천히 돌면 벽을 보며 시작한다.
      if (justPicked) viewYaw = people.yaw[live.follow];
      camera.position.set(figure.group.position.x, figure.group.position.y + (sliding ? 1.1 : 1.6), figure.group.position.z);
      // 계단처럼 한 줄로 걷는 곳에서는 바로 앞사람 몸통이 화면을 덮는다. 팔 닿을 거리 안의 사람은 그리지 않는다.
      for (const other of people.figures) {
        if (other !== figure && other.group.visible && other.group.position.distanceTo(figure.group.position) < 1.1) other.group.visible = false;
      }
      // 가까운 쪽으로 천천히 돌아 갈림길에서 화면이 홱 꺾이지 않게 한다.
      const wanted = gazeYaw ?? people.yaw[live.follow];
      const turn = Math.atan2(Math.sin(wanted - viewYaw), Math.cos(wanted - viewYaw));
      viewYaw += turn * Math.min(1, seconds * (gazeYaw === null ? 4 : 6));
      // 계단에서는 발 디딜 쪽을 본다. 내려갈 때는 아래를, 올라갈 때는 위를 향하고, 미끄럼틀에서는 내려다본다.
      const slope = Math.max(-0.75, Math.min(0.5, people.slope[live.follow]));
      const pitch = sliding ? -0.35 : -0.05 + slope * 0.9;
      viewPitch += (pitch - viewPitch) * Math.min(1, seconds * 4);
      camera.rotation.set(viewPitch, viewYaw + Math.PI, 0, "YXZ");
      if (time - lastListenerAt > 0.25) {
        lastListenerAt = time;
        // 계단을 걷는 동안의 지점은 떠나온 층의 계단 지점이다. 아래층에 닿아야 그 층의 출구 유도음 대상이 된다.
        live.onListener?.({ x: camera.position.x, z: camera.position.z, yaw: viewYaw, nodeId: followed.from, toNodeId: followed.to,
          routeNodeId: followed.returning && followed.to !== null ? followed.to : followed.from,
          personIndex: live.follow, runId: live.state.run_id, progress: followed.progress, moving: followed.status === "MOVING",
          evacuating: followed.started === true && followed.status !== "OUT" });
      }
      const zoneId = live.nodeById.get(followed.from)?.zone_id;
      const smoke = zoneId === undefined ? 0 : Math.max(live.smokeByZone?.get(zoneId) ?? 0,
        localSmoke(live.hazardByZone.get(zoneId) ?? [],zoneId,camera.position.x,camera.position.z));
      handles.fog.density = 0.012 + 0.11 * smoke;
    };

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const following = liveRef.current.follow !== null || liveRef.current.cctv !== null;
      // 1인칭에서는 궤도 조작이 카메라를 되돌리지 않게 건너뛴다.
      if (!following) controls.update();
      camera.updateMatrixWorld();
      const size = renderer.getSize(new THREE.Vector2());
      const labels = staticGroup.children.flatMap((child) => {
        if (!(child instanceof THREE.Sprite)) return [];
        // 1인칭에서는 이름표와 떠 있는 아이콘을 모두 감춘다. 실제 표지판만 보인다.
        if (following) {
          child.visible = false;
          return [];
        }
        if (child.userData.iconKind !== undefined) child.visible = true;
        // 설비 아이콘은 이름표 겹침 정리 대상이 아니다. 늘 보여야 한다.
        if (child.userData.iconKind !== undefined) return [];
        // CCTV·출구 이름표는 커서를 올렸을 때만 보이므로 겹침 정리에서 뺀다.
        if (child.userData.hoverLabel === true) return [];
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
      const now = performance.now();
      // 불꽃·시점 같은 화면 효과만 한 프레임의 시간을 묶는다. 사람의 이동 시간은 walkPeople이 따로 센다.
      const seconds = Math.min((now - lastFrame) / 1000, 0.2);
      const time = now / 1000;
      lastFrame = now;
      movePeople(seconds, time);
      // 불꽃과 불빛, 연기.
      for (const fire of handles.fires) fire.update(time, seconds);
      fireLights.forEach((light, index) => {
        const fire = handles.fires[index];
        if (fire === undefined) {
          light.intensity = 0;
          return;
        }
        light.position.copy(fire.object.position);
        light.position.y += 1.2;
        light.intensity = 26 + Math.sin(time * 13 + index) * 5 + Math.sin(time * 29) * 3;
      });
      const live = liveRef.current;
      for (const puff of handles.smokePuffs) placeSmoke(puff, live.smokeByZone?.get(puff.zoneId) ?? 0, live.wallHeight, time);
      if (live.cctv) handles.fog.density = 0.012 + 0.11 * cctvSmoke(live.cctv, live.smokeByZone, live.hazardByZone.get(live.cctv.zoneId) ?? []);
      for (const {puff,smoke} of handles.fieldPuffs.values()) {
        placeSmoke(puff,smoke,live.wallHeight,time);
        puff.sprite.scale.multiplyScalar(.55);
      }
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
      for (const child of [...staticGroup.children, ...dynamicGroup.children]) {
        if (!(child instanceof THREE.Sprite)) continue;
        sizeName(child, height);
        sizeIcon(child, height);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(frame);
      clearInterval(walker);
      observer.disconnect();
      controls.removeEventListener("change", keepInside);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      clearGroup(staticGroup);
      clearGroup(dynamicGroup);
      clearGroup(smokeGroup);
      clearGroup(fireGroup);
      for (const item of handles.disposables) item.dispose();
      for (const texture of handles.icons.values()) texture.dispose();
      handles.signboard?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      handlesRef.current = null;
    };
  }, []);

  // 1-1) 대피 인원. 실행이 바뀌면 방 입구에 다시 세운다. 표시를 껐다 켜는 것은 보이기만 바꾸고 사람의 상태는 그대로 둔다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    // 새로고침으로 다시 열렸으면 같은 방·같은 실행의 대피 상태를 이어 간다. 초기화된 실행이나 다른 방의 것은 쓰지 않는다.
    const scope = storageScope();
    let saved: ReturnType<typeof loadPeople> = null;
    try { saved = loadPeople(localStorage, scope, state.run_id, building); } catch { /* 저장소를 못 쓰면 처음 상태로 시작한다 */ }
    const list = saved?.people ?? spawnPeople(building);
    if (list.length === 0) return;
    const group = new THREE.Group();
    const figures = list.map((_, index) => {
      const figure = createFigure(index);
      figure.group.userData.personIndex = index;
      group.add(figure.group);
      return figure;
    });
    // 위에서 내려다볼 때 사람을 찾기 쉽게 머리 위에 점을 띄운다. 1인칭에서는 감춘다.
    const markers = list.map((_, index) => {
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: COLOR.person, depthTest: false, depthWrite: false, sizeAttenuation: false }));
      marker.scale.set(0.028, 0.028, 1);
      marker.renderOrder = 12;
      marker.userData.personIndex = index;
      group.add(marker);
      return marker;
    });
    handles.scene.add(group);
    // 처음에는 문에서 나갈 쪽을 본다. 모두 같은 쪽을 보면 1인칭이 벽이나 문을 보며 시작한다.
    const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
    const facing = list.map((person) => {
      const here = nodes.get(person.from);
      const ahead = nodes.get(doorFacing(building).get(person.from) ?? "");
      return here === undefined || ahead === undefined ? 0 : Math.atan2(ahead.position.x - here.position.x, ahead.position.z - here.position.z);
    });
    // 이미 탈출한 사람이 새로고침 뒤에 미끄럼틀을 다시 타지 않게 한다.
    peopleRef.current = { list, group, figures, markers, yaw: facing, slope: list.map(() => 0),
      slide: list.map((person) => (person.status === "OUT" && saved !== null ? SLIDE_SECONDS : 0)), key: "", lost: 0 };
    if (saved !== null && saved.follow !== null && list[saved.follow].status !== "OUT") liveRef.current.onFollow?.(saved.follow);
    const store = () => {
      try { savePeople(localStorage, scope, state.run_id, building, list, liveRef.current.follow); } catch { /* 저장 실패는 복원만 빠진다 */ }
    };
    const saver = setInterval(store, 1000);
    window.addEventListener("pagehide", store);
    return () => {
      clearInterval(saver);
      window.removeEventListener("pagehide", store);
      handles.scene.remove(group);
      disposeTree(group);
      for (const marker of markers) marker.material.dispose();
      peopleRef.current = null;
    };
  }, [building, state.run_id]);

  const handledFollow = useRef(0);
  useEffect(() => {
    if (followRequest === null || followRequest.nonce === handledFollow.current || peopleRef.current === null) return;
    handledFollow.current = followRequest.nonce;
    const index = nearestPerson(building, peopleRef.current.list, followRequest.nodeId);
    if (index === null) onFollowUnavailable?.();
    else onFollow?.(index);
  }, [followRequest, building, onFollow, onFollowUnavailable]);

  // 1-2) 1인칭 전환. 시야를 넓히고 궤도 조작을 끈다. 나오면 2-1의 화면 맞춤이 시점을 되돌린다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const firstPerson = firstPersonView;
    handles.controls.enabled = !firstPerson;
    handles.camera.fov = firstPerson ? 72 : FOV;
    handles.camera.near = firstPerson ? 0.1 : 0.5;
    handles.camera.updateProjectionMatrix();
    handles.scene.fog = firstPerson ? handles.fog : null;
    handles.hemisphere.groundColor.setHex(firstPerson ? 0xb9c2cf : 0x1a2230);
    handles.uplight.intensity = firstPerson ? 1.4 : 0;
  }, [firstPersonView]);

  // 2) 정적 형상: 바닥·벽·계단·구역 판. 형상이나 층 표시가 바뀔 때만 다시 만든다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const { staticGroup } = handles;
    clearGroup(staticGroup);
    handles.zoneMeshes.clear();
    clearGroup(handles.smokeGroup);
    handles.smokePuffs = [];
    handles.fieldPuffs.clear();
    handles.signFaces = new Map();
    const edgeByDoor = doorFacing(building);

    // 1인칭에서는 벽을 천장까지 올려 옆방이 넘겨다보이지 않게 한다. 평소에는 위에서 들여다보도록 낮게 둔다.
    const wallHeight = firstPersonView ? geometry.floor_height - geometry.slab_thickness : geometry.wall_height;
    const elevationById = new Map(geometry.floors.map((floor) => [floor.floor_id, floor.elevation]));
    const lowestFloorOf = (stair: GeometryStair) => [...stair.floors].sort((a, b) => (elevationById.get(a) ?? 0) - (elevationById.get(b) ?? 0))[0];
    const groundElevation = Math.min(...geometry.floors.map((floor) => floor.elevation));
    const topFloorId = geometry.floors
      .filter((floor) => visibleFloors.has(floor.floor_id))
      .reduce<{ floor_id: string; elevation: number } | null>((top, floor) => (top === null || floor.elevation > top.elevation ? floor : top), null)
      ?.floor_id;
    for (const floor of geometry.floors) {
      if (!visibleFloors.has(floor.floor_id)) continue;

      // 바닥. 뚫린 공간은 구멍으로 판다.
      const slabShape = shapeFrom(floor.slab);
      for (const hole of floor.slab_holes) slabShape.holes.push(shapeFrom(hole.polygon));
      // 계단이 올라오는 자리는 바닥을 뚫는다. 막혀 있으면 계단을 걷는 사람이 바닥을 뚫고 지나간다.
      // 이미 뚫린 공간 안에 있는 계단은 겹쳐 뚫지 않는다.
      for (const stair of geometry.stairs) {
        if (!stair.floors.includes(floor.floor_id) || floor.floor_id === lowestFloorOf(stair)) continue;
        const center = {
          x: stair.footprint.reduce((sum, point) => sum + point.x, 0) / stair.footprint.length,
          z: stair.footprint.reduce((sum, point) => sum + point.z, 0) / stair.footprint.length,
        };
        if (floor.slab_holes.some((hole) => insidePolygon(center, hole.polygon))) continue;
        slabShape.holes.push(shapeFrom(stair.footprint));
      }
      const slab = new THREE.Mesh(
        new THREE.ExtrudeGeometry(slabShape, { depth: geometry.slab_thickness, bevelEnabled: false }),
        new THREE.MeshLambertMaterial({ color: COLOR.slab }),
      );
      const base = displayY(floor.elevation, floor.floor_id, lift);
      layFlat(slab, base);
      slab.receiveShadow = true;
      slab.castShadow = true;
      staticGroup.add(slab);
      // 뚫린 공간 둘레의 유리 난간. 계단이 올라오는 자리는 비워 둔다.
      for (const hole of floor.slab_holes) {
        const rail = new THREE.Group();
        const pane = new THREE.MeshLambertMaterial({ color: COLOR.glass, transparent: true, opacity: 0.35, depthWrite: false });
        const bar = new THREE.MeshLambertMaterial({ color: COLOR.frame });
        hole.polygon.forEach((from, index) => {
          const to = hole.polygon[(index + 1) % hole.polygon.length];
          const length = Math.hypot(to.x - from.x, to.z - from.z);
          const pieces = Math.max(1, Math.round(length / 0.9));
          for (let piece = 0; piece < pieces; piece += 1) {
            const x = from.x + ((to.x - from.x) * (piece + 0.5)) / pieces;
            const z = from.z + ((to.z - from.z) * (piece + 0.5)) / pieces;
            const onStair = geometry.stairs.some((stair) => {
              if (!stair.floors.includes(floor.floor_id)) return false;
              const sx = stair.footprint.map((point) => point.x);
              const sz = stair.footprint.map((point) => point.z);
              return x > Math.min(...sx) - 0.4 && x < Math.max(...sx) + 0.4 && z > Math.min(...sz) - 0.4 && z < Math.max(...sz) + 0.4;
            });
            if (onStair) continue;
            for (const [material, height, y, thick] of [[pane, 1.05, 0.55, 0.03], [bar, 0.05, 1.1, 0.06]] as const) {
              const part = new THREE.Mesh(new THREE.BoxGeometry(thick, height, length / pieces), material);
              part.position.set(x, base + y, z);
              part.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
              rail.add(part);
            }
          }
        });
        staticGroup.add(rail);
      }

      // 맨 위층은 위에 바닥이 없으므로 1인칭일 때만 천장을 덮는다.
      if (firstPersonView && floor.floor_id === topFloorId) {
        const ceiling = new THREE.Mesh(
          new THREE.ExtrudeGeometry(shapeFrom(floor.slab), { depth: geometry.slab_thickness, bevelEnabled: false }),
          new THREE.MeshLambertMaterial({ color: COLOR.concrete }),
        );
        layFlat(ceiling, base + geometry.floor_height);
        staticGroup.add(ceiling);
      }

      // 외관: 실제 건물처럼 층마다 흰 콘크리트 띠가 튀어나오고 그 사이는 어두운 유리 외벽이다.
      // 안쪽은 지금처럼 위에서 들여다본다. 지붕은 내부를 가려 그리지 않고 맨 위층에 난간 띠만 두른다.
      const xs = floor.slab.map((point) => point.x);
      const zs = floor.slab.map((point) => point.z);
      const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      const concrete = () => new THREE.MeshLambertMaterial({ color: COLOR.concrete });
      const rect = (grow: number) => [
        { x: minX - grow, z: minZ - grow }, { x: maxX + grow, z: minZ - grow },
        { x: maxX + grow, z: maxZ + grow }, { x: minX - grow, z: maxZ + grow },
      ];
      if (floor.floor_id === topFloorId) {
        const bandShape = shapeFrom(rect(1));
        bandShape.holes.push(shapeFrom(rect(0)));
        const band = new THREE.Mesh(new THREE.ExtrudeGeometry(bandShape, { depth: 0.45, bevelEnabled: false }), concrete());
        layFlat(band, base + wallHeight + 0.45);
        staticGroup.add(band);
      }
      const facade = facadeParts(building, floor, wallHeight);
      const place = new THREE.Matrix4();
      const still = new THREE.Quaternion();
      for (const [parts, material] of [
        [facade.glass, new THREE.MeshLambertMaterial({ color: COLOR.glass, transparent: true, opacity: 0.32, depthWrite: false })],
        [facade.frames, new THREE.MeshLambertMaterial({ color: COLOR.frame })],
        [facade.band, concrete()],
        // 대피 출구로 쓰지 않는 외부 문 후보. 문은 있되 닫혀 있다. 실제 출입문인지는 미확인(U06)이다.
        [facade.closedDoors, new THREE.MeshLambertMaterial({ color: COLOR.door })],
      ] as const) {
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, parts.length);
        parts.forEach((part, index) => {
          place.compose(new THREE.Vector3(part.x, base + part.y, part.z), still, new THREE.Vector3(part.width, part.height, part.depth));
          mesh.setMatrixAt(index, place);
        });
        mesh.instanceMatrix.needsUpdate = true;
        staticGroup.add(mesh);
      }

      // 간판: 맨 위층 유리 상단. 1층이 깊게 들어간 필로티 쪽(안내도 위쪽) 면을 밖에서 볼 때 오른쪽 끝이다.
      if (floor.floor_id === topFloorId) {
        handles.signboard ??= signboardTexture();
        const texture = handles.signboard;
        if (texture !== null) {
          const image = texture.image as HTMLCanvasElement;
          const width = (1.2 * image.width) / image.height;
          const board = new THREE.Mesh(
            new THREE.PlaneGeometry(width, 1.2),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
          );
          board.position.set(minX + width / 2 + 1.5, base + wallHeight - 0.8, minZ - 0.2);
          board.rotation.y = Math.PI;
          board.renderOrder = 5;
          staticGroup.add(board);
        }
      }

      // 아래층보다 튀어나온 쪽은 기둥으로 받친다(1층 필로티).
      const below = geometry.floors[geometry.floors.indexOf(floor) - 1];
      if (below !== undefined && visibleFloors.has(below.floor_id)) {
        const belowBase = displayY(below.elevation, below.floor_id, lift);
        const parts = facadeColumns(building, floor, below, base - geometry.slab_thickness - belowBase);
        if (parts.length > 0) {
          const columns = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), concrete(), parts.length);
          parts.forEach((part, index) => {
            place.compose(new THREE.Vector3(part.x, belowBase + part.y, part.z), still, new THREE.Vector3(part.width, part.height, part.depth));
            columns.setMatrixAt(index, place);
          });
          columns.instanceMatrix.needsUpdate = true;
          staticGroup.add(columns);
        }
      }

      // 벽. 열린 계단 안의 난간 선은 빼고 하나의 인스턴스 메시로 그린다.
      // 건물 둘레의 벽은 불투명하게 세우지 않는다. 그 자리는 위의 유리 외벽이 맡아 안이 들여다보인다.
      const near = (value: number, edge: number) => Math.abs(value - edge) < 0.4;
      const walls = visibleWalls(floor, geometry.stairs).filter((wall) => {
        const box = wallBox(wall);
        return !(box.sizeZ < 0.5 && (near(box.centerZ, minZ) || near(box.centerZ, maxZ)))
          && !(box.sizeX < 0.5 && (near(box.centerX, minX) || near(box.centerX, maxX)));
      });
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
            new THREE.Vector3(box.centerX, base + wallHeight / 2, box.centerZ),
            new THREE.Quaternion(),
            new THREE.Vector3(box.sizeX, wallHeight, box.sizeZ),
          );
          mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        staticGroup.add(mesh);

        // 벽 윗면 마감 띠. 잘린 단면처럼 보이지 않게 조금 넓고 어두운 띠를 얹는다.
        const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: COLOR.wallCap }), walls.length);
        walls.forEach((wall, index) => {
          const box = wallBox(wall);
          matrix.compose(
            new THREE.Vector3(box.centerX, base + wallHeight + 0.04, box.centerZ),
            new THREE.Quaternion(),
            new THREE.Vector3(box.sizeX + 0.06, 0.08, box.sizeZ + 0.06),
          );
          caps.setMatrixAt(index, matrix);
        });
        caps.instanceMatrix.needsUpdate = true;
        staticGroup.add(caps);
      }

      // 문. 방 입구 지점에 문틀과 열린 문짝을 세운다. 문이 향하는 쪽은 그 입구에서 이어진 통로 방향이다.
      for (const node of building.nodes) {
        if (node.kind !== "DOOR" || node.floor_id !== floor.floor_id) continue;
        const toward = nodeById.get(edgeByDoor.get(node.node_id) ?? "");
        if (toward === undefined) continue;
        const door = new THREE.Group();
        const frame = new THREE.MeshLambertMaterial({ color: COLOR.frame });
        for (const [w, h, x, y] of [[0.1, 2.2, -0.55, 1.1], [0.1, 2.2, 0.55, 1.1], [1.2, 0.1, 0, 2.25]]) {
          const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), frame);
          piece.position.set(x, y, 0);
          piece.castShadow = true;
          door.add(piece);
        }
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 2.1, 0.05), new THREE.MeshLambertMaterial({ color: COLOR.door }));
        // 활짝 열어 방 안쪽으로 젖혀 둔다. 반쯤 열면 나오는 사람이 문짝을 뚫고 지나간다.
        leaf.position.set(-0.52, 1.05, -0.5);
        leaf.rotation.y = Math.PI / 2;
        leaf.castShadow = true;
        door.add(leaf);
        door.position.set(node.position.x, base, node.position.z);
        door.rotation.y = Math.atan2(toward.position.x - node.position.x, toward.position.z - node.position.z);
        staticGroup.add(door);
      }

      // 출구 미끄럼틀. 켜진 출구마다 밖으로 내려가는 미끄럼판과 옆 난간을 놓는다. 사람이 이 위로 빠져나간다.
      for (const exit of building.exits) {
        const node = nodeById.get(exit.node_id);
        if (!exit.enabled || node === undefined || node.floor_id !== floor.floor_id) continue;
        const inner = nodeById.get(building.edges.find((edge) => edge.to_node_id === exit.node_id)?.from_node_id ?? "");
        if (inner === undefined) continue;
        const slide = new THREE.Group();
        const paint = new THREE.MeshLambertMaterial({ color: COLOR.slide });
        const length = Math.hypot(SLIDE_LENGTH, SLIDE_DROP);
        const pitch = Math.atan2(SLIDE_DROP, SLIDE_LENGTH);
        for (const [width, height, x] of [[1.2, 0.08, 0], [0.08, 0.35, -0.6], [0.08, 0.35, 0.6]]) {
          const piece = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), paint);
          piece.position.set(x, -SLIDE_DROP / 2 + height / 2, SLIDE_LENGTH / 2);
          piece.rotation.x = pitch;
          piece.castShadow = true;
          slide.add(piece);
        }
        slide.position.set(node.position.x, base, node.position.z);
        slide.rotation.y = Math.atan2(node.position.x - inner.position.x, node.position.z - inner.position.z);
        staticGroup.add(slide);
      }

      // 천장 표지판. 면마다 바라보는 쪽이 자료에 있으므로 그대로 세운다. 그림은 서버 표시값이 올 때 채운다.
      for (const sign of building.signs) {
        const node = nodeById.get(sign.node_id);
        if (node === undefined || node.floor_id !== floor.floor_id) continue;
        // view_direction은 그 면을 보는 사람의 시선이다. 면은 그 반대쪽을 향한다.
        const hung = buildHangingSign(sign.faces.map((face) => ({ faceId: face.face_id, normalX: -face.view_direction.x, normalZ: -face.view_direction.z })));
        hung.group.position.set(node.position.x, base + wallHeight - 0.56, node.position.z);
        staticGroup.add(hung.group);
        handles.signFaces.set(sign.sign_id, hung.faces);
        // QR은 유도등 옆의 위치 확인판이다. 인식 연출은 휴대폰 UI에서만 수행한다.
        if (building.building_id === "WFI" && building.building_version === 5) {
          const texture = new THREE.TextureLoader().load(`/qr/${encodeURIComponent(sign.sign_id)}.png`);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.magFilter = THREE.NearestFilter;
          const qr = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.65), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
          qr.userData.ownsMap = true;
          const face = sign.faces[0];
          qr.rotation.y = Math.atan2(-face.view_direction.x, -face.view_direction.z);
          qr.position.set(node.position.x - face.view_direction.z * 0.85, base + 1.85, node.position.z + face.view_direction.x * 0.85);
          staticGroup.add(qr);
        }
      }

      // 구역 판. 관측 위험 표시에 재사용하므로 평소에는 숨겨 둔다.
      for (const zone of building.zones) {
        if (zone.floor_id !== floor.floor_id) continue;
        // 바닥 색으로 통행 공간·방·계단을 구분한다. 뚫린 공간은 칠하지 않는다.
        // shortcut: 구역 종류 필드가 없어 WFI zone_id 이름으로 가른다, 다른 건물을 넣으면 표시 자료에 종류를 둔다.
        const tint = /STAIR/.test(zone.zone_id) ? (floor.elevation > groundElevation ? null : COLOR.floorStair)
          : /CORR|PASSAGE|LOBBY/.test(zone.zone_id) ? COLOR.floorPassage
          : /VOID/.test(zone.zone_id) ? null : COLOR.floorRoom;
        if (tint !== null) {
          const floorTint = new THREE.Mesh(
            new THREE.ShapeGeometry(shapeFrom(zone.polygon)),
            new THREE.MeshLambertMaterial({ color: tint, side: THREE.DoubleSide }),
          );
          layFlat(floorTint, base + 0.02);
          floorTint.receiveShadow = true;
          staticGroup.add(floorTint);
        }
        // 방과 로비 바닥에 이름을 흐리게 눕혀 적는다. 복도·계단은 좁아서 적지 않는다.
        const named = tint === COLOR.floorRoom || /LOBBY/.test(zone.zone_id);
        const nameMap = named ? floorNameTexture(zone.label) : null;
        if (nameMap !== null) {
          const px = zone.polygon.map((point) => point.x);
          const pz = zone.polygon.map((point) => point.z);
          const [roomW, roomD] = [Math.max(...px) - Math.min(...px), Math.max(...pz) - Math.min(...pz)];
          const aspect = nameMap.image.width / nameMap.image.height;
          const height = Math.min(roomD * 0.3, 1.5, (roomW * 0.8) / aspect);
          const name = new THREE.Mesh(
            new THREE.PlaneGeometry(height * aspect, height),
            new THREE.MeshBasicMaterial({ map: nameMap, transparent: true, opacity: 0.32, depthWrite: false }),
          );
          // 안내도 위쪽이 글자 위쪽이 되게 눕힌다.
          name.rotation.x = -Math.PI / 2;
          name.position.set((Math.min(...px) + Math.max(...px)) / 2, base + 0.04, (Math.min(...pz) + Math.max(...pz)) / 2);
          name.userData.ownsMap = true;
          staticGroup.add(name);
        }
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

        // 연기 입자. 구역 안 여기저기에 미리 흩어 두고, 농도에 따라 천장부터 내려오게 한다.
        const zoneXs = zone.polygon.map((point) => point.x);
        const zoneZs = zone.polygon.map((point) => point.z);
        const [zx, zz] = [Math.min(...zoneXs), Math.min(...zoneZs)];
        const [zw, zd] = [Math.max(...zoneXs) - zx, Math.max(...zoneZs) - zz];
        const wanted = Math.max(3, Math.min(14, Math.round((zw * zd) / 5)));
        // 다시 그려도 같은 자리에 놓이게 순번으로 자리를 정한다.
        for (let index = 0, placed = 0; index < wanted * 4 && placed < wanted; index += 1) {
          const x = zx + ((index * 0.618 + 0.13) % 1) * zw;
          const z = zz + ((index * 0.7548 + 0.37) % 1) * zd;
          if (!insidePolygon({ x, z }, zone.polygon)) continue;
          const sprite = createSmokeSprite();
          handles.smokeGroup.add(sprite);
          handles.smokePuffs.push({ sprite, zoneId: zone.zone_id, baseY: base, seed: ((index * 0.3819 + 0.2) % 1), x, z });
          placed += 1;
        }
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
      const top = Math.max(...elevations) + wallHeight;
      const mesh = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shapeFrom(stair.footprint), { depth: top - bottom, bevelEnabled: false }),
        new THREE.MeshLambertMaterial({
          color: stair.kind === "ENCLOSED" ? COLOR.stairEnclosed : COLOR.stairOpen,
          transparent: true,
          opacity: stair.kind === "ENCLOSED" ? 0.35 : 0.2,
        }),
      );
      // layFlat은 준 높이에서 아래로 내려 깐다. 윗면 높이를 줘야 바닥부터 위로 선다.
      layFlat(mesh, top);
      // 1인칭에서는 계단실 안이 뿌옇게 물들어 보이므로 그리지 않는다.
      if (!firstPersonView) staticGroup.add(mesh);
      else disposeTree(mesh);

      // 층 사이 계단. 안내도 모양(꺾인 계단·둥글게 꺾이는 계단·곧은 계단)대로 디딤판과 난간을 놓는다.
      const elevationOf = (id: string) => geometry.floors.find((floor) => floor.floor_id === id)?.elevation ?? 0;
      const ordered = [...shown].sort((a, b) => elevationOf(a) - elevationOf(b));
      const up = new THREE.Vector3(0, 1, 0);
      const rail = new THREE.MeshLambertMaterial({ color: COLOR.frame });
      for (let level = 1; level < ordered.length; level += 1) {
        const steps = flightSteps(building, geometry, stair, ordered[level - 1], ordered[level], lift);
        const treads = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshLambertMaterial({ color: stair.kind === "ENCLOSED" ? COLOR.stepEnclosed : COLOR.stepOpen }),
          steps.length,
        );
        const matrix = new THREE.Matrix4();
        const turn = new THREE.Quaternion();
        steps.forEach((step, index) => {
          matrix.compose(
            new THREE.Vector3(step.x, step.y - 0.09, step.z),
            turn.setFromAxisAngle(up, step.yaw),
            new THREE.Vector3(step.width, 0.18, step.run * 1.1),
          );
          treads.setMatrixAt(index, matrix);
        });
        treads.instanceMatrix.needsUpdate = true;
        treads.castShadow = true;
        treads.receiveShadow = true;
        staticGroup.add(treads);

        const landing = stairLanding(building, geometry, stair, ordered[level - 1], ordered[level], lift);
        if (landing !== null) {
          const platform = new THREE.Mesh(
            new THREE.BoxGeometry(landing.width, 0.18, landing.run),
            new THREE.MeshLambertMaterial({ color: stair.kind === "ENCLOSED" ? COLOR.stepEnclosed : COLOR.stepOpen }),
          );
          platform.position.set(landing.x, landing.y - 0.09, landing.z);
          platform.rotation.y = landing.yaw;
          platform.castShadow = true;
          platform.receiveShadow = true;
          staticGroup.add(platform);
        }

        // 난간. 진행 방향의 오른쪽 가장자리에 손잡이와 기둥을 세운다.
        const edge = (step: StairStepAlong, height: number) => new THREE.Vector3(
          step.x + Math.cos(step.yaw) * (step.width / 2 - 0.05),
          step.y + height,
          step.z - Math.sin(step.yaw) * (step.width / 2 - 0.05),
        );
        steps.forEach((step, index) => {
          const next = steps[index + 1];
          const handrail = next === undefined ? null : rod(edge(step, 0.95), edge(next, 0.95), 0.03, rail.clone());
          if (handrail !== null) staticGroup.add(handrail);
          if (index % 3 === 0) {
            const post = rod(edge(step, 0), edge(step, 0.95), 0.022, rail.clone());
            if (post !== null) staticGroup.add(post);
          }
        });
      }
      rail.dispose();
    }
    handles.cameraIcons = [];
    handles.exitLabels = new Map();
    // 출구 유도등 아이콘이 서는 출구. 이 출구의 이름표는 아이콘에 커서를 올렸을 때만 보인다.
    // 유도등이 없는 출구 후보(비활성)는 올릴 아이콘이 없으므로 이름표를 그대로 둔다.
    const exitSignNodes = new Set(
      building.signs.filter((sign) => display?.signs[sign.sign_id]?.kind === "EXIT_LOCATION").map((sign) => sign.node_id),
    );
    const viewportHeight = handles.renderer.getSize(new THREE.Vector2()).y;
    for (const label of sceneLabels(building, display, visibleFloors)) {
      const y = displayY(label.position.y, label.floorId, lift);
      const exitHover = label.nodeId !== null && exitSignNodes.has(label.nodeId);
      // 공간 이름표는 "공간 이름"을 켰을 때만. CCTV·출구 이름표는 따로, 아이콘에 커서를 올렸을 때만 보인다.
      const sprite = showNames || label.camera || exitHover ? nameSprite(label.text, viewportHeight) : null;
      if (sprite !== null) {
        sprite.position.set(label.position.x, y + 0.5, label.position.z);
        sprite.userData.priority = label.priority;
        if (label.camera) {
          // CCTV 아이콘은 기준점이 가운데라 아이콘 높이의 절반 위로 띄운다.
          liftLabelAbove(sprite, ICON_PIXELS.CAMERA.height / 2);
        } else if (exitHover && label.nodeId !== null) {
          // 출구 아이콘은 기둥 끝에 아래쪽을 맞춰 서므로 같은 높이에서 아이콘 높이만큼 위로 띄운다.
          sprite.position.y = y + wallHeight + 0.3;
          liftLabelAbove(sprite, ICON_PIXELS.EXIT_ON.height);
          handles.exitLabels.set(label.nodeId, sprite);
        }
        staticGroup.add(sprite);
      }
      if (label.camera && label.sourceId) {
        // CCTV 아이콘. 고른 카메라는 아래 동적 표시에서 더 큰 아이콘으로 덮는다.
        const icon = iconSprite(handles, "CAMERA", true);
        if (icon !== null) {
          icon.position.set(label.position.x, y + 0.5, label.position.z);
          staticGroup.add(icon);
          handles.cameraIcons.push({ sourceId: label.sourceId, icon, label: sprite });
        } else {
          const camera = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({ color: COLOR.camera }));
          camera.position.set(label.position.x, y, label.position.z);
          staticGroup.add(camera);
        }
      }
    }
  }, [geometry, building, display, showNames, visibleFloors, lift, nodeById, firstPersonView]);

  // 2-1) 화면 맞춤. 보이는 층이나 간격이 바뀌면 그 범위가 다 보이게 마지막 시점 모드로 맞추고,
  //      시점 버튼(view.nonce)을 누르면 같은 모드라도 다시 맞춘다.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const box = visibleBox(geometry, visibleFloors, lift);
    handles.box = box;
    if (box === null) return;
    if (cctv) {
      const { eye, target } = cctv;
      handles.camera.position.set(eye.x, eye.y, eye.z);
      handles.camera.lookAt(target.x, target.y, target.z);
      return;
    }
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
  }, [geometry, visibleFloors, lift, view, cctv]);

  // 3) 서버 결과: 지점 상태·다음 이동 방향·유도등·관측 위험·연기 정답.
  useEffect(() => {
    const handles = handlesRef.current;
    if (handles === null) return;
    const { dynamicGroup } = handles;
    clearGroup(dynamicGroup);
    handles.pick = null;
    // 출발점을 고르면 전체 안내는 흐리게 두고 그 지점의 경로만 또렷하게 그린다.
    const focused = journey !== null;
    // 1인칭에서는 지점 구·바닥 화살표·기둥 아이콘·선택 경로를 그리지 않는다. 걷는 사람 눈에는 실제 표지판만 보인다.
    const firstPerson = firstPersonView;

    const blockedReason = new Map(state.blocked_nodes.map((node) => [node.node_id, node.reason_codes]));
    const routeByNode = new Map(state.routes.map((route) => [route.node_id, route]));
    const signNodes = new Map(building.signs.map((sign) => [sign.node_id, sign.sign_id]));
    const signState = new Map(state.signs.map((sign) => [sign.sign_id, sign]));

    const shownNodes = building.nodes.filter((node) => visibleFloors.has(node.floor_id));

    // 지점 표시. 차단·안내 가능·안내 불가를 색으로 나눈다.
    if (shownNodes.length > 0 && !firstPerson) {
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
      handles.pick = { mesh, ids: shownNodes.map((node) => node.node_id) };
    }

    // 다음 이동 방향. 서버 Route의 next_node_id만 사용한다.
    // 같은 층 이동은 바닥에 눕힌 평면 화살표로 그린다. 원뿔은 위에서 보면 덩어리로만 보여
    // 방향을 읽기 어렵다. 층을 오르내리는 계단 이동만 위아래가 드러나는 원뿔로 남긴다.
    const segments: number[] = [];
    const flatArrows: THREE.Matrix4[] = [];
    const stairArrows: THREE.Matrix4[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const route of showGuidance && !firstPerson ? state.routes : []) {
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
      // 층을 오르내리는 안내는 계단을 따라 그린다. 곧게 이으면 선이 바닥을 뚫는다.
      const stairs = stairLink(building, geometry, lift, from, to, 1.1);
      if (stairs !== null) {
        for (let index = 1; index < stairs.length; index += 1) {
          segments.push(stairs[index - 1].x, stairs[index - 1].y, stairs[index - 1].z, stairs[index].x, stairs[index].y, stairs[index].z);
        }
        const middle = Math.floor(stairs.length / 2);
        const slope = stairs[middle].clone().sub(stairs[middle - 1]);
        if (slope.length() > 0.001) {
          stairArrows.push(new THREE.Matrix4().compose(stairs[middle], new THREE.Quaternion().setFromUnitVectors(up, slope.normalize()), new THREE.Vector3(1, 1, 1)));
        }
        continue;
      }
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
          new THREE.LineBasicMaterial({ color: COLOR.guided, transparent: true, opacity: focused ? DIMMED : 0.5 }),
        ),
      );
    }

    if (flatArrows.length > 0) {
      const plates = new THREE.InstancedMesh(
        flatArrowGeometry(),
        new THREE.MeshBasicMaterial({ color: COLOR.guided, side: THREE.DoubleSide, transparent: focused, opacity: focused ? DIMMED : 1 }),
        flatArrows.length,
      );
      flatArrows.forEach((matrix, index) => plates.setMatrixAt(index, matrix));
      plates.instanceMatrix.needsUpdate = true;
      dynamicGroup.add(plates);
    }

    if (stairArrows.length > 0) {
      const cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.42, 1.1, 10),
        new THREE.MeshLambertMaterial({ color: COLOR.guided, transparent: focused, opacity: focused ? DIMMED : 1 }),
        stairArrows.length,
      );
      stairArrows.forEach((matrix, index) => cones.setMatrixAt(index, matrix));
      cones.instanceMatrix.needsUpdate = true;
      dynamicGroup.add(cones);
    }

    // 유도등. 표지 종류를 모양으로 구분한다(이슈 #70).
    // 가는 기둥으로 설치 지점을 잡고, 그 위에 국내 유도등 모양 아이콘을 띄운다.
    // 출구 위치 표지는 초록 바탕 피난구 유도등 그림, 가변 방향 안내는 작은 네모 표시등이다(icons.ts).
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

    // 기둥은 바닥에서 벽 높이 조금 위까지. 아이콘은 그 끝에 얹어 벽 너머에서도 보이게 한다.
    const poleTop = geometry.wall_height + 0.3;
    if (!firstPerson) placeSigns(shownSigns, () => new THREE.CylinderGeometry(0.06, 0.06, poleTop, 6), poleTop / 2);
    handles.exitIcons = [];
    for (const [signs, exitLocation] of firstPerson ? [] : ([[directionalSigns, false], [exitSigns, true]] as const)) {
      for (const sign of signs) {
        const node = nodeById.get(sign.node_id);
        if (node === undefined) continue;
        const guiding = signState.get(sign.sign_id)?.faces.some((face) => face.display !== null) ?? false;
        // 출구 위치 표지는 수가 적고 출구 이름표와 같은 자리에 서므로 이름표 위로 늘 보이게 한다.
        const icon = iconSprite(handles, signIcon(exitLocation, guiding), exitLocation);
        if (icon === null) continue;
        icon.center.set(0.5, 0);
        icon.position.set(node.position.x, displayY(node.position.y, node.floor_id, lift) + poleTop, node.position.z);
        dynamicGroup.add(icon);
        if (exitLocation) handles.exitIcons.push({ icon, nodeId: node.node_id });
      }
    }

    // 관측 위험 구역: 활성 경보 원인의 담당 구역을 바닥 판으로 칠한다.
    for (const mesh of handles.zoneMeshes.values()) mesh.visible = false;
    for (const cause of state.active_causes) {
      if (cause.ignition_position) continue;
      const source = sourceById.get(cause.source_id);
      if (source === undefined) continue;
      const mesh = handles.zoneMeshes.get(source.zone_id);
      const zone = zoneById.get(source.zone_id);
      if (mesh === undefined || zone === undefined || !visibleFloors.has(zone.floor_id)) continue;
      mesh.material.color.setHex(COLOR.hazard);
      // 1인칭에서는 바닥의 위험 판 대신 불과 연기가 보인다.
      mesh.visible = !firstPerson;
    }

    // 천장 표지판의 면. 서버가 준 표시값 그대로 그림을 바꾼다. 안내 불가면 꺼진 면이다.
    for (const sign of state.signs) {
      const meshes = handles.signFaces.get(sign.sign_id);
      if (meshes === undefined) continue;
      for (const face of sign.faces) {
        const mesh = meshes.get(face.face_id);
        if (mesh === undefined) continue;
        mesh.material.map = signFaceTexture(face.display);
        mesh.material.needsUpdate = true;
      }
    }

    // 실제 경보는 구역 표시, 위치 지정 시험은 서버가 보낸 작은 칸별 화염을 표시한다.
    const burning = [...new Set(state.active_causes.filter((cause) => cause.hazard_type === "FIRE" && !cause.ignition_position).map((cause) => sourceById.get(cause.source_id)?.zone_id))]
      .flatMap((zoneId) => {
        const zone = zoneId === undefined ? undefined : zoneById.get(zoneId);
        return zone !== undefined && visibleFloors.has(zone.floor_id) ? [zone] : [];
      });
    const flameCells = simulationFireCells(state.fire_simulation,visibleFloors);
    const desired = [...flameCells.map(c=>({key:`${state.run_id}/${c.cell_id}`,position:c.position,floorId:c.floor_id,intensity:c.fire})),
      ...burning.map(zone=>({key:`${state.run_id}/zone:${zone.zone_id}`,position:{
        x:zone.polygon.reduce((s,p)=>s+p.x,0)/zone.polygon.length,
        y:building.floors.find(f=>f.floor_id===zone.floor_id)!.elevation,
        z:zone.polygon.reduce((s,p)=>s+p.z,0)/zone.polygon.length},floorId:zone.floor_id,intensity:1}))];
    const fireIds = new Set(desired.map(c=>c.key));
    for (const [key,fire] of handles.fireObjects) {
      if (!fireIds.has(key)) { handles.fireGroup.remove(fire.object); disposeTree(fire.object); handles.fireObjects.delete(key); }
    }
    for (const cell of desired) {
      let fire = handles.fireObjects.get(cell.key);
      if (!fire) { fire=createFire(); handles.fireObjects.set(cell.key,fire); handles.fireGroup.add(fire.object); }
      fire.object.position.set(cell.position.x,displayY(cell.position.y,cell.floorId,lift),cell.position.z);
      fire.object.scale.setScalar(.2+.8*cell.intensity);
    }
    handles.fires = [...handles.fireObjects.values()];
    const smokeCells = (state.fire_simulation?.cells ?? []).filter(c=>c.smoke>.02 && visibleFloors.has(c.floor_id)
      && !c.cell_id.startsWith("node:") && !c.cell_id.startsWith("edge:"));
    const smokeIds = new Set(smokeCells.map(c=>`${state.run_id}/${c.cell_id}`));
    for (const [key,{puff}] of handles.fieldPuffs) {
      if (!smokeIds.has(key)) { handles.smokeGroup.remove(puff.sprite); puff.sprite.material.dispose(); handles.fieldPuffs.delete(key); }
    }
    smokeCells.forEach((cell,index)=>{
      const key = `${state.run_id}/${cell.cell_id}`;
      const baseY = displayY(cell.position.y,cell.floor_id,lift);
      let entry = handles.fieldPuffs.get(key);
      if (!entry) {
        const sprite = createSmokeSprite(); handles.smokeGroup.add(sprite);
        entry = {puff:{sprite,zoneId:cell.zone_id,baseY,x:cell.position.x,z:cell.position.z,seed:(index*.3819+.2)%1},smoke:cell.smoke};
        handles.fieldPuffs.set(key,entry);
      } else {
        entry.smoke=cell.smoke;
        entry.puff={...entry.puff,baseY,x:cell.position.x,z:cell.position.z,zoneId:cell.zone_id};
      }
    });

    // 고른 카메라의 설치 위치 강조(이슈 #74). 관측 구역(바닥 판)과 달리 설치 지점만 가리킨다.
    const installation = highlightSourceId === null
      ? null
      : display?.sources[highlightSourceId]?.installation ?? null;
    if (!firstPerson && installation !== null && visibleFloors.has(installation.floor_id)) {
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
      // 고른 카메라 아이콘은 더 크고 밝게 덮어 그린다.
      const picked = iconSprite(handles, "CAMERA_PICKED", true);
      if (picked !== null) {
        picked.position.set(x, y + 0.5, z);
        picked.renderOrder = 22;
        dynamicGroup.add(picked);
      }
    }

    // M06: 고른 출발점의 경로. 서버 path_node_ids를 순서대로 잇기만 한다.
    if (journey !== null && !firstPerson) {
      const pointOf = (nodeId: string, height: number) => {
        const node = nodeById.get(nodeId);
        if (node === undefined || !visibleFloors.has(node.floor_id)) return null;
        return new THREE.Vector3(node.position.x, displayY(node.position.y, node.floor_id, lift) + height, node.position.z);
      };
      /** 두 지점 사이를 그릴 조각들. 층이 바뀌면 계단을 따라 여러 조각으로 나눈다. 한쪽 층이 숨겨져 있으면 그리지 않는다. */
      const piecesOf = (fromId: string, toId: string, height: number): [THREE.Vector3, THREE.Vector3][] => {
        const from = pointOf(fromId, height);
        const to = pointOf(toId, height);
        if (from === null || to === null) return [];
        const a = nodeById.get(fromId);
        const b = nodeById.get(toId);
        const stairs = a === undefined || b === undefined ? null : stairLink(building, geometry, lift, a, b, height);
        if (stairs === null) return [[from, to]];
        return stairs.slice(1).map((point, index) => [stairs[index], point]);
      };
      // 벽·바닥에 가려도 경로가 끊겨 보이지 않게 깊이 검사를 끈다.
      const overlay = (color: number, opacity: number) =>
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false });

      // 직전 경로(비교용): 가는 회색 막대. 현재 경로보다 낮게 깔아 겹쳐도 구분된다.
      // 점선은 WebGL 선 굵기(1px) 때문에 이름표에 가리면 보이지 않아 막대로 그린다.
      if (journey.previousPath !== null && journey.previousPath.length > 1) {
        for (let index = 1; index < journey.previousPath.length; index += 1) {
          for (const [from, to] of piecesOf(journey.previousPath[index - 1], journey.previousPath[index], 0.6)) {
            const piece = rod(from, to, 0.09, overlay(COLOR.journeyPrevious, 0.75));
            if (piece !== null) {
              piece.renderOrder = 8;
              dynamicGroup.add(piece);
            }
          }
        }
      }

      // 현재 경로: 굵은 노란 막대와 진행 방향 화살표.
      const rodMaterial = overlay(COLOR.journey, 0.95);
      for (let index = 1; index < journey.path.length; index += 1) {
        const from = pointOf(journey.path[index - 1], 1.1);
        const to = pointOf(journey.path[index], 1.1);
        if (from === null || to === null) continue;
        for (const [a, b] of piecesOf(journey.path[index - 1], journey.path[index], 1.1)) {
          const piece = rod(a, b, 0.16, rodMaterial.clone());
          if (piece !== null) {
            piece.renderOrder = 9;
            dynamicGroup.add(piece);
          }
        }
        const node = nodeById.get(journey.path[index - 1]);
        const next = nodeById.get(journey.path[index]);
        if (node !== undefined && next !== undefined && node.floor_id === next.floor_id) {
          const arrow = new THREE.Mesh(flatArrowGeometry(), overlay(COLOR.journey, 1));
          arrow.position.copy(from).lerp(to, 0.55).setY(from.y + 0.02);
          arrow.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), planYaw(to.x - from.x, to.z - from.z));
          arrow.scale.setScalar(1.25);
          arrow.renderOrder = 10;
          dynamicGroup.add(arrow);
        }
      }
      rodMaterial.dispose();

      // 출발점: 바닥 고리. 경로가 없어도 어디를 골랐는지는 보인다.
      const startPoint = pointOf(journey.startId, 0.08);
      if (startPoint !== null) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.9, 1.3, 32),
          new THREE.MeshBasicMaterial({ color: journey.path.length > 0 ? COLOR.journey : COLOR.noRoute, side: THREE.DoubleSide, depthTest: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(startPoint);
        ring.renderOrder = 10;
        dynamicGroup.add(ring);
      }

      // 표에서 고른 유도등 위치.
      const signPoint = journey.signNodeId === null ? null : pointOf(journey.signNodeId, 2.6);
      if (signPoint !== null) {
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(0.6, 0.08, 8, 24),
          new THREE.MeshBasicMaterial({ color: COLOR.journey, depthTest: false }),
        );
        halo.position.copy(signPoint);
        halo.rotation.x = -Math.PI / 2;
        halo.renderOrder = 10;
        dynamicGroup.add(halo);
      }
    }
  }, [state, smokeByZone, visibleFloors, building, display, geometry, nodeById, zoneById, sourceById, lift, spread, highlightSourceId, journey, showGuidance, firstPersonView]);

  return <div className="scene" ref={mountRef} />;
}

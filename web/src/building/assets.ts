/**
 * 3D 부품: 천장 표지판, 사람, 불, 연기.
 *
 * 전부 표시용이다. 방향·경로·위험은 서버 결과를 받아 그리기만 하고, 여기서 판단하지 않는다.
 * 외부 모델 파일 없이 코드로 만든다.
 */
import * as THREE from "three";

// ---------- 표지판 ----------

const FACE_W = 384;
const FACE_H = 128;
/** 표시값별 화살표 각도(오른쪽 0, 시계 방향 양수). 없으면 화살표를 그리지 않는다. */
const ARROW_ANGLE: Record<string, number> = {
  RIGHT: 0,
  LEFT: Math.PI,
  FORWARD: -Math.PI / 2,
  BACK: Math.PI / 2,
  STAIRS_UP: -Math.PI / 4,
  STAIRS_DOWN: Math.PI / 4,
};

const faceCache = new Map<string, THREE.Texture | null>();

function drawRunner(ctx: CanvasRenderingContext2D, x: number, ink: string) {
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(x + 14, 30, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(x + 6, 46); ctx.lineTo(x - 8, 78);
  ctx.moveTo(x - 8, 78); ctx.lineTo(x + 16, 92); ctx.lineTo(x + 8, 114);
  ctx.moveTo(x - 8, 78); ctx.lineTo(x - 34, 86); ctx.lineTo(x - 50, 108);
  ctx.moveTo(x + 4, 52); ctx.lineTo(x + 30, 60); ctx.lineTo(x + 44, 46);
  ctx.moveTo(x + 2, 52); ctx.lineTo(x - 26, 50);
  ctx.stroke();
}

/**
 * 유도등 한 면의 그림. display가 null이면 꺼진 면(안내 불가)이다.
 * 피난구유도등은 녹색 바탕에 흰 그림, 통로유도등(passage)은 흰 바탕에 녹색 그림이다(유도등의 형식승인 및 제품검사의 기술기준 제9조).
 * wide는 가로로 긴 와이드형(약 3:1) 표시면, 아니면 정사각형에 가까운 표준 표시면이다. 작은 판도 읽히도록 해상도를 두 배로 그린다.
 * 그림을 만들 수 없는 환경이면 null을 돌려주고, 그때는 빈 면으로 둔다.
 */
export function signFaceTexture(display: string | null, passage = false, wide = true): THREE.Texture | null {
  const key = `${passage ? "P" : "E"}${wide ? "W" : "S"}/${display ?? "OFF"}`;
  const cached = faceCache.get(key);
  if (cached !== undefined) return cached;
  const [width, height] = wide ? [FACE_W, FACE_H] : [256, 256];
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    faceCache.set(key, null);
    return null;
  }
  ctx.scale(2, 2);
  const ink = display === null ? "#6b7280" : passage ? "#0b8f3c" : "#ffffff";
  ctx.fillStyle = display === null ? "#374151" : passage ? "#ffffff" : "#0b8f3c";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, width - 10, height - 10);
  const arrow = (x: number, y: number, angle: number, scale: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(-52, -13); ctx.lineTo(8, -13); ctx.lineTo(8, -36); ctx.lineTo(54, 0);
    ctx.lineTo(8, 36); ctx.lineTo(8, 13); ctx.lineTo(-52, 13);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  if (display === null) {
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(width / 2 - 60, height / 2 - 8, 120, 16);
  } else if (wide) {
    if (display === "EXIT") {
      drawRunner(ctx, 150, ink);
      ctx.lineWidth = 8;
      ctx.strokeRect(232, 20, 70, 94);
    } else {
      // 왼쪽을 가리키면 화살표를 왼쪽에, 그 밖에는 오른쪽에 둔다.
      const arrowLeft = display === "LEFT";
      drawRunner(ctx, arrowLeft ? 288 : 96, ink);
      if (ARROW_ANGLE[display] !== undefined) arrow(arrowLeft ? 110 : 274, 64, ARROW_ANGLE[display], 1);
    }
  } else if (display === "EXIT") {
    ctx.translate(-64, 64);
    drawRunner(ctx, 150, ink);
    ctx.lineWidth = 8;
    ctx.strokeRect(232, 20, 70, 94);
  } else {
    // 표준 표시면: 위에 사람, 아래에 큰 화살표.
    ctx.save();
    ctx.translate(128 * 0.1, 10);
    ctx.scale(0.9, 0.9);
    drawRunner(ctx, 128, ink);
    ctx.restore();
    if (ARROW_ANGLE[display] !== undefined) arrow(128, 180, ARROW_ANGLE[display], 1.15);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  faceCache.set(key, texture);
  return texture;
}

export type SignFaceMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/**
 * 유도등 기구 하나를 세운다. 외함·지지대는 signMount.fixtureParts가 준 도형(평면 자리·높이·크기) 그대로이고, 여기서 자리를 다시 정하지 않는다.
 * 표시면(panels)은 외함 앞면에 붙인다. 돌려준 면 메시의 그림만 바꾸면 방향이 바뀐다. 좌표는 층 바닥 기준이다.
 */
export function buildSignFixture(
  parts: readonly { readonly role: "HOUSING" | "STEM" | "BASE"; readonly x: number; readonly z: number; readonly y: number; readonly normalX: number; readonly normalZ: number; readonly wide: number; readonly tall: number; readonly deep: number }[],
  panels: readonly { readonly faceId: string; readonly x: number; readonly z: number; readonly normalX: number; readonly normalZ: number; readonly viewX: number; readonly viewZ: number }[],
  y: number, wide: number, tall: number, passage: boolean, wideFace: boolean,
): { group: THREE.Group; faces: Map<string, SignFaceMesh> } {
  const group = new THREE.Group();
  const housing = new THREE.MeshLambertMaterial({ color: 0xe6e9ed });
  const metal = new THREE.MeshLambertMaterial({ color: 0x8b949e });
  for (const part of parts) {
    const mesh = part.role === "STEM"
      ? new THREE.Mesh(new THREE.CylinderGeometry(part.wide / 2, part.wide / 2, part.tall, 8), metal)
      : new THREE.Mesh(new THREE.BoxGeometry(part.wide, part.tall, part.deep), part.role === "HOUSING" ? housing : metal);
    mesh.position.set(part.x, part.y, part.z);
    mesh.rotation.y = Math.atan2(part.normalX, part.normalZ);
    mesh.castShadow = part.role === "HOUSING";
    group.add(mesh);
  }
  const meshes = new Map<string, SignFaceMesh>();
  for (const panel of panels) {
    const mesh: SignFaceMesh = new THREE.Mesh(new THREE.PlaneGeometry(wide - 0.012, tall - 0.012), new THREE.MeshBasicMaterial({ map: signFaceTexture(null, passage, wideFace) }));
    mesh.position.set(panel.x, y, panel.z);
    mesh.rotation.y = Math.atan2(panel.normalX, panel.normalZ);
    Object.assign(mesh.userData, { passage, wideFace, viewX: panel.viewX, viewZ: panel.viewZ, normalX: panel.normalX, normalZ: panel.normalZ });
    group.add(mesh);
    meshes.set(panel.faceId, mesh);
  }
  return { group, faces: meshes };
}

// ---------- 사람 ----------

export type Figure = {
  readonly group: THREE.Group;
  /** 왼팔·오른팔·왼다리·오른다리. 어깨·엉덩이에서 돈다. */
  readonly limbs: readonly THREE.Group[];
};

const SHIRTS = [0x2563eb, 0xe11d48, 0xf59e0b, 0x0d9488, 0x7c3aed, 0x64748b, 0xdb2777, 0x16a34a];

export function createFigure(index: number): Figure {
  const group = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0xe8b796 });
  const cloth = new THREE.MeshLambertMaterial({ color: SHIRTS[index % SHIRTS.length] });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2f3b52 });
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, 0);
    mesh.castShadow = true;
    return mesh;
  };
  group.add(part(new THREE.SphereGeometry(0.13, 14, 10), skin, 0, 1.6));
  group.add(part(new THREE.CapsuleGeometry(0.17, 0.42, 4, 8), cloth, 0, 1.13));
  const limb = (material: THREE.Material, x: number, y: number, length: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    pivot.add(part(new THREE.CapsuleGeometry(0.06, length, 4, 6), material, 0, -length / 2 - 0.05));
    group.add(pivot);
    return pivot;
  };
  const limbs = [limb(cloth, -0.24, 1.38, 0.42), limb(cloth, 0.24, 1.38, 0.42), limb(pants, -0.09, 0.84, 0.73), limb(pants, 0.09, 0.84, 0.73)];
  return { group, limbs };
}

/** 걷는 동안 팔다리를 흔들고, 서 있으면 내린다. */
export function poseFigure(figure: Figure, phase: number, walking: boolean) {
  const swing = walking ? Math.sin(phase) * 0.7 : 0;
  const [armL, armR, legL, legR] = figure.limbs;
  armL.rotation.x = swing;
  armR.rotation.x = -swing;
  legL.rotation.x = -swing;
  legR.rotation.x = swing;
}

/** 귀에 꽂은 이어폰 한 쌍. 머리에 붙여 두고, 방송을 들으려고 뺄 때 숨긴다. */
export function addEarbuds(figure: Figure): THREE.Group {
  const buds = new THREE.Group();
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const side of [-1, 1]) {
    const bud = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), white);
    bud.position.set(side * 0.135, 1.6, 0);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 5), white);
    stem.position.set(side * 0.14, 1.53, 0.015);
    buds.add(bud, stem);
  }
  figure.group.add(buds);
  return buds;
}

/**
 * 시연 인물의 단계별 자세. 서 있는 기본 자세 위에 덮어쓴다.
 * 돌려주는 값은 몸 전체를 앞으로 숙이는 각도(tilt)와 앉느라 낮아지는 높이(drop)다.
 */
export function poseActing(figure: Figure, act: "SLEEP" | "NOTICE" | "PANIC" | "LISTEN" | "LOOK" | null, time: number): { tilt: number; drop: number } {
  const [armL, armR, legL, legR] = figure.limbs;
  armL.rotation.z = armR.rotation.z = 0;
  if (act === null) return { tilt: 0, drop: 0 };
  if (act === "SLEEP" || act === "NOTICE") {
    // 의자에 앉아 다리를 앞으로 낸다. 잘 때는 고개와 몸을 앞으로 숙이고 숨에 맞춰 조금 오르내린다.
    legL.rotation.x = legR.rotation.x = -1.45;
    armL.rotation.x = armR.rotation.x = act === "SLEEP" ? -0.5 : 0.2;
    return { tilt: act === "SLEEP" ? 0.55 + Math.sin(time * 1.3) * 0.04 : -0.12, drop: 0.42 };
  }
  legL.rotation.x = legR.rotation.x = 0;
  if (act === "PANIC") {
    // 두 손을 번쩍 들고 떤다.
    armL.rotation.x = -2.8 + Math.sin(time * 15) * 0.14;
    armR.rotation.x = -2.8 + Math.cos(time * 15) * 0.14;
    armL.rotation.z = -0.35;
    armR.rotation.z = 0.35;
    return { tilt: -0.08, drop: 0 };
  }
  // 한 손을 귀에 대거나(방송 듣기), 앞의 유도등을 가리킨다(변경 확인).
  armL.rotation.x = 0;
  armR.rotation.x = act === "LISTEN" ? -2.6 : -1.7;
  armR.rotation.z = act === "LISTEN" ? -0.45 : 0;
  return { tilt: 0, drop: 0 };
}

/** 그룹 안의 메시를 모두 정리한다. 함께 쓰는 그림(표지판 면)은 건드리지 않는다. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
    object.geometry.dispose();
    const material: THREE.Material | THREE.Material[] = object.material;
    for (const item of Array.isArray(material) ? material : [material]) item.dispose();
  });
}

// ---------- 불·연기 ----------

let softDot: THREE.Texture | null | undefined;
/** 가운데가 진하고 가장자리가 흐린 점. 불꽃과 연기 입자가 함께 쓴다. */
export function softDotTexture(): THREE.Texture | null {
  if (softDot !== undefined) return softDot;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    softDot = null;
    return null;
  }
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.5)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  softDot = new THREE.CanvasTexture(canvas);
  return softDot;
}

const FLAMES = 150;

export type Fire = { readonly object: THREE.Group; readonly update: (time: number, seconds: number) => void };

/** 일렁이는 불꽃. 원점이 불의 바닥 가운데다. */
export function createFire(): Fire {
  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(FLAMES * 3);
  const color = new Float32Array(FLAMES * 3);
  const life = Float32Array.from({ length: FLAMES }, (_, index) => (index * 0.618) % 1);
  const seed = Float32Array.from({ length: FLAMES * 2 }, (_, index) => ((index * 0.7548) % 1) - 0.5);
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const flames = new THREE.Points(
    geometry,
    // 더하기 혼합은 밝은 벽·바닥 앞에서 흰 빛으로 날아가 불꽃으로 읽히지 않는다. 색을 그대로 덮어 어느 배경에서도 주황 불꽃으로 보이게 한다.
    new THREE.PointsMaterial({ size: 0.62, map: softDotTexture(), vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
  );
  flames.frustumCulled = false;
  group.add(flames);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0xff4a12, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  group.add(glow);
  const update = (time: number, seconds: number) => {
    for (let i = 0; i < FLAMES; i += 1) {
      life[i] += seconds * (0.7 + (i % 7) * 0.08);
      if (life[i] > 1) life[i] = 0;
      const spread = (1 - life[i]) * 0.8;
      position[i * 3] = seed[i * 2] * spread * 2 + Math.sin(time * 5 + i) * 0.05;
      position[i * 3 + 1] = 0.1 + life[i] * 2.1;
      position[i * 3 + 2] = seed[i * 2 + 1] * spread * 2;
      // 밑동은 노랑, 위로 갈수록 주황에서 검붉은 색으로 식는다.
      const heat = 1 - life[i];
      color[i * 3] = 0.55 + heat * 0.45;
      color[i * 3 + 1] = 0.08 + heat * heat * 0.72;
      color[i * 3 + 2] = heat * heat * heat * 0.18;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  };
  update(0, 0);
  return { object: group, update };
}

export type SmokePuff = {
  readonly sprite: THREE.Sprite;
  readonly zoneId: string;
  /** 구역 바닥 높이. */
  readonly baseY: number;
  /** 0~1. 연기층 안에서의 높이와 움직임의 위상을 정한다. */
  readonly seed: number;
  readonly x: number;
  readonly z: number;
};

let smokeDot: THREE.Texture | null | undefined;
/**
 * 연기 입자의 그림. 원 하나로 그리면 겹친 자리마다 둥근 원판의 테두리가 드러난다.
 * 크기가 다른 덩이 여럿을 겹쳐 가운데는 짙고 가장자리는 울퉁불퉁하게 풀어지는 한 뭉치로 그린다. 색은 입자마다 농도에 맞춰 입힌다.
 */
function smokeTexture(): THREE.Texture | null {
  if (smokeDot !== undefined) return smokeDot;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    smokeDot = null;
    return null;
  }
  // 덩이의 자리·크기(가운데 64 기준). 모든 덩이가 그림 안에 들어와 네모난 끝이 생기지 않는다.
  const lobes = [[64, 66, 40], [44, 54, 26], [86, 52, 28], [52, 84, 24], [82, 82, 26], [64, 40, 22], [34, 74, 16], [96, 68, 16]];
  for (const [x, y, radius] of lobes) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.3)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  smokeDot = new THREE.CanvasTexture(canvas);
  return smokeDot;
}

export function createSmokeSprite(): THREE.Sprite {
  const sprite = new THREE.Sprite(
    // 빛을 받지 않는 재질이라 조명이 연기를 희게 띄우지 않는다. 색은 placeSmoke가 농도에 맞춰 정한다.
    new THREE.SpriteMaterial({ map: smokeTexture(), color: 0x4a4846, transparent: true, opacity: 0, depthWrite: false }),
  );
  // 불꽃(더하기 혼합) 뒤에 그려, 불 위로 올라온 연기가 불빛에 지워지지 않게 한다.
  sprite.renderOrder = 6;
  sprite.visible = false;
  return sprite;
}

/**
 * 농도에 따른 연기의 밝기(0~255 회색 값). 옅으면 짙은 회색, 통로를 막는 농도(약 0.5)를 넘으면 그을음의 검정에 가깝다.
 * 입자마다 조금씩 달라 한 가지 색으로 칠한 면처럼 보이지 않는다.
 */
export function smokeShade(smoke: number, seed: number): number {
  return Math.round(Math.min(96, Math.max(14, 88 - 74 * Math.min(1, smoke * 1.5) + (seed - 0.5) * 22)));
}

/**
 * 연기 입자 하나를 지금 농도에 맞춰 놓는다. 연기는 천장부터 차서 농도가 짙을수록 아래로 내려온다.
 */
export function placeSmoke(puff: SmokePuff, smoke: number, wallHeight: number, time: number, overview = false) {
  const { sprite, seed } = puff;
  if (smoke <= 0.02) {
    sprite.visible = false;
    return;
  }
  sprite.visible = true;
  // 뜨거운 연기는 천장 아래에 층으로 깔리고, 짙어질수록 층이 두꺼워져 바닥 쪽으로 내려온다.
  // 옅을 때는 아래쪽이 비어 그 밑으로 복도 안쪽의 불꽃이 보이고, 통로가 완전히 찰 만큼 짙어지면 시야를 가린다.
  const depth = wallHeight * (0.3 + 0.65 * smoke);
  // 천천히 부풀었다 줄고 돌면서 피어오르는 것처럼 보이게 한다. 옆으로 퍼진 납작한 덩이다.
  const size = (2.2 + seed * 1.4 + smoke * 0.9) * (1 + Math.sin(time * 0.5 + seed * 31) * 0.06);
  const tall = size * 0.6;
  sprite.position.set(
    puff.x + Math.sin(time * 0.25 + seed * 40) * 0.35,
    puff.baseY + wallHeight - tall * 0.3 - seed * Math.max(depth - tall * 0.6, 0) + Math.sin(time * 0.4 + seed * 17) * 0.08,
    puff.z + Math.cos(time * 0.21 + seed * 23) * 0.35,
  );
  sprite.scale.set(size, tall, 1);
  sprite.material.rotation = Math.sin(time * 0.15 + seed * 6.28) * 0.25;
  // 그을음 섞인 연기: 붉은 기가 조금 도는 무채색. 농도가 색과 불투명도를 함께 정한다.
  const shade = smokeShade(smoke, seed);
  sprite.material.color.setRGB((shade + 4) / 255, shade / 255, (shade - 3) / 255, THREE.SRGBColorSpace);
  // 밖에서 내려다볼 때는 범위가 보이게 짙게, 연기 속을 걷는 1인칭에서는 조금 옅게 그린다(가까운 시야 저하는 안개가 맡는다).
  sprite.material.opacity = overview ? Math.min(0.92, 0.3 + smoke * 0.7) : Math.min(0.8, 0.24 + smoke * 0.6);
}

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

function drawRunner(ctx: CanvasRenderingContext2D, x: number) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
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
 * 표지판 한 면의 그림. display가 null이면 꺼진 면(안내 불가)이다.
 * 그림을 만들 수 없는 환경이면 null을 돌려주고, 그때는 빈 면으로 둔다.
 */
export function signFaceTexture(display: string | null): THREE.Texture | null {
  const key = display ?? "OFF";
  const cached = faceCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    faceCache.set(key, null);
    return null;
  }
  ctx.fillStyle = display === null ? "#374151" : "#0b8f3c";
  ctx.fillRect(0, 0, FACE_W, FACE_H);
  ctx.strokeStyle = display === null ? "#6b7280" : "#ffffff";
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, FACE_W - 10, FACE_H - 10);
  if (display === "EXIT") {
    drawRunner(ctx, 150);
    ctx.lineWidth = 8;
    ctx.strokeRect(232, 20, 70, 94);
  } else if (display !== null) {
    const angle = ARROW_ANGLE[display];
    // 왼쪽을 가리키면 화살표를 왼쪽에, 그 밖에는 오른쪽에 둔다.
    const arrowLeft = display === "LEFT";
    drawRunner(ctx, arrowLeft ? 288 : 96);
    if (angle !== undefined) {
      ctx.save();
      ctx.translate(arrowLeft ? 110 : 274, 64);
      ctx.rotate(angle);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(-52, -13); ctx.lineTo(8, -13); ctx.lineTo(8, -36); ctx.lineTo(54, 0);
      ctx.lineTo(8, 36); ctx.lineTo(8, 13); ctx.lineTo(-52, 13);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  } else {
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(132, 56, 120, 16);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  faceCache.set(key, texture);
  return texture;
}

export type SignFaceMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/**
 * 천장에 매달린 표지판. faces의 normal은 그 면이 향하는 쪽(보는 사람 쪽)이다.
 * 돌려준 면 메시의 그림만 바꾸면 방향이 바뀐다.
 */
export function buildHangingSign(
  faces: readonly { readonly faceId: string; readonly normalX: number; readonly normalZ: number }[],
): { group: THREE.Group; faces: Map<string, SignFaceMesh> } {
  const group = new THREE.Group();
  const frame = new THREE.MeshLambertMaterial({ color: 0x1f2933 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.1), frame);
  body.castShadow = true;
  group.add(body);
  for (const dx of [-0.42, 0.42]) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 6), frame);
    rod.position.set(dx, 0.38, 0);
    group.add(rod);
  }
  const meshes = new Map<string, SignFaceMesh>();
  const first = faces[0];
  if (first !== undefined) group.rotation.y = Math.atan2(first.normalX, first.normalZ);
  faces.forEach((face, index) => {
    // 첫 면을 기준으로 몸체를 돌렸으므로, 반대쪽을 보는 면은 뒷면에 붙인다.
    const opposite = first !== undefined && index > 0 && face.normalX * first.normalX + face.normalZ * first.normalZ < 0;
    const mesh: SignFaceMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 0.34), new THREE.MeshBasicMaterial({ map: signFaceTexture(null) }));
    mesh.position.z = opposite ? -0.052 : 0.052;
    if (opposite) mesh.rotation.y = Math.PI;
    group.add(mesh);
    meshes.set(face.faceId, mesh);
  });
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
    new THREE.PointsMaterial({ size: 0.5, map: softDotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  flames.frustumCulled = false;
  group.add(flames);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0xff4a12, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
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
      // 겹쳐 더해지면 하얗게 날아가므로 입자 하나의 밝기를 낮춘다.
      const heat = 1 - life[i];
      color[i * 3] = 0.55;
      color[i * 3 + 1] = 0.1 + heat * 0.22;
      color[i * 3 + 2] = heat * heat * 0.04;
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

export function createSmokeSprite(): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: softDotTexture(), color: 0x70757e, transparent: true, opacity: 0, depthWrite: false }),
  );
  sprite.visible = false;
  return sprite;
}

/**
 * 연기 입자 하나를 지금 농도에 맞춰 놓는다. 연기는 천장부터 차서 농도가 짙을수록 아래로 내려온다.
 */
export function placeSmoke(puff: SmokePuff, smoke: number, wallHeight: number, time: number) {
  const { sprite, seed } = puff;
  if (smoke <= 0.02) {
    sprite.visible = false;
    return;
  }
  sprite.visible = true;
  const depth = wallHeight * (0.25 + 0.6 * smoke);
  sprite.position.set(
    puff.x + Math.sin(time * 0.25 + seed * 40) * 0.35,
    puff.baseY + wallHeight - seed * depth + Math.sin(time * 0.4 + seed * 17) * 0.08,
    puff.z + Math.cos(time * 0.21 + seed * 23) * 0.35,
  );
  const size = 2 + seed * 1.4 + smoke * 0.8;
  sprite.scale.set(size, size, 1);
  sprite.material.opacity = Math.min(0.5, 0.08 + smoke * 0.34);
}

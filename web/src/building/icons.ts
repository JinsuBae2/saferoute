/**
 * 3D 설비 아이콘(유도등·CCTV). 멀리서도 무엇인지 알아보게 평면 그림을 항상 화면 쪽으로 띄운다.
 *
 * - 출구 위치 표지(피난구 유도등, 2개): 초록 바탕에 흰 달리는 사람과 문. 출구라는 것이 바로 보이게 크게 그린다
 * - 가변 방향 안내(35개): 그림 없는 작은 네모 표시등. 그림을 모두 그리면 화면이 그림으로 가득 차고,
 *   방향은 바닥의 경로 화살표가 이미 보여 주므로 위치와 켜짐 여부만 나타낸다
 * - 안내 불가·확인 불가면 회색으로 바꿔 꺼진 표지처럼 보이게 한다
 * 실제 방향은 표시면(FRONT/REAR)마다 다르므로 단말·표에서 확인한다.
 */
export type IconKind = "EXIT_ON" | "EXIT_OFF" | "DIRECTION_ON" | "DIRECTION_OFF" | "CAMERA" | "CAMERA_PICKED";

/** 화면에 보이는 아이콘 크기(px). 확대·축소와 관계없이 같다. */
export const ICON_PIXELS: Record<IconKind, { readonly width: number; readonly height: number }> = {
  EXIT_ON: { width: 50, height: 32 },
  EXIT_OFF: { width: 50, height: 32 },
  DIRECTION_ON: { width: 14, height: 14 },
  DIRECTION_OFF: { width: 14, height: 14 },
  CAMERA: { width: 32, height: 32 },
  CAMERA_PICKED: { width: 42, height: 42 },
};

/** 표지 종류와 현재 안내 여부로 고를 아이콘. */
export function signIcon(exitLocation: boolean, guiding: boolean): IconKind {
  if (exitLocation) return guiding ? "EXIT_ON" : "EXIT_OFF";
  return guiding ? "DIRECTION_ON" : "DIRECTION_OFF";
}

const GREEN = "#16a34a";
const GRAY = "#6b7280";
const WHITE = "#ffffff";
const LIGHT = "#e5e7eb";

/** 그림을 그릴 바탕 해상도. 화면 크기의 3배로 그려 확대돼도 흐리지 않게 한다. */
const SCALE = 3;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 오른쪽으로 달리는 사람. (x, y)는 머리 중심, size는 키. */
function runner(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  const s = size / 10;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = s * 1.5;
  ctx.beginPath();
  ctx.arc(x, y, s * 1.3, 0, Math.PI * 2);
  ctx.fill();
  const hip = { x: x - s * 1.2, y: y + s * 5 };
  const neck = { x: x - s * 0.2, y: y + s * 1.8 };
  ctx.beginPath();
  ctx.moveTo(neck.x, neck.y);
  ctx.lineTo(hip.x, hip.y);
  // 팔: 앞팔은 앞으로, 뒷팔은 뒤로
  ctx.moveTo(neck.x + s * 0.2, neck.y + s * 0.8);
  ctx.lineTo(x + s * 2, y + s * 2.6);
  ctx.lineTo(x + s * 3, y + s * 1.4);
  ctx.moveTo(neck.x, neck.y + s * 0.8);
  ctx.lineTo(x - s * 2.6, y + s * 3);
  ctx.lineTo(x - s * 3.8, y + s * 2);
  // 다리: 앞다리는 앞으로 굽히고 뒷다리는 뒤로 뻗는다
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(x + s * 1.2, y + s * 6.6);
  ctx.lineTo(x + s * 1.2, y + s * 8.6);
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(x - s * 2.4, y + s * 7.2);
  ctx.lineTo(x - s * 4.4, y + s * 8);
  ctx.stroke();
}

function drawExit(ctx: CanvasRenderingContext2D, w: number, h: number, on: boolean) {
  roundRect(ctx, 1, 1, w - 2, h - 2, h * 0.14);
  ctx.fillStyle = on ? GREEN : GRAY;
  ctx.fill();
  ctx.lineWidth = h * 0.05;
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  // 문: 오른쪽의 열린 출입구
  ctx.fillStyle = on ? WHITE : LIGHT;
  ctx.fillRect(w * 0.64, h * 0.16, w * 0.24, h * 0.7);
  ctx.fillStyle = on ? GREEN : GRAY;
  ctx.fillRect(w * 0.68, h * 0.22, w * 0.16, h * 0.64);
  runner(ctx, w * 0.42, h * 0.22, h * 0.68, on ? WHITE : LIGHT);
}

/** 작은 네모 표시등. 흰 테두리로 어두운 배경과 초록 경로 화살표 위에서도 구분된다. */
function drawDirection(ctx: CanvasRenderingContext2D, w: number, h: number, on: boolean) {
  const line = h * 0.16;
  roundRect(ctx, line / 2, line / 2, w - line, h - line, h * 0.18);
  ctx.fillStyle = on ? GREEN : GRAY;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = on ? WHITE : LIGHT;
  ctx.stroke();
}

function drawCamera(ctx: CanvasRenderingContext2D, w: number, h: number, picked: boolean) {
  const r = Math.min(w, h) / 2 - 1;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = picked ? "#0891b2" : "#1d4ed8";
  ctx.fill();
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = picked ? "#a5f3fc" : WHITE;
  ctx.stroke();
  // CCTV: 기울어진 몸통, 앞쪽 렌즈, 벽 받침
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.35);
  ctx.fillStyle = WHITE;
  roundRect(ctx, -r * 0.55, -r * 0.28, r * 1.0, r * 0.52, r * 0.1);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(r * 0.45, -r * 0.2);
  ctx.lineTo(r * 0.72, -r * 0.34);
  ctx.lineTo(r * 0.72, r * 0.34);
  ctx.lineTo(r * 0.45, r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = WHITE;
  ctx.fillRect(w / 2 - r * 0.42, h / 2 + r * 0.22, r * 0.14, r * 0.42);
  ctx.fillRect(w / 2 - r * 0.62, h / 2 + r * 0.56, r * 0.54, r * 0.12);
}

/** 아이콘 그림. 문서에 그릴 수 없으면(테스트 환경 등) null. */
export function drawIcon(kind: IconKind): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const size = ICON_PIXELS[kind];
  const canvas = document.createElement("canvas");
  canvas.width = size.width * SCALE;
  canvas.height = size.height * SCALE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const w = canvas.width;
  const h = canvas.height;
  if (kind === "EXIT_ON" || kind === "EXIT_OFF") drawExit(ctx, w, h, kind === "EXIT_ON");
  else if (kind === "DIRECTION_ON" || kind === "DIRECTION_OFF") drawDirection(ctx, w, h, kind === "DIRECTION_ON");
  else drawCamera(ctx, w, h, kind === "CAMERA_PICKED");
  return canvas;
}

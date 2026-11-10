/**
 * CCTV 미리보기 표시 판정 (이슈 #74, P06).
 *
 * 기준은 A06 인계 문서(docs/ai/a06-preview-delivery.md)의 "화면 담당 조회"다.
 * - 현재 실행·건물과 일치하는 READY만 보여준다.
 * - 기한은 서버 시각에서 왕복 시간을 뺀 값으로 잡는다. 브라우저 시계로 추정하지 않는다.
 * - 검출 좌표는 원본 크기로 나눈 0~1 값이라 표시 크기와 무관하게 비율로 그린다.
 *
 * 여기서 경보를 판정하지 않는다. 상자 개수나 신뢰도로 위험을 다시 정하지 않는다.
 */
import type { Building, Preview, StateSnapshot } from "@contracts";

type PreviewFrame = NonNullable<Preview["frame"]>;
type Detection = PreviewFrame["detections"][number];
type Source = Building["sources"][number];

export type PreviewBlockReason =
  | "NOT_SELECTED"
  | "NOT_LOADED"
  | "RUN_MISMATCH"
  | "BUILDING_MISMATCH"
  | "SOURCE_MISMATCH"
  | "NOT_READY"
  | "NO_FRAME";

export type PreviewCheck =
  | { readonly usable: true; readonly frame: PreviewFrame }
  | { readonly usable: false; readonly reason: PreviewBlockReason };

/** 영상 관측원만 미리보기를 가진다. */
export function cameraSources(building: Building | null): readonly Source[] {
  return building?.sources.filter((source) => source.source_type === "VIDEO_AI") ?? [];
}

/**
 * 지금 화면에 띄워도 되는 프레임인지. 실행·건물·카메라가 모두 맞고 READY여야 한다.
 * reset 직후 옛 실행의 결과가 현재 상황처럼 보이지 않게 한다.
 */
export function checkPreview(
  preview: Preview | null,
  state: StateSnapshot,
  selectedSourceId: string | null,
): PreviewCheck {
  if (selectedSourceId === null) return { usable: false, reason: "NOT_SELECTED" };
  if (preview === null) return { usable: false, reason: "NOT_LOADED" };
  if (preview.run_id !== state.run_id) return { usable: false, reason: "RUN_MISMATCH" };
  if (
    preview.building_id !== state.building_id ||
    preview.building_version !== state.building_version
  ) {
    return { usable: false, reason: "BUILDING_MISMATCH" };
  }
  if (preview.source_id !== selectedSourceId) return { usable: false, reason: "SOURCE_MISMATCH" };
  if (preview.status !== "READY") return { usable: false, reason: "NOT_READY" };
  if (preview.frame === null) return { usable: false, reason: "NO_FRAME" };
  return { usable: true, frame: preview.frame };
}

/**
 * 프레임 기한(performance.now() 기준). 서버 시각 차이에서 왕복 시간을 뺀다.
 * 수신 시점에 기한을 새로 시작하지 않으며, 알 수 없으면 null이라 표시하지 않는다.
 */
export function frameDeadline(
  expiresAt: string,
  serverTime: string,
  startedMs: number,
  receivedMs: number,
  freshnessMs: number,
): number | null {
  if (receivedMs < startedMs) return null;
  const remaining = Date.parse(expiresAt) - Date.parse(serverTime) - (receivedMs - startedMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  // 서버가 알려준 유효기간보다 길게 잡지 않는다.
  if (remaining > freshnessMs) return null;
  return receivedMs + remaining;
}

export type Box = {
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly widthPercent: number;
  readonly heightPercent: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 정규화 xyxy를 표시용 비율 상자로 바꾼다.
 * 뒤집힌 좌표는 바로잡고, 화면 밖은 잘라낸다. 값이 올바르지 않으면 그리지 않는다.
 */
export function detectionBox(detection: Detection): Box | null {
  const xyxy = detection.xyxy;
  if (xyxy.length !== 4 || xyxy.some((value) => !Number.isFinite(value))) return null;

  const left = clamp01(Math.min(xyxy[0], xyxy[2]));
  const right = clamp01(Math.max(xyxy[0], xyxy[2]));
  const top = clamp01(Math.min(xyxy[1], xyxy[3]));
  const bottom = clamp01(Math.max(xyxy[1], xyxy[3]));
  if (right <= left || bottom <= top) return null;

  return {
    leftPercent: left * 100,
    topPercent: top * 100,
    widthPercent: (right - left) * 100,
    heightPercent: (bottom - top) * 100,
  };
}

export const PREVIEW_STATUS_LABEL: Record<Preview["status"], string> = {
  INITIALIZING: "준비 중",
  READY: "표시 중",
  STALE: "오래됨",
  EOF: "영상 종료",
  UNAVAILABLE: "제공 불가",
};

export const PREVIEW_ERROR_LABEL: Record<NonNullable<Preview["error_code"]>, string> = {
  VIDEO_OPEN_FAILED: "영상을 열지 못했습니다",
  DECODE_FAILED: "영상을 읽지 못했습니다",
  INFERENCE_FAILED: "추론에 실패했습니다",
  DELIVERY_FAILED: "관측 전송에 실패했습니다",
  PREVIEW_FAILED: "미리보기를 만들지 못했습니다",
  OPERATOR_STOPPED: "운영자가 중단했습니다",
};

export const PREVIEW_BLOCK_LABEL: Record<PreviewBlockReason, string> = {
  NOT_SELECTED: "카메라를 선택하세요",
  NOT_LOADED: "미리보기를 아직 받지 못했습니다",
  RUN_MISMATCH: "다른 실행의 미리보기라 표시하지 않습니다",
  BUILDING_MISMATCH: "다른 건물 자료의 미리보기라 표시하지 않습니다",
  SOURCE_MISMATCH: "다른 카메라의 미리보기라 표시하지 않습니다",
  NOT_READY: "지금 보여줄 프레임이 없습니다",
  NO_FRAME: "지금 보여줄 프레임이 없습니다",
};

export const HAZARD_LABEL: Record<Detection["hazard_type"], string> = {
  FIRE: "불꽃",
  SMOKE: "연기",
};

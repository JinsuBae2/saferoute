/** 공통 생성 계약을 사용한다. 실제 설명 API 연결은 A05 후속 단계다. */
import type { Explanation } from "@contracts";

export type { Explanation } from "@contracts";
export type ExplanationStatus = Explanation["status"];
export type ExplanationErrorCode = NonNullable<Explanation["error_code"]>;

export const EXPLANATION_ERROR_LABEL: Record<ExplanationErrorCode, string> = {
  BEDROCK_UNAVAILABLE: "모델을 호출하지 못했습니다",
  INVALID_RESPONSE: "응답 형식이나 근거가 올바르지 않습니다",
  STALE_BASIS: "근거 상태가 너무 오래됐습니다",
  EXPLANATION_LOG_ERROR: "설명 기록을 저장하지 못했습니다",
  DISABLED: "설명 기능이 꺼져 있습니다",
};

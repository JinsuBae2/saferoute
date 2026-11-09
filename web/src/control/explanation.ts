/**
 * F11 상황 설명 DTO. 05번 명세 11절을 그대로 옮긴 임시 정의다.
 *
 * A05(#41)가 Python 모델과 생성 TypeScript를 추가하면 이 파일을 지우고
 * `@contracts`의 생성 형식을 import해야 한다. 그때까지 관제가 설명 영역을
 * 먼저 만들 수 있도록 여기 둔다. 서버에는 아직 이 엔드포인트가 없으므로
 * 404·503이 정상 경로다.
 */

export type ExplanationStatus = "PENDING" | "READY" | "UNAVAILABLE";

export type ExplanationErrorCode =
  | "BEDROCK_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "STALE_BASIS"
  | "EXPLANATION_LOG_ERROR"
  | "DISABLED";

export type Explanation = {
  schema_version: 1;
  run_id: string;
  building_id: string;
  building_version: number;
  guidance_version: number;
  status: ExplanationStatus;
  /** 근거로 삼은 StateSnapshot의 generated_at. */
  basis_generated_at: string;
  generated_at: string | null;
  expires_at: string | null;
  summary: string | null;
  fact_refs: string[];
  model_id: string | null;
  prompt_version: string | null;
  error_code: ExplanationErrorCode | null;
};

export const EXPLANATION_ERROR_LABEL: Record<ExplanationErrorCode, string> = {
  BEDROCK_UNAVAILABLE: "모델을 호출하지 못했습니다",
  INVALID_RESPONSE: "응답 형식이나 근거가 올바르지 않습니다",
  STALE_BASIS: "근거 상태가 너무 오래됐습니다",
  EXPLANATION_LOG_ERROR: "설명 기록을 저장하지 못했습니다",
  DISABLED: "설명 기능이 꺼져 있습니다",
};

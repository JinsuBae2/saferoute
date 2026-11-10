/**
 * 제어 백엔드(B01~B03) 호출만 담당한다. 경로·방향 판단은 서버가 하며 여기서 계산하지 않는다.
 * 개발 서버에서는 vite.config.ts의 프록시가 /api를 127.0.0.1:8000으로 넘긴다.
 */
import type {
  Building,
  ClearReceipt,
  ClearRequest,
  EventReceipt,
  ObservationEvent,
  ErrorResponse,
  Session,
  SignAck,
  SignCommand,
  SignState,
  SimulationState,
  StateSnapshot,
} from "@contracts";

import type { Explanation } from "../control/explanation";
import { explanationDeadline } from "../control/explanationTiming";

const BASE = "/api";

/** 서버가 05번 명세 6.1절 형식으로 돌려준 오류. code는 본문이 없으면 null이다. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly field: string | null;

  constructor(status: number, code: string | null, field: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const detail: unknown = (value as { error: unknown }).error;
  return typeof detail === "object" && detail !== null && "code" in detail && "message" in detail;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code: string | null = null;
  let field: string | null = null;
  let message = `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (isErrorResponse(body)) {
      code = body.error.code;
      field = body.error.field;
      message = body.error.message;
    }
  } catch {
    // 본문이 JSON이 아닌 경우가 있다. 상태 코드만으로 처리한다.
  }
  return new ApiError(response.status, code, field, message);
}

async function requestAt<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

function request<T>(path: string, init: RequestInit): Promise<T> {
  return requestAt<T>(`${BASE}${path}`, init);
}

export function fetchSession(signal?: AbortSignal): Promise<Session> {
  return request<Session>("/session", { method: "GET", signal });
}

/** 현재 실행이 검증한 공간 자료. 단말 목록을 하드코딩하지 않으려고 읽는다. */
export function fetchBuilding(signal?: AbortSignal): Promise<Building> {
  return request<Building>("/building", { method: "GET", signal });
}

/** 조회 1회가 명령 1건 발행이다. 서버가 command_id·command_sequence를 새로 만든다. */
export function fetchSignCommand(signId: string, signal?: AbortSignal): Promise<SignCommand> {
  return request<SignCommand>(`/signs/${encodeURIComponent(signId)}/command`, { method: "GET", signal });
}

export function postSignAck(signId: string, ack: SignAck, signal?: AbortSignal): Promise<SignState> {
  return request<SignState>(`/signs/${encodeURIComponent(signId)}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ack),
    signal,
  });
}

/** 한 안내 버전으로 묶인 상태·경로·단말 현황. 조회만으로 명령을 발행하지 않는다. */
export function fetchState(signal?: AbortSignal): Promise<StateSnapshot> {
  return request<StateSnapshot>("/state", { method: "GET", signal });
}

/**
 * 별도 A05 프로세스의 설명. 서버 시각·왕복 시간을 이용해 표시 기한을 계산한다.
 * 실패해도 관제의 제어 결과 표시는 그대로 유지한다.
 */
export async function fetchExplanation(signal?: AbortSignal): Promise<{
  explanation: Explanation;
  expiresAtMs: number | null;
}> {
  const started = performance.now();
  const response = await fetch(`${BASE}/explanations/current`, {
    method: "GET", cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
  });
  if (!response.ok) throw await toApiError(response);
  const explanation = (await response.json()) as Explanation;
  return { explanation, expiresAtMs: explanationDeadline(
    explanation.expires_at, response.headers.get("X-Explanation-Server-Time"), started, performance.now(),
  ) };
}

/**
 * 별도 시나리오 실행기(8001)의 연기 정답. 제어기 판단과 분리해서 표시한다.
 * 관제가 이 값을 경로나 방향 계산에 쓰지 않는다.
 */
export function fetchSimulationState(signal?: AbortSignal): Promise<SimulationState> {
  return requestAt<SimulationState>("/sim/state", { method: "GET", signal });
}

/** Registered manual test inputs use the same boundary as other observations. */
export function postObservation(event: ObservationEvent, signal?: AbortSignal): Promise<EventReceipt> {
  return request<EventReceipt>("/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event), signal });
}

export function clearCause(requestBody: ClearRequest, signal?: AbortSignal): Promise<ClearReceipt> {
  return request<ClearReceipt>("/control/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody), signal });
}

/**
 * 단말의 명령 수용·만료 판정과 ACK 구성. 순수 함수이며 네트워크·DOM·벽시계를 쓰지 않는다.
 * 기준은 05번 명세 5.2 적용 순서와 5.3 적용 응답이다.
 *
 * 핵심 규칙:
 *  - 유효 기한은 "요청 시작 시각 + valid_for_ms"다. 응답 도착 시각이 아니다.
 *  - 낮거나 같은 순번, 다른 실행, 다른 건물 버전, 다른 단말의 명령은 적용하지 않는다.
 *  - 기한이 지나면 화살표를 지우고 UNKNOWN·COMMAND_EXPIRED로 전환한다.
 *  - 단말은 경로나 방향을 스스로 계산하지 않는다. 서버가 준 faces를 그대로 표시한다.
 */
import type { FaceResult, Session, SignAck, SignCommand } from "@contracts";

/** 화면에 실제로 보이는 것. LIVE일 때만 화살표가 있다. */
export type DisplayState =
  | { readonly kind: "WAITING" }
  | { readonly kind: "LIVE"; readonly faces: readonly FaceResult[]; readonly guidanceVersion: number }
  | { readonly kind: "EXPIRED" };

export type TerminalState = {
  readonly signId: string;
  /** 이 실행에서 수신한 가장 높은 명령 순번. 만료된 명령도 순번은 남긴다. */
  readonly lastSequence: number;
  /** 아직 기한이 남아 ACK할 수 있는 명령. 만료되면 null이 된다. */
  readonly command: SignCommand | null;
  /** performance.now() 기준 단조 시각. 벽시계가 아니다. */
  readonly expiresAtMs: number | null;
  readonly display: DisplayState;
};

export type DiscardReason =
  | "SIGN_MISMATCH"
  | "BUILDING_MISMATCH"
  | "STALE_SEQUENCE"
  | "ALREADY_EXPIRED";

export type AcceptResult =
  | { readonly outcome: "ACCEPTED"; readonly state: TerminalState }
  | { readonly outcome: "DISCARDED"; readonly reason: DiscardReason; readonly state: TerminalState }
  | { readonly outcome: "RUN_CHANGED"; readonly state: TerminalState };

export type AcceptInput = {
  readonly state: TerminalState;
  readonly command: SignCommand;
  readonly session: Session;
  /** fetch를 보내기 직전에 찍은 performance.now() 값. */
  readonly requestStartedAtMs: number;
  /** 응답을 처리하는 지금의 performance.now() 값. */
  readonly nowMs: number;
};

export function createTerminalState(signId: string): TerminalState {
  return { signId, lastSequence: 0, command: null, expiresAtMs: null, display: { kind: "WAITING" } };
}

function cleared(state: TerminalState, lastSequence: number, kind: "WAITING" | "EXPIRED"): TerminalState {
  return { signId: state.signId, lastSequence, command: null, expiresAtMs: null, display: { kind } };
}

/**
 * 수신한 명령을 적용할지 판정한다. 적용하지 않는 경우에도 순번은 보존해
 * 뒤늦게 도착한 낮은 순번이 최신 표시를 덮지 못하게 한다.
 */
export function acceptCommand(input: AcceptInput): AcceptResult {
  const { state, command, session, requestStartedAtMs, nowMs } = input;

  if (command.sign_id !== state.signId) {
    return { outcome: "DISCARDED", reason: "SIGN_MISMATCH", state };
  }
  if (command.run_id !== session.run_id) {
    // 실행이 바뀌었다. 기존 명령을 폐기하고 session을 다시 읽어야 한다(명세 5.2-7).
    return { outcome: "RUN_CHANGED", state: createTerminalState(state.signId) };
  }
  if (
    command.building_id !== session.building_id ||
    command.building_version !== session.building_version
  ) {
    return { outcome: "DISCARDED", reason: "BUILDING_MISMATCH", state };
  }
  if (command.command_sequence <= state.lastSequence) {
    return { outcome: "DISCARDED", reason: "STALE_SEQUENCE", state };
  }

  // 지연된 시간을 유효기간에 더하지 않는다(명세 5.2-4).
  const expiresAtMs = requestStartedAtMs + command.valid_for_ms;
  if (nowMs >= expiresAtMs) {
    return {
      outcome: "DISCARDED",
      reason: "ALREADY_EXPIRED",
      state: cleared(state, command.command_sequence, "EXPIRED"),
    };
  }

  return {
    outcome: "ACCEPTED",
    state: {
      signId: state.signId,
      lastSequence: command.command_sequence,
      command,
      expiresAtMs,
      // face 전체를 한 번에 반영한다(명세 5.2-5).
      display: { kind: "LIVE", faces: command.faces, guidanceVersion: command.guidance_version },
    },
  };
}

/** 기한이 지났으면 화살표를 제거한다. 절전 복귀 시에도 이것을 먼저 호출한다(명세 5.2-6,-8). */
export function evaluateExpiry(state: TerminalState, nowMs: number): TerminalState {
  if (state.expiresAtMs === null || nowMs < state.expiresAtMs) return state;
  return cleared(state, state.lastSequence, "EXPIRED");
}

/** 지금 ACK를 보내도 되는 명령인지. 기한이 지났으면 적용 성공을 주장하지 않는다. */
export function ackableCommand(state: TerminalState, nowMs: number): SignCommand | null {
  if (state.command === null || state.expiresAtMs === null) return null;
  return nowMs < state.expiresAtMs ? state.command : null;
}

export function remainingMs(state: TerminalState, nowMs: number): number | null {
  if (state.expiresAtMs === null) return null;
  return Math.max(0, state.expiresAtMs - nowMs);
}

/**
 * 적용 응답. faces는 명령의 (face_id, mode, display)를 그대로 복사한다.
 * 서버 check_ack가 이 세 값을 대조하므로 임의로 다시 만들면 COMMAND_MISMATCH가 된다.
 */
export function buildAppliedAck(
  command: SignCommand,
  terminalInstanceId: string,
  clientApplyDurationMs: number,
): SignAck {
  return {
    schema_version: 1,
    run_id: command.run_id,
    sign_id: command.sign_id,
    terminal_instance_id: terminalInstanceId,
    command_id: command.command_id,
    command_sequence: command.command_sequence,
    guidance_version: command.guidance_version,
    status: "APPLIED",
    faces: command.faces.map((face) => ({
      face_id: face.face_id,
      mode: face.mode,
      display: face.display,
    })),
    client_apply_duration_ms: Math.max(0, Math.round(clientApplyDurationMs * 100) / 100),
    error_code: null,
  };
}

/** 표시에 실패했을 때. error_code는 공백 없는 식별자여야 한다. */
export function buildRejectedAck(
  command: SignCommand,
  terminalInstanceId: string,
  errorCode: string,
): SignAck {
  return {
    schema_version: 1,
    run_id: command.run_id,
    sign_id: command.sign_id,
    terminal_instance_id: terminalInstanceId,
    command_id: command.command_id,
    command_sequence: command.command_sequence,
    guidance_version: command.guidance_version,
    status: "REJECTED",
    faces: [],
    client_apply_duration_ms: null,
    error_code: errorCode,
  };
}

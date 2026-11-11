/**
 * 단말 장애 주입. V09가 요구하는 "낮은 순번, 지난 실행, 다른 단말, 늦게 도착한 명령"을
 * 사람이 직접 넣어 볼 수 있게 만든 점검용 도구다.
 *
 * 전부 단말 안에서만 쓰인다. 서버로 보내지 않고, 주입한 명령으로 ACK를 만들지도 않는다.
 * 따라서 제어기의 실행 기록에는 이 주입이 남지 않는다.
 */
import type { Session, SignCommand } from "@contracts";

export type InvalidKind = "STALE_SEQUENCE" | "RUN_MISMATCH" | "SIGN_MISMATCH" | "LATE_ARRIVAL";

export const INVALID_LABEL: Record<InvalidKind, string> = {
  STALE_SEQUENCE: "낮은 순번",
  RUN_MISMATCH: "지난 실행",
  SIGN_MISMATCH: "다른 단말",
  LATE_ARRIVAL: "늦게 도착",
};

/** 지난 실행을 흉내 낼 때 쓰는 고정 UUID. 실제 실행 ID와 겹치지 않는다. */
const PAST_RUN_ID = "00000000-0000-4000-8000-000000000000";

export type Injection = {
  readonly command: SignCommand;
  /** 이 명령을 받았다고 칠 요청 시작 시각(performance.now() 기준). */
  readonly requestStartedAtMs: number;
};

/**
 * 마지막으로 받은 진짜 명령을 바탕으로 무효 명령을 만든다.
 * 아직 명령을 한 번도 못 받았으면 주입할 것이 없으므로 null이다.
 */
export function buildInvalidCommand(
  kind: InvalidKind,
  latest: SignCommand | null,
  session: Session | null,
  nowMs: number,
): Injection | null {
  if (latest === null || session === null) return null;

  switch (kind) {
    case "STALE_SEQUENCE":
      return {
        command: {
          ...latest,
          command_sequence: Math.max(1, latest.command_sequence - 1),
          command_id: "11111111-2222-4333-8444-555555555555",
        },
        requestStartedAtMs: nowMs,
      };
    case "RUN_MISMATCH":
      return {
        command: { ...latest, run_id: PAST_RUN_ID, command_sequence: latest.command_sequence + 1 },
        requestStartedAtMs: nowMs,
      };
    case "SIGN_MISMATCH":
      return {
        command: {
          ...latest,
          sign_id: `${latest.sign_id}-OTHER`,
          command_sequence: latest.command_sequence + 1,
        },
        requestStartedAtMs: nowMs,
      };
    case "LATE_ARRIVAL":
      // 순번은 더 높지만, 요청을 보낸 시각이 유효기간보다 앞서 이미 기한이 지난 상태다.
      return {
        command: { ...latest, command_sequence: latest.command_sequence + 1 },
        requestStartedAtMs: nowMs - latest.valid_for_ms - 1,
      };
  }
}

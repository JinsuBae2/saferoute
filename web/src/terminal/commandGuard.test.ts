/**
 * 단말 수용·만료·ACK 규칙 시험. 입력은 2번이 생성한 공통 샘플(contracts/samples.generated.ts)이며
 * 단말이 임의로 만든 값이 아니다. 기준은 05번 명세 5.2·5.3절이다.
 */
import { describe, expect, it } from "vitest";

import type { SignCommand } from "@contracts";
import { command as commandSample, no_route_command as noRouteSample, session as sessionSample } from "@samples";

import {
  acceptCommand,
  ackableCommand,
  buildAppliedAck,
  buildRejectedAck,
  createTerminalState,
  evaluateExpiry,
  remainingMs,
} from "./commandGuard";

const SESSION = sessionSample;
const COMMAND: SignCommand = commandSample;
const NO_ROUTE: SignCommand = noRouteSample;

function withCommand(patch: Partial<SignCommand>): SignCommand {
  return { ...COMMAND, ...patch };
}

function freshState() {
  return createTerminalState(COMMAND.sign_id);
}

describe("유효기간은 요청 시작 시각 기준이다 (명세 5.2-4)", () => {
  it("응답이 늦게 와도 기한은 요청 시작 시각 + valid_for_ms로 고정된다", () => {
    const result = acceptCommand({
      state: freshState(),
      command: COMMAND,
      session: SESSION,
      requestStartedAtMs: 1_000,
      nowMs: 2_500, // 네트워크에서 1.5초 지연됐다
    });

    expect(result.outcome).toBe("ACCEPTED");
    // 2_500 + 3_000 = 5_500이 아니라 1_000 + 3_000 = 4_000이어야 한다.
    expect(result.state.expiresAtMs).toBe(4_000);
    expect(remainingMs(result.state, 2_500)).toBe(1_500);
  });

  it("도착했을 때 이미 기한이 지났으면 적용하지 않고 만료로 넘어간다", () => {
    const result = acceptCommand({
      state: freshState(),
      command: COMMAND,
      session: SESSION,
      requestStartedAtMs: 1_000,
      nowMs: 4_000, // 경계 시각부터 만료다
    });

    expect(result).toMatchObject({ outcome: "DISCARDED", reason: "ALREADY_EXPIRED" });
    expect(result.state.display).toEqual({ kind: "EXPIRED" });
    expect(result.state.command).toBeNull();
    // 뒤늦은 낮은 순번이 다시 적용되지 않도록 순번은 남긴다.
    expect(result.state.lastSequence).toBe(COMMAND.command_sequence);
  });
});

describe("적용하지 않는 명령 (명세 5.2-3)", () => {
  const applied = acceptCommand({
    state: freshState(),
    command: COMMAND,
    session: SESSION,
    requestStartedAtMs: 0,
    nowMs: 10,
  });

  it("같거나 낮은 순번은 거부한다", () => {
    const stale = acceptCommand({
      state: applied.state,
      command: withCommand({ command_sequence: COMMAND.command_sequence - 1, command_id: "a" }),
      session: SESSION,
      requestStartedAtMs: 20,
      nowMs: 25,
    });
    expect(stale).toMatchObject({ outcome: "DISCARDED", reason: "STALE_SEQUENCE" });
    // 기존 표시는 그대로 유지된다.
    expect(stale.state.command?.command_id).toBe(COMMAND.command_id);
  });

  it("다른 단말의 명령은 거부한다", () => {
    const other = acceptCommand({
      state: freshState(),
      command: withCommand({ sign_id: "SIGN-B" }),
      session: SESSION,
      requestStartedAtMs: 0,
      nowMs: 1,
    });
    expect(other).toMatchObject({ outcome: "DISCARDED", reason: "SIGN_MISMATCH" });
  });

  it("건물 자료 버전이 다르면 거부한다", () => {
    const mismatched = acceptCommand({
      state: freshState(),
      command: withCommand({ building_version: SESSION.building_version + 1 }),
      session: SESSION,
      requestStartedAtMs: 0,
      nowMs: 1,
    });
    expect(mismatched).toMatchObject({ outcome: "DISCARDED", reason: "BUILDING_MISMATCH" });
  });

  it("실행이 바뀌면 기존 명령을 폐기하고 처음 상태로 돌아간다 (명세 5.2-7)", () => {
    const changed = acceptCommand({
      state: applied.state,
      command: withCommand({ run_id: "99999999-9999-4999-8999-999999999999" }),
      session: SESSION,
      requestStartedAtMs: 20,
      nowMs: 25,
    });
    expect(changed.outcome).toBe("RUN_CHANGED");
    expect(changed.state).toEqual(createTerminalState(COMMAND.sign_id));
  });
});

describe("기한 경과 처리 (명세 5.2-6)", () => {
  const live = acceptCommand({
    state: freshState(),
    command: COMMAND,
    session: SESSION,
    requestStartedAtMs: 0,
    nowMs: 5,
  }).state;

  it("기한 전에는 표시를 유지한다", () => {
    expect(evaluateExpiry(live, 2_999).display).toEqual({
      kind: "LIVE",
      faces: COMMAND.faces,
      guidanceVersion: COMMAND.guidance_version,
    });
  });

  it("기한이 지나면 화살표를 제거하고 순번만 남긴다", () => {
    const expired = evaluateExpiry(live, 3_000);
    expect(expired.display).toEqual({ kind: "EXPIRED" });
    expect(expired.command).toBeNull();
    expect(expired.expiresAtMs).toBeNull();
    expect(expired.lastSequence).toBe(COMMAND.command_sequence);
  });

  it("만료된 명령으로는 ACK를 보내지 않는다", () => {
    expect(ackableCommand(live, 2_999)?.command_id).toBe(COMMAND.command_id);
    expect(ackableCommand(live, 3_000)).toBeNull();
    expect(ackableCommand(evaluateExpiry(live, 3_000), 3_001)).toBeNull();
  });
});

describe("적용 응답 구성 (명세 5.3)", () => {
  it("APPLIED는 명령의 face_id·mode·display를 그대로 복사한다", () => {
    const ack = buildAppliedAck(COMMAND, "44444444-4444-4444-8444-444444444444", 8.456);

    expect(ack.status).toBe("APPLIED");
    expect(ack.error_code).toBeNull();
    expect(ack.client_apply_duration_ms).toBe(8.46);
    expect(ack.faces).toEqual(
      COMMAND.faces.map((face) => ({ face_id: face.face_id, mode: face.mode, display: face.display })),
    );
    // 서버 check_ack가 대조하는 식별자들
    expect(ack.command_id).toBe(COMMAND.command_id);
    expect(ack.command_sequence).toBe(COMMAND.command_sequence);
    expect(ack.guidance_version).toBe(COMMAND.guidance_version);
    expect(ack.run_id).toBe(COMMAND.run_id);
  });

  it("NO_ROUTE 명령도 그대로 되돌려준다. 단말이 방향을 지어내지 않는다", () => {
    const ack = buildAppliedAck(NO_ROUTE, "44444444-4444-4444-8444-444444444444", 3);
    expect(ack.faces.every((face) => face.display === null)).toBe(true);
    expect(ack.faces.every((face) => face.mode === "NO_ROUTE")).toBe(true);
  });

  it("REJECTED는 error_code를 반드시 담고 적용 시간을 주장하지 않는다", () => {
    const ack = buildRejectedAck(COMMAND, "44444444-4444-4444-8444-444444444444", "RENDER_FAILED");
    expect(ack.status).toBe("REJECTED");
    expect(ack.error_code).toBe("RENDER_FAILED");
    expect(ack.client_apply_duration_ms).toBeNull();
    expect(ack.faces).toEqual([]);
  });

  it("음수 적용 시간은 0으로 막는다", () => {
    expect(buildAppliedAck(COMMAND, "44444444-4444-4444-8444-444444444444", -1).client_apply_duration_ms).toBe(0);
  });
});

describe("단말은 안내를 재계산하지 않는다 (이슈 #15 완료 조건)", () => {
  it("서버가 준 faces 배열을 그대로 표시한다", () => {
    const result = acceptCommand({
      state: freshState(),
      command: COMMAND,
      session: SESSION,
      requestStartedAtMs: 0,
      nowMs: 1,
    });
    expect(result.state.display).toEqual({
      kind: "LIVE",
      faces: COMMAND.faces,
      guidanceVersion: COMMAND.guidance_version,
    });
  });
});

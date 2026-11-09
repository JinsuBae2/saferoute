/**
 * V09 단말 단절·역순·만료 시험.
 *
 * 07번 시나리오서 V09가 요구하는 "낮은 command_sequence, 지난 run_id, 다른 sign_id,
 * 늦게 도착한 명령"을 주입하고, 무효 명령이 화면에 적용되지 않는지와
 * 신선한 명령으로만 복구되는지를 확인한다.
 *
 * 브라우저 타이머 한계는 여기서 다루지 않는다. 이 시험은 판정 규칙만 본다.
 */
import { describe, expect, it } from "vitest";

import type { Session, SignCommand } from "@contracts";
import { command as commandSample, session as sessionSample } from "@samples";

import { acceptCommand, createTerminalState, evaluateExpiry } from "./commandGuard";
import type { TerminalState } from "./commandGuard";
import { INVALID_LABEL, buildInvalidCommand } from "./faults";
import type { InvalidKind } from "./faults";

const SESSION: Session = sessionSample;
const COMMAND: SignCommand = commandSample;

/** 정상 명령 하나를 받아 화살표를 띄운 상태 */
function appliedState(nowMs = 10): TerminalState {
  const result = acceptCommand({
    state: createTerminalState(COMMAND.sign_id),
    command: COMMAND,
    session: SESSION,
    requestStartedAtMs: 0,
    nowMs,
  });
  if (result.outcome !== "ACCEPTED") throw new Error("정상 명령이 적용되지 않았습니다");
  return result.state;
}

function inject(kind: InvalidKind, state: TerminalState, nowMs: number) {
  const injection = buildInvalidCommand(kind, state.command ?? COMMAND, SESSION, nowMs);
  if (injection === null) throw new Error("주입할 명령을 만들지 못했습니다");
  return acceptCommand({
    state,
    command: injection.command,
    session: SESSION,
    requestStartedAtMs: injection.requestStartedAtMs,
    nowMs,
  });
}

describe("주입할 명령 만들기", () => {
  it("받은 명령이 없으면 주입하지 않는다", () => {
    expect(buildInvalidCommand("STALE_SEQUENCE", null, SESSION, 0)).toBeNull();
    expect(buildInvalidCommand("STALE_SEQUENCE", COMMAND, null, 0)).toBeNull();
  });

  it("네 가지 장애에 모두 한국어 이름이 있다", () => {
    const kinds: InvalidKind[] = ["STALE_SEQUENCE", "RUN_MISMATCH", "SIGN_MISMATCH", "LATE_ARRIVAL"];
    for (const kind of kinds) expect(INVALID_LABEL[kind]).toBeTruthy();
  });

  it("늦게 도착한 명령은 순번이 높아도 요청 시작 시각이 기한을 넘긴다", () => {
    const injection = buildInvalidCommand("LATE_ARRIVAL", COMMAND, SESSION, 10_000);
    if (injection === null) throw new Error("주입 실패");
    expect(injection.command.command_sequence).toBe(COMMAND.command_sequence + 1);
    expect(injection.requestStartedAtMs + injection.command.valid_for_ms).toBeLessThan(10_000);
  });
});

describe("무효 명령은 화면에 적용되지 않는다 (V09)", () => {
  it("낮은 순번은 거부하고 기존 표시를 유지한다", () => {
    const before = appliedState();
    const result = inject("STALE_SEQUENCE", before, 50);

    expect(result).toMatchObject({ outcome: "DISCARDED", reason: "STALE_SEQUENCE" });
    expect(result.state.display).toEqual(before.display);
    expect(result.state.command?.command_id).toBe(COMMAND.command_id);
  });

  it("다른 단말의 명령은 거부하고 기존 표시를 유지한다", () => {
    const before = appliedState();
    const result = inject("SIGN_MISMATCH", before, 50);

    expect(result).toMatchObject({ outcome: "DISCARDED", reason: "SIGN_MISMATCH" });
    expect(result.state.display).toEqual(before.display);
  });

  it("지난 실행의 명령은 적용하지 않고 처음 상태로 되돌린다", () => {
    const before = appliedState();
    const result = inject("RUN_MISMATCH", before, 50);

    expect(result.outcome).toBe("RUN_CHANGED");
    // 적용이 아니라 폐기다. 화살표가 남아 있으면 안 된다.
    expect(result.state.display).toEqual({ kind: "WAITING" });
    expect(result.state.command).toBeNull();
  });

  it("늦게 도착한 명령은 적용하지 않고 화살표를 지운다", () => {
    const before = appliedState();
    const result = inject("LATE_ARRIVAL", before, 2_000);

    expect(result).toMatchObject({ outcome: "DISCARDED", reason: "ALREADY_EXPIRED" });
    expect(result.state.display).toEqual({ kind: "EXPIRED" });
    expect(result.state.command).toBeNull();
  });
});

describe("신선한 명령으로만 복구한다 (V09)", () => {
  function fresh(sequence: number): SignCommand {
    return {
      ...COMMAND,
      command_sequence: sequence,
      command_id: "99999999-8888-4777-8666-555555555555",
    };
  }

  it("통신이 끊겨 기한이 지난 뒤, 새 명령을 받으면 다시 표시한다", () => {
    const live = appliedState();
    const expired = evaluateExpiry(live, 5_000);
    expect(expired.display).toEqual({ kind: "EXPIRED" });

    const recovered = acceptCommand({
      state: expired,
      command: fresh(COMMAND.command_sequence + 5),
      session: SESSION,
      requestStartedAtMs: 5_100,
      nowMs: 5_150,
    });

    expect(recovered.outcome).toBe("ACCEPTED");
    expect(recovered.state.display).toMatchObject({ kind: "LIVE" });
    expect(recovered.state.expiresAtMs).toBe(5_100 + COMMAND.valid_for_ms);
  });

  it("실행이 바뀐 뒤에는 새 실행의 명령만 받는다", () => {
    const before = appliedState();
    const changed = inject("RUN_MISMATCH", before, 50);
    expect(changed.state.lastSequence).toBe(0);

    // 새 session을 다시 읽었다고 보고, 같은 실행의 명령을 받는다.
    const next = acceptCommand({
      state: changed.state,
      command: fresh(1),
      session: SESSION,
      requestStartedAtMs: 100,
      nowMs: 120,
    });
    expect(next.outcome).toBe("ACCEPTED");
    expect(next.state.display).toMatchObject({ kind: "LIVE" });
  });

  it("절전에서 돌아오면 만료부터 확인하고, 그 뒤 새 명령을 받는다", () => {
    const live = appliedState();
    // 탭이 멈춰 있는 동안 기한이 지났다.
    const afterWake = evaluateExpiry(live, 60_000);
    expect(afterWake.display).toEqual({ kind: "EXPIRED" });
    expect(afterWake.command).toBeNull();

    const next = acceptCommand({
      state: afterWake,
      command: fresh(COMMAND.command_sequence + 9),
      session: SESSION,
      requestStartedAtMs: 60_100,
      nowMs: 60_120,
    });
    expect(next.outcome).toBe("ACCEPTED");
    expect(next.state.display).toMatchObject({ kind: "LIVE" });
  });
});

/**
 * 단말 1대(sign_id 1개)의 조회 → 표시 → ACK 루프.
 * 명세 5.2 적용 순서를 그대로 따른다. 판단은 commandGuard의 순수 함수가 하고
 * 여기서는 네트워크·타이머·화면 반영 시점만 다룬다.
 */
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { Session, SignCommand, SignState } from "@contracts";

import { ApiError, fetchSession, fetchSignCommand, postSignAck } from "../api/client";
import type { DiscardReason, TerminalState } from "./commandGuard";
import {
  acceptCommand,
  ackableCommand,
  buildAppliedAck,
  createTerminalState,
  evaluateExpiry,
  remainingMs,
} from "./commandGuard";

/** valid_for_ms 3000 기준으로 만료 전 세 번의 기회를 둔다. */
const POLL_INTERVAL_MS = 800;
/** 서버의 만료 작업과 같은 주기로 화살표 제거를 확인한다. */
const EXPIRY_WATCH_MS = 100;
/** 화면이 숨겨져 rAF가 멈출 때 루프가 영원히 멈추지 않게 한다. */
const PAINT_TIMEOUT_MS = 500;
const HIDDEN_RECHECK_MS = 300;

export type AckOutcome = {
  readonly commandSequence: number;
  readonly status: "APPLIED" | "SKIPPED" | "FAILED";
  readonly detail: string;
  /** 서버가 되돌려준 현재 적용 상태. 단말이 스스로 정하지 않는다. */
  readonly applicationStatus: SignState["application_status"] | null;
};

export type TerminalView = {
  readonly state: TerminalState;
  readonly session: Session | null;
  readonly terminalInstanceId: string;
  readonly remainingMs: number | null;
  readonly lastAck: AckOutcome | null;
  readonly notice: string | null;
  readonly fatal: string | null;
  readonly commandCount: number;
  readonly hidden: boolean;
};

const DISCARD_NOTICE: Record<DiscardReason, string> = {
  SIGN_MISMATCH: "다른 유도등의 명령이라 적용하지 않았습니다.",
  BUILDING_MISMATCH: "건물 자료 버전이 달라 적용하지 않았습니다.",
  STALE_SEQUENCE: "더 낮은 순번의 명령이라 적용하지 않았습니다.",
  ALREADY_EXPIRED: "도착했을 때 이미 기한이 지나 적용하지 않았습니다.",
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message} (${error.code ?? error.status})`;
  if (error instanceof Error) return error.message;
  return fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 실제로 한 프레임이 그려질 때까지 기다린다. 숨은 탭에서는 시간 제한으로 빠져나온다. */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, PAINT_TIMEOUT_MS);
  });
}

export function useSignTerminal(signId: string): TerminalView {
  const instanceRef = useRef<string | null>(null);
  instanceRef.current ??= crypto.randomUUID();
  const terminalInstanceId = instanceRef.current;

  const [view, setView] = useState<TerminalView>(() => ({
    state: createTerminalState(signId),
    session: null,
    terminalInstanceId,
    remainingMs: null,
    lastAck: null,
    notice: null,
    fatal: null,
    commandCount: 0,
    hidden: false,
  }));

  useEffect(() => {
    const abort = new AbortController();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    let state = createTerminalState(signId);
    let session: Session | null = null;
    let lastAck: AckOutcome | null = null;
    let notice: string | null = null;
    let fatal: string | null = null;
    let commandCount = 0;

    const publish = () => {
      if (stopped) return;
      setView({
        state,
        session,
        terminalInstanceId,
        remainingMs: remainingMs(state, performance.now()),
        lastAck,
        notice,
        fatal,
        commandCount,
        hidden: document.visibilityState !== "visible",
      });
    };

    const scheduleNext = (delayMs: number = POLL_INTERVAL_MS) => {
      if (stopped) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => void tick(), delayMs);
    };

    const applyAndAck = async (command: SignCommand) => {
      const applyStartedAt = performance.now();
      // 화면 상태를 동기 커밋한 뒤 실제 페인트까지 기다린다. 수신 성공만으로 APPLIED를 보내지 않는다.
      flushSync(publish);
      await waitForPaint();
      if (stopped) return;

      const clientApplyDurationMs = performance.now() - applyStartedAt;
      const current = ackableCommand(state, performance.now());
      const painted = document.visibilityState === "visible";

      if (current === null || current.command_id !== command.command_id) {
        lastAck = {
          commandSequence: command.command_sequence,
          status: "SKIPPED",
          detail: "화면에 반영하기 전에 기한이 지나 적용을 주장하지 않았습니다.",
          applicationStatus: null,
        };
        publish();
        return;
      }
      if (!painted) {
        lastAck = {
          commandSequence: command.command_sequence,
          status: "SKIPPED",
          detail: "탭이 화면에 없어 표시를 확인할 수 없으므로 적용을 주장하지 않았습니다.",
          applicationStatus: null,
        };
        publish();
        return;
      }

      try {
        const signState = await postSignAck(
          signId,
          buildAppliedAck(command, terminalInstanceId, clientApplyDurationMs),
          abort.signal,
        );
        lastAck = {
          commandSequence: command.command_sequence,
          status: "APPLIED",
          detail: `화면 반영 ${clientApplyDurationMs.toFixed(1)}ms 뒤 응답`,
          applicationStatus: signState.application_status,
        };
      } catch (error) {
        if (isAbort(error)) return;
        lastAck = {
          commandSequence: command.command_sequence,
          status: "FAILED",
          detail: messageOf(error, "적용 응답을 보내지 못했습니다"),
          applicationStatus: null,
        };
      }
      publish();
    };

    const handleCommandError = (error: unknown) => {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          fatal = `${error.message} 건물 설정에 없는 sign_id입니다: ${signId}`;
          return;
        }
        if (error.status === 503) {
          notice = "제어기가 명령을 제공할 수 없습니다. 기존 만료 정책을 유지합니다.";
          return;
        }
        if (error.status === 409) {
          notice = "발행 중 안내가 바뀌거나 기한이 지났습니다. 새 명령을 다시 조회합니다.";
          return;
        }
        if (error.status >= 500) {
          // 개발 프록시·배포 Nginx는 제어기가 죽으면 502·500을 돌려준다.
          notice = "제어기에 연결하지 못했습니다. 신선한 명령을 받을 때까지 방향을 표시하지 않습니다.";
          return;
        }
      }
      notice = messageOf(error, "명령을 조회하지 못했습니다");
    };

    const tick = async () => {
      if (stopped || fatal !== null) return;
      if (document.visibilityState !== "visible") {
        // 숨은 탭에서는 명령을 발행받지 않는다. 기존 명령은 만료 감시가 지운다.
        publish();
        scheduleNext(HIDDEN_RECHECK_MS);
        return;
      }

      if (session === null) {
        try {
          session = await fetchSession(abort.signal);
          notice = null;
        } catch (error) {
          if (isAbort(error)) return;
          notice = messageOf(error, "세션을 읽지 못했습니다");
          publish();
          scheduleNext(1000);
          return;
        }
      }

      const requestStartedAtMs = performance.now();
      let command: SignCommand;
      try {
        command = await fetchSignCommand(signId, abort.signal);
      } catch (error) {
        if (isAbort(error)) return;
        handleCommandError(error);
        publish();
        scheduleNext();
        return;
      }

      commandCount += 1;
      const result = acceptCommand({
        state,
        command,
        session,
        requestStartedAtMs,
        nowMs: performance.now(),
      });
      state = result.state;

      if (result.outcome === "RUN_CHANGED") {
        session = null;
        notice = "실행이 바뀌어 기존 명령을 폐기했습니다. 세션을 다시 읽습니다.";
        publish();
        scheduleNext(0);
        return;
      }
      if (result.outcome === "DISCARDED") {
        notice = DISCARD_NOTICE[result.reason];
        publish();
        scheduleNext();
        return;
      }

      notice = null;
      await applyAndAck(command);
      scheduleNext();
    };

    const watchExpiry = () => {
      state = evaluateExpiry(state, performance.now());
      publish();
    };

    const onVisibility = () => {
      // 명세 5.2-8: 복귀 시 만료부터 확인하고 신선한 명령 전까지 방향을 표시하지 않는다.
      watchExpiry();
      if (document.visibilityState === "visible") scheduleNext(0);
    };

    const expiryTimer = setInterval(watchExpiry, EXPIRY_WATCH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void tick();

    return () => {
      stopped = true;
      clearInterval(expiryTimer);
      clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      abort.abort();
    };
  }, [signId, terminalInstanceId]);

  return view;
}

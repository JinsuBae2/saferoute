/**
 * 개인 체험방의 문. 입장·복귀·정원 초과·종료·만료를 다루고, 방이 준비됐을 때만 안쪽 화면을 그린다.
 * 어느 방인지는 서버가 쿠키로 정한다. 방이 없어졌다고 공동 시연이나 다른 방으로 넘기지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError, enterRoom, fetchRoom, leaveRoom } from "../api/client";
import type { RoomInfo } from "../api/client";
import { rememberRoom, rememberedRoom } from "../api/scope";
import { stopSound } from "../control/alarmSound";
import { startPolling } from "../control/poll";

type Phase =
  | { readonly kind: "CHECKING" | "NONE" | "FULL" | "ENDED" | "LEFT" | "UNAVAILABLE" }
  | { readonly kind: "ERROR"; readonly message: string }
  | { readonly kind: "READY"; readonly room: RoomInfo };

const MESSAGE: Record<"NONE" | "FULL" | "ENDED" | "LEFT" | "UNAVAILABLE", string> = {
  NONE: "나만 쓰는 체험방입니다. 화재를 내고, 해제하고, 처음부터 다시 해 볼 수 있습니다. 다른 사람의 화면에는 영향을 주지 않습니다.",
  FULL: "현재 체험방이 모두 사용 중입니다. 자리가 나면 다시 확인해 주세요.",
  ENDED: "체험이 종료되었습니다. 새 체험을 시작해 주세요.",
  LEFT: "체험을 종료했습니다. 자리를 반환했습니다.",
  UNAVAILABLE: "이 서버는 개인 체험방을 제공하지 않습니다.",
};

const isGone = (error: unknown) => error instanceof ApiError && error.status === 401;

export function RoomGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "CHECKING" });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const lost = useCallback((wasInside: boolean) => {
    // 방이 사라졌다. 그 방의 소리를 끊고, 조용히 다른 곳으로 잇지 않고 종료를 알린다.
    // 방 안에 있다가 사라졌으면(만료·서버 재시작·다른 탭에서 종료) 언제나 종료로 알린다.
    stopSound();
    const had = wasInside || rememberedRoom() !== null;
    rememberRoom(null);
    setPhase({ kind: had ? "ENDED" : "NONE" });
  }, []);

  // 처음 들어오면 이 브라우저의 방이 아직 살아 있는지부터 본다.
  useEffect(() => {
    const abort = new AbortController();
    fetchRoom(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])).then((room) => {
      rememberRoom(room.room_id);
      setPhase({ kind: "READY", room });
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      if (isGone(error)) lost(false);
      else if (error instanceof ApiError && error.code === "ROOMS_UNAVAILABLE") setPhase({ kind: "UNAVAILABLE" });
      else setPhase({ kind: "ERROR", message: "체험방 서버에 연결하지 못했습니다. 잠시 뒤 다시 확인해 주세요." });
    });
    return () => abort.abort();
  }, [lost]);

  // 들어와 있는 동안 방이 살아 있는지 계속 확인한다. 다른 탭에서 종료했거나 만료되면 여기서 안다.
  const ready = phase.kind === "READY";
  useEffect(() => {
    if (!ready) return;
    return startPolling(fetchRoom, (room) => setPhase({ kind: "READY", room }), (error) => { if (isGone(error)) lost(true); }, 3000);
  }, [ready, lost]);

  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      const room = await enterRoom(AbortSignal.timeout(15000));
      rememberRoom(room.room_id);
      if (alive.current) setPhase({ kind: "READY", room });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.code === "ROOM_FULL") setPhase({ kind: "FULL" });
      else if (error instanceof ApiError && error.code === "ROOMS_UNAVAILABLE") setPhase({ kind: "UNAVAILABLE" });
      else setPhase({ kind: "ERROR", message: "체험방을 준비하지 못했습니다. 잠시 뒤 다시 시도해 주세요." });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function end() {
    if (busy) return;
    setBusy(true);
    stopSound();
    try {
      await leaveRoom(AbortSignal.timeout(8000));
      rememberRoom(null);
      if (alive.current) setPhase({ kind: "LEFT" });
    } catch {
      if (alive.current) setPhase({ kind: "ERROR", message: "종료 요청이 전달되지 않았습니다. 다시 확인해 주세요." });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (phase.kind === "READY") {
    return (
      <>
        <div className="room-bar">
          <strong>개인 체험방</strong>
          <span>
            이 방의 화재·해제·처음부터는 나에게만 적용됩니다 · 체험방 {phase.room.capacity}개 중 {phase.room.in_use}개 사용 중
            {" "}· 모든 화면을 닫고 {Math.max(1, Math.round(phase.room.idle_seconds / 60))}분이 지나면 자동 종료
            {phase.room.status === "FAILED" && " · 이 방의 시뮬레이션이 멈췄습니다. 「처음부터」를 누르거나 종료 후 다시 시작해 주세요"}
          </span>
          <span className="room-bar__actions">
            <Link className="chip" to="/shared">공동 시연 보기</Link>
            <button type="button" className="chip" disabled={busy} onClick={() => void end()}>체험 종료</button>
          </span>
        </div>
        {/* 방이 바뀌면 안쪽 화면을 통째로 새로 만든다. 이전 방의 조회·경로·경보·집계가 남지 않는다. */}
        <div key={phase.room.room_id}>{children}</div>
      </>
    );
  }

  return (
    <main className="control">
      <section className="panel room-entry" aria-live="polite">
        <header className="panel__head"><h2>SafeRoute 화재 대피 안내 · 개인 체험</h2></header>
        <p>건물에 불이 났을 때 불과 연기를 피해 가는 대피 경로를 유도등과 휴대폰으로 안내하는 시연입니다.</p>
        <ol className="room-entry__steps">
          <li>3D 도면에서 <strong>화재 위치</strong>를 누릅니다.</li>
          <li>한 번 더 눌러 <strong>내 위치</strong>를 정합니다.</li>
          <li><strong>시연 시작</strong>을 누르고 1인칭·휴대폰 안내로 탈출까지 따라갑니다.</li>
        </ol>
        <p className="panel__empty">
          {phase.kind === "CHECKING" ? "체험방을 확인하는 중입니다." : phase.kind === "ERROR" ? phase.message : MESSAGE[phase.kind]}
        </p>
        {phase.kind !== "CHECKING" && phase.kind !== "UNAVAILABLE" && (
          <button type="button" className="chip chip--on" disabled={busy} onClick={() => void start()}>
            {busy ? "준비 중…" : phase.kind === "FULL" || phase.kind === "ERROR" ? "다시 확인" : phase.kind === "NONE" ? "개인 체험 시작" : "새 체험 시작"}
          </button>
        )}
        <p className="panel__note">
          로그인은 없습니다. 같은 브라우저의 다른 탭은 같은 방을 씁니다. <Link to="/shared">공동 시연 보기</Link>
        </p>
      </section>
    </main>
  );
}

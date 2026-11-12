/**
 * 재난 상태 배너와 방송 조절. 서버 상태로 방송을 정해 소리 모듈에 넘기고, 자막·음량·음소거를 보여 준다.
 * 경보가 없으면 배너를 그리지 않는다. 기존 관제 정보를 가리지 않도록 한 줄로 둔다.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";

import { enableSound, setAnnouncement, setMuted, setVolume, soundStatus, stopSound, subscribeSound } from "./alarmSound";
import { alarmLevel, alarmPlace, announce, broadcastKey } from "./broadcast";
import type { BroadcastMemory, Places } from "./broadcast";

export function AlarmSoundBar({ state, stale, building = null, display = null, finishing = false }: {
  state: StateSnapshot;
  stale: boolean;
  /** 자리를 말해 주려면 둘 다 있어야 한다. 없으면 예전처럼 자리 없는 문장만 나온다. */
  building?: Building | null;
  display?: BuildingDisplay | null;
  finishing?: boolean;
}) {
  const sound = useSyncExternalStore(subscribeSound, soundStatus);
  const memory = useRef<BroadcastMemory | null>(null);
  useEffect(() => () => stopSound(), []);
  const level = alarmLevel(state);
  const places: Places = { building, display };
  const key = broadcastKey(state, stale, places);
  // 경보 구성·불이 닿은 구역이 바뀔 때만 방송을 다시 정한다. 1초마다 오는 상태 갱신으로 같은 문장이 처음부터 되풀이되지 않는다.
  useEffect(() => {
    const next = announce(memory.current, state, stale, places);
    memory.current = next.memory;
    setAnnouncement(next.announcement);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key가 state의 경보 구성·확산·stale을 대신한다
  }, [key]);

  const fires = state.active_causes.filter((cause) => cause.hazard_type === "FIRE").length;
  const place = alarmPlace(state, places);
  return (
    <div className={level === "NONE" ? "alarm-bar" : `alarm-bar alarm-bar--${level === "FIRE" ? "fire" : "smoke"}`} role={level === "NONE" ? undefined : "alert"}>
      {level !== "NONE" && <span className="alarm-bar__lamp" aria-hidden />}
      <strong className="alarm-bar__title">
        {level === "NONE" ? (finishing ? "경보 해제 · 대피 마무리 중" : "경보 없음") : level === "FIRE" ? `화재 경보 ${fires}건` : "연기 감지 경보"}
        {level !== "NONE" && place !== null && ` · ${place}`}
        {level !== "NONE" && ` · 전체 활성 경보 ${state.active_causes.length}건`}
        {level !== "NONE" && stale && " · 제어기 연결 끊김(방향 안내 중단, 경보 유지)"}
      </strong>
      <span className="alarm-bar__caption" aria-live="polite">
        {sound.caption !== null ? `방송: ${sound.caption}` : level === "NONE" ? "방송 없음" : "방송 대기 중"}
        {sound.exit !== null && ` · 출구 유도음 ${sound.exit.exitId} (${sound.exit.metres}m)`}
      </span>
      <span className="alarm-bar__controls">
        {!sound.enabled ? (
          <button type="button" className="chip" onClick={() => enableSound()}>소리 켜기</button>
        ) : (
          <>
            <button type="button" className={sound.muted ? "chip chip--on" : "chip"} aria-pressed={sound.muted} onClick={() => setMuted(!sound.muted)}>
              {sound.muted ? "음소거 해제" : "음소거"}
            </button>
            <label className="alarm-bar__volume">
              음량
              <input type="range" min={0} max={1} step={0.05} value={sound.volume} aria-label="방송 음량"
                onChange={(event) => setVolume(Number(event.target.value))} />
            </label>
            {sound.silencedByOtherWindow && <span className="grid__dim">다른 관제 창이 방송 중</span>}
          </>
        )}
      </span>
    </div>
  );
}

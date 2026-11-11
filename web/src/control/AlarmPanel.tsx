/**
 * 활성 경보를 원인별로 보여 주고 하나씩 해제한다. 화재뿐 아니라 연기·스프링클러 경보도 같다.
 * 정상 관측이 들어오는 것과 경보 해제는 별개다. 사람이 원인을 확인하고 눌러야만 해제된다.
 * 해제 요청의 응답과, 그 뒤 서버 상태에 실제로 반영됐는지를 따로 보여 준다.
 */
import { useEffect, useRef, useState } from "react";

import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";

import { ApiError, clearCause } from "../api/client";
import { observedAgeMs, sourceStatus } from "./controlModel";
import type { SourceStatus } from "./controlModel";

type Cause = StateSnapshot["active_causes"][number];
type Hazard = Cause["hazard_type"];

const HAZARD_LABEL: Record<Hazard, string> = { FIRE: "화재", SMOKE: "연기", SPRINKLER: "스프링클러" };
const HAZARD_TONE: Record<Hazard, string> = { FIRE: "fire", SMOKE: "warn", SPRINKLER: "warn" };

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  NEVER: "아직 정보를 받지 못함",
  FRESH: "최신 정보 수신 중",
  EXPIRED: "정보가 오래되어 만료됨",
  UNAVAILABLE: "감지기가 관측 불가를 알림",
};

export const SOURCE_STATUS_TONE: Record<SourceStatus, string> = { NEVER: "muted", FRESH: "route", EXPIRED: "warn", UNAVAILABLE: "fire" };

/** 경과 시간을 사람이 읽는 말로. */
export function agoText(ms: number | null): string {
  if (ms === null) return "받은 적 없음";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}초 전` : `${Math.floor(ms / 60_000)}분 ${Math.floor((ms % 60_000) / 1000)}초 전`;
}

type Attempt = {
  readonly key: string;
  readonly label: string;
  /** 해제한 경보의 첫 이벤트. 같은 원인이 다른 이벤트로 다시 켜졌는지 가리는 데 쓴다. */
  readonly firstEventId: string;
  readonly outcome: "PENDING" | "ACCEPTED" | "FAILED";
  readonly message: string;
};

type Props = {
  readonly state: StateSnapshot;
  readonly building: Building | null;
  readonly display: BuildingDisplay | null;
  readonly connected: boolean;
};

const keyOf = (cause: { source_id: string; hazard_type: string }) => `${cause.source_id}:${cause.hazard_type}`;

export function AlarmPanel({ state, building, display, connected }: Props) {
  const [attempts, setAttempts] = useState<readonly Attempt[]>([]);
  const busy = useRef(false);
  const runId = useRef(state.run_id);
  // 실행이 바뀌면 이전 실행의 해제 기록은 의미가 없다.
  useEffect(() => {
    if (runId.current === state.run_id) return;
    runId.current = state.run_id;
    setAttempts([]);
  }, [state.run_id]);

  const zoneOf = (sourceId: string) => {
    const zoneId = building?.sources.find((item) => item.source_id === sourceId)?.zone_id;
    return zoneId === undefined ? "위치 미확인" : display?.zone_labels[zoneId] ?? zoneId;
  };
  const labelOf = (cause: Cause) => `${zoneOf(cause.source_id)} ${HAZARD_LABEL[cause.hazard_type]}`;

  async function clear(cause: Cause) {
    if (busy.current || !connected) return;
    busy.current = true;
    const key = keyOf(cause);
    const base = { key, label: labelOf(cause), firstEventId: cause.first_event_id };
    const put = (attempt: Attempt) => setAttempts((previous) => [attempt, ...previous.filter((item) => item.key !== key)].slice(0, 6));
    put({ ...base, outcome: "PENDING", message: "해제 요청을 보내는 중" });
    try {
      const receipt = await clearCause({ schema_version: 1, run_id: state.run_id, source_id: cause.source_id,
        hazard_type: cause.hazard_type, reason: "관제 화면에서 원인 확인 후 해제" }, AbortSignal.timeout(8000));
      if (!receipt.cleared || receipt.run_id !== state.run_id || receipt.source_id !== cause.source_id) throw new Error("해제 응답이 요청과 다릅니다");
      put({ ...base, outcome: "ACCEPTED", message: `서버가 해제를 수락함 (안내 버전 ${receipt.guidance_version})` });
    } catch (error) {
      const message = error instanceof ApiError ? `${error.message} (${error.code ?? error.status})` : error instanceof Error ? error.message : "연결 오류";
      put({ ...base, outcome: "FAILED", message: `해제 실패 · ${message}. 응답을 받지 못했다면 반영됐을 수 있으니 아래 목록을 확인하세요` });
    } finally {
      busy.current = false;
    }
  }

  const active = new Map(state.active_causes.map((cause) => [keyOf(cause), cause]));
  /** 요청 응답과 별개로, 지금 서버 상태에 어떻게 반영돼 있는지. */
  const reflected = (attempt: Attempt): { text: string; tone: string } => {
    const now = active.get(attempt.key);
    if (attempt.outcome === "PENDING") return { text: "응답 대기", tone: "muted" };
    if (now === undefined) return attempt.outcome === "ACCEPTED"
      ? { text: "서버 반영 확인 · 경보 목록에서 사라짐", tone: "route" }
      : { text: "지금 서버에는 이 경보가 없음", tone: "muted" };
    if (attempt.outcome === "FAILED") return { text: "서버에 경보가 그대로 있음", tone: "fire" };
    return now.first_event_id === attempt.firstEventId
      ? { text: "서버 상태 반영 확인 중", tone: "muted" }
      : { text: "해제 뒤 감지기가 다시 위험을 알려 경보가 다시 켜짐 · 원인이 남아 있습니다", tone: "fire" };
  };

  return (
    <>
      {state.active_causes.length === 0 ? (
        <p className="panel__empty">
          활성 경보가 없습니다.
          {state.controller_mode === "NORMAL" && attempts.some((item) => item.outcome === "ACCEPTED") && " 모든 경보가 해제되어 평상시로 돌아왔습니다."}
        </p>
      ) : (
        <ul className="causes causes--actions">
          {state.active_causes.map((cause) => {
            const source = state.sources.find((item) => item.source_id === cause.source_id);
            const status = source === undefined ? null : sourceStatus(source.validity);
            return (
              <li key={keyOf(cause)}>
                <span className={`badge badge--${HAZARD_TONE[cause.hazard_type]}`}>{HAZARD_LABEL[cause.hazard_type]}</span>
                <span>
                  <strong>{zoneOf(cause.source_id)}</strong>
                  <small className="location-detail" title={cause.source_id}>
                    원인: {display?.sources[cause.source_id]?.label ?? cause.source_id} · 경보 시작 {cause.activated_at}
                  </small>
                  <small className="location-detail">
                    감지 정보: {status === null || source === undefined ? "확인 불가" : `${SOURCE_STATUS_LABEL[status]} · 마지막 관측 ${agoText(observedAgeMs(state, source))}`}
                  </small>
                </span>
                <button type="button" className="chip" disabled={!connected}
                  aria-label={`${labelOf(cause)} 경보 해제`} onClick={() => void clear(cause)}>
                  이 경보 해제
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {state.active_causes.length > 0 && (
        <p className="panel__note">
          감지기가 다시 정상 정보를 보내도 경보는 스스로 꺼지지 않습니다. 원인을 확인한 뒤 하나씩 해제하세요. 위험이 남아 있으면 해제해도 다시 켜집니다.
          {!connected && " 지금은 제어기와 연결이 끊겨 해제할 수 없습니다."}
        </p>
      )}
      {attempts.length > 0 && (
        <ul className="causes" aria-live="polite">
          {attempts.map((attempt) => {
            const server = reflected(attempt);
            return (
              <li key={attempt.key}>
                <span>{attempt.label}</span>
                <span className="grid__dim">요청 결과: {attempt.message}</span>
                <span className={`badge badge--${server.tone}`}>{server.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

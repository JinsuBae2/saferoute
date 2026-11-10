/**
 * 별도 유도등 단말 화면. 관제 화면의 자식이 아니라 자기 sign_id로 직접 API를 조회한다.
 * 표시 내용은 전부 서버 명령의 faces에서 온다.
 */
import { useSearchParams } from "react-router-dom";

import type { FaceResult } from "@contracts";

import { useBuildingData } from "../building/useBuildingData";
import { ArrowGlyph, DISPLAY_LABEL, UnavailableGlyph } from "./ArrowDisplay";
import type { FacePresentation, SignKind } from "./signPresentation";
import { SIGN_KIND_LABEL, SIGN_KIND_NOTE, presentFace, signKindOf } from "./signPresentation";
import { INVALID_LABEL } from "./faults";
import type { InvalidKind } from "./faults";
import { useSignTerminal } from "./useSignTerminal";

const INVALID_KINDS: readonly InvalidKind[] = [
  "STALE_SEQUENCE",
  "RUN_MISMATCH",
  "SIGN_MISMATCH",
  "LATE_ARRIVAL",
];

type Mode = FaceResult["mode"];
type ReasonCode = FaceResult["reason_codes"][number];

const MODE_LABEL: Record<Mode, string> = {
  DEFAULT: "평상시 기본 안내",
  DYNAMIC: "동적 경로 안내",
  NO_ROUTE: "안내 불가",
  UNKNOWN: "확인 불가",
};

const REASON_LABEL: Record<ReasonCode, string> = {
  INITIALIZING: "새 실행 준비 중",
  ORIGIN_BLOCKED: "이 지점이 위험·차단 구역입니다",
  NO_REACHABLE_EXIT: "남은 통로로 도달할 수 있는 출구가 없습니다",
  REQUIRED_OBSERVATION_UNKNOWN: "필수 관측을 확인할 수 없습니다",
  EXIT_UNAVAILABLE: "출구 조건을 충족하지 못했습니다",
  UNSUPPORTED_DISPLAY: "이 표시면에서 안내할 수 없는 방향입니다",
  CONTROLLER_UNAVAILABLE: "제어 상태를 확인할 수 없습니다",
  COMMAND_EXPIRED: "명령 유효기간이 지났습니다",
  VERSION_MISMATCH: "실행·건물 자료 버전이 맞지 않습니다",
};

const FACE_LABEL: Record<string, string> = { FRONT: "정면", REAR: "후면" };

function FaceCard({ face, kind }: { face: FaceResult; kind: SignKind | null }) {
  const shown: FacePresentation = presentFace(kind, face);
  const exitLocation = shown.role === "EXIT_LOCATION";
  const headline = exitLocation
    ? shown.available
      ? "출구"
      : MODE_LABEL[face.mode]
    : shown.display === null
      ? MODE_LABEL[face.mode]
      : DISPLAY_LABEL[shown.display];

  return (
    <section className={shown.available ? "face face--live" : "face face--muted"}>
      <h2 className="face__name">
        {FACE_LABEL[face.face_id] ?? face.face_id} 표시면
        <span className="face__id">{face.face_id}</span>
      </h2>

      <div className="face__glyph">
        {shown.available ? (
          // 출구 위치 표지는 방향을 그리지 않고 출구 기호만 쓴다.
          <ArrowGlyph display={exitLocation ? "EXIT" : (shown.display ?? "FORWARD")} />
        ) : (
          <UnavailableGlyph label={MODE_LABEL[face.mode]} />
        )}
      </div>

      <p className="face__headline">{headline}</p>
      <p className="face__mode">{MODE_LABEL[face.mode]}</p>

      {shown.mismatch !== null && <p className="face__caution">{shown.mismatch}</p>}

      {face.reason_codes.length > 0 && (
        <ul className="face__reasons">
          {face.reason_codes.map((code) => (
            <li key={code}>
              {REASON_LABEL[code]} <code>{code}</code>
            </li>
          ))}
        </ul>
      )}

      {face.mode === "NO_ROUTE" && (
        <p className="face__caution">
          안내 불가는 이 자리가 안전하다거나 머무르라는 지시가 아닙니다.
        </p>
      )}

      {exitLocation && shown.available && (
        <p className="face__note">{SIGN_KIND_NOTE.EXIT_LOCATION}</p>
      )}

      {!exitLocation && shown.available && (
        <dl className="face__detail">
          <div>
            <dt>다음 지점</dt>
            <dd>{face.next_node_id ?? "—"}</dd>
          </div>
          <div>
            <dt>목적지</dt>
            <dd>{face.exit_id ?? "—"}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function Placeholder({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="face face--muted face--wide">
      <div className="face__glyph">
        <UnavailableGlyph label={title} />
      </div>
      <p className="face__headline">{title}</p>
      <p className="face__mode">{detail}</p>
    </section>
  );
}

export function SignTerminal({ signId }: { signId: string }) {
  const view = useSignTerminal(signId);
  const [params] = useSearchParams();
  // 점검 패널은 ?fault=1 일 때만 나온다. 시연 화면에 섞이지 않게 한다.
  const faultPanel = params.get("fault") === "1";
  const { state, session, lastAck, controls, faults } = view;
  // 표지 종류와 한글 위치 이름은 표시 자료에서 온다. 못 읽어도 방향 안내는 그대로 보여준다.
  const space = useBuildingData(session);
  const kind = signKindOf(space.display, signId);
  const label = space.display?.signs[signId]?.label ?? null;
  const live = state.display.kind === "LIVE" ? state.display : null;
  const remaining = view.remainingMs;

  return (
    <main className="terminal">
      <header className="terminal__header">
        <div className="terminal__title">
          <span className="terminal__sign">{label ?? signId}</span>
          <span className="terminal__sub">
            {kind === null ? "유도등 단말" : SIGN_KIND_LABEL[kind]}
            {label !== null && ` · ${signId}`}
          </span>
        </div>
        {/*
          controller_mode는 /api/session을 읽은 시점의 값이라 지금 상태가 아니다.
          오래된 값을 현재 안내처럼 보이게 두지 않고, 현재 상태는 표시면의 mode로만 보여준다.
        */}
        <div className="terminal__meta">
          <span>
            실행 {session ? `${session.run_id.slice(0, 8)} · ${session.building_id} v${session.building_version}` : "확인 중"}
          </span>
          <span>안내 버전 {live ? live.guidanceVersion : "—"}</span>
          <span>명령 순번 {state.lastSequence > 0 ? state.lastSequence : "—"}</span>
        </div>
      </header>

      <div className="terminal__validity" aria-hidden>
        <div
          className="terminal__validity-bar"
          style={{ width: `${remaining === null ? 0 : Math.min(100, (remaining / 3000) * 100)}%` }}
        />
      </div>

      {view.fatal !== null ? (
        <Placeholder title="단말을 시작할 수 없습니다" detail={view.fatal} />
      ) : (
        <div className={live && live.faces.length > 1 ? "faces faces--two" : "faces"}>
          {live ? (
            live.faces.map((face) => <FaceCard key={face.face_id} face={face} kind={kind} />)
          ) : state.display.kind === "EXPIRED" ? (
            <Placeholder
              title="방향 표시 없음"
              detail="기한 안에 새 명령을 받지 못했습니다. 신선한 명령을 받을 때까지 방향을 표시하지 않습니다."
            />
          ) : (
            <Placeholder title="명령 대기 중" detail="제어기에서 첫 명령을 받으면 방향을 표시합니다." />
          )}
        </div>
      )}

      <footer className="terminal__footer">
        <div className="terminal__row">
          <span className="terminal__label">남은 유효시간</span>
          <span>{remaining === null ? "—" : `${Math.round(remaining)} ms`}</span>
          <span className="terminal__label">조회한 명령</span>
          <span>{view.commandCount}건</span>
          <span className="terminal__label">단말 인스턴스</span>
          <code>{view.terminalInstanceId.slice(0, 8)}</code>
        </div>

        <div className="terminal__row">
          <span className="terminal__label">마지막 적용 응답</span>
          {lastAck === null ? (
            <span>아직 없음</span>
          ) : (
            <span className={`ack ack--${lastAck.status.toLowerCase()}`}>
              #{lastAck.commandSequence} {lastAck.status}
              {lastAck.applicationStatus !== null && ` · 서버 ${lastAck.applicationStatus}`} — {lastAck.detail}
            </span>
          )}
        </div>

        {view.hidden && (
          <p className="terminal__notice">
            이 탭이 화면에 없습니다. 표시를 확인할 수 없으므로 명령 조회와 적용 주장을 멈춥니다.
          </p>
        )}
        {view.notice !== null && <p className="terminal__notice">{view.notice}</p>}
        {space.displayError !== null && (
          <p className="terminal__notice">
            표지 종류·이름을 읽지 못했습니다 ({space.displayError}). 방향 안내는 그대로 표시됩니다.
          </p>
        )}

        {faultPanel && (
          <div className="faults">
            <div className="terminal__row">
              <span className="terminal__label">점검</span>
              <button
                type="button"
                className={faults.offline ? "chip chip--on" : "chip"}
                onClick={() => controls.setOffline(!faults.offline)}
              >
                {faults.offline ? "통신 끊김" : "통신 끊기"}
              </button>
              <button
                type="button"
                className={faults.responseDelayMs > 0 ? "chip chip--on" : "chip"}
                onClick={() => controls.setResponseDelayMs(faults.responseDelayMs > 0 ? 0 : 4000)}
              >
                응답 지연 {faults.responseDelayMs > 0 ? `${faults.responseDelayMs}ms` : "끄기"}
              </button>
              {INVALID_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="chip"
                  onClick={() => controls.injectInvalid(kind)}
                >
                  {INVALID_LABEL[kind]} 주입
                </button>
              ))}
            </div>
            {view.lastInjection !== null && (
              <p className="terminal__notice">주입 결과: {view.lastInjection}</p>
            )}
            <p className="terminal__hint">
              주입한 명령은 이 단말 안에서만 쓰입니다. 서버로 보내지 않고 적용 응답도 만들지 않습니다.
            </p>
          </div>
        )}
      </footer>
    </main>
  );
}

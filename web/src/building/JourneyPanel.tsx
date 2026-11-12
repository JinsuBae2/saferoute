/**
 * 선택한 출발점의 대피 안내(M06, 이슈 #71). 경로는 서버 결과를 정리해 보여 줄 뿐이다.
 * 고른 지점은 실제 사용자 위치가 아니며, 선택해도 서버 상태나 설치 유도등 명령은 바뀌지 않는다.
 */
import { useMemo } from "react";

import type { Building, BuildingDisplay } from "@contracts";

import type { Journey, JourneyTrack, SignOnPath } from "./journey";
import { APPLICATION_LABEL, FACE_DISPLAY_LABEL, ROUTE_REASON_LABEL } from "./journey";

type Props = {
  readonly building: Building;
  readonly display: BuildingDisplay | null;
  readonly startId: string | null;
  readonly onStart: (nodeId: string | null) => void;
  readonly journey: Journey | null;
  readonly track: JourneyTrack | null;
  /** 상태 조회가 끊기거나 늦으면 경로를 현재 안내로 보여 주지 않는다. */
  readonly stale: boolean;
  readonly selectedSignId: string | null;
  readonly onSelectSign: (signId: string | null) => void;
  /** 출발점 고르기를 여기서 그릴지. 시연 패널이 대신 그리면 끈다. */
  readonly picker?: boolean;
};

const FACE_NAME: Record<string, string> = { FRONT: "정면", REAR: "후면" };
const STATUS_TONE: Record<string, string> = {
  APPLIED: "route",
  PENDING: "warn",
  NOT_ISSUED: "muted",
  EXPIRED: "warn",
  REJECTED: "fire",
  DUPLICATE_TERMINAL: "fire",
};

/** 지점 이름에 이미 층이 붙어 있으면("2층 …") 층 제목 옆에서 한 번 더 쓰지 않는다. */
function withoutFloor(label: string, floorLabel: string) {
  return label.startsWith(`${floorLabel} `) ? label.slice(floorLabel.length + 1) : label;
}

function faceText(face: SignOnPath["faces"][number]) {
  if (face.display !== null) return FACE_DISPLAY_LABEL[face.display];
  return face.mode === "UNKNOWN" ? "확인 불가" : "안내 불가";
}

type PickerProps = Pick<Props, "building" | "display" | "startId" | "onStart">;

/** 출발점 고르기. 시연 패널이 두 번째 단계로 가져다 쓸 수 있게 따로 뺐다. */
export function StartPicker({ building, display, startId, onStart }: PickerProps) {
  // 층별로 묶고 이름순으로 정렬한다. 문·갈림길·계단·출구 모두 출발점으로 고를 수 있다.
  const groups = useMemo(
    () =>
      building.floors.map((floor) => ({
        floorId: floor.floor_id,
        label: display?.floor_labels[floor.floor_id] ?? floor.label,
        nodes: building.nodes
          .filter((node) => node.floor_id === floor.floor_id)
          .map((node) => ({ id: node.node_id, label: display?.node_labels[node.node_id] ?? node.node_id }))
          .sort((a, b) => a.label.localeCompare(b.label, "ko")),
      })),
    [building, display],
  );

  return (
      <div className="journey__pick">
        <label className="journey__select">
          현재 위치 선택
          <select value={startId ?? ""} onChange={(event) => onStart(event.target.value === "" ? null : event.target.value)}>
            <option value="">선택 안 함</option>
            {groups.map((group) => (
              <optgroup key={group.floorId} label={group.label}>
                {group.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {startId !== null && (
          <button type="button" className="chip" onClick={() => onStart(null)}>
            내 위치 지우기
          </button>
        )}
        <small className="journey__hint">
          실제 위치 추적이 아니라 화면에서 고른 지점입니다. 3D에서 지점을 눌러도 고를 수 있고, 선택해도 유도등 명령은 바뀌지 않습니다.
        </small>
      </div>
  );
}

export function JourneyPanel({ building, display, startId, onStart, journey, track, stale, selectedSignId, onSelectSign, picker = true }: Props) {
  const nodeLabel = (nodeId: string) => display?.node_labels[nodeId] ?? nodeId;
  const previous = track?.previous ?? null;

  return (
    <div className="journey">
      {picker && <StartPicker building={building} display={display} startId={startId} onStart={onStart} />}

      {startId !== null && stale && (
        <p className="journey__alert">제어 상태 조회가 끊기거나 늦어 경로를 현재 안내로 표시하지 않습니다.</p>
      )}

      {startId !== null && !stale && journey !== null && (
        <>
          {journey.kind === "UNKNOWN_START" && (
            <p className="journey__alert">이 지점의 서버 경로가 없습니다. 다른 지점을 고르세요.</p>
          )}

          {journey.kind === "NO_ROUTE" && (
            <p className="journey__alert journey__alert--fire">
              <strong>{nodeLabel(journey.startId)}</strong>: 안내 불가 ·{" "}
              {journey.reasons.map((code) => ROUTE_REASON_LABEL[code]).join(" · ") || "사유 없음"}
              <br />
              출구까지 안전한 경로가 없습니다. 연기가 없는 쪽으로 피해 문을 닫고, 119에 위치를 알린 뒤 구조를 기다리세요.
              이 위치는 관제에 안내 불가로 표시됩니다. 사람이 있는지는 시스템이 알 수 없습니다.
              <br />
              <small>일반 행동요령이며 서버가 계산한 대피 경로가 아닙니다. 대피 공간 안내는 아직 지원하지 않습니다.</small>
            </p>
          )}

          {journey.kind === "ROUTE" && (
            <div className="journey__route">
              <h3>
                {nodeLabel(journey.startId)} → <span className="journey__exit">{journey.exitLabel}</span>
                <small> 안내 버전 {track?.guidanceVersion ?? "—"}</small>
              </h3>
              {journey.atExit ? (
                <p className="journey__note">선택한 지점이 출구입니다.</p>
              ) : (
                <ol className="journey__steps">
                  {journey.steps.map((step, index) => (
                    <li key={index} className={`journey__step journey__step--${step.kind.toLowerCase()}`}>
                      {step.kind === "WALK" && (
                        <>
                          <b>{step.floorLabel}</b> {withoutFloor(step.from, step.floorLabel)} → {withoutFloor(step.to, step.floorLabel)}
                          <small> · 지점 {step.stops}개 지남</small>
                        </>
                      )}
                      {step.kind === "STAIRS" && (
                        <>
                          <b>{step.stair}</b>로 {step.fromFloor} → {step.toFloor} {step.down ? "내려감" : "올라감"}
                        </>
                      )}
                      {step.kind === "EXIT" && (
                        <>
                          <b>{step.label}</b>로 나감
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {previous !== null && (
            <p className="journey__previous">
              <span className="journey__tag">비교용 · 현재 안내 아님</span> 직전 경로(안내 버전 {previous.guidanceVersion}):{" "}
              {previous.path.length === 0
                ? "안내 불가"
                : `${previous.path.map(nodeLabel).join(" → ")}${previous.exitId === null ? "" : ` (${display?.exit_labels[previous.exitId] ?? previous.exitId})`}`}
            </p>
          )}

          {journey.kind === "ROUTE" && journey.signs.length > 0 && (
            <table className="grid journey__signs">
              <thead>
                <tr>
                  <th>경로 위 유도등</th>
                  <th>표시면 안내</th>
                  <th>적용 상태</th>
                </tr>
              </thead>
              <tbody>
                {journey.signs.map((item) => (
                  <tr
                    key={item.signId}
                    className={item.signId === selectedSignId ? "journey__row journey__row--on" : "journey__row"}
                    onClick={() => onSelectSign(item.signId === selectedSignId ? null : item.signId)}
                  >
                    <td>
                      <span title={item.signId}>{item.label}</span>
                      <small className="location-detail">{item.exitLocation ? "출구 위치 표지" : "가변 방향 안내"}</small>
                    </td>
                    <td>
                      {item.faces.length === 0
                        ? "—"
                        : item.faces.map((face) => `${FACE_NAME[face.faceId] ?? face.faceId} ${faceText(face)}`).join(" · ")}
                    </td>
                    <td>
                      <span className={`badge badge--${item.status === null ? "muted" : STATUS_TONE[item.status]}`}>
                        {item.status === null ? "정보 없음" : APPLICATION_LABEL[item.status]}
                      </span>
                      <small className="location-detail">
                        {item.commandVersion === null
                          ? "명령 없음"
                          : `명령 버전 ${item.commandVersion}${item.current ? " (현재 안내)" : " (이전 안내)"}`}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

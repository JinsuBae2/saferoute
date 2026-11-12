/**
 * CCTV 추론 미리보기 (이슈 #74, P06).
 *
 * 고른 카메라의 프레임과 검출 영역을 보여주고, 그 카메라가 건물 어디에 달려 있는지 잇는다.
 * 검출 상자는 프레임 크기에 대한 비율로 그리므로 화면 크기가 달라져도 같은 자리에 붙는다.
 *
 * 여기서 화재를 판정하지 않는다. 상자가 보이는 것과 제어기의 경보는 별개이며,
 * 미리보기가 안 떠도 관제 상태·경로·유도등 표시는 그대로 둔다.
 */
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";

import {
  checkPreview,
  detectionBox,
  cameraSources,
  HAZARD_LABEL,
  PREVIEW_BLOCK_LABEL,
  PREVIEW_ERROR_LABEL,
  PREVIEW_STATUS_LABEL,
} from "./previewModel";
import { useCameraPreview } from "./useCameraPreview";

type Props = {
  readonly state: StateSnapshot;
  readonly building: Building | null;
  readonly display: BuildingDisplay | null;
  readonly selectedSourceId: string | null;
  readonly onSelect: (sourceId: string | null) => void;
  /** 3D에서 이 카메라의 설치 위치를 찾아 보여 달라는 요청. */
  readonly onLocate: (sourceId: string) => void;
};

const STATUS_TONE: Record<string, string> = {
  INITIALIZING: "muted",
  READY: "route",
  STALE: "warn",
  EOF: "muted",
  UNAVAILABLE: "fire",
};

export function CameraPreviewPanel({ state, building, display, selectedSourceId, onSelect, onLocate }: Props) {
  const cameras = cameraSources(building);
  const selected = cameras.find((camera) => camera.source_id === selectedSourceId) ?? null;
  const view = useCameraPreview(selected === null ? null : selected.source_id, state.run_id);
  const check = checkPreview(view.preview, state, selected === null ? null : selected.source_id);

  // 그림과 상자는 훅이 한 덩어리로 들고 있다. 늘 같은 프레임이고, 지워질 때도 함께 사라진다.
  const shown = check.usable ? view.shown : null;
  const frame = shown?.frame ?? null;

  const sourceDisplay = selected === null ? null : display?.sources[selected.source_id] ?? null;
  const installation = sourceDisplay?.installation ?? null;
  const validity = selected === null
    ? null
    : state.sources.find((source) => source.source_id === selected.source_id)?.validity ?? null;

  return (
    <section className="panel">
      <header className="panel__head">
        <h3>입력 영상의 검출 결과</h3>
        <span className="panel__note">
          검출 상자의 %는 해당 프레임에서 모델이 보고한 신뢰도입니다.
        </span>
      </header>

      {cameras.length === 0 ? (
        <p className="panel__empty">
          등록된 영상 관측원이 없습니다.
          <br />
          관측원 상태와 경로는 아래 제어 결과로 계속 표시됩니다.
        </p>
      ) : (
        <>
          <div className="camera__picker">
            {cameras.map((camera) => {
              const picked = camera.source_id === selectedSourceId;
              return (
                <button
                  key={camera.source_id}
                  type="button"
                  className={picked ? "chip chip--on" : "chip"}
                  aria-pressed={picked}
                  title={camera.source_id}
                  onClick={() => onSelect(picked ? null : camera.source_id)}
                >
                  {display?.sources[camera.source_id]?.label ?? camera.source_id}
                </button>
              );
            })}
          </div>

          {selected === null ? (
            <p className="panel__empty">{PREVIEW_BLOCK_LABEL.NOT_SELECTED}</p>
          ) : (
            <div className="camera">
              <div className="camera__stage">
                {shown === null ? (
                  <p className="camera__blank">
                    {check.usable
                      ? "프레임을 받는 중입니다."
                      : check.reason === "NOT_READY" && view.preview
                        ? PREVIEW_STATUS_LABEL[view.preview.status]
                        : PREVIEW_BLOCK_LABEL[check.reason]}
                    {view.preview?.error_code != null && ` — ${PREVIEW_ERROR_LABEL[view.preview.error_code]}`}
                    {view.error !== null && ` (${view.error})`}
                  </p>
                ) : (
                  <div
                    className="camera__frame"
                    style={{ aspectRatio: `${shown.frame.width} / ${shown.frame.height}` }}
                  >
                    <img src={shown.url} alt={`${sourceDisplay?.label ?? selected.source_id} 추론 미리보기`} />
                    {shown.frame.detections.map((detection, index) => {
                      const box = detectionBox(detection);
                      if (box === null) return null;
                      return (
                        <span
                          key={`${detection.hazard_type}:${index}`}
                          className={`camera__box camera__box--${detection.hazard_type.toLowerCase()}`}
                          style={{
                            left: `${box.leftPercent}%`,
                            top: `${box.topPercent}%`,
                            width: `${box.widthPercent}%`,
                            height: `${box.heightPercent}%`,
                          }}
                        >
                          <span className="camera__box-label">
                            {HAZARD_LABEL[detection.hazard_type]} · 신뢰도 {(detection.confidence * 100).toFixed(0)}%
                          </span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <dl className="camera__facts">
                <div>
                  <dt>카메라</dt>
                  <dd title={selected.source_id}>{sourceDisplay?.label ?? selected.source_id}</dd>
                </div>
                <div>
                  <dt>설치 위치</dt>
                  <dd>
                    {installation === null
                      ? "미확인"
                      : `${display?.floor_labels[installation.floor_id] ?? installation.floor_id} · ${
                          installation.basis === "SIMULATED" ? "가상 설치 위치" : "실측 설치 위치"
                        }`}
                    {installation !== null && (
                      <button type="button" className="chip camera__locate" onClick={() => onLocate(selected.source_id)}>
                        3D에서 찾기
                      </button>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>관측 구역</dt>
                  <dd title={selected.zone_id}>
                    {display?.zone_labels[selected.zone_id] ?? selected.zone_id}
                    <small className="location-detail">설치 위치와 다를 수 있습니다</small>
                  </dd>
                </div>
                <div>
                  <dt>미리보기</dt>
                  <dd>
                    <span
                      className={`badge badge--${
                        view.preview === null ? "muted" : STATUS_TONE[view.preview.status] ?? "muted"
                      }`}
                    >
                      {view.preview === null ? "조회 중" : PREVIEW_STATUS_LABEL[view.preview.status]}
                    </span>
                    {view.preview?.error_code != null && (
                      <small className="location-detail">{PREVIEW_ERROR_LABEL[view.preview.error_code]}</small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>프레임 시각</dt>
                  <dd className="grid__dim">
                    {frame === null ? "—" : frame.observed_at}
                    {frame !== null && (
                      <small className="location-detail">
                        {frame.frame_index}번째 · 영상 {(frame.media_time_ms / 1000).toFixed(1)}초 · 추론 완료{" "}
                        {frame.inference_completed_at}
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>검출</dt>
                  <dd>
                    {frame === null
                      ? "—"
                      : frame.detections.length === 0
                        ? "이 프레임에서는 없음"
                        : frame.detections
                            .map(
                              (detection) =>
                                `${HAZARD_LABEL[detection.hazard_type]} ${(detection.confidence * 100).toFixed(0)}%`,
                            )
                            .join(" · ")}
                    <small className="location-detail">모델 결과입니다. 경보 판정 근거가 아닙니다</small>
                  </dd>
                </div>
                <div>
                  <dt>관측원 유효성</dt>
                  <dd>
                    {validity ?? "—"}
                    <small className="location-detail">미리보기 상태와 별개입니다</small>
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import type { StateSnapshot } from "@contracts";
import { checkPreview, detectionBox, HAZARD_LABEL, PREVIEW_BLOCK_LABEL, PREVIEW_ERROR_LABEL, PREVIEW_STATUS_LABEL } from "./previewModel";
import { useCameraPreview } from "./useCameraPreview";

export function CameraPreviewPanel({ state, sourceId }: { state: StateSnapshot; sourceId: string }) {
  const view = useCameraPreview(sourceId, state.run_id);
  const check = checkPreview(view.preview, state, sourceId);
  const shown = check.usable ? view.shown : null;
  const preview = view.preview;
  if (!shown) {
    const message = !preview ? "분석 프레임을 기다리는 중입니다." :
      preview.error_code ? PREVIEW_ERROR_LABEL[preview.error_code] :
      !check.usable && check.reason !== "NOT_READY" ? PREVIEW_BLOCK_LABEL[check.reason] : PREVIEW_STATUS_LABEL[preview.status];
    return <p className="camera__blank">{message}{view.error && ` · ${view.error}`}</p>;
  }
  return <div className="camera">
    <div className="camera__stage">
      <div
        className="camera__frame"
        style={{ aspectRatio: `${shown.frame.width} / ${shown.frame.height}` }}
      >
        <img src={shown.url} alt="예시 영상의 AI 검출 결과" />
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
    </div>
    <p className="panel__note">영상 {(shown.frame.media_time_ms / 1000).toFixed(1)}초 · 검출 {shown.frame.detections.length}개 · 상자의 %는 모델이 보고한 신뢰도입니다.</p>
  </div>;
}

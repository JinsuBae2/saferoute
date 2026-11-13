import type { Preview } from "@contracts";
import { detectionBox, HAZARD_LABEL } from "./previewModel";

type Frame = NonNullable<Preview["frame"]>;

export function CameraPreviewPanel({ frame, url }: { frame: Frame; url: string }) {
  return <div className="camera">
    <div className="camera__stage">
      <div
        className="camera__frame"
        style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
      >
        <img src={url} alt="예시 영상의 AI 검출 결과" />
        {frame.detections.map((detection, index) => {
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
    <p className="panel__note">영상 {(frame.media_time_ms / 1000).toFixed(1)}초 · 검출 {frame.detections.length}개 · 상자의 %는 모델이 보고한 신뢰도입니다.</p>
  </div>;
}

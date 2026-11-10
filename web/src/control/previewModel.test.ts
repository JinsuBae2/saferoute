/**
 * CCTV 미리보기 표시 판정 시험 (이슈 #74, P06).
 * 입력은 2번이 생성한 공통 샘플(contracts/samples.generated.ts)이다.
 */
import { describe, expect, it } from "vitest";

import type { Preview, StateSnapshot } from "@contracts";
import {
  emergency_state as stateSample,
  preview_eof as eofSample,
  preview_no_detections as noDetectionSample,
  preview_ready as readySample,
  preview_stale as staleSample,
  preview_unavailable as unavailableSample,
} from "@samples";

import {
  cameraSources,
  checkPreview,
  detectionBox,
  holdFrame,
  frameDeadline,
} from "./previewModel";

const STATE: StateSnapshot = stateSample;
const READY: Preview = readySample;
const SOURCE = READY.source_id;

function ready(patch: Partial<Preview>): Preview {
  return { ...READY, ...patch };
}

describe("표시 가능 판정", () => {
  it("같은 실행·건물·카메라의 READY만 표시한다", () => {
    const check = checkPreview(READY, STATE, SOURCE);
    expect(check.usable).toBe(true);
  });

  it("카메라를 고르지 않았으면 표시하지 않는다", () => {
    expect(checkPreview(READY, STATE, null)).toEqual({ usable: false, reason: "NOT_SELECTED" });
  });

  it("아직 받지 못했으면 표시하지 않는다", () => {
    expect(checkPreview(null, STATE, SOURCE)).toEqual({ usable: false, reason: "NOT_LOADED" });
  });

  it("지난 실행의 미리보기는 거부한다", () => {
    const other = ready({ run_id: "99999999-9999-4999-8999-999999999999" });
    expect(checkPreview(other, STATE, SOURCE)).toEqual({ usable: false, reason: "RUN_MISMATCH" });
  });

  it("건물 자료 버전이 다르면 거부한다", () => {
    const other = ready({ building_version: STATE.building_version + 1 });
    expect(checkPreview(other, STATE, SOURCE)).toEqual({
      usable: false,
      reason: "BUILDING_MISMATCH",
    });
  });

  it("고른 카메라와 다르면 거부한다", () => {
    expect(checkPreview(READY, STATE, "CAM-OTHER")).toEqual({
      usable: false,
      reason: "SOURCE_MISMATCH",
    });
  });

  it("준비 중·오래됨·영상 종료·제공 불가는 프레임을 띄우지 않는다", () => {
    for (const sample of [staleSample, eofSample, unavailableSample] as Preview[]) {
      const check = checkPreview(sample, STATE, sample.source_id);
      expect(check.usable).toBe(false);
    }
  });

  it("검출이 없는 READY도 프레임은 표시한다", () => {
    const check = checkPreview(noDetectionSample as Preview, STATE, SOURCE);
    expect(check.usable).toBe(true);
    if (check.usable) expect(check.frame.detections).toEqual([]);
  });
});

describe("프레임 기한", () => {
  const expires = "2026-11-10T01:00:03.000Z";
  const serverTime = "2026-11-10T01:00:00.200Z";

  it("서버 시각 차이에서 왕복 시간을 뺀다", () => {
    // 남은 2800ms에서 왕복 200ms를 뺀 2600ms 뒤가 기한이다.
    expect(frameDeadline(expires, serverTime, 1_000, 1_200, 3_000)).toBe(1_200 + 2_600);
  });

  it("이미 지났으면 표시하지 않는다", () => {
    expect(frameDeadline(serverTime, expires, 1_000, 1_100, 3_000)).toBeNull();
  });

  it("서버가 알려준 유효기간보다 길게 잡지 않는다", () => {
    expect(frameDeadline(expires, serverTime, 1_000, 1_200, 1_000)).toBeNull();
  });

  it("시각을 읽지 못하면 표시하지 않는다", () => {
    expect(frameDeadline("언제인지 모름", serverTime, 1_000, 1_200, 3_000)).toBeNull();
    expect(frameDeadline(expires, "언제인지 모름", 1_000, 1_200, 3_000)).toBeNull();
  });

  it("받은 시각이 보낸 시각보다 앞서면 표시하지 않는다", () => {
    expect(frameDeadline(expires, serverTime, 1_200, 1_000, 3_000)).toBeNull();
  });
});

describe("검출 영역", () => {
  function detection(xyxy: number[]) {
    return { hazard_type: "FIRE" as const, confidence: 0.8, xyxy };
  }

  it("정규화 좌표를 비율 상자로 바꾼다", () => {
    expect(detectionBox(detection([0.25, 0.25, 0.5, 0.75]))).toEqual({
      leftPercent: 25,
      topPercent: 25,
      widthPercent: 25,
      heightPercent: 50,
    });
  });

  it("뒤집힌 좌표를 바로잡는다", () => {
    expect(detectionBox(detection([0.5, 0.75, 0.25, 0.25]))).toEqual(
      detectionBox(detection([0.25, 0.25, 0.5, 0.75])),
    );
  });

  it("화면 밖은 잘라낸다", () => {
    const box = detectionBox(detection([-0.5, -0.5, 1.5, 1.5]));
    expect(box).toEqual({ leftPercent: 0, topPercent: 0, widthPercent: 100, heightPercent: 100 });
  });

  it("넓이가 없거나 좌표가 올바르지 않으면 그리지 않는다", () => {
    expect(detectionBox(detection([0.5, 0.5, 0.5, 0.5]))).toBeNull();
    expect(detectionBox(detection([0, 0, 1]))).toBeNull();
    expect(detectionBox(detection([0, 0, Number.NaN, 1]))).toBeNull();
  });
});

describe("카메라 목록", () => {
  it("영상 관측원만 고른다", () => {
    const building = {
      sources: [
        { source_id: "CAM-A", source_type: "VIDEO_AI" },
        { source_id: "DETECTOR-A", source_type: "SIM_SMOKE_DETECTOR" },
      ],
    } as unknown as Parameters<typeof cameraSources>[0];
    expect(cameraSources(building).map((source) => source.source_id)).toEqual(["CAM-A"]);
  });

  it("공간 자료가 없으면 빈 목록이다", () => {
    expect(cameraSources(null)).toEqual([]);
  });
});

describe("보여주던 프레임 유지", () => {
  const usable = checkPreview(READY, STATE, SOURCE).usable;

  it("기한 안이면 계속 보여준다", () => {
    expect(holdFrame(usable, 2_000, 1_900)).toBe("SHOW");
  });

  it("더 새 프레임이 왔다는 것만으로는 지우지 않는다", () => {
    // 미리보기 정보가 그림보다 먼저 도착하는 그 사이에도 화면이 비지 않아야 한다.
    const newer = checkPreview(
      ready({ frame: { ...READY.frame!, frame_id: "다음-프레임" } }),
      STATE,
      SOURCE,
    ).usable;
    expect(holdFrame(newer, 2_000, 1_900)).toBe("SHOW");
  });

  it("기한이 지나면 지운다", () => {
    expect(holdFrame(usable, 2_000, 2_000)).toBe("EXPIRED");
    expect(holdFrame(usable, null, 1_900)).toBe("EXPIRED");
  });

  it("띄우면 안 되는 상태면 지운다", () => {
    expect(holdFrame(checkPreview(staleSample as Preview, STATE, SOURCE).usable, 9_999, 0)).toBe("BLOCKED");
    expect(holdFrame(checkPreview(READY, STATE, "CAM-OTHER").usable, 9_999, 0)).toBe("BLOCKED");
  });
});

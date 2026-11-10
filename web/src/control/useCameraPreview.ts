/**
 * 고른 카메라의 추론 미리보기를 받아온다 (이슈 #74, P06).
 *
 * 미리보기는 제어기와 다른 프로세스(preview_worker)다. 꺼져 있거나 늦어도
 * 관제 상태·경로·유도등 표시는 그대로 돌아야 하므로 자체 반복 조회를 쓴다.
 *
 * 오래된 프레임이 실시간 영상처럼 남지 않게 하는 것이 이 훅의 핵심이다.
 * - 기한이 지나면 조회 성공 여부와 상관없이 그림과 검출 상자를 함께 지운다.
 * - 실행·카메라가 바뀌면 받아둔 것을 먼저 버리고 새로 받는다.
 */
import { useEffect, useState } from "react";

import type { Preview } from "@contracts";

import { ApiError, fetchPreview, fetchPreviewFrame } from "../api/client";
import { frameDeadline } from "./previewModel";
import { startPolling } from "./poll";

const POLL_INTERVAL_MS = 700;

export type CameraPreview = {
  readonly preview: Preview | null;
  /** 지금 화면에 띄워도 되는 그림. 기한이 지나면 null이 된다. */
  readonly imageUrl: string | null;
  /** imageUrl이 어느 프레임의 것인지. 검출 상자를 같은 프레임에만 그리기 위해 쓴다. */
  readonly imageFrameId: string | null;
  readonly error: string | null;
};

const EMPTY: CameraPreview = { preview: null, imageUrl: null, imageFrameId: null, error: null };

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code === null ? `HTTP ${error.status}` : `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "미리보기를 읽지 못했습니다";
}

export function useCameraPreview(sourceId: string | null, runId: string | null): CameraPreview {
  const [view, setView] = useState<CameraPreview>(EMPTY);

  useEffect(() => {
    // 카메라나 실행이 바뀌면 이전 결과를 먼저 버린다.
    setView(EMPTY);
    if (sourceId === null || runId === null) return;

    let preview: Preview | null = null;
    let error: string | null = null;
    let imageUrl: string | null = null;
    let imageFrameId: string | null = null;
    let deadlineMs: number | null = null;
    /** 지금 받는 중인 프레임. 같은 프레임을 두 번 받지 않는다. */
    let fetching: string | null = null;
    let stopped = false;

    const frameAbort = new AbortController();

    const dropImage = () => {
      if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
      imageUrl = null;
      imageFrameId = null;
      deadlineMs = null;
    };

    const publish = () => {
      if (stopped) return;
      // 기한이 지난 그림은 조회가 멀쩡해도 지운다.
      if (deadlineMs !== null && performance.now() >= deadlineMs) dropImage();
      setView({ preview, imageUrl, imageFrameId, error });
    };

    async function loadFrame(frameId: string, startedMs: number) {
      fetching = frameId;
      try {
        const image = await fetchPreviewFrame(frameId, runId!, sourceId!, frameAbort.signal);
        const receivedMs = performance.now();
        const current = preview;
        const frame = current?.frame ?? null;
        const stale =
          stopped ||
          current === null ||
          frame === null ||
          frame.frame_id !== frameId ||
          current.run_id !== runId ||
          current.source_id !== sourceId ||
          // 헤더가 다른 프레임을 가리키면 쓰지 않는다 (A06 인계 문서 2번).
          (image.frameId !== null && image.frameId !== frameId);
        if (stale || current === null || frame === null) {
          URL.revokeObjectURL(image.objectUrl);
          return;
        }
        const until = frameDeadline(
          frame.expires_at,
          current.generated_at,
          startedMs,
          receivedMs,
          current.freshness_ms,
        );
        if (until === null) {
          // 도착했을 때 이미 늦은 프레임은 띄우지 않는다.
          URL.revokeObjectURL(image.objectUrl);
          return;
        }
        dropImage();
        imageUrl = image.objectUrl;
        imageFrameId = frameId;
        deadlineMs = until;
        publish();
      } catch {
        // 다음 프레임으로 교체된 frame_id의 404는 정상이다. 다음 조회에서 새 frame_id를 받는다.
      } finally {
        if (fetching === frameId) fetching = null;
      }
    }

    const stop = startPolling(
      (signal) => fetchPreview(sourceId, runId, signal),
      (value) => {
        preview = value;
        error = null;
        const frame = value.frame;
        const usable =
          frame !== null && value.status === "READY" && value.run_id === runId && value.source_id === sourceId;
        if (!usable) {
          // 준비 중·오래됨·종료·장애에서는 이전 그림을 남기지 않는다.
          dropImage();
        } else if (frame.frame_id !== imageFrameId && frame.frame_id !== fetching) {
          void loadFrame(frame.frame_id, performance.now());
        }
        publish();
      },
      (reason) => {
        error = messageOf(reason);
        dropImage();
        publish();
      },
      POLL_INTERVAL_MS,
    );

    // 조회가 멈춰도 기한은 지나간다. 짧게 확인해 늦은 그림을 지운다.
    const clock = setInterval(publish, 200);

    return () => {
      stopped = true;
      stop();
      frameAbort.abort();
      clearInterval(clock);
      if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
    };
  }, [sourceId, runId]);

  return view;
}

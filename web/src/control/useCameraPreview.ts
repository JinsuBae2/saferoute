/**
 * 고른 카메라의 추론 미리보기를 받아온다 (이슈 #74, P06).
 *
 * 미리보기는 제어기와 다른 프로세스(preview_worker)다. 꺼져 있거나 늦어도
 * 관제 상태·경로·유도등 표시는 그대로 돌아야 하므로 자체 반복 조회를 쓴다.
 *
 * 오래된 프레임이 실시간 영상처럼 남지 않게 하는 것이 이 훅의 핵심이다.
 * - 기한이 지나면 조회 성공 여부와 상관없이 그림과 검출 상자를 함께 지운다.
 * - 실행·카메라가 바뀌면 받아둔 것을 먼저 버리고 새로 받는다.
 *
 * 그러면서도 화면이 깜빡이지 않아야 한다. 미리보기 정보는 그림보다 먼저 도착하므로,
 * "더 새 프레임이 있다"는 것만으로 비우면 받을 때마다 화면이 비었다 찬다.
 * 그래서 그림과 프레임을 한 덩어리로 들고, 새 그림을 다 그릴 수 있게 된 뒤에 통째로 바꾼다.
 */
import { useEffect, useState } from "react";

import type { Preview } from "@contracts";

import { ApiError, fetchPreview, fetchPreviewFrame } from "../api/client";
import { frameDeadline, holdFrame } from "./previewModel";
import { startPolling } from "./poll";

const POLL_INTERVAL_MS = 700;

/** 화면에 띄우는 그림과 그 그림의 프레임. 둘은 언제나 같은 프레임이며 함께 바뀐다. */
export type ShownFrame = {
  readonly url: string;
  readonly frame: NonNullable<Preview["frame"]>;
};

export type CameraPreview = {
  readonly preview: Preview | null;
  readonly shown: ShownFrame | null;
  readonly error: string | null;
};

const EMPTY: CameraPreview = { preview: null, shown: null, error: null };

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code === null ? `HTTP ${error.status}` : `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "미리보기를 읽지 못했습니다";
}

/**
 * 그림이 그려질 준비가 될 때까지 기다린다.
 * 해독이 끝나기 전에 바꿔 달면 그 사이가 빈칸으로 보인다.
 * decode를 쓸 수 없는 환경에서는 그냥 넘어간다. 조금 깜빡일 뿐 화면이 멈추지는 않는다.
 */
async function drawable(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode !== "function") return;
  try {
    await image.decode();
  } catch {
    // 못 읽는 그림이면 어차피 아래에서 걸러진다.
  }
}

export function useCameraPreview(sourceId: string | null, runId: string | null): CameraPreview {
  const [view, setView] = useState<CameraPreview>(EMPTY);

  useEffect(() => {
    // 카메라나 실행이 바뀌면 이전 결과를 먼저 버린다.
    setView(EMPTY);
    if (sourceId === null || runId === null) return;

    let preview: Preview | null = null;
    let error: string | null = null;
    let shown: ShownFrame | null = null;
    let deadlineMs: number | null = null;
    /** 마지막 조회에서 이 카메라의 READY 프레임을 받았는지. 아니면 보여주던 것을 지운다. */
    let usable = false;
    /** 지금 받는 중인 프레임. 같은 프레임을 두 번 받지 않는다. */
    let fetching: string | null = null;
    /**
     * 방금 교체되어 물러난 그림 주소. 바꾸자마자 돌려주면 그 순간 화면이 빈다.
     * 다음 교체나 정리 때 돌려주므로, 살아 있는 임시 주소는 많아야 두 개다.
     */
    let retired: string | null = null;
    let published: CameraPreview = EMPTY;
    let stopped = false;

    const frameAbort = new AbortController();

    const retire = (url: string | null) => {
      if (retired !== null && retired !== url) URL.revokeObjectURL(retired);
      retired = url;
    };

    const drop = () => {
      retire(shown?.url ?? null);
      shown = null;
      deadlineMs = null;
    };

    const publish = () => {
      if (stopped) return;
      if (shown !== null && holdFrame(usable, deadlineMs, performance.now()) !== "SHOW") drop();
      // 바뀐 것이 없으면 다시 그리지 않는다. 200ms 시계가 화면을 들썩이게 하면 안 된다.
      if (preview === published.preview && shown === published.shown && error === published.error) return;
      published = { preview, shown, error };
      setView(published);
    };

    async function loadFrame(frameId: string, startedMs: number) {
      fetching = frameId;
      try {
        const image = await fetchPreviewFrame(frameId, runId!, sourceId!, frameAbort.signal);
        const receivedMs = performance.now();
        const current = preview;
        const frame = current?.frame ?? null;
        const unusable =
          stopped ||
          current === null ||
          frame === null ||
          frame.frame_id !== frameId ||
          current.run_id !== runId ||
          current.source_id !== sourceId ||
          // 헤더가 다른 프레임을 가리키면 쓰지 않는다 (A06 인계 문서 2번).
          (image.frameId !== null && image.frameId !== frameId);
        if (unusable || current === null || frame === null) {
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

        await drawable(image.objectUrl);
        // 기다리는 동안 기한이 지났거나 화면이 닫혔을 수 있다.
        if (stopped || performance.now() >= until) {
          URL.revokeObjectURL(image.objectUrl);
          return;
        }

        const previous = shown;
        shown = { url: image.objectUrl, frame };
        deadlineMs = until;
        publish();
        retire(previous?.url ?? null);
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
        usable =
          frame !== null && value.status === "READY" && value.run_id === runId && value.source_id === sourceId;
        // 준비 중·오래됨·종료·장애면 publish가 보여주던 것을 지운다.
        if (usable && frame !== null && frame.frame_id !== shown?.frame.frame_id && frame.frame_id !== fetching) {
          void loadFrame(frame.frame_id, performance.now());
        }
        publish();
      },
      (reason) => {
        error = messageOf(reason);
        usable = false;
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
      if (shown !== null) URL.revokeObjectURL(shown.url);
      if (retired !== null) URL.revokeObjectURL(retired);
    };
  }, [sourceId, runId]);

  return view;
}

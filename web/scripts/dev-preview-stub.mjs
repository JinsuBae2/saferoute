/**
 * 개발용 CCTV 미리보기 생산자 (이슈 #74).
 *
 * preview_worker는 저장·조회만 한다. 프레임은 영상을 추론하는 생산자가
 * /internal/preview 로 밀어 넣어야 한다. 실제 생산자(ai_worker)와 영상이 없는 자리에서
 * 관제 화면을 확인하려고 쓰는 시험용 대역이다. 제품 코드가 아니다.
 *
 * 실제 추론 결과가 아니다. 그림에도 "시험용"이라고 적혀 있다.
 *
 *   node scripts/dev-preview-stub.mjs           프레임을 계속 밀어 넣는다
 *   node scripts/dev-preview-stub.mjs eof       영상 종료로 끝낸다
 *   node scripts/dev-preview-stub.mjs fail      영상 열기 실패로 끝낸다
 *   node scripts/dev-preview-stub.mjs once      한 장만 넣고 멈춘다(기한이 지나는 것을 본다)
 *
 * 환경 변수: SAFEROUTE_API(기본 8000), SAFEROUTE_PREVIEW_API(기본 8003)
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CONTROL = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";
const PREVIEW = process.env.SAFEROUTE_PREVIEW_API ?? "http://127.0.0.1:8003";
const MODE = process.argv[2] ?? "run";
const PERIOD_MS = 500;

// 시험용 프레임 한 장. 영상이 없으므로 같은 그림을 계속 쓰고 검출 상자만 움직인다.
const FRAME_PATH = new URL("./dev-preview-frame.jpg", import.meta.url);
const JPEG_BASE64 = readFileSync(FRAME_PATH).toString("base64");

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1Z");
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

async function push(body) {
  const response = await fetch(`${PREVIEW}/internal/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return true;
  const text = await response.text();
  console.error(`밀어 넣기 실패 HTTP ${response.status}: ${text.slice(0, 200)}`);
  return false;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round = (value) => Math.round(clamp01(value) * 1000) / 1000;
/** 0~1을 벗어나거나 뒤집힌 상자는 서버가 거부한다. */
const box = (x1, y1, x2, y2) => [round(x1), round(y1), round(x2), round(y2)];

/** 프레임마다 조금씩 옮겨 다니는 시험용 검출. 정규화 xyxy(0~1)다. */
function detections(step) {
  const drift = Math.sin(step / 6) * 0.06;
  return [
    { hazard_type: "FIRE", confidence: round(0.72 + Math.sin(step / 9) * 0.12), xyxy: box(0.56 + drift, 0.58, 0.80 + drift, 0.82) },
    { hazard_type: "SMOKE", confidence: round(0.54 + Math.cos(step / 7) * 0.1), xyxy: box(0.46 + drift, 0.26, 0.92 + drift, 0.66) },
  ];
}

function previewOf(state, source, status, frame, errorCode) {
  return {
    schema_version: 1,
    building_id: state.building_id,
    building_version: state.building_version,
    run_id: state.run_id,
    source_id: source.source_id,
    // 서버가 "미래 시각"으로 거부하지 않도록 조금 앞선 시각을 쓰지 않는다.
    generated_at: iso(Date.now() - 50),
    freshness_ms: source.freshness_ms,
    status,
    frame,
    error_code: errorCode,
  };
}

async function main() {
  const [state, building] = await Promise.all([
    readJson(`${CONTROL}/api/state`),
    readJson(`${CONTROL}/api/building`),
  ]);
  const cameras = building.sources.filter((source) => source.source_type === "VIDEO_AI");
  if (cameras.length === 0) {
    console.error("영상 관측원이 없습니다. 건물 자료를 확인하세요.");
    process.exitCode = 1;
    return;
  }
  console.log(`실행 ${state.run_id} · 카메라 ${cameras.map((camera) => camera.source_id).join(", ")}`);

  // 서버는 순번과 프레임 번호가 늘어나야만 받는다. 이 스크립트를 다시 실행해도
  // 이전 실행보다 큰 값이 되도록 시각에서 뽑아 시작한다.
  const seed = Math.floor(Date.now() / 100) % 100_000_000;
  const sequence = new Map(cameras.map((camera) => [camera.source_id, seed]));
  const index = new Map(cameras.map((camera) => [camera.source_id, seed]));

  if (MODE === "eof" || MODE === "fail") {
    for (const camera of cameras) {
      const status = MODE === "eof" ? "EOF" : "UNAVAILABLE";
      const errorCode = MODE === "eof" ? null : "VIDEO_OPEN_FAILED";
      await push({
        sequence: sequence.get(camera.source_id) + 1,
        preview: previewOf(state, camera, status, null, errorCode),
        jpeg_base64: null,
      });
    }
    console.log(`${MODE} 로 끝냈습니다. 되돌리려면 관제에서 초기화하세요.`);
    return;
  }

  let step = 0;
  const tick = async () => {
    const now = Date.now();
    for (const camera of cameras) {
      const next = (index.get(camera.source_id) ?? 0) + 1;
      index.set(camera.source_id, next);
      sequence.set(camera.source_id, (sequence.get(camera.source_id) ?? 0) + 1);
      const frame = {
        // frame_id는 UUID여야 한다(contracts/previews.py).
        frame_id: randomUUID(),
        frame_index: next,
        media_time_ms: next * PERIOD_MS,
        observed_at: iso(now - 120),
        inference_completed_at: iso(now - 60),
        // 유효기간은 관측 시각부터 센다. 추론이 끝난 때부터 다시 시작하면 서버가 거부한다.
        expires_at: iso(now - 120 + camera.freshness_ms),
        width: 640,
        height: 360,
        detections: detections(step),
      };
      const ok = await push({
        sequence: sequence.get(camera.source_id),
        preview: previewOf(state, camera, "READY", frame, null),
        jpeg_base64: JPEG_BASE64,
      });
      if (!ok) return false;
    }
    step += 1;
    return true;
  };

  if (!(await tick())) return;
  if (MODE === "once") {
    console.log("한 장만 넣었습니다. 기한이 지나면 화면에서 사라져야 합니다.");
    return;
  }
  console.log(`${PERIOD_MS}ms마다 넣습니다. Ctrl+C로 멈춥니다.`);
  const timer = setInterval(() => {
    void tick().then((ok) => {
      if (!ok) clearInterval(timer);
    });
  }, PERIOD_MS);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

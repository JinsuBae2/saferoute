/**
 * 개발용 CCTV 미리보기 생산자 (이슈 #74).
 *
 * preview_worker는 저장·조회만 한다. 프레임은 영상을 추론하는 생산자가
 * /internal/preview 로 밀어 넣어야 한다. 실제 생산자(ai_worker)와 영상이 없는 자리에서
 * 관제 화면을 확인하려고 쓰는 시험용 대역이다. 제품 코드가 아니다.
 *
 * 실제 추론 결과가 아니다. 그림에도 "시험용"이라고 적혀 있다.
 *
 * 검출값은 카메라마다 다르다. 제어기가 확정한 화재 구역을 보는 카메라에만 불꽃이 잡히고,
 * 연기는 공용 모형(dev-smoke-model.mjs)이 그 구역까지 번졌을 때부터 잡힌다.
 * 3D에 차오르는 연기와 같은 모형이라 두 화면이 서로 어긋나지 않는다.
 *
 * 제어기가 잠깐 느리거나 순번이 엇갈려도 멈추지 않고 다음 주기에 다시 보낸다.
 * 한 번 실패했다고 멈추면 화면이 그대로 비어버린다.
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

import { fireZones, smokeAt } from "./dev-smoke-model.mjs";

const CONTROL = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";
const PREVIEW = process.env.SAFEROUTE_PREVIEW_API ?? "http://127.0.0.1:8003";
const MODE = process.argv[2] ?? "run";
const PERIOD_MS = 800;

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

/**
 * 밀어 넣기 결과.
 * - "ok"    받아들여졌다
 * - "retry" 이번만 안 된 것이다. 제어기가 잠깐 느리거나(503) 순번이 엇갈렸다(409).
 *           다음 주기에 다시 보내면 된다. 여기서 멈추면 화면이 그대로 비어버린다.
 * - "stop"  이 스크립트가 잘못 만든 요청이다(422). 다시 보내도 같다.
 */
async function push(body) {
  let response;
  try {
    response = await fetch(`${PREVIEW}/internal/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    report(`미리보기 서버에 닿지 못했습니다: ${error.message}`);
    return "retry";
  }
  if (response.status === 204) return "ok";
  const text = await response.text();
  if (response.status === 422 || response.status === 413) {
    console.error(`요청이 잘못되었습니다 HTTP ${response.status}: ${text.slice(0, 200)}`);
    return "stop";
  }
  report(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return "retry";
}

/** 같은 실패가 이어질 때 화면을 로그로 덮지 않도록 가끔만 적는다. */
let lastReport = { text: "", atMs: 0, count: 0 };
function report(text) {
  const now = Date.now();
  lastReport.count += 1;
  if (text === lastReport.text && now - lastReport.atMs < 10_000) return;
  const repeated = lastReport.count > 1 && text === lastReport.text ? ` (${lastReport.count}번째)` : "";
  console.error(`잠시 건너뜁니다 — ${text}${repeated}`);
  lastReport = { text, atMs: now, count: 1 };
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round = (value) => Math.round(clamp01(value) * 1000) / 1000;
/** 0~1을 벗어나거나 뒤집힌 상자는 서버가 거부한다. */
const box = (x1, y1, x2, y2) => [round(x1), round(y1), round(x2), round(y2)];

/**
 * 그 카메라가 지금 볼 만한 검출. 정규화 xyxy(0~1)다.
 *
 * 카메라마다 다르게 나와야 한다. 불이 난 구역을 보는 카메라에만 불꽃이 잡히고,
 * 연기는 공용 모형(dev-smoke-model)이 그 구역까지 번졌을 때부터 잡힌다.
 * 그래서 3D에 차오르는 연기와 카메라가 말하는 퍼센트가 서로 맞는다.
 *
 * 불이 없으면 빈 목록이다. 검출이 없는 것도 정상 상태다.
 */
function detections(camera, building, started, nowMs, step) {
  const burning = started.has(camera.zone_id);
  const smoke = smokeAt(building, started, camera.zone_id, nowMs);
  const found = [];
  const drift = Math.sin(step / 6) * 0.05;

  if (burning) {
    // 불난 구역을 보는 카메라. 시간이 지날수록 또렷해진다.
    const age = (nowMs - started.get(camera.zone_id)) / 20_000;
    // 흔들림은 아주 작게 둔다. 크게 흔들면 값이 떨어지는 것처럼 읽힌다.
    const confidence = 0.55 + Math.min(0.35, Math.max(0, age) * 0.35) + Math.sin(step / 9) * 0.015;
    found.push({
      hazard_type: "FIRE",
      confidence: round(confidence),
      xyxy: box(0.56 + drift, 0.58, 0.80 + drift, 0.82),
    });
  }

  if (smoke >= 0.05) {
    // 연기가 짙을수록 신뢰도가 오르고 상자가 위로 커진다.
    // 흔들림을 섞지 않는다. 연기가 쌓이는 중에 값이 오르내리면 줄어드는 것처럼 보인다.
    const confidence = 0.3 + smoke * 0.65;
    const top = 0.62 - smoke * 0.38;
    found.push({
      hazard_type: "SMOKE",
      confidence: round(confidence),
      xyxy: box(0.46 + drift, top, 0.92 + drift, 0.68),
    });
  }

  return found;
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
  let [state, building] = await Promise.all([
    readJson(`${CONTROL}/api/state`),
    readJson(`${CONTROL}/api/building`),
  ]);
  let cameras = building.sources.filter((source) => source.source_type === "VIDEO_AI");
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
        sequence: (sequence.get(camera.source_id) ?? 0) + 1,
        preview: previewOf(state, camera, status, null, errorCode),
        jpeg_base64: null,
      });
    }
    console.log(`${MODE} 로 끝냈습니다. 되돌리려면 관제에서 초기화하세요.`);
    return;
  }

  let step = 0;
  const tick = async () => {
    // 실행이나 화재 상황이 바뀌었을 수 있으므로 매번 다시 읽는다.
    try {
      const next = await readJson(`${CONTROL}/api/state`);
      if (next.run_id !== state.run_id || next.building_version !== state.building_version) {
        building = await readJson(`${CONTROL}/api/building`);
        cameras = building.sources.filter((source) => source.source_type === "VIDEO_AI");
        console.log(`실행이 바뀌었습니다 → ${next.run_id}`);
      }
      state = next;
    } catch (error) {
      report(`제어기를 읽지 못했습니다: ${error.message}`);
      return "retry";
    }

    const now = Date.now();
    const started = fireZones(state, building);
    for (const camera of cameras) {
      const next = (index.get(camera.source_id) ?? 0) + 1;
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
        detections: detections(camera, building, started, now, step),
      };
      const result = await push({
        sequence: (sequence.get(camera.source_id) ?? 0) + 1,
        preview: previewOf(state, camera, "READY", frame, null),
        jpeg_base64: JPEG_BASE64,
      });
      if (result === "stop") return "stop";
      // 받아들여진 것만 번호를 올린다. 거부된 번호를 건너뛰면 다음 것도 어긋난다.
      if (result === "ok") {
        index.set(camera.source_id, next);
        sequence.set(camera.source_id, (sequence.get(camera.source_id) ?? 0) + 1);
      }
    }
    step += 1;
    return "ok";
  };

  if ((await tick()) === "stop") return;
  if (MODE === "once") {
    console.log("한 장만 넣었습니다. 기한이 지나면 화면에서 사라져야 합니다.");
    return;
  }
  console.log(`${PERIOD_MS}ms마다 넣습니다. 잠깐 실패해도 계속 다시 시도합니다. Ctrl+C로 멈춥니다.`);
  // 앞 묶음이 끝나기 전에 다음 묶음을 보내지 않는다. 겹치면 순번이 추월해 거부당한다.
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick()
      .then((result) => {
        if (result === "stop") {
          console.error("요청이 잘못되어 멈춥니다. 스크립트를 고쳐야 합니다.");
          clearInterval(timer);
        }
      })
      .finally(() => {
        busy = false;
      });
  }, PERIOD_MS);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

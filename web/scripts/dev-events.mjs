/**
 * 개발·시연용 관측 이벤트 주입기. 단말(P01)을 확인하려면 제어기 상태를 바꿔야 한다.
 *
 *   npm run dev:events              대화형. arm 후 하트비트를 계속 보낸다.
 *   npm run dev:events -- fire      한 번만 실행하는 명령 (arm·fire·smoke·clear·status·reset)
 *   npm run dev:events -- smoke DETECTOR-B   관측원을 직접 지정
 *
 * 하는 일
 *  1. GET /api/session 으로 현재 run_id를 읽는다.
 *  2. GET /api/building 으로 관측원 설정을 읽는다. 관측원 ID를 코드에 박지 않는다.
 *  3. 필수 관측원에 OBSERVATION을 보내고 POST /api/control/arm 으로 시작한다.
 *  4. freshness_ms 안에 HEARTBEAT를 계속 보낸다.
 *     이걸 멈추면 필수 관측이 STALE이 되어 DEGRADED·NO_ROUTE로 떨어진다.
 *
 * 이 스크립트는 시험 입력 생성기다. 제어기는 여기서 보낸 관측만 보고 판단하며
 * 시나리오 정답을 직접 읽지 않는다.
 */
import { randomUUID } from "node:crypto";
import process from "node:process";

const BASE = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";
/** 관측 시각이 서버 기준 미래가 되지 않도록 조금 뒤로 둔다(future_tolerance_ms = 0). */
const OBSERVED_BACKDATE_MS = 100;

const sequences = new Map();
let building = null;
let session = null;
let heartbeatTimer = null;
let mediaTimeMs = 0;

function observedAt() {
  return new Date(Date.now() - OBSERVED_BACKDATE_MS).toISOString();
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = parsed?.error ?? {};
    throw new Error(`${method} ${path} → ${response.status} ${detail.code ?? ""} ${detail.message ?? text}`);
  }
  return parsed;
}

function buildEvent(source, kind, options = {}) {
  const next = (sequences.get(source.source_id) ?? 0) + 1;
  sequences.set(source.source_id, next);
  const video = source.source_type === "VIDEO_AI";
  const analysed = kind === "OBSERVATION" || kind === "ALARM";
  if (video && analysed) mediaTimeMs += 200;

  return {
    schema_version: 1,
    run_id: session.run_id,
    building_id: building.building_id,
    building_version: building.building_version,
    event_id: randomUUID(),
    source_id: source.source_id,
    source_type: source.source_type,
    source_sequence: next,
    event_kind: kind,
    hazard_type: options.hazard ?? null,
    validity: kind === "UNAVAILABLE" ? "UNAVAILABLE" : "VALID",
    observed_at: observedAt(),
    media_time_ms: video && analysed ? mediaTimeMs : null,
    confidence: video && kind === "ALARM" ? 0.82 : null,
    reason_code: kind === "UNAVAILABLE" ? (options.reason ?? "SOURCE_DOWN") : null,
  };
}

function send(source, kind, options) {
  return call("POST", "/events", buildEvent(source, kind, options));
}

function requiredSources() {
  return building.sources.filter((source) => source.required);
}

function pick(type, hazard) {
  return building.sources.find(
    (source) => source.source_type === type && source.allowed_hazard_types.includes(hazard),
  );
}

function startHeartbeat() {
  stopHeartbeat();
  const interval = Math.max(
    300,
    Math.floor(Math.min(...requiredSources().map((source) => source.freshness_ms)) / 3),
  );
  heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        for (const source of requiredSources()) await send(source, "HEARTBEAT");
      } catch (error) {
        console.error("  하트비트 실패:", error.message);
      }
    })();
  }, interval);
  console.log(`  하트비트 ${interval}ms 주기로 시작 (필수 관측 ${requiredSources().length}개)`);
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function loadSession() {
  session = await call("GET", "/session");
  building = await call("GET", "/building");
  // 순번은 서버가 기억하는 마지막 수락 값에서 이어간다.
  // 이렇게 해야 주입기를 다시 실행해도 STALE_SEQUENCE로 거부되지 않는다.
  const state = await call("GET", "/state");
  sequences.clear();
  for (const source of state.sources) {
    if (source.last_source_sequence !== null) {
      sequences.set(source.source_id, source.last_source_sequence);
    }
  }
  console.log(
    `  실행 ${session.run_id} · ${session.building_id} v${session.building_version} · ${session.controller_mode}`,
  );
}

async function arm() {
  for (const source of requiredSources()) await send(source, "OBSERVATION");
  const receipt = await call("POST", "/control/arm", {
    schema_version: 1,
    run_id: session.run_id,
    reason: "P01 단말 확인용 시연 시작",
  });
  console.log(`  arm 완료 → ${receipt.controller_mode}`);
  startHeartbeat();
}

async function alarm(kind, hazard, sourceId) {
  const source =
    sourceId === undefined
      ? pick(kind, hazard)
      : building.sources.find((item) => item.source_id === sourceId);
  if (source === undefined) {
    console.log(`  ${sourceId ?? `${kind}/${hazard}`} 관측원이 이 건물에 없습니다.`);
    return;
  }
  if (!source.allowed_hazard_types.includes(hazard)) {
    console.log(`  ${source.source_id}는 ${hazard} 경보를 보낼 수 없습니다.`);
    return;
  }
  await send(source, "ALARM", { hazard });
  console.log(`  ${source.source_id} ${hazard} 경보 발생 (구역 ${source.zone_id})`);
}

async function clearAll() {
  const state = await call("GET", "/state");
  if (state.active_causes.length === 0) {
    console.log("  활성 경보가 없습니다.");
    return;
  }
  for (const cause of state.active_causes) {
    await call("POST", "/control/clear", {
      schema_version: 1,
      run_id: session.run_id,
      reason: "시연 확인 후 해제",
      source_id: cause.source_id,
      hazard_type: cause.hazard_type,
    });
    console.log(`  해제: ${cause.source_id} ${cause.hazard_type}`);
  }
}

async function reset() {
  stopHeartbeat();
  const receipt = await call("POST", "/control/reset", {
    schema_version: 1,
    run_id: session.run_id,
    reason: "시연 재시작",
  });
  console.log(`  reset → 새 실행 ${receipt.run_id}`);
  await loadSession();
  await arm();
}

async function status() {
  const state = await call("GET", "/state");
  console.log(`  모드 ${state.controller_mode} · 안내 버전 ${state.guidance_version}`);
  console.log(`  관측 ${state.sources.map((s) => `${s.source_id}=${s.validity}`).join(" ")}`);
  console.log(
    `  경보 ${state.active_causes.length === 0 ? "없음" : state.active_causes.map((c) => `${c.source_id}:${c.hazard_type}`).join(" ")}`,
  );
  for (const sign of state.signs) {
    const faces = sign.faces.map((f) => `${f.face_id}=${f.mode}/${f.display ?? "—"}`).join(" ");
    console.log(`  ${sign.sign_id} ${faces} · ${sign.application_status}`);
  }
}

const KEYS = {
  f: ["화재 경보 (VIDEO_AI / FIRE)", () => alarm("VIDEO_AI", "FIRE")],
  s: ["연기 경보 (SIM_SMOKE_DETECTOR / SMOKE)", () => alarm("SIM_SMOKE_DETECTOR", "SMOKE")],
  c: ["활성 경보 전부 해제", clearAll],
  h: ["하트비트 중지·재개 (중지하면 3초 뒤 안내 불가)", async () => {
    if (heartbeatTimer === null) startHeartbeat();
    else {
      stopHeartbeat();
      console.log("  하트비트 중지. 필수 관측이 곧 STALE이 됩니다.");
    }
  }],
  t: ["현재 상태 출력", status],
  r: ["reset 후 다시 arm", reset],
};

function help() {
  console.log("\n  키 안내");
  for (const [key, [label]] of Object.entries(KEYS)) console.log(`   ${key}  ${label}`);
  console.log("   q  종료\n");
}

/** 한 번만 실행하고 끝나는 명령. 하트비트를 잡지 않으므로 다른 창에서 함께 쓸 수 있다. */
const ONE_SHOT = {
  arm: async () => {
    await arm();
    stopHeartbeat();
  },
  fire: (sourceId) => alarm("VIDEO_AI", "FIRE", sourceId),
  smoke: (sourceId) => alarm("SIM_SMOKE_DETECTOR", "SMOKE", sourceId),
  clear: clearAll,
  status,
  reset: async () => {
    const receipt = await call("POST", "/control/reset", {
      schema_version: 1,
      run_id: session.run_id,
      reason: "시연 재시작",
    });
    console.log(`  reset → 새 실행 ${receipt.run_id}`);
  },
};

async function main() {
  console.log(`saferoute 이벤트 주입기 → ${BASE}`);
  await loadSession();

  const command = process.argv[2];
  if (command !== undefined) {
    const action = ONE_SHOT[command];
    if (action === undefined) {
      console.error(`  알 수 없는 명령: ${command}. 사용 가능: ${Object.keys(ONE_SHOT).join(", ")}`);
      process.exit(1);
    }
    await action(process.argv[3]);
    stopHeartbeat();
    return;
  }

  await arm();
  await status();
  help();

  if (!process.stdin.isTTY) {
    console.log("  (대화형 입력이 없어 하트비트만 유지합니다. Ctrl+C로 종료)");
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const key = chunk.toString().toLowerCase();
    if (key === "q" || key === "\u0003") {
      stopHeartbeat();
      process.stdin.setRawMode(false);
      process.exit(0);
    }
    const entry = KEYS[key];
    if (entry === undefined) {
      help();
      return;
    }
    void entry[1]().catch((error) => console.error("  실패:", error.message));
  });
}

main().catch((error) => {
  console.error("시작 실패:", error.message);
  console.error("제어기가 떠 있는지 확인하세요: python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1");
  process.exit(1);
});

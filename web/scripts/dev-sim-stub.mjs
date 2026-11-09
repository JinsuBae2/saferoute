/**
 * 개발용 /sim 임시 응답기. 3D 연기 표시를 눈으로 확인하려고 만든 프론트 쪽 도구다.
 *
 *   npm run dev:sim
 *
 * 이것은 B04의 시나리오 실행기가 아니다. 실제 시나리오 정답도 아니다.
 * WFI 시나리오 자료가 준비되면(5번 Q02) 이 스텁 대신 실제 실행기를 쓴다.
 * 그때까지 관제 3D의 연기 표현을 확인하는 용도로만 쓴다.
 *
 * 지키는 것
 * - 제어기에 어떤 이벤트도 보내지 않는다. 관측은 dev-events.mjs가 따로 만든다.
 * - 따라서 여기서 만든 연기 값은 제어기 판단에 영향을 주지 않는다.
 *   화면에서 "시험 정답"과 "관측 위험"이 다르게 보이는 것이 정상이다.
 */
import { createServer } from "node:http";
import process from "node:process";

const CONTROL = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";
const PORT = Number(process.env.SAFEROUTE_SIM_PORT ?? 8001);
/** 연기가 번지는 순서. 실제 확산 계산이 아니라 화면 확인용 순서다. */
const SPREAD_DELAY_MS = 6000;
const RISE_MS = 9000;

let session = null;
let building = null;
let startedAt = Date.now();
let sequence = 0;

async function readJson(path) {
  const response = await fetch(`${CONTROL}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

async function refresh() {
  const next = await readJson("/api/session");
  if (session === null || next.run_id !== session.run_id) {
    session = next;
    building = await readJson("/api/building");
    startedAt = Date.now();
    sequence = 0;
    console.log(`  실행 ${session.run_id} · ${session.building_id} v${session.building_version}`);
  }
}

/** 화재가 난 구역부터 인접 순서 없이 번호 순으로 퍼지는 단순한 시간표다. */
function smokeZones(elapsedMs) {
  if (building === null) return [];
  const ordered = building.zones.map((zone) => zone.zone_id).sort();
  return ordered.map((zoneId, index) => {
    const begins = index * SPREAD_DELAY_MS;
    const progress = (elapsedMs - begins) / RISE_MS;
    const smoke = Math.max(0, Math.min(1, progress));
    return { zone_id: zoneId, smoke: Number(smoke.toFixed(2)) };
  });
}

function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      await refresh();
    } catch (error) {
      send(response, 503, { error: { code: "CONTROLLER_NOT_READY", message: error.message, field: null } });
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/sim/health") {
      send(response, 200, { status: "ok", stub: true });
      return;
    }
    if (url.pathname !== "/sim/state") {
      send(response, 404, { error: { code: "UNKNOWN_SOURCE", message: "없는 경로입니다", field: null } });
      return;
    }

    const elapsed = Date.now() - startedAt;
    sequence += 1;
    send(response, 200, {
      schema_version: 1,
      building_id: building.building_id,
      building_version: building.building_version,
      scenario_id: "dev-smoke-stub",
      run_id: session.run_id,
      simulation_time_ms: elapsed,
      simulation_sequence: sequence,
      status: "RUNNING",
      zones: smokeZones(elapsed),
      error_code: null,
    });
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`개발용 /sim 임시 응답기 → http://127.0.0.1:${PORT}/sim/state`);
  console.log("  B04 시나리오 실행기가 아닙니다. 3D 연기 표시 확인용입니다.");
  console.log(`  제어기 ${CONTROL}에서 실행·구역 정보를 읽습니다. 이벤트는 보내지 않습니다.`);
});

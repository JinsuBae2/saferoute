/**
 * 개발용 연기 확산 모형 (이슈 #74).
 *
 * 실제 유체 계산이 아니다. "불난 곳에서 가까운 데부터 서서히 차오른다"를
 * 눈으로 보이게 만든 화면 확인용 시간표다. 제품 코드가 아니며 제어기 판단에도
 * 쓰이지 않는다. 실제 연기 정답은 B04 시나리오 실행기가, 실제 검출은
 * 1번의 ai_worker가 만든다.
 *
 * 3D의 연기(dev-sim-stub)와 CCTV의 검출(dev-preview-stub)이 같은 값을 쓰도록
 * 여기 한 곳에 둔다. 따로 두면 "3D에는 연기가 있는데 캠에는 없다"처럼
 * 서로 어긋난 화면이 나온다.
 */

/** 한 구역이 0에서 최대치까지 차오르는 데 걸리는 시간. */
export const RISE_MS = 9000;
/** 1m 번지는 데 걸리는 시간. 작을수록 빨리 퍼진다. */
export const SPREAD_MS_PER_M = 450;
/** 위·아래층으로 넘어가는 데 더 걸리는 시간. 계단을 타고 넘어간다고 본다. */
export const FLOOR_DELAY_MS = 12000;
/** 이 거리를 넘으면 거의 닿지 않는다(m). */
export const REACH_M = 45;
/** 다른 층에서는 이만큼만 옅게 찬다. */
export const OTHER_FLOOR_RATIO = 0.45;

export function centroid(zone) {
  const points = zone.polygon;
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, z: acc.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: sum.x / points.length, z: sum.z / points.length };
}

/**
 * 지금 타고 있는 불. 관측원이 담당하는 구역과 불이 난 시각을 뽑는다.
 * 제어기가 확정한 active_causes만 쓴다. 여기서 화재를 판정하지 않는다.
 */
export function fireZones(state, building) {
  const zoneOf = new Map(building.sources.map((source) => [source.source_id, source.zone_id]));
  const started = new Map();
  for (const cause of state.active_causes) {
    const zoneId = zoneOf.get(cause.source_id);
    if (zoneId === undefined) continue;
    const at = Date.parse(cause.activated_at);
    if (!Number.isFinite(at)) continue;
    // 같은 구역에 여러 원인이 있으면 가장 먼저 난 때를 쓴다.
    started.set(zoneId, Math.min(started.get(zoneId) ?? at, at));
  }
  return started;
}

/**
 * 한 구역의 지금 연기 농도(0~1).
 * 불난 구역에서 멀수록 늦게 시작하고 옅게 찬다. 불이 없으면 0이다.
 */
export function smokeAt(building, started, zoneId, nowMs) {
  const byId = new Map(building.zones.map((zone) => [zone.zone_id, zone]));
  const zone = byId.get(zoneId);
  if (zone === undefined || started.size === 0) return 0;

  const here = centroid(zone);
  let smoke = 0;
  for (const [fireZoneId, firedAt] of started) {
    const fire = byId.get(fireZoneId);
    if (fire === undefined) continue;
    const there = centroid(fire);
    const metres = Math.hypot(here.x - there.x, here.z - there.z);
    if (metres > REACH_M) continue;
    const sameFloor = zone.floor_id === fire.floor_id;
    const begins = metres * SPREAD_MS_PER_M + (sameFloor ? 0 : FLOOR_DELAY_MS);
    // 멀수록 옅게. 불난 구역이 가장 짙다.
    const ceiling = (1 - metres / REACH_M) * (sameFloor ? 1 : OTHER_FLOOR_RATIO);
    const progress = Math.max(0, (nowMs - firedAt - begins) / RISE_MS);
    smoke = Math.max(smoke, Math.min(ceiling, progress * ceiling));
  }
  return smoke;
}

/** 연기가 조금이라도 있는 구역만. 0인 구역은 보내지 않는다. */
export function smokeByZone(building, started, nowMs) {
  const out = [];
  for (const zone of building.zones) {
    const smoke = smokeAt(building, started, zone.zone_id, nowMs);
    if (smoke >= 0.01) out.push({ zone_id: zone.zone_id, smoke: Number(smoke.toFixed(2)) });
  }
  return out;
}

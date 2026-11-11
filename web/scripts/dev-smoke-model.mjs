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

/** 불난 구역이 0에서 가득 차는 데 걸리는 시간. 먼 구역은 이보다 느리게 찬다. */
export const RISE_MS = 9000;
/** 1m 번지는 데 걸리는 시간. 연기가 그 구역에 "닿기까지" 걸리는 시간이다. */
export const SPREAD_MS_PER_M = 450;
/** 위·아래층으로 넘어가는 데 더 걸리는 시간. 계단을 타고 넘어간다고 본다. */
export const FLOOR_DELAY_MS = 12000;
/** 이 거리를 넘으면 닿지 않는다(m). 건물을 다 덮을 만큼 넉넉히 둔다. */
export const REACH_M = 80;
/** 멀수록 느리게 찬다. 이 거리마다 차는 데 걸리는 시간이 한 배씩 늘어난다(m). */
export const SLOWDOWN_M = 25;
/** 다른 층은 끝까지 차도 여기까지만. 불난 층보다는 늘 옅다. */
export const OTHER_FLOOR_CAP = 0.85;

/** 불꽃이 그 구역에 "옮겨붙기까지". 연기보다 한참 느리게 번진다. */
export const FIRE_SPREAD_MS_PER_M = 1200;
/** 옮겨붙은 뒤 세지는 속도. 연기보다 천천히 커진다. */
export const FIRE_RISE_MS = 22000;
/** 멀수록 느리게 커진다. 이 거리마다 커지는 데 걸리는 시간이 한 배씩 늘어난다(m). */
export const FIRE_SLOWDOWN_M = 10;
/** 이 거리를 넘으면 불꽃은 보이지 않는다(m). 연기와 달리 좁게 잡는다. */
export const FIRE_REACH_M = 20;
/** 위·아래층으로 옮겨붙는 데 더 걸리는 시간. 연기보다 훨씬 늦다. */
export const FIRE_FLOOR_DELAY_MS = 25000;
/** 불난 구역 바로 그곳의 최대 세기. */
export const FIRE_NEAR_CAP = 0.9;
/** 닿는 끝자락의 최대 세기. 멀수록 이 값으로 수렴한다. */
export const FIRE_FAR_CAP = 0.45;
/** 다른 층의 불꽃은 같은 거리라도 이 비율까지만 보인다. */
export const FIRE_OTHER_FLOOR_SCALE = 0.6;

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
 *
 * 거리는 "언제 닿는지"와 "얼마나 느리게 차는지"만 정한다. 최대치는 깎지 않는다.
 * 멀다고 최대치를 깎으면 시간이 지나도 영영 옅은 채로 멈춰, 연기가 번졌는데도
 * 그 구역 카메라가 낮은 값만 말하게 된다. 연기는 시간이 지나면 쌓인다.
 *
 * 불이 없으면 0이다.
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
    // 연기가 그 구역에 닿기까지. 멀수록, 다른 층일수록 늦게 시작한다.
    const begins = metres * SPREAD_MS_PER_M + (sameFloor ? 0 : FLOOR_DELAY_MS);
    // 닿은 뒤 차오르는 속도. 멀수록 천천히 차지만 끝내는 가득 찬다.
    const rise = RISE_MS * (1 + metres / SLOWDOWN_M);
    const ceiling = sameFloor ? 1 : OTHER_FLOOR_CAP;
    const progress = Math.max(0, (nowMs - firedAt - begins) / rise);
    smoke = Math.max(smoke, Math.min(ceiling, progress * ceiling));
  }
  return smoke;
}

/**
 * 한 구역에서 지금 보이는 불꽃의 세기(0~1).
 *
 * 연기와 같은 거리 모형을 쓰되 더 좁고 느리다. 불난 구역은 처음부터 또렷하고,
 * 옆 구역은 옮겨붙기를 기다린 뒤 서서히 세진다. 멀수록 늦게 붙고 끝내 약하게
 * 머문다. 그래서 "방에 난 불이 앞 복도 카메라에 먼저, 반대편에 나중에" 잡힌다.
 *
 * 불이 없거나 닿는 거리 밖이면 0이다.
 */
export function fireAt(building, started, zoneId, nowMs) {
  const byId = new Map(building.zones.map((zone) => [zone.zone_id, zone]));
  const zone = byId.get(zoneId);
  if (zone === undefined || started.size === 0) return 0;

  const here = centroid(zone);
  let fire = 0;
  for (const [fireZoneId, firedAt] of started) {
    const source = byId.get(fireZoneId);
    if (source === undefined) continue;
    const there = centroid(source);
    const metres = Math.hypot(here.x - there.x, here.z - there.z);
    if (metres > FIRE_REACH_M) continue;
    const sameFloor = zone.floor_id === source.floor_id;
    const reach = metres / FIRE_REACH_M;
    // 옮겨붙기까지. 다른 층은 계단을 타야 해서 한참 늦다.
    const begins = metres * FIRE_SPREAD_MS_PER_M + (sameFloor ? 0 : FIRE_FLOOR_DELAY_MS);
    const rise = FIRE_RISE_MS * (1 + metres / FIRE_SLOWDOWN_M);
    // 가까울수록 세게 탄다. 끝자락은 약한 채로 머문다.
    const near = FIRE_NEAR_CAP - (FIRE_NEAR_CAP - FIRE_FAR_CAP) * reach;
    const ceiling = sameFloor ? near : near * FIRE_OTHER_FLOOR_SCALE;
    // 붙자마자 조금은 보인다. 0에서 시작하면 한참 "불 없음"으로 읽힌다.
    const base = sameFloor ? Math.max(0, 1 - reach) * 0.55 : 0;
    const progress = Math.min(1, Math.max(0, (nowMs - firedAt - begins) / rise));
    fire = Math.max(fire, Math.min(ceiling, base + progress * Math.max(0, ceiling - base)));
  }
  return fire;
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

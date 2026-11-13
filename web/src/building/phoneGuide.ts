import type { Building, BuildingDisplay, Route, StateSnapshot } from "@contracts";
import type { WallRect } from "./geometry";
import { segmentHitsWall } from "./geometry";
import type { QrMount } from "./signMount";
import { describeJourney, ROUTE_REASON_LABEL } from "./journey";
import type { Person } from "./people";

export type FollowPose = {
  x: number; z: number; yaw: number;
  nodeId: string; toNodeId: string | null; routeNodeId: string;
  personIndex: number; runId: string; progress: number; moving: boolean; evacuating: boolean;
};

/** 선택 위치와 같은 층에서 아직 탈출하지 않은 사람을 고른다. */
export function nearestPerson(building: Building, people: readonly Person[], startId: string): number | null {
  const nodes = new Map(building.nodes.map(node => [node.node_id, node]));
  const start = nodes.get(startId);
  if (!start) return null;
  let nearest: number | null = null;
  let distance = Infinity;
  people.forEach((person, index) => {
    const from = nodes.get(person.from);
    const to = person.to === null ? undefined : nodes.get(person.to);
    if (!from || person.status === "OUT" || (person.returning ? to : from)?.floor_id !== start.floor_id) return;
    const x = from.position.x + ((to?.position.x ?? from.position.x) - from.position.x) * person.progress;
    const z = from.position.z + ((to?.position.z ?? from.position.z) - from.position.z) * person.progress;
    const value = Math.hypot(x - start.position.x, z - start.position.z);
    if (value < distance) { distance = value; nearest = index; }
  });
  return nearest;
}

/** 위치 QR 자산(web/public/qr)이 이 건물 자료의 것인지. 내용에 건물 ID와 자료 버전이 들어 있어, 다르면 QR 연출을 켜지 않는다. */
export function qrAssetsMatch(building: Pick<Building, "building_id" | "building_version">): boolean {
  // shortcut: 위치 QR 자산은 WFI v7용이다. 다른 건물·버전에는 web/scripts/location-qr.swift로 먼저 만든다.
  return building.building_id === "WFI" && building.building_version === 7;
}

/**
 * 시연 인물이 스스로 QR을 비출 때인지. 휴대폰을 꺼냈고, 비추는 중이 아니고, 보이는 QR이 있고, 아직 한 번도 확인하지 않았을 때뿐이다.
 * 한 번 확인한 뒤에는 자동으로 다시 비추지 않는다(다시 확인은 사용자가 직접 누른다). 첫 인식이 취소됐으면 확인 전이므로 다시 시도한다.
 */
export function shouldAutoScan(input: { readonly acting: boolean; readonly open: boolean; readonly scanning: boolean; readonly qrSignId: string | null; readonly confirmed: string | null }): boolean {
  return input.acting && input.open && !input.scanning && input.qrSignId !== null && input.confirmed === null;
}

/** 휴대폰으로 비출 수 있는 거리(m), 시선 정면에서 벗어나도 되는 각의 코사인(약 65도), 판을 비스듬히 볼 수 있는 한계(판 정면에서 약 75도). */
const QR_REACH = 5;
const QR_VIEW = 0.42;
const QR_SLANT = 0.25;

/**
 * 지금 비출 수 있는 가까운 QR. 3D에 붙인 것과 같은 자리(mounts)로 판정한다.
 * 같은 층에서, 걷는 구간의 양 끝 지점의 QR 가운데 거리 안에 있고, 바라보는 쪽에 있고, 판의 앞면 쪽에 서 있고, 벽에 가리지 않은 것만 고른다.
 * 벽 너머, 등 뒤, 판의 뒷면 쪽에서는 잡지 않는다. 모의 인식이다. 실제 카메라로 QR을 읽지 않는다.
 */
export function nearbyQr(building: Building, pose: FollowPose, mounts: ReadonlyMap<string, QrMount>, walls: readonly WallRect[] = []) {
  if (!qrAssetsMatch(building)) return null;
  const origin = building.nodes.find(node => node.node_id === pose.routeNodeId);
  const seen = building.signs.flatMap(sign => {
    const node = building.nodes.find(item => item.node_id === sign.node_id);
    const place = mounts.get(sign.sign_id);
    if (!node || !place || node.floor_id !== origin?.floor_id || (node.node_id !== pose.nodeId && node.node_id !== pose.toNodeId)) return [];
    const dx = place.x - pose.x;
    const dz = place.z - pose.z;
    const distance = Math.hypot(dx, dz);
    if (distance > QR_REACH || distance < 0.05) return [];
    if ((dx * Math.sin(pose.yaw) + dz * Math.cos(pose.yaw)) / distance < QR_VIEW) return [];
    // 판의 앞면 쪽에 서 있어야 한다. 뒷면(벽 속)이나 판과 거의 나란한 옆에서는 읽히지 않는다.
    if ((-dx * place.normalX - dz * place.normalZ) / distance < QR_SLANT) return [];
    const front = { x: place.x + place.normalX * 0.05, z: place.z + place.normalZ * 0.05 };
    return walls.some(wall => segmentHitsWall(wall, pose.x, pose.z, front.x, front.z)) ? [] : [{ sign, distance }];
  });
  return seen.sort((a, b) => a.distance - b.distance)[0]?.sign ?? null;
}

type ReasonCode = Route["reason_codes"][number];
/** 경로가 없다고 확정한 것이 아니라, 감지 정보나 제어 상태를 확인하지 못해 안내하지 못하는 사유. */
const UNCONFIRMED: readonly ReasonCode[] = ["INITIALIZING", "REQUIRED_OBSERVATION_UNKNOWN", "CONTROLLER_UNAVAILABLE", "COMMAND_EXPIRED", "VERSION_MISMATCH", "UNSUPPORTED_DISPLAY"];

/** 서버가 남은 통로로 갈 출구가 없다고 판단했는지(NO_ROUTE), 확인하지 못한 것인지(UNCONFIRMED). */
export function routeLoss(reasons: readonly ReasonCode[]): "NO_ROUTE" | "UNCONFIRMED" {
  return reasons.length === 0 || reasons.some(reason => UNCONFIRMED.includes(reason)) ? "UNCONFIRMED" : "NO_ROUTE";
}

/**
 * 경로가 막혔을 때의 행동 안내. 서버가 계산한 대피 경로가 아니라 일반 행동요령이다.
 * 근거: 행정안전부 국민안전24 「화재 국민행동요령」(소관 소방청 생활안전과)의 '대피가 어려운 경우' 항목.
 */
export const BLOCKED_HELP = {
  source: "행정안전부 국민안전24 「화재 국민행동요령」",
  noRoute: [
    "불·연기가 있는 통로로 무리하게 들어가지 마세요",
    "화염·연기에서 먼 곳으로 가 문을 닫고, 젖은 수건 등으로 틈새를 막으세요",
    "119에 현재 위치와 상황을 알리고 구조를 요청하세요",
    "창문이 있으면 창문으로 구조를 요청하세요",
  ],
  unconfirmed: [
    "경로가 없다는 뜻이 아닙니다. 감지 정보나 연결을 확인하지 못했습니다",
    "가까운 유도등·안내방송과 직접 보이는 상황으로 판단하세요",
    "연기가 오는 쪽은 피하고, 문은 손잡이가 뜨겁지 않은지 확인한 뒤 여세요",
    "엘리베이터는 타지 말고 계단을 이용하세요",
  ],
  /** 옥상은 자동 목적지로 안내하지 않는다. 일반 도움말로만, 조건을 붙여 보여 준다. */
  roof: "옥상: 이 건물은 옥상을 쓸 수 있는지와 가는 길이 확인되지 않아 대피 목적지로 안내하지 않습니다. 공식 요령은 계단으로 대피할 수 있을 때 지상층·옥상 등 안전한 곳으로 가도록 안내합니다. 계단에 불·연기가 없고 옥상 문이 열려 있는 것을 직접 확인한 경우에만 고려하세요.",
} as const;

/** 119에 알릴 위치. 최신 상태로 확인한 층과 지점 이름만 쓴다. 모르면 추측하지 않고 null이다. */
export function reportPlace(building: Building, display: BuildingDisplay | null, nodeId: string): string | null {
  const node = building.nodes.find(item => item.node_id === nodeId);
  if (node === undefined) return null;
  const floor = display?.floor_labels[node.floor_id] ?? building.floors.find(item => item.floor_id === node.floor_id)?.label;
  if (floor === undefined) return null;
  const near = display?.node_labels[nodeId];
  // 지점 이름에 이미 층이 들어 있으면 층을 두 번 말하지 않는다.
  return near === undefined ? floor : near.startsWith(floor) ? `${near} 부근` : `${floor} · ${near} 부근`;
}

type Guidance =
  /**
   * UNAVAILABLE: 통신이 늦거나 끊겨 최신 상태를 모른다. UNCONFIRMED: 감지·제어 문제로 서버가 경로를 확인하지 못했다.
   * BLOCKED: 서버가 남은 통로로 갈 수 있는 출구가 없다고 판단했다. place는 119에 알릴 위치이고, 확실하지 않으면 null이다.
   */
  | { kind: "UNAVAILABLE" | "UNCONFIRMED" | "BLOCKED"; instruction: string; detail: string; actions: readonly string[]; place: string | null }
  | { kind: "ROUTE"; instruction: string; detail: string; path: readonly string[]; exitLabel: string; icon: string; distanceMetres: number | null; stairs: boolean; floorId: string; floorLabel: string; floorTransition: string | null; mapHint: string };

export function phoneGuidance(building: Building, display: BuildingDisplay | null, state: StateSnapshot, pose: FollowPose, stale: boolean): Guidance {
  // 연결이 늦으면 위치도 그때의 것이다. 지금 위치처럼 신고에 쓰라고 내밀지 않는다.
  if (stale || state.run_id !== pose.runId || !Number.isFinite(pose.progress)) return { kind: "UNAVAILABLE", instruction: "안내 연결 확인 중", detail: "통신이 늦어 경로와 위치를 확인하지 못했습니다. 경로가 없다는 뜻은 아닙니다", actions: BLOCKED_HELP.unconfirmed.slice(1), place: null };
  const journey = describeJourney(building, display, state, pose.routeNodeId);
  if (journey.kind !== "ROUTE") {
    const reasons = journey.kind === "NO_ROUTE" ? journey.reasons : [];
    const place = reportPlace(building, display, pose.routeNodeId);
    const why = reasons.map(reason => ROUTE_REASON_LABEL[reason]).join(" · ");
    return routeLoss(reasons) === "NO_ROUTE"
      ? { kind: "BLOCKED", instruction: "출구로 가는 경로가 없습니다", detail: why, actions: BLOCKED_HELP.noRoute, place }
      : { kind: "UNCONFIRMED", instruction: "경로를 확인하지 못했습니다", detail: why || "현재 위치의 안내를 확인할 수 없습니다", actions: BLOCKED_HELP.unconfirmed, place };
  }
  const node = building.nodes.find(n => n.node_id === pose.routeNodeId)!;
  const returning = pose.routeNodeId !== pose.nodeId;
  const targetId = returning ? pose.routeNodeId : journey.path[1] ?? journey.path[0];
  const target = building.nodes.find(n => n.node_id === targetId)!;
  const floorLabel = (id: string) => display?.floor_labels[id] ?? building.floors.find(f => f.floor_id === id)?.label ?? id;
  const stairs = target.floor_id !== node.floor_id;
  const changingFloor = stairs && pose.moving && pose.toNodeId === targetId;
  const floorTransition = changingFloor ? `${floorLabel(node.floor_id)} → ${floorLabel(target.floor_id)}` : null;
  const mapHint = changingFloor ? `${floorLabel(target.floor_id)} 도착하면 지도 전환` : "파란 점은 내 위치";
  const navigation = nextManeuver(journey.path.map(id => building.nodes.find(n => n.node_id === id)!), pose, journey.exitLabel, floorLabel);
  return { kind: "ROUTE", ...navigation, path: journey.path, exitLabel: journey.exitLabel, stairs, floorId: node.floor_id, floorLabel: floorLabel(node.floor_id), floorTransition, mapHint };
}

/** 서버 경로의 다음 회전·계단·출구까지, 인물과 같은 선분 진행률로 남은 거리를 잰다. */
function nextManeuver(nodes: readonly Building["nodes"][number][], pose: FollowPose, exitLabel: string, floorLabel: (id: string) => string) {
  if (pose.routeNodeId !== pose.nodeId) return { instruction: "안내가 바뀌어 돌아가는 중", detail: "돌아간 지점에서 새 경로를 안내합니다", icon: "↶", distanceMetres: null };
  if (pose.toNodeId !== null && pose.toNodeId !== nodes[1]?.node_id) return { instruction: "경로 변경 확인 중", detail: "최신 경로에 맞춰 안내를 바꿉니다", icon: "↶", distanceMetres: null };
  let distance = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const previous = nodes[i - 1];
    const next = nodes[i + 1];
    if (previous !== undefined) {
      const length = Math.hypot(node.position.x - previous.position.x, node.position.y - previous.position.y, node.position.z - previous.position.z);
      const remaining = i === 1 && pose.toNodeId === node.node_id ? 1 - pose.progress : 1;
      distance += length * remaining;
    }
    const metres = Math.max(1, Math.ceil(distance));
    const near = distance <= 1.5;
    if (next === undefined) return { instruction: nodes.length === 1 ? "출구에 도착했습니다" : near ? "바로 앞 출구" : `약 ${metres}m 앞 출구`, detail: exitLabel, icon: "↑", distanceMetres: distance };
    if (next.floor_id !== node.floor_id) {
      const down = next.position.y < node.position.y;
      const destination = `${floorLabel(next.floor_id)}으로 ${down ? "내려가세요" : "올라가세요"}`;
      return { instruction: i === 0 ? destination : near ? "바로 앞 계단" : `약 ${metres}m 직진 후 계단`, detail: i === 0 ? "계단을 따라 이동하세요" : destination, icon: down ? "↘" : "↗", distanceMetres: distance };
    }
    if (previous === undefined) continue;
    const incoming = { x: node.position.x - previous.position.x, z: node.position.z - previous.position.z };
    const outgoing = { x: next.position.x - node.position.x, z: next.position.z - node.position.z };
    if (Math.hypot(incoming.x, incoming.z) < .01 || Math.hypot(outgoing.x, outgoing.z) < .01) continue;
    const delta = Math.atan2(outgoing.x, outgoing.z) - Math.atan2(incoming.x, incoming.z);
    const angle = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(angle) < Math.PI * 35 / 180) continue;
    const back = Math.abs(angle) > Math.PI * 150 / 180;
    const turn = back ? "뒤돌아 이동" : angle > 0 ? "좌회전" : "우회전";
    return { instruction: near ? `지금 ${turn}` : `약 ${metres}m 앞에서 ${turn}`, detail: near ? "안내된 통로로 이동하세요" : "갈림길까지 직진하세요", icon: back ? "↶" : angle > 0 ? "↰" : "↱", distanceMetres: distance };
  }
  // describeJourney가 빈 경로를 거르므로 정상 자료에서는 도달하지 않는다.
  return { instruction: "경로 확인 중", detail: "최신 경로를 기다립니다", icon: "!", distanceMetres: null };
}

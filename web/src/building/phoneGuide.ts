import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
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
  // shortcut: 위치 QR 자산은 WFI v6용이다. 다른 건물·버전에는 web/scripts/location-qr.swift로 먼저 만든다.
  return building.building_id === "WFI" && building.building_version === 6;
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

type Guidance =
  | { kind: "UNAVAILABLE" | "BLOCKED"; instruction: string; detail: string }
  | { kind: "ROUTE"; instruction: string; detail: string; path: readonly string[]; exitLabel: string; icon: string; distanceMetres: number | null; stairs: boolean; floorId: string; floorLabel: string; floorTransition: string | null; mapHint: string };

export function phoneGuidance(building: Building, display: BuildingDisplay | null, state: StateSnapshot, pose: FollowPose, stale: boolean): Guidance {
  if (stale || state.run_id !== pose.runId || !Number.isFinite(pose.progress)) return { kind: "UNAVAILABLE", instruction: "안내 연결 확인 중", detail: "최신 경로를 받을 때까지 기다려 주세요" };
  const journey = describeJourney(building, display, state, pose.routeNodeId);
  if (journey.kind !== "ROUTE") return { kind: "BLOCKED", instruction: "경로 차단 · 구조를 기다리세요", detail: journey.kind === "NO_ROUTE" ? `${journey.reasons.map(reason => ROUTE_REASON_LABEL[reason]).join(" · ")} · 연기가 없는 쪽에서 문을 닫고 119에 위치를 알리세요` : "현재 위치의 안내를 확인할 수 없습니다" };
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

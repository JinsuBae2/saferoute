/**
 * 선택한 출발점의 대피 안내 정리(M06, 이슈 #71). 연결 기준은 docs/implementation/b05-display-integration.md 2절.
 *
 * 지키는 것
 * - 경로를 여기서 계산하지 않는다. 같은 StateSnapshot의 routes[출발점].path_node_ids를 그대로 쓴다.
 * - 출발점은 화면에서 고른 위치다. 실제 사용자 위치 추적 결과로 표현하지 않는다.
 * - 선택은 서버 상태나 설치 유도등 명령을 바꾸지 않는다.
 * - 비교용 이전 경로는 같은 실행·건물·출발점에서만 남긴다.
 */
import type { Building, BuildingDisplay, FaceResult, Route, SignState, StateSnapshot } from "@contracts";

type ReasonCode = Route["reason_codes"][number];
type Display = NonNullable<FaceResult["display"]>;
type ApplicationStatus = SignState["application_status"];

export const ROUTE_REASON_LABEL: Record<ReasonCode, string> = {
  INITIALIZING: "새 실행 준비 중",
  ORIGIN_BLOCKED: "출발점이 위험·차단 구역입니다",
  NO_REACHABLE_EXIT: "남은 통로로 갈 수 있는 출구가 없습니다",
  REQUIRED_OBSERVATION_UNKNOWN: "필수 관측을 확인할 수 없습니다",
  EXIT_UNAVAILABLE: "출구 조건을 충족하지 못했습니다",
  UNSUPPORTED_DISPLAY: "표시면에서 안내할 수 없는 방향입니다",
  CONTROLLER_UNAVAILABLE: "제어 상태를 확인할 수 없습니다",
  COMMAND_EXPIRED: "명령 유효기간이 지났습니다",
  VERSION_MISMATCH: "실행·건물 자료 버전이 맞지 않습니다",
};

export const FACE_DISPLAY_LABEL: Record<Display, string> = {
  LEFT: "왼쪽",
  RIGHT: "오른쪽",
  FORWARD: "앞쪽",
  BACK: "뒤쪽",
  STAIRS_UP: "위층 계단",
  STAIRS_DOWN: "아래층 계단",
  EXIT: "출구",
};

export const APPLICATION_LABEL: Record<ApplicationStatus, string> = {
  NOT_ISSUED: "미발행",
  PENDING: "확인 대기",
  APPLIED: "적용 확인",
  REJECTED: "적용 실패",
  EXPIRED: "기한 만료",
  DUPLICATE_TERMINAL: "중복 단말",
};

export type JourneyStep =
  /** 한 층 안에서 이동. 지나는 지점 수와 처음·끝 지점 이름. */
  | { readonly kind: "WALK"; readonly floorId: string; readonly floorLabel: string; readonly from: string; readonly to: string; readonly stops: number }
  /** 계단으로 층 이동. */
  | { readonly kind: "STAIRS"; readonly stair: string; readonly fromFloor: string; readonly toFloor: string; readonly down: boolean }
  /** 도착 출구. */
  | { readonly kind: "EXIT"; readonly label: string };

export type SignOnPath = {
  readonly signId: string;
  readonly nodeId: string;
  readonly label: string;
  readonly exitLocation: boolean;
  readonly faces: readonly { readonly faceId: string; readonly mode: FaceResult["mode"]; readonly display: Display | null }[];
  readonly status: ApplicationStatus | null;
  /** 마지막 발행 명령의 안내 버전. 현재 안내 버전과 다르면 이전 명령이다. */
  readonly commandVersion: number | null;
  readonly current: boolean;
};

export type Journey =
  | {
      readonly kind: "ROUTE";
      readonly startId: string;
      readonly path: readonly string[];
      readonly exitId: string;
      readonly exitLabel: string;
      /** 출발점이 곧 출구. path가 [출구]인 정상 결과다. */
      readonly atExit: boolean;
      readonly steps: readonly JourneyStep[];
      readonly signs: readonly SignOnPath[];
    }
  | { readonly kind: "NO_ROUTE"; readonly startId: string; readonly reasons: readonly ReasonCode[] }
  | { readonly kind: "UNKNOWN_START"; readonly startId: string };

function nodeLabel(display: BuildingDisplay | null, nodeId: string): string {
  return display?.node_labels[nodeId] ?? nodeId;
}

/** 서버 경로를 사람이 읽는 이동 순서와 경로 위 유도등 상태로 정리한다. */
export function describeJourney(
  building: Building,
  display: BuildingDisplay | null,
  state: StateSnapshot,
  startId: string,
): Journey {
  const nodes = new Map(building.nodes.map((node) => [node.node_id, node]));
  const route = state.routes.find((item) => item.node_id === startId);
  if (!nodes.has(startId) || route === undefined) return { kind: "UNKNOWN_START", startId };
  if (route.reason_codes.length > 0 || route.exit_id === null || route.path_node_ids.length === 0) {
    return { kind: "NO_ROUTE", startId, reasons: route.reason_codes };
  }

  const path = route.path_node_ids;
  const floorLabel = (floorId: string) =>
    display?.floor_labels[floorId] ?? building.floors.find((floor) => floor.floor_id === floorId)?.label ?? floorId;
  const floorOf = (nodeId: string) => nodes.get(nodeId)?.floor_id ?? "";
  const elevationOf = (nodeId: string) => nodes.get(nodeId)?.position.y ?? 0;

  // 층이 바뀌는 곳에서 끊어 층별 이동과 계단 이동을 번갈아 둔다.
  const steps: JourneyStep[] = [];
  let runStart = 0;
  for (let index = 1; index <= path.length; index += 1) {
    const changed = index === path.length || floorOf(path[index]) !== floorOf(path[index - 1]);
    if (!changed) continue;
    const from = path[runStart];
    const to = path[index - 1];
    if (index - 1 > runStart) {
      steps.push({
        kind: "WALK",
        floorId: floorOf(from),
        floorLabel: floorLabel(floorOf(from)),
        from: nodeLabel(display, from),
        to: nodeLabel(display, to),
        stops: index - 1 - runStart,
      });
    }
    if (index < path.length) {
      steps.push({
        kind: "STAIRS",
        stair: nodeLabel(display, to),
        fromFloor: floorLabel(floorOf(to)),
        toFloor: floorLabel(floorOf(path[index])),
        down: elevationOf(path[index]) < elevationOf(to),
      });
    }
    runStart = index;
  }
  const exitLabel = display?.exit_labels[route.exit_id] ?? route.exit_id;
  steps.push({ kind: "EXIT", label: exitLabel });

  const statusById = new Map(state.signs.map((sign) => [sign.sign_id, sign]));
  const signByNode = new Map(building.signs.map((sign) => [sign.node_id, sign]));
  const signs: SignOnPath[] = [];
  for (const nodeId of path) {
    const sign = signByNode.get(nodeId);
    if (sign === undefined) continue;
    const current = statusById.get(sign.sign_id);
    const commandVersion = current?.latest_command?.guidance_version ?? null;
    signs.push({
      signId: sign.sign_id,
      nodeId,
      label: display?.signs[sign.sign_id]?.label ?? sign.sign_id,
      exitLocation: display?.signs[sign.sign_id]?.kind === "EXIT_LOCATION",
      faces: (current?.faces ?? []).map((face) => ({ faceId: face.face_id, mode: face.mode, display: face.display })),
      status: current?.application_status ?? null,
      commandVersion,
      current: commandVersion === state.guidance_version,
    });
  }

  return {
    kind: "ROUTE",
    startId,
    path,
    exitId: route.exit_id,
    exitLabel,
    atExit: path.length === 1,
    steps,
    signs,
  };
}

/** 비교용 경로 기록. 같은 실행·건물·출발점에서만 이어진다. */
export type JourneyTrack = {
  readonly context: string;
  readonly guidanceVersion: number;
  /** 현재 경로. 안내 불가면 빈 배열. */
  readonly path: readonly string[];
  readonly exitId: string | null;
  /** 경로가 바뀌기 직전의 경로. 현재 안내가 아니다. */
  readonly previous: { readonly guidanceVersion: number; readonly path: readonly string[]; readonly exitId: string | null } | null;
};

export function trackContext(state: Pick<StateSnapshot, "run_id" | "building_id" | "building_version">, startId: string): string {
  return `${state.run_id}/${state.building_id}/${state.building_version}/${startId}`;
}

function samePath(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 새 상태를 받을 때마다 호출한다. 실행·건물·출발점이 바뀌면 이전 기록을 버리고,
 * 같은 맥락에서 경로나 도착 출구가 바뀌었을 때만 직전 경로를 비교용으로 남긴다.
 */
export function advanceTrack(
  track: JourneyTrack | null,
  state: Pick<StateSnapshot, "run_id" | "building_id" | "building_version" | "guidance_version">,
  journey: Journey,
): JourneyTrack {
  const context = trackContext(state, journey.startId);
  const path = journey.kind === "ROUTE" ? journey.path : [];
  const exitId = journey.kind === "ROUTE" ? journey.exitId : null;
  if (track === null || track.context !== context) {
    return { context, guidanceVersion: state.guidance_version, path, exitId, previous: null };
  }
  if (samePath(track.path, path) && track.exitId === exitId) {
    return { ...track, guidanceVersion: state.guidance_version };
  }
  return {
    context,
    guidanceVersion: state.guidance_version,
    path,
    exitId,
    previous: { guidanceVersion: track.guidanceVersion, path: track.path, exitId: track.exitId },
  };
}

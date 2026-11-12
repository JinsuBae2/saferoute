import type { Building, ClearReceipt, ClearRequest, EventReceipt, ObservationEvent, Position, StateSnapshot } from "@contracts";
import { defaultIgnition } from "../building/firePresentation";
import { ApiError, clearCause, fetchState, postObservation } from "../api/client";

export function manualFireSources(building: Building) {
  return building.sources.filter((source) => source.source_type === "MANUAL_TEST" && !source.required
    && source.allowed_hazard_types.includes("FIRE"));
}

/** 지점도 차단 대상도 없는 구역은 불을 내도 경로가 바뀌지 않는다. 서버(check_event)와 같은 기준이다. */
export function fireSelectable(building: Building, zoneId: string) {
  const zone = building.zones.find((z) => z.zone_id === zoneId);
  return zone !== undefined && (zone.blocked_node_ids.length > 0 || zone.blocked_edge_ids.length > 0
    || building.nodes.some((node) => node.zone_id === zoneId));
}

/**
 * 「시연 시작」 옆 한 줄. 거절 사유는 직전 조작 결과보다 먼저 보인다.
 * 시연에 성공한 뒤 제한 구역을 눌러도 "발생 1건" 문구에 가려지지 않게 한다.
 */
export function demoMessage(pending: boolean, refused: string | null, notice: string | null, step: string) {
  if (pending) return "서버 응답을 확인하고 있습니다…";
  return refused ?? notice ?? step;
}

export type ManualAction = { kind: "ignite" | "clear"; zoneId: string; position?: Position | null } | { kind: "clear_all" };
export type ManualResult = { completed: number; guidanceVersion: number };
type ManualApi = {
  state: (signal: AbortSignal) => Promise<StateSnapshot>;
  ignite: (event: ObservationEvent, signal: AbortSignal) => Promise<EventReceipt>;
  clear: (request: ClearRequest, signal: AbortSignal) => Promise<ClearReceipt>;
};

/** One panel owns one in-flight write, always bound to the displayed run. */
export class ManualFireControl {
  private pending: AbortController | null = null;
  constructor(private readonly building: Building, private readonly runId: string,
    private readonly api: ManualApi = { state: fetchState, ignite: postObservation, clear: clearCause }) {}

  cancel() { this.pending?.abort(); }

  async run(action: ManualAction): Promise<ManualResult> {
    if (this.pending !== null) throw new Error("다른 시험 조작을 처리 중입니다");
    const abort = new AbortController();
    this.pending = abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]);
    let completed = 0;
    try {
      const state = await this.api.state(signal);
      signal.throwIfAborted();
      if (state.run_id !== this.runId || state.building_id !== this.building.building_id
        || state.building_version !== this.building.building_version) throw new Error("실행 또는 건물 자료가 변경되었습니다. 최신 상태를 확인하세요");
      const sources = manualFireSources(this.building);
      const active = new Set(state.active_causes.filter((c) => c.hazard_type === "FIRE").map((c) => c.source_id));
      let guidanceVersion = state.guidance_version;
      if (action.kind === "ignite") {
        const source = sources.find((s) => s.zone_id === action.zoneId);
        if (!source) throw new Error("시험 화재를 낼 수 없는 구역입니다");
        if (active.has(source.source_id)) throw new Error("이미 활성 시험 화재가 있습니다");
        const latest = state.sources.find((s) => s.source_id === source.source_id);
        if (!latest) throw new Error("시험 입력의 현재 순번을 확인할 수 없습니다");
        const event: ObservationEvent = {
          schema_version: 1, run_id: this.runId, building_id: this.building.building_id, building_version: this.building.building_version,
          event_id: crypto.randomUUID(), source_id: source.source_id, source_type: "MANUAL_TEST",
          source_sequence: (latest.last_source_sequence ?? 0) + 1, event_kind: "ALARM", hazard_type: "FIRE",
          validity: "VALID", observed_at: state.generated_at, media_time_ms: null, confidence: null, reason_code: null,
          ignition_position: action.position ?? defaultIgnition(this.building, action.zoneId),
        };
        const receipt = await this.api.ignite(event, signal);
        signal.throwIfAborted();
        if (receipt.run_id !== this.runId || receipt.event_id !== event.event_id || !receipt.accepted) throw new Error("시험 입력 응답이 요청과 다릅니다");
        completed = 1; guidanceVersion = receipt.guidance_version;
      } else {
        const targets = action.kind === "clear_all" ? sources.filter((s) => active.has(s.source_id))
          : sources.filter((s) => s.zone_id === action.zoneId && active.has(s.source_id));
        if (targets.length === 0) throw new Error("해제할 활성 시험 화재가 없습니다");
        for (const source of targets) {
          signal.throwIfAborted();
          const receipt = await this.api.clear({ schema_version: 1, run_id: this.runId,
            source_id: source.source_id, hazard_type: "FIRE", reason: "B06 화면에서 시험 화재 확인 후 해제" }, signal);
          signal.throwIfAborted();
          if (receipt.run_id !== this.runId || receipt.source_id !== source.source_id || receipt.hazard_type !== "FIRE" || !receipt.cleared) throw new Error("시험 해제 응답이 요청과 다릅니다");
          completed += 1; guidanceVersion = receipt.guidance_version;
        }
      }
      return { completed, guidanceVersion };
    } catch (error) {
      const message = error instanceof ApiError ? `${error.message} (${error.code ?? error.status})`
        : error instanceof Error ? error.message : "연결 오류";
      throw new Error(`${completed}건 수락 확인 · ${message}. 응답을 받지 못한 요청은 반영됐을 수 있으니 현재 경보를 확인하세요.`, { cause: error });
    } finally {
      this.pending = null;
    }
  }
}

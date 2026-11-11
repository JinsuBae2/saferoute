import { describe, expect, it, vi } from "vitest";
import type { Building, ClearRequest, ObservationEvent, StateSnapshot } from "@contracts";
import { state as sample } from "@samples";
import buildingData from "@space/wfi-v1.json";
import { ManualFireControl, manualFireSources } from "./manualFire";

const building = buildingData as Building;
const north = "MANUAL-F1-PASSAGE-N";
const south = "MANUAL-F1-PASSAGE-S";
function snapshot(): StateSnapshot {
  return { ...structuredClone(sample), building_id: building.building_id, building_version: building.building_version,
    sources: building.sources.map((source) => ({ source_id: source.source_id, validity: "VALID",
      last_event_id: null, last_observed_at: null, last_source_sequence: 7 })), active_causes: [] };
}
function active(source_id: string, hazard_type: "FIRE" | "SMOKE" = "FIRE") {
  return { source_id, hazard_type, first_event_id: sample.run_id, last_event_id: sample.run_id, activated_at: sample.generated_at };
}
function setup(state = snapshot()) {
  const api = {
    state: vi.fn(async () => state),
    ignite: vi.fn(async (event: ObservationEvent) => ({ accepted: true, duplicate: false, event_id: event.event_id, run_id: state.run_id, guidance_version: 10 })),
    clear: vi.fn(async (request: ClearRequest) => ({ cleared: true, source_id: request.source_id, hazard_type: request.hazard_type, run_id: state.run_id, guidance_version: 11 })),
  };
  return { api, control: new ManualFireControl(building, state.run_id, api), state };
}

describe("manual fire controls", () => {
  // 도면 아무 데나 눌러 불을 낼 수 있어야 하므로 모든 구역에 시험 입력이 있어야 한다(이슈 #21).
  // 하나라도 빠지면 그 방은 눌러도 불이 나지 않는다.
  it("registers one optional FIRE input for every zone", () => {
    const sources = manualFireSources(building);
    expect(sources.every((s) => s.source_type === "MANUAL_TEST" && !s.required)).toBe(true);
    expect(new Set(sources.map((s) => s.zone_id))).toEqual(new Set(building.zones.map((z) => z.zone_id)));
    // 예전에는 복도·로비만 등록돼 있어 호실은 고를 수 없었다.
    expect(sources.some((s) => s.zone_id === "F2-R201")).toBe(true);
  });

  it("uses fresh server sequence/time and a manual event without zone or video fields", async () => {
    const { api, control, state } = setup();
    const result = await control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" });
    expect(api.ignite).toHaveBeenCalledOnce();
    expect(api.ignite.mock.calls[0][0]).toMatchObject({ run_id: state.run_id, building_version: building.building_version,
      source_id: north, source_type: "MANUAL_TEST", source_sequence: 8, observed_at: state.generated_at,
      event_kind: "ALARM", hazard_type: "FIRE", media_time_ms: null, confidence: null });
    expect(api.ignite.mock.calls[0][0]).not.toHaveProperty("zone_id");
    expect(result).toEqual({ completed: 1, guidanceVersion: 10 });
  });

  it("does not write on selection and rejects unsupported zones", async () => {
    const { control, api } = setup();
    expect(api.state).not.toHaveBeenCalled();
    await expect(control.run({ kind: "ignite", zoneId: "F9" })).rejects.toThrow("등록된 시험");
    expect(api.ignite).not.toHaveBeenCalled();
  });

  it.each(["run_id", "building_id", "building_version"] as const)("rejects a changed %s before any mutation", async (field) => {
    const { control, api, state } = setup();
    Object.assign(state, { [field]: field === "building_version" ? 99 : "different" });
    await expect(control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" })).rejects.toThrow("실행");
    expect(api.ignite).not.toHaveBeenCalled();
  });

  it("clears only the selected registered manual cause", async () => {
    const state = snapshot(); state.active_causes = [active(north), active(south), active("SMK-F1-PASSAGE-N", "SMOKE")];
    const { control, api } = setup(state);
    await control.run({ kind: "clear", zoneId: "F1-PASSAGE-N" });
    expect(api.clear.mock.calls.map(([body]) => body.source_id)).toEqual([north]);
  });

  it("clear-all preserves other inputs and never resets the whole controller", async () => {
    const state = snapshot(); state.active_causes = [active(north), active(south), active("CAM-F2-CORR-W"), active("SMK-F1-PASSAGE-N", "SMOKE")];
    const { control, api } = setup(state);
    expect(await control.run({ kind: "clear_all" })).toEqual({ completed: 2, guidanceVersion: 11 });
    expect(api.clear.mock.calls.map(([body]) => body.source_id)).toEqual([north, south]);
    expect(api.ignite).not.toHaveBeenCalled();
  });

  it("stops after partial failure and reports the accepted count", async () => {
    const state = snapshot(); state.active_causes = [active(north), active(south)];
    const { control, api } = setup(state);
    api.clear.mockRejectedValueOnce(new Error("통신 실패"));
    await expect(control.run({ kind: "clear_all" })).rejects.toThrow("0건 수락");
    expect(api.clear).toHaveBeenCalledOnce();
    api.clear.mockClear();
    api.clear.mockResolvedValueOnce({ cleared: true, source_id: north, hazard_type: "FIRE", run_id: state.run_id, guidance_version: 11 });
    api.clear.mockRejectedValueOnce(new Error("통신 실패"));
    await expect(control.run({ kind: "clear_all" })).rejects.toThrow("1건 수락");
    expect(api.clear).toHaveBeenCalledTimes(2);
  });

  it("rejects fast repeated clicks until the in-flight action settles", async () => {
    const { control, api, state } = setup();
    let release!: (value: StateSnapshot) => void;
    api.state.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" });
    await expect(control.run({ kind: "ignite", zoneId: "F1-PASSAGE-S" })).rejects.toThrow("처리 중");
    release(state); await first;
    expect(api.ignite).toHaveBeenCalledOnce();
  });

  it("cancels a pending old-run read before it can send an alarm", async () => {
    const { control, api, state } = setup();
    let release!: (value: StateSnapshot) => void;
    api.state.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const request = control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" });
    control.cancel(); release(state);
    await expect(request).rejects.toThrow();
    expect(api.ignite).not.toHaveBeenCalled();
  });

  it("does not automatically retry a failed or rejected input", async () => {
    const { control, api } = setup();
    api.ignite.mockRejectedValueOnce(new Error("STALE_SEQUENCE"));
    await expect(control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" })).rejects.toThrow("STALE_SEQUENCE");
    expect(api.ignite).toHaveBeenCalledOnce();
  });

  it("reads the latest active cause before repeat ignition or clear", async () => {
    const { control, api, state } = setup();
    await expect(control.run({ kind: "clear", zoneId: "F1-PASSAGE-N" })).rejects.toThrow("활성 시험 화재");
    state.active_causes = [active(north)];
    await expect(control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" })).rejects.toThrow("이미 활성");
    expect(api.ignite).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
  });

  it("rejects a response for another run", async () => {
    const { control, api } = setup();
    api.ignite.mockResolvedValueOnce({ accepted: true, duplicate: false, event_id: sample.run_id, run_id: "different", guidance_version: 10 });
    await expect(control.run({ kind: "ignite", zoneId: "F1-PASSAGE-N" })).rejects.toThrow("응답");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Building, StateSnapshot } from "@contracts";
import { emergency_state } from "@samples";
import buildingSample from "../../../data/fixtures/two-route-v1.json";
import { AiDemoSummary } from "./AiDemoSummary";

const state: StateSnapshot = emergency_state;
const building = buildingSample as Building;
const render = (sourceId: string | null, stale = false, snapshot = state) => renderToStaticMarkup(
  createElement(AiDemoSummary, { state: snapshot, building, display: null, sourceId, stale }),
);

describe("AI 시연 요약", () => {
  it("선택하지 않은 카메라에 다른 관측원의 경보를 붙이지 않는다", () => {
    const html = render(null);
    expect(html).toContain("카메라 선택");
    expect(html).not.toContain("경보 1");
    expect(render("DETECTOR-A")).toContain("카메라 선택");
  });

  it("선택 카메라 원인만 집계하고 경로·단말은 건물 전체라고 표시한다", () => {
    const snapshot: StateSnapshot = {
      ...state,
      active_causes: [
        { ...state.active_causes[0], source_id: "CAM-A", hazard_type: "FIRE", activated_at: state.generated_at },
        { ...state.active_causes[0], source_id: "DETECTOR-A", hazard_type: "SMOKE", activated_at: state.generated_at },
      ],
      blocked_edges: [
        { edge_id: "one", reason_codes: ["ACTIVE_ALARM"], source_ids: ["CAM-A", "DETECTOR-A"] },
        { edge_id: "two", reason_codes: ["ACTIVE_ALARM"], source_ids: ["DETECTOR-A"] },
      ],
    };
    const html = render("CAM-A", false, snapshot);
    expect(html).toContain("경보 1 · 차단 통로 1");
    expect(html).toContain("건물 전체 경로");
    expect(html).toContain("건물 전체 유도등");
    expect(html).toContain("유도등 화면 응답 기준");
  });

  it("제어 연결이 끊기면 마지막 집계값을 현재 성과처럼 표시하지 않는다", () => {
    const html = render("CAM-A", true);
    expect(html).toContain("제어 연결 지연");
    expect(html).not.toMatch(/경보 \d|차단 통로 \d|안내 \d|적용 \d/);
    expect(html).toContain("연결 복구 후 확인");
  });

  it("관측 만료와 잔존 경보를 별도로 표시하며 성능 합격을 주장하지 않는다", () => {
    const html = render("CAM-A", false, {
      ...state,
      sources: state.sources.map((source) => ({ ...source, validity: "STALE" })),
      active_causes: [{ ...state.active_causes[0], source_id: "CAM-A", hazard_type: "FIRE", activated_at: state.generated_at }],
    });
    expect(html).toContain("관측 오래됨");
    expect(html).toContain("경보 1");
    expect(html).toContain("정확도가 아닙니다");
    expect(html).toContain("기준 미달");
  });
});

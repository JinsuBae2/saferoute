import { describe, expect, it } from "vitest";
import type { Building } from "@contracts";
import buildingData from "@space/wfi-v1.json";
import displayData from "@space/wfi-display-v1.json";
import { parseDisplay, sceneLabels, visibleLabelIndexes } from "./display";

const building = buildingData as Building;

describe("WFI display metadata", () => {
  it("keeps the Korean name and installed camera position separate from the observed zone", () => {
    const display = parseDisplay(displayData, building);
    expect(display.sources["CAM-F2-CORR-E"].label).toBe("2층 우측 계단 B 앞 CAM");
    expect(display.sources["CAM-F2-CORR-E"].installation?.basis).toBe("SIMULATED");
    expect(building.sources.find((s) => s.source_id === "CAM-F2-CORR-E")?.zone_id).toBe("F2-CORR-E");
    expect(display.signs["SIGN-F1-X-N"].kind).toBe("EXIT_LOCATION");
  });

  it.each(["building_id", "building_version", "schema_version"])("rejects different %s", (field) => {
    expect(() => parseDisplay({ ...displayData, [field]: field === "building_id" ? "OTHER" : 99 }, building)).toThrow();
  });

  it.each(["floor_labels", "zone_labels", "node_labels", "exit_labels", "sources", "signs"] as const)("rejects missing and extra references in %s", (field) => {
    const value = structuredClone(displayData);
    const entries = value[field] as Record<string, unknown>;
    delete entries[Object.keys(entries)[0]];
    expect(() => parseDisplay(value, building)).toThrow();
    entries.UNKNOWN = "unknown";
    expect(() => parseDisplay(value, building)).toThrow();
  });

  it("rejects blank labels, malformed coordinates and incompatible sign kinds", () => {
    const blank = structuredClone(displayData);
    blank.node_labels["F2-S-A"] = " ";
    expect(() => parseDisplay(blank, building)).toThrow();
    const coordinate = structuredClone(displayData);
    coordinate.sources["CAM-F2-CORR-E"].installation.position.x = Infinity;
    expect(() => parseDisplay(coordinate, building)).toThrow();
    const exit = structuredClone(displayData);
    exit.signs["SIGN-F2-J-N3"].kind = "EXIT_LOCATION";
    expect(() => parseDisplay(exit, building)).toThrow();
  });

  it("rejects unknown installation floors and simulated equipment claiming measured positions", () => {
    const data = structuredClone(displayData);
    data.sources["CAM-F2-CORR-E"].installation.floor_id = "F9";
    expect(() => parseDisplay(data, building)).toThrow();
    data.sources["CAM-F2-CORR-E"].installation.floor_id = "F2";
    data.sources["CAM-F2-CORR-E"].installation.basis = "MEASURED";
    expect(() => parseDisplay(data, building)).toThrow();
  });

  it("uses the same labels in 3D and lists without turning unknown positions into camera locations", () => {
    const display = parseDisplay(displayData, building);
    const labels = sceneLabels(building, display, new Set(["F2"]));
    expect(labels.some((label) => label.text === display.node_labels["F2-D-R201"])).toBe(true);
    expect(labels.some((label) => label.text === display.node_labels["F2-S-B"])).toBe(true);
    const camera = labels.find((label) => label.text.includes(display.sources["CAM-F2-CORR-E"].label));
    expect(camera?.position).toEqual(display.sources["CAM-F2-CORR-E"].installation?.position);
    expect(labels.every((label) => label.floorId === "F2")).toBe(true);
    expect(labels.some((label) => label.text.includes("감지기"))).toBe(false);
    expect(sceneLabels(building, null, new Set(["F2"]))).toEqual([]);
  });
});


it("keeps camera and stair labels readable when room labels overlap, and restores them after zoom", () => {
  expect(visibleLabelIndexes([
    { left: 0, top: 0, width: 100, height: 30, priority: 2 },
    { left: 30, top: 10, width: 100, height: 30, priority: 0 },
    { left: 150, top: 0, width: 100, height: 30, priority: 1 },
  ])).toEqual(new Set([1, 2]));
  expect(visibleLabelIndexes([
    { left: 0, top: 0, width: 100, height: 30, priority: 2 },
    { left: 150, top: 0, width: 100, height: 30, priority: 0 },
  ])).toEqual(new Set([1, 0]));
});

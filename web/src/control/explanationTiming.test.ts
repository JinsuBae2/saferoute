import { afterEach, expect, it, vi } from "vitest";
import { explanationDeadline } from "./explanationTiming";
import { startPolling } from "./poll";

afterEach(() => vi.useRealTimers());

it("서버 시간과 왕복 지연으로만 만료 기한을 계산한다", () => {
  expect(explanationDeadline("2026-11-09T12:00:15Z", "2026-11-09T12:00:05Z", 100, 600)).toBe(10100);
});

it.each([
  [null, "2026-11-09T12:00:05Z"], ["2026-11-09T12:00:15Z", null],
  ["bad", "bad"], ["2026-11-09T12:00:05Z", "2026-11-09T12:00:05Z"],
  ["2026-11-09T12:00:25Z", "2026-11-09T12:00:05Z"],
])("시각이 없거나 만료/과도한 기한이면 표시하지 않는다", (expiry, server) => {
  expect(explanationDeadline(expiry, server, 100, 600)).toBe(null);
});

it("설명 응답이 멈춰도 상태 조회는 계속되고 정리 후 응답은 무시한다", async () => {
  vi.useFakeTimers();
  const state = vi.fn(async () => "state");
  const shown = vi.fn();
  let complete!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { complete = resolve; });
  const stopExplanation = startPolling(() => pending, shown, vi.fn(), 5000);
  const stopState = startPolling(state, vi.fn(), vi.fn(), 1000);
  await vi.advanceTimersByTimeAsync(2500);
  expect(state).toHaveBeenCalledTimes(3);
  expect(shown).not.toHaveBeenCalled();
  stopExplanation(); stopState(); complete("late");
  await vi.advanceTimersByTimeAsync(5000);
  expect(shown).not.toHaveBeenCalled();
  expect(state).toHaveBeenCalledTimes(3);
});

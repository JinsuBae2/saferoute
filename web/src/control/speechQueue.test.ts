/** 무효가 된 음성 안내가 이후에 재생되지 않는지 확인한다. 가짜 합성기는 브라우저처럼 요청과 실제 시작 사이에 틈을 둔다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BROADCAST_TEXT } from "./broadcast";
import { SpeechQueue } from "./speechQueue";
import { fakeSpeech } from "./speechFake";

describe("음성 대기열", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("아직 시작하지 않은(재생 대기) 출구 안내도 취소하면 이후 재생되지 않고 자막도 사라진다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    expect(queue.speaking).toBeNull();
    expect(queue.caption).toBe(BROADCAST_TEXT.EXIT);
    queue.cancel("EXIT");
    speech.drain();
    expect(speech.played).toEqual([]);
    expect(queue.caption).toBeNull();
    expect(queue.busy).toBe(false);
  });

  it("재생 중인 출구 안내를 취소하면 바로 끊긴다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    speech.next();
    expect(queue.speaking).toBe("EXIT");
    queue.cancel("EXIT");
    expect(speech.cancels).toBe(1);
    expect(queue.speaking).toBeNull();
    expect(queue.caption).toBeNull();
  });

  it("취소된 음성의 시작·종료 콜백이 뒤늦게 와도 새 음성의 상태를 바꾸지 못한다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say("이전 안내", "EXIT", 1, true);
    const old = speech.everRequested[0];
    queue.cancel("EXIT");
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, true);
    speech.next();
    old.on.start();
    expect(queue.speaking).toBe("BROADCAST");
    old.on.end();
    expect(queue.speaking).toBe("BROADCAST");
    expect(queue.caption).toBe(BROADCAST_TEXT.FIRE);
  });

  it("출구 안내를 취소할 때 함께 지워진 전체 방송은 돌려줘서 다시 내보낼 수 있다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, true);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    expect(queue.cancel("EXIT")).toEqual([BROADCAST_TEXT.FIRE]);
    // 취소할 출구 안내가 없으면 방송을 건드리지 않는다.
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, true);
    expect(queue.cancel("EXIT")).toEqual([]);
    expect(queue.has("BROADCAST")).toBe(true);
  });

  it("소리 없이 자막만 낼 때도 취소하면 자막이 바로 사라지고, 그냥 두면 잠시 뒤 사라진다", () => {
    const queue = new SpeechQueue(null);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, false);
    expect(queue.caption).toBe(BROADCAST_TEXT.EXIT);
    queue.cancel("EXIT");
    expect(queue.caption).toBeNull();
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, false);
    vi.advanceTimersByTime(6000);
    expect(queue.caption).toBeNull();
  });

  it("20초 동안 시작되지 않은 출구 안내는 합성기에서도 지워져, 그 뒤 무효가 돼도 뒤늦게 재생되지 않는다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    // 합성기가 시작·종료를 알려 주지 않은 채 20초가 지난다.
    vi.advanceTimersByTime(21_000);
    expect(queue.busy).toBe(false);
    // 그 뒤 출구가 막혀 안내가 무효가 된다.
    queue.cancel("EXIT");
    speech.drain();
    expect(speech.played).toEqual([]);
  });

  it("시작했지만 종료를 알려 주지 않는 음성도 20초 뒤 합성기에서 끊고, 늦은 종료 콜백이 새 안내를 건드리지 못한다", () => {
    const speech = fakeSpeech();
    const queue = new SpeechQueue(speech.port);
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    speech.next();
    const stuck = speech.everRequested[0];
    vi.advanceTimersByTime(21_000);
    expect(queue.busy).toBe(false);
    expect(speech.playing).toBeNull();
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, true);
    speech.next();
    stuck.on.end();
    expect(queue.speaking).toBe("BROADCAST");
    expect(queue.caption).toBe(BROADCAST_TEXT.FIRE);
  });

  it("시간 초과로 합성기를 비울 때 함께 지워진 다른 안내는 알려 줘서 유효하면 다시 내보낼 수 있다", () => {
    const speech = fakeSpeech();
    const lost: string[][] = [];
    const queue = new SpeechQueue(speech.port, () => {}, (texts) => lost.push(texts));
    queue.say(BROADCAST_TEXT.EXIT, "EXIT", 1, true);
    vi.advanceTimersByTime(15_000);
    queue.say(BROADCAST_TEXT.FIRE, "BROADCAST", 1, true);
    vi.advanceTimersByTime(6_000);
    // 멈춘 출구 안내만 버리고, 휩쓸려 지워진 화재 방송은 돌려준다.
    expect(lost).toEqual([[BROADCAST_TEXT.FIRE]]);
    speech.drain();
    expect(speech.played).toEqual([]);
  });
});

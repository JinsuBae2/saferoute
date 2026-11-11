/**
 * 소리 모듈 전체를 가짜 합성기로 돌려, 출구가 막히거나 바뀌거나 연결이 끊긴 뒤에
 * 이전 출구 안내가 재생되지 않는지 결과로 확인한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enableSound, resetSoundForTest, setAnnouncement, setExitGuide, soundStatus, stopSound, tickSoundForTest } from "./alarmSound";
import { BROADCAST_TEXT } from "./broadcast";
import { fakeSpeech } from "./speechFake";

const NEAR = { x: 0, z: 0, yaw: 0 };
const EXIT_A = { exitId: "EXIT-A", x: 0, z: 3 };
const EXIT_B = { exitId: "EXIT-B", x: 3, z: 0 };
const FIRE = { key: "run-1/fire", siren: true, loop: BROADCAST_TEXT.FIRE, once: null };

it("관제 종료는 방송 권한과 권한 대기를 해제하고 소리 장치를 닫는다", async () => {
  resetSoundForTest();
  let held: Promise<void> | undefined;
  let signal: AbortSignal | undefined;
  const close = vi.fn().mockResolvedValue(undefined);
  const node = () => ({ connect: (target: unknown) => target, start() {}, frequency: { value: 0 }, gain: { value: 0 } });
  vi.stubGlobal("window", { AudioContext: class {
    destination = {};
    resume = () => Promise.resolve();
    close = close;
    createOscillator = node;
    createGain = node;
  } });
  vi.stubGlobal("navigator", { locks: { request: (_name: string, options: { signal: AbortSignal }, granted: () => Promise<void>) => {
    signal = options.signal;
    held = granted();
    return held;
  } } });
  try {
    enableSound(fakeSpeech().port);
    expect(soundStatus().silencedByOtherWindow).toBe(false);
    stopSound();
    expect(signal?.aborted).toBe(true);
    await expect(held).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    resetSoundForTest();
    vi.unstubAllGlobals();
  }
});

describe("출구 유도 음성의 취소", () => {
  let speech: ReturnType<typeof fakeSpeech>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetSoundForTest();
    speech = fakeSpeech();
    enableSound(speech.port, false);
  });
  afterEach(() => {
    resetSoundForTest();
    vi.useRealTimers();
  });

  /** 출구 A 앞에 서서 출구 안내가 요청된 상태를 만든다. */
  const callExitA = () => {
    setExitGuide(EXIT_A, NEAR);
    tickSoundForTest();
    expect(speech.waiting).toEqual([BROADCAST_TEXT.EXIT]);
  };

  it("재생 대기 중에 출구가 막히면 그 안내는 끝내 재생되지 않고 자막도 지워진다", () => {
    callExitA();
    setExitGuide(null, NEAR);
    expect(soundStatus().caption).toBeNull();
    expect(soundStatus().exit).toBeNull();
    speech.drain();
    expect(speech.played).not.toContain(BROADCAST_TEXT.EXIT);
  });

  it("재생 중에 출구가 막히면 바로 끊고, 이후 틱에서도 다시 부르지 않는다", () => {
    callExitA();
    speech.next();
    setExitGuide(null, NEAR);
    expect(speech.cancels).toBeGreaterThan(0);
    for (let step = 0; step < 50; step += 1) { vi.advanceTimersByTime(400); tickSoundForTest(); speech.drain(); }
    expect(speech.played.filter((text) => text === BROADCAST_TEXT.EXIT)).toHaveLength(1);
  });

  it("출구 A에서 B로 바뀌면 A를 부르던 음성을 끊고 B를 새로 부른다", () => {
    callExitA();
    setExitGuide(EXIT_B, NEAR);
    expect(speech.waiting).toEqual([]);
    tickSoundForTest();
    expect(speech.waiting).toEqual([BROADCAST_TEXT.EXIT]);
    expect(soundStatus().exit?.exitId).toBe("EXIT-B");
  });

  it("연결이 끊겨 출구 안내가 사라져도 사이렌과 전체 경보 방송은 이어진다", () => {
    setAnnouncement(FIRE);
    callExitA();
    // 연결 끊김: 방송 문장은 끊김 안내로 바뀌고 출구 안내는 없어진다.
    setAnnouncement({ key: "run-1/fire", siren: true, loop: BROADCAST_TEXT.STALE, once: null });
    setExitGuide(null, NEAR);
    tickSoundForTest();
    expect(soundStatus().siren).toBe(true);
    speech.drain();
    expect(speech.played).toEqual([BROADCAST_TEXT.STALE]);
  });

  it("출구 안내를 끊을 때 함께 지워진 전체 방송은 곧바로 다시 내보낸다", () => {
    setAnnouncement(FIRE);
    tickSoundForTest();
    expect(speech.waiting).toEqual([BROADCAST_TEXT.FIRE]);
    speech.next();
    setExitGuide(EXIT_A, NEAR);
    // 방송이 나가는 중에는 출구 안내가 끼어들지 않으므로, 방송이 끝난 뒤 출구 안내가 줄에 선다.
    speech.finish();
    tickSoundForTest();
    expect(speech.waiting).toEqual([BROADCAST_TEXT.EXIT]);
    setExitGuide(null, NEAR);
    speech.drain();
    expect(speech.played).toEqual([BROADCAST_TEXT.FIRE]);
    expect(soundStatus().siren).toBe(true);
  });

  it("처음부터 출구 안내가 없으면(평상시 대기) 아무것도 부르지 않는다", () => {
    setExitGuide(null, null);
    for (let step = 0; step < 20; step += 1) { vi.advanceTimersByTime(400); tickSoundForTest(); }
    speech.drain();
    expect(speech.played).toEqual([]);
  });

  it("관제 화면을 떠나면 재생과 반복 방송을 끝내고 다음 화면에서 다시 말하지 않는다", () => {
    setAnnouncement(FIRE);
    tickSoundForTest();
    speech.next();
    stopSound();
    expect(speech.playing).toBeNull();
    vi.advanceTimersByTime(30_000);
    speech.drain();
    expect(speech.played).toEqual([BROADCAST_TEXT.FIRE]);
    expect(soundStatus()).toMatchObject({ enabled: false, siren: false, caption: null, exit: null });
  });

  it("20초 넘게 시작되지 않은 출구 안내가 있어도, 출구가 막힌 뒤에는 어떤 출구 안내도 재생되지 않는다", () => {
    callExitA();
    vi.advanceTimersByTime(21_000);
    setExitGuide(null, NEAR);
    speech.drain();
    expect(speech.played).not.toContain(BROADCAST_TEXT.EXIT);
  });
  it("출구가 바뀌어도 지워진 것이 없으면 전체 방송을 앞당겨 되풀이하지 않는다", () => {
    setAnnouncement(FIRE);
    tickSoundForTest();
    speech.drain();
    setExitGuide(EXIT_A, { x: 0, z: 100, yaw: 0 });
    setExitGuide(EXIT_B, { x: 0, z: 100, yaw: 0 });
    tickSoundForTest();
    speech.drain();
    expect(speech.played).toEqual([BROADCAST_TEXT.FIRE]);
  });

  it("멈춘 출구 안내를 정리하다 함께 지워진 해제 방송은, 그 사이 새 화재가 났으면 되살리지 않는다", () => {
    setAnnouncement({ key: "run-1/", siren: false, loop: null, once: null });
    callExitA();
    vi.advanceTimersByTime(15_000);
    // 출구 안내가 줄에서 멈춰 있는 동안 해제 방송이 나가고, 곧바로 새 화재가 난다.
    setAnnouncement({ key: "run-1/", siren: false, loop: null, once: BROADCAST_TEXT.ALL_CLEAR });
    tickSoundForTest();
    setAnnouncement(FIRE);
    for (let step = 0; step < 80; step += 1) { vi.advanceTimersByTime(400); speech.drain(); }
    expect(speech.played).not.toContain(BROADCAST_TEXT.ALL_CLEAR);
    expect(speech.played).toContain(BROADCAST_TEXT.FIRE);
  });
});


describe("일회성 방송과 최신 경보 상태", () => {
  let speech: ReturnType<typeof fakeSpeech>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetSoundForTest();
    speech = fakeSpeech();
    enableSound(speech.port, false);
  });
  afterEach(() => {
    resetSoundForTest();
    vi.useRealTimers();
  });

  const fire = (key = "run-1/fire") => ({ key, siren: true, loop: BROADCAST_TEXT.FIRE, once: null });
  const allClear = (key = "run-1/") => ({ key, siren: false, loop: null, once: BROADCAST_TEXT.ALL_CLEAR });
  const quiet = (key = "run-1/") => ({ key, siren: false, loop: null, once: null });
  /** 남은 줄을 끝까지 재생하며 몇 틱을 더 돌린다. */
  const run = (ticks = 5) => { for (let step = 0; step < ticks; step += 1) { tickSoundForTest(); speech.drain(); vi.advanceTimersByTime(400); } };

  it("전체 해제 방송이 나가기 전에 새 화재가 나면 해제 방송은 버리고 화재 방송을 낸다", () => {
    setAnnouncement(fire());
    run();
    setAnnouncement(allClear());
    // 다음 재생 틱 전에 재발화.
    setAnnouncement(fire("run-1/fire-2"));
    run();
    expect(speech.played).not.toContain(BROADCAST_TEXT.ALL_CLEAR);
    expect(speech.played.at(-1)).toBe(BROADCAST_TEXT.FIRE);
    expect(soundStatus().siren).toBe(true);
  });

  it("전체 해제 방송이 재생 중일 때 새 화재가 나면 해제 방송을 끊고 화재 방송을 낸다", () => {
    setAnnouncement(allClear());
    tickSoundForTest();
    speech.next();
    expect(speech.playing).toBe(BROADCAST_TEXT.ALL_CLEAR);
    setAnnouncement(fire("run-1/fire-2"));
    expect(speech.playing).toBeNull();
    expect(soundStatus().caption).toBeNull();
    run();
    expect(speech.played.at(-1)).toBe(BROADCAST_TEXT.FIRE);
  });

  it("새 실행으로 초기화되면 이전 실행의 해제 방송은 대기 중이든 재생 중이든 나오지 않는다", () => {
    setAnnouncement(allClear());
    setAnnouncement(quiet("run-2/"));
    run();
    expect(speech.played).toEqual([]);
    setAnnouncement(allClear("run-2/"));
    tickSoundForTest();
    speech.next();
    setAnnouncement(quiet("run-3/"));
    expect(speech.playing).toBeNull();
  });

  it("같은 상태가 다시 전달돼도 유효한 해제 방송은 사라지지 않고, 한 번만 나온다", () => {
    setAnnouncement(allClear());
    // 화면이 같은 경보 상태를 다시 넘긴다(한 번짜리 문장 없이).
    setAnnouncement(quiet());
    setAnnouncement(quiet());
    run(40);
    expect(speech.played.filter((text) => text === BROADCAST_TEXT.ALL_CLEAR)).toHaveLength(1);
  });

  it("재생 중인 유효한 해제 방송은 같은 상태가 다시 전달돼도 끊기지 않는다", () => {
    setAnnouncement(allClear());
    tickSoundForTest();
    speech.next();
    setAnnouncement(quiet());
    expect(speech.playing).toBe(BROADCAST_TEXT.ALL_CLEAR);
  });
});

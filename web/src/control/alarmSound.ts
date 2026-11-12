/**
 * 사이렌·방송·출구 유도음을 실제로 내는 곳. 무엇을 낼지는 broadcast.ts가 정하고 여기서는 재생만 한다.
 * - 브라우저 정책상 사용자가 한 번 누른 뒤에만 소리가 난다(enable). 그 뒤로는 경보 변화에 스스로 반응한다.
 * - 관제 화면이 여러 창이어도 한 창만 소리를 낸다(Web Locks). 유도등 화면은 이 모듈을 쓰지 않는다.
 * - 자막은 음소거와 무관하게 항상 갱신한다.
 */
import { storageScope } from "../api/scope";
import type { Announcement, ExitCall, Listener } from "./broadcast";
import { BROADCAST_TEXT, exitSound } from "./broadcast";
import { SpeechQueue } from "./speechQueue";
import type { SpeechPort } from "./speechQueue";

export type SoundStatus = {
  /** 사용자가 소리를 켰는지. */
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly volume: number;
  /** 지금 내보내는 문장. 음소거여도 채운다. */
  readonly caption: string | null;
  readonly siren: boolean;
  /** 다른 관제 창이 소리를 맡고 있어 이 창은 내지 않음. */
  readonly silencedByOtherWindow: boolean;
  /** 1인칭에서 부르고 있는 출구와 거리. */
  readonly exit: { readonly exitId: string; readonly metres: number } | null;
};

const LOOP_GAP_MS = 12_000;
const EXIT_GAP_MS = 7_000;

let status: SoundStatus = { enabled: false, muted: false, volume: 0.6, caption: null, siren: false, silencedByOtherWindow: false, exit: null };
const subscribers = new Set<() => void>();
const set = (patch: Partial<SoundStatus>) => {
  status = { ...status, ...patch };
  subscribers.forEach((notify) => notify());
};

let announcement: Announcement = { key: "", siren: false, loop: null, once: null };
/** 한 번짜리 방송과 그것이 만들어진 경보 상태. 상태가 달라지면 무효다. */
type Once = { readonly text: string; readonly key: string };
/** 아직 내보내지 않은 한 번짜리 방송. */
let pendingOnce: Once | null = null;
/** 마지막으로 내보낸 한 번짜리 방송. 재생 중에 상태가 바뀌면 끊는 데 쓴다. */
let spokenOnce: Once | null = null;
let exit: ExitCall | null = null;
let listener: Listener | null = null;
let owner = false;
let ownershipRequest: AbortController | null = null;
let releaseOwnership: (() => void) | null = null;
let context: AudioContext | null = null;
let sirenGain: GainNode | null = null;
// 음성은 대기열이 맡는다. 자막은 대기열에 살아 있는 안내의 문장만 보여 준다.
const syncCaption = () => { if (status.caption !== queue.caption) set({ caption: queue.caption }); };
/** 합성기를 비우면서 함께 지워진 안내 가운데 지금도 유효한 것만 되살린다. */
const restore = (texts: string[]) => {
  // 되풀이 방송과 출구 안내는 다음 틱이 '지금의' 문장·출구로 다시 정하므로 간격만 푼다. 옛 문장을 그대로 되살리지 않고,
  // 지워진 것이 지금도 내보낼 문장일 때만 푼다.
  if (announcement.loop !== null && texts.includes(announcement.loop)) lastLoopAt = -Infinity;
  if (texts.includes(BROADCAST_TEXT.EXIT)) lastExitAt = -Infinity;
  // 한 번짜리 방송은 나가던 것이 지금 경보 상태의 것일 때만 다시 건다.
  if (spokenOnce !== null && spokenOnce.key === announcement.key && texts.includes(spokenOnce.text)) pendingOnce = spokenOnce;
};
const newQueue = (port: SpeechPort | null) => new SpeechQueue(port, syncCaption, restore);
let queue = newQueue(null);
let lastLoopAt = -Infinity;
let lastExitAt = -Infinity;
let lastBeepAt = -Infinity;
let ticker: ReturnType<typeof setInterval> | undefined;

const audible = () => status.enabled && !status.muted && owner;

function say(text: string, kind: "BROADCAST" | "EXIT", volume = 1) {
  queue.say(text, kind, status.volume * volume, audible());
}

/** 브라우저 음성 합성기. 없는 환경이면 null이고 자막만 나온다. */
function browserSpeech(): SpeechPort | null {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return null;
  return {
    speak: (text, volume, on) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ko-KR";
      utterance.volume = volume;
      utterance.onstart = on.start;
      utterance.onend = utterance.onerror = on.end;
      speechSynthesis.speak(utterance);
    },
    cancel: () => speechSynthesis.cancel(),
  };
}

/** 출구 쪽에서 들리는 짧은 유도음. 좌우와 크기로 방향·거리를 알린다. */
function beep(pan: number, gain: number) {
  if (context === null || !audible() || gain <= 0.01) return;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const panner = context.createStereoPanner();
  oscillator.frequency.value = 880;
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  const now = context.currentTime;
  envelope.gain.setValueAtTime(0, now);
  envelope.gain.linearRampToValueAtTime(0.5 * gain * status.volume, now + 0.02);
  envelope.gain.linearRampToValueAtTime(0, now + 0.25);
  oscillator.connect(envelope).connect(panner).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.3);
}

function tick() {
  const now = performance.now();
  // 사이렌: 경보가 있는 동안 계속. 방송 중에는 낮춰 말이 들리게 한다.
  if (sirenGain !== null && context !== null) {
    const target = audible() && announcement.siren ? (queue.speaking === null ? 0.12 : 0.025) * status.volume : 0;
    sirenGain.gain.setTargetAtTime(target, context.currentTime, 0.15);
  }
  if (status.siren !== announcement.siren) set({ siren: announcement.siren });
  if (pendingOnce !== null) {
    // 해제 방송은 되풀이 방송보다 먼저다. 말하던 것과 기다리던 것을 모두 끊고 바로 알린다.
    queue.cancel();
    spokenOnce = pendingOnce;
    pendingOnce = null;
    say(spokenOnce.text, "BROADCAST");
    lastLoopAt = now;
    return;
  }
  const near = exit !== null && listener !== null ? exitSound(listener, exit) : null;
  const shownExit = exit !== null && near !== null ? { exitId: exit.exitId, metres: Math.round(near.metres) } : null;
  if (status.exit?.exitId !== shownExit?.exitId || status.exit?.metres !== shownExit?.metres) set({ exit: shownExit });
  if (near !== null && near.gain > 0) {
    if (now - lastBeepAt > 1500) {
      beep(near.pan, near.gain);
      lastBeepAt = now;
    }
    // 1인칭에서는 출구 유도 음성이 우선이고, 전체 방송은 그 사이에 낀다.
    if (!queue.busy && now - lastExitAt > EXIT_GAP_MS) {
      say(BROADCAST_TEXT.EXIT, "EXIT", 0.35 + 0.65 * near.gain);
      lastExitAt = now;
      return;
    }
  }
  if (announcement.loop !== null && !queue.busy && now - lastLoopAt > LOOP_GAP_MS) {
    say(announcement.loop, "BROADCAST");
    lastLoopAt = now;
  }
}

/**
 * 사용자 동작(시연 시작·소리 켜기)에서 부른다. 이후 경보 변화에는 자동으로 반응한다.
 * 인자는 시험용이다. 음성 합성기를 바꿔 끼우고, 창 사이 독점(exclusive)을 끌 수 있다.
 */
export function enableSound(port: SpeechPort | null = browserSpeech(), exclusive = true) {
  if (status.enabled) return;
  queue.cancel();
  queue = newQueue(port);
  const Context = typeof window === "undefined" ? undefined : window.AudioContext;
  if (Context !== undefined) {
    context = new Context();
    void context.resume();
    // 두 음을 오가는 사이렌.
    const oscillator = context.createOscillator();
    const wobble = context.createOscillator();
    const depth = context.createGain();
    sirenGain = context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.value = 760;
    wobble.frequency.value = 0.6;
    depth.gain.value = 240;
    sirenGain.gain.value = 0;
    wobble.connect(depth).connect(oscillator.frequency);
    oscillator.connect(sirenGain).connect(context.destination);
    oscillator.start();
    wobble.start();
  }
  // 한 창만 소리를 낸다. 관제에서 나오거나 창을 닫으면 다른 관제 창이 이어받는다.
  if (!exclusive || typeof navigator === "undefined" || navigator.locks === undefined) owner = true;
  else {
    set({ silencedByOtherWindow: true });
    const request = new AbortController();
    ownershipRequest = request;
    void navigator.locks.request(`saferoute-alarm-sound-${storageScope()}`, { signal: request.signal }, () => {
      owner = true;
      set({ silencedByOtherWindow: false });
      return new Promise<void>((resolve) => { releaseOwnership = resolve; });
    }).catch(() => {
      if (ownershipRequest === request) stopSound();
    });
  }
  set({ enabled: true });
  ticker ??= setInterval(tick, 400);
}

export function setMuted(muted: boolean) {
  if (muted) queue.cancel();
  set({ muted });
}

export function setVolume(volume: number) {
  set({ volume: Math.max(0, Math.min(1, volume)) });
}

/**
 * 서버 상태에서 정한 방송을 넘긴다.
 * 한 번짜리 방송(일부 해제·전체 해제)은 그것이 만들어진 경보 상태에서만 유효하다. 새 화재가 나거나 새 실행이 되면
 * 기다리던 것은 버리고 재생 중인 것은 끊는다. 같은 상태가 다시 전달되는 것만으로는 버리지도, 다시 내지도 않는다.
 */
export function setAnnouncement(next: Announcement) {
  if (next.once !== null) pendingOnce = { text: next.once, key: next.key };
  else if (pendingOnce !== null && pendingOnce.key !== next.key) pendingOnce = null;
  const staleOnce = spokenOnce !== null && spokenOnce.key !== next.key && queue.holds(spokenOnce.text);
  const staleLoop = announcement.loop !== null && next.loop !== announcement.loop && queue.holds(announcement.loop);
  if (next.loop !== announcement.loop) lastLoopAt = -Infinity;
  announcement = next;
  // 무효가 된 문장만 끊는다. 재생 중이든 대기 중이든 같다. 함께 지워진 출구 안내는 아직 유효하면 다음 틱에 다시 부른다.
  if (staleOnce || staleLoop) restore(queue.cancel("BROADCAST"));
  // 소리를 켜지 않았어도 자막은 나와야 한다.
  ticker ??= setInterval(tick, 400);
}

/**
 * 1인칭에서 부를 출구와 듣는 위치. 출구가 바뀌거나(다른 출구·차단·연결 끊김·탈출·1인칭 종료) 사라지면
 * 이전 출구의 음성을 재생 중·대기 중 가리지 않고 바로 끊는다. 자막도 함께 사라진다.
 * 사이렌은 건드리지 않고, 함께 지워진 전체 방송은 곧바로 다시 내보낸다.
 */
export function setExitGuide(next: ExitCall | null, at: Listener | null) {
  if (next?.exitId !== exit?.exitId) {
    restore(queue.cancel("EXIT"));
    lastExitAt = -Infinity;
    lastBeepAt = -Infinity;
  }
  exit = next;
  listener = at;
  if (next === null && status.exit !== null) set({ exit: null });
}

/** 시험에서 한 틱을 직접 돌리고 처음 상태로 되돌리는 데 쓴다. */
export function tickSoundForTest() {
  tick();
}

/** 관제를 떠나면 오래된 경보 재생과 다른 창의 방송을 막는 권한을 모두 정리한다. */
export function stopSound() {
  clearInterval(ticker);
  ticker = undefined;
  queue.cancel();
  queue = newQueue(null);
  announcement = { key: "", siren: false, loop: null, once: null };
  pendingOnce = null;
  spokenOnce = null;
  exit = null;
  listener = null;
  owner = false;
  const request = ownershipRequest;
  ownershipRequest = null;
  request?.abort();
  releaseOwnership?.();
  releaseOwnership = null;
  if (context !== null) void context.close();
  context = null;
  sirenGain = null;
  lastLoopAt = lastExitAt = lastBeepAt = -Infinity;
  set({ enabled: false, caption: null, siren: false, silencedByOtherWindow: false, exit: null });
}

export function resetSoundForTest() {
  stopSound();
  status = { enabled: false, muted: false, volume: 0.6, caption: null, siren: false, silencedByOtherWindow: false, exit: null };
}

export function soundStatus(): SoundStatus {
  return status;
}

export function subscribeSound(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/**
 * 음성 안내의 대기열. 무효가 된 안내가 뒤늦게 재생되지 않게 하는 것이 이 파일의 일이다.
 *
 * 브라우저 음성 합성은 speak()를 부른 뒤 실제 시작(onstart)까지 틈이 있고, cancel()은 종류를 가리지 않고 전부 지운다.
 * 그래서 요청한 순간부터 끝날 때까지 항목을 직접 들고 있으면서, 대기 중인 것도 재생 중인 것과 똑같이 취소한다.
 * 취소된 음성의 콜백이 나중에 도착해도 항목이 이미 없으므로 새 상태를 건드리지 못한다.
 */
export type SpeechKind = "BROADCAST" | "EXIT";

/** 실제 음성 합성기. 시험에서는 가짜를 끼운다. start는 소리가 실제로 나기 시작할 때, end는 끝나거나 실패했을 때 부른다. */
export type SpeechPort = {
  speak(text: string, volume: number, on: { start(): void; end(): void }): void;
  /** 재생 중인 것과 대기 중인 것을 모두 지운다. */
  cancel(): void;
};

type Entry = { readonly id: number; readonly kind: SpeechKind; readonly text: string; started: boolean; timer: ReturnType<typeof setTimeout> };

/** 소리 없이 자막만 낼 때 자막을 띄워 두는 시간. */
export const CAPTION_MS = 5_000;
/**
 * 합성기가 이 시간 안에 끝났다고 알려 주지 않으면 멈춘 것으로 본다.
 * 이때 기록만 지우면 합성기 안에는 문장이 남아 나중에 재생될 수 있으므로, 합성기까지 함께 비운다.
 */
export const STUCK_MS = 20_000;

export class SpeechQueue {
  private entries: Entry[] = [];
  private nextId = 1;

  /**
   * changed: 자막·재생 상태가 바뀌었다.
   * lost: 멈춘 음성을 정리하느라 합성기를 비우면서 함께 지워진 다른 안내의 문장들. 받은 쪽이 지금도 유효한 것만 다시 요청한다.
   */
  constructor(
    private readonly port: SpeechPort | null,
    private readonly changed: () => void = () => {},
    private readonly lost: (texts: string[]) => void = () => {},
  ) {}

  /** 재생을 요청한다. audible이 아니면 소리 없이 자막만 잠시 띄운다. */
  say(text: string, kind: SpeechKind, volume: number, audible: boolean): void {
    const id = this.nextId++;
    const live = () => this.entries.find((entry) => entry.id === id);
    const finish = () => {
      const entry = live();
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      this.entries = this.entries.filter((item) => item !== entry);
      this.changed();
    };
    const spoken = audible && this.port !== null;
    // 합성기에 넘긴 음성이 멈추면 합성기의 대기열과 재생을 모두 지운다. cancel은 전부 지우므로 기록도 전부 비우고,
    // 함께 지워진 다른 안내는 알려 준다. 멈춘 음성 자체는 돌려주지 않는다(이미 들렸을 수 있어 되풀이하지 않는다).
    const stuck = () => {
      const entry = live();
      if (entry === undefined) return;
      const others = this.entries.filter((item) => item !== entry).map((item) => item.text);
      for (const item of this.entries) clearTimeout(item.timer);
      this.entries = [];
      this.port?.cancel();
      this.changed();
      if (others.length > 0) this.lost(others);
    };
    this.entries.push({ id, kind, text, started: !spoken, timer: setTimeout(spoken ? stuck : finish, spoken ? STUCK_MS : CAPTION_MS) });
    if (spoken && this.port !== null) {
      this.port.speak(text, Math.max(0, Math.min(1, volume)), {
        start: () => {
          const entry = live();
          if (entry === undefined) return;
          entry.started = true;
          this.changed();
        },
        end: finish,
      });
    }
    this.changed();
  }

  /**
   * 그 종류의 음성을 재생 중·대기 중 가리지 않고 없앤다(kind를 주지 않으면 전부).
   * 합성기의 cancel은 다른 종류까지 지우므로, 함께 지워진 다른 종류의 문장을 돌려준다. 부른 쪽이 필요하면 다시 요청한다.
   */
  cancel(kind?: SpeechKind): string[] {
    const hit = this.entries.filter((entry) => kind === undefined || entry.kind === kind);
    if (hit.length === 0) return [];
    const lost = this.entries.filter((entry) => !hit.includes(entry));
    for (const entry of this.entries) clearTimeout(entry.timer);
    this.entries = [];
    this.port?.cancel();
    this.changed();
    return lost.map((entry) => entry.text);
  }

  /** 지금 소리가 나고 있는 음성의 종류. */
  get speaking(): SpeechKind | null {
    return this.entries.find((entry) => entry.started)?.kind ?? null;
  }

  /** 재생 중이거나 대기 중인 음성이 있는지. */
  get busy(): boolean {
    return this.entries.length > 0;
  }

  has(kind: SpeechKind): boolean {
    return this.entries.some((entry) => entry.kind === kind);
  }

  /** 그 문장이 재생 중이거나 대기 중인지. */
  holds(text: string): boolean {
    return this.entries.some((entry) => entry.text === text);
  }

  /** 자막. 유효한 안내의 문장만 보인다. 취소되면 바로 사라진다. */
  get caption(): string | null {
    return this.entries.at(-1)?.text ?? null;
  }
}

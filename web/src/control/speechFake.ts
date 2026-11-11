/** 시험용 가짜 음성 합성기. 브라우저처럼 요청과 실제 시작 사이에 틈을 둔다. */
import type { SpeechPort } from "./speechQueue";

/** 요청을 줄 세워 두었다가 next()로 하나씩 시작하고, finish()로 끝낸다. cancel은 줄과 재생 중인 것을 모두 지운다. */
export function fakeSpeech() {
  type Item = { text: string; on: { start(): void; end(): void } };
  const waiting: Item[] = [];
  const everRequested: Item[] = [];
  const played: string[] = [];
  let playing: Item | null = null;
  let cancels = 0;
  const port: SpeechPort = {
    speak: (text, _volume, on) => { const item = { text, on }; waiting.push(item); everRequested.push(item); },
    cancel: () => { cancels += 1; waiting.length = 0; playing = null; },
  };
  return {
    port, played, everRequested,
    get cancels() { return cancels; },
    get waiting() { return waiting.map((item) => item.text); },
    /** 지금 소리가 나고 있는 문장. */
    get playing() { return playing?.text ?? null; },
    /** 줄 맨 앞의 음성이 실제로 나기 시작한다. */
    next() {
      const item = waiting.shift();
      if (item === undefined) return false;
      playing = item;
      played.push(item.text);
      item.on.start();
      return true;
    },
    finish() { const item = playing; playing = null; item?.on.end(); },
    /** 남은 것을 전부 재생해 본다. 무효가 된 안내가 있으면 played에 나타난다. */
    drain() { while (this.next()) this.finish(); },
  };
}

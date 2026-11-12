import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "./id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("HTTP 주소처럼 crypto.randomUUID가 없어도 UUID v4를 만든다", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes) });
    const first = newId();
    expect(first).toMatch(UUID_V4);
    expect(newId()).not.toBe(first);
  });

  it("있으면 브라우저 것을 쓴다", () => {
    expect(newId()).toMatch(UUID_V4);
  });
});

const realCrypto = globalThis.crypto;

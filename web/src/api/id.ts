/**
 * 새 식별자(UUID v4 형식).
 * crypto.randomUUID는 HTTPS와 localhost에서만 있다. 공개 서버는 HTTP라 그대로 쓰면
 * 「시연 시작」과 유도등 화면이 "crypto.randomUUID is not a function"으로 멈춘다.
 * getRandomValues는 HTTP에서도 쓸 수 있다.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

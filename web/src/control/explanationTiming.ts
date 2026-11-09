/** Server clock plus conservative round-trip subtraction; never use the PC's wall clock. */
export function explanationDeadline(
  expiresAt: string | null,
  serverTime: string | null,
  startedMs: number,
  receivedMs: number,
): number | null {
  if (expiresAt === null || serverTime === null) return null;
  const remaining = Date.parse(expiresAt) - Date.parse(serverTime) - (receivedMs - startedMs);
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 15000 || receivedMs < startedMs) return null;
  return receivedMs + remaining;
}

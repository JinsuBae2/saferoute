/** Each source owns its loop so an unavailable explanation never delays state. */
export function startPolling<T>(
  fetchValue: (signal: AbortSignal) => Promise<T>,
  success: (value: T) => void,
  failure: (error: unknown) => void,
  intervalMs: number,
): () => void {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    try {
      const value = await fetchValue(AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]));
      if (!abort.signal.aborted) success(value);
    } catch (error) {
      if (!abort.signal.aborted) failure(error);
    } finally {
      if (!abort.signal.aborted) timer = setTimeout(() => void tick(), intervalMs);
    }
  }
  void tick();
  return () => { abort.abort(); clearTimeout(timer); };
}

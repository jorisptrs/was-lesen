/** A cancellable delay. Rejects with an AbortError-named Error if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      abort();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

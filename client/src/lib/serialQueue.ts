/**
 * A queue that runs its items ONE AT A TIME, with a cancel that in-flight work can see.
 *
 * Both properties are load-bearing for manual suggestions. Sequential, because each suggestion
 * posts the current map back and returns a recomputed one — two in flight would both build on
 * the same map and the second would silently discard the first. Cancellable, because a request
 * that is still running when a new run starts must NOT apply its result: it would drop a stale
 * map on top of the run in progress.
 *
 * `run` receives `isCurrent()` and must check it after every await before touching app state.
 * Framework-free so it can be tested directly rather than through a component.
 */
export interface SerialQueue<T> {
  push: (item: T) => void;
  /** Drop everything pending; in-flight work sees `isCurrent()` turn false. */
  reset: () => void;
  /** Items waiting, including the one currently running. */
  size: () => number;
  has: (predicate: (item: T) => boolean) => boolean;
}

export function serialQueue<T>(opts: {
  /** `waiting` is how many items sit behind this one — for a "· 2 waiting" status line. */
  run: (item: T, isCurrent: () => boolean, waiting: number) => Promise<void>;
  onSizeChange?: (size: number) => void;
  onBusyChange?: (busy: boolean) => void;
}): SerialQueue<T> {
  const items: T[] = [];
  let draining = false;
  let generation = 0;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    const started = generation;
    const isCurrent = () => started === generation;
    opts.onBusyChange?.(true);
    try {
      while (items.length > 0 && isCurrent()) {
        try {
          await opts.run(items[0]!, isCurrent, items.length - 1);
        } catch (err) {
          // Callers are expected to handle their own failures (they own the user-facing
          // message), but one that escapes must not wedge the queue or surface as an unhandled
          // rejection — drop the item and keep going.
          console.warn("[queue] item failed:", err instanceof Error ? err.message : err);
        }
        if (!isCurrent()) return;
        items.shift();
        opts.onSizeChange?.(items.length);
      }
    } finally {
      draining = false;
      opts.onBusyChange?.(false);
    }
  };

  return {
    push: (item) => {
      items.push(item);
      opts.onSizeChange?.(items.length);
      void drain();
    },
    reset: () => {
      generation++;
      items.length = 0;
      opts.onSizeChange?.(0);
    },
    size: () => items.length,
    has: (predicate) => items.some(predicate),
  };
}

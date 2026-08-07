import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared persistence kit for the small on-disk stores (published run, past reads): lazy save,
// debounced, written atomically, and flushed on shutdown.

type Flush = () => void;
const registered = new Set<Flush>();
let shutdownHooked = false;

/**
 * ONE shutdown handler for every store. This is correctness, not tidiness: a store that
 * registers its own `process.once("SIGTERM", () => { flush(); process.exit(0) })` ends the
 * process from inside the FIRST handler, so any other store's handler never runs and its
 * unwritten changes are lost on every Ctrl-C. One registry flushes them all, then exits once.
 */
function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      for (const flush of registered) {
        try {
          flush();
        } catch {
          // one store failing to write must not stop the others from trying
        }
      }
      process.exit(0);
    });
  }
}

export interface PersistedFile {
  /** Debounced write — call after every mutation; bursts collapse into one write. */
  save: () => void;
  /** Write now, cancelling any pending debounce (shutdown, and tests). */
  flushNow: () => void;
  /** True while a write is queued — i.e. memory is ahead of disk. */
  hasPending: () => boolean;
}

/**
 * A file that writes itself. `serialize` is called at write time (not at `save` time), so the
 * caller can mutate freely and the last state wins.
 */
export function persistedFile(opts: {
  /** Log prefix, e.g. "publish". */
  label: string;
  file: string;
  serialize: () => string;
  debounceMs?: number;
}): PersistedFile {
  let timer: NodeJS.Timeout | null = null;

  const write = (): void => {
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      // Write-then-rename: a crash mid-write must not truncate the only copy.
      writeFileSync(`${opts.file}.tmp`, opts.serialize());
      renameSync(`${opts.file}.tmp`, opts.file);
    } catch (err) {
      console.warn(`[${opts.label}] persist failed:`, err instanceof Error ? err.message : err);
    }
  };

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    write();
  };

  const save = (): void => {
    hookShutdown();
    registered.add(pendingFlush);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      write();
    }, opts.debounceMs ?? 2000);
    timer.unref?.(); // never keep the process alive just to flush
  };

  // Only flush on shutdown if a write is actually pending — a store nobody touched shouldn't
  // rewrite (and possibly downgrade) a file another process may have edited.
  const pendingFlush: Flush = () => {
    if (timer) flushNow();
  };

  return { save, flushNow, hasPending: () => timer !== null };
}

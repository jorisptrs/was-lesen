import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SavedRun } from "@sb/shared";

// THE published run — a single slot. The main page shows it to everyone; publishing a new
// run replaces it. Persisted like books/cache.ts (lazy load + debounced write) so a
// laptop-host restart keeps it; on ephemeral hosts (Render free) a deploy clears it and the
// organizer re-publishes from a saved JSON in one click.

interface PublishedRun {
  run: SavedRun;
  publishedAt: string;
}

const DIR = join(homedir(), ".cache", "satisfying-books");
const FILE = join(DIR, "published-run.json");
let current: PublishedRun | null = null;
let loaded = false;
let writeTimer: NodeJS.Timeout | null = null;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as PublishedRun | null;
    // Cheap shape check: a file from another app version must not 500 the main page.
    if (parsed && typeof parsed.publishedAt === "string" && Array.isArray(parsed.run?.scored?.books)) {
      current = parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[publish] could not read published-run.json — starting empty:", err instanceof Error ? err.message : err);
    }
  }
}

function flush(): void {
  try {
    mkdirSync(DIR, { recursive: true });
    // Write-then-rename: a crash mid-write must not truncate the only copy.
    writeFileSync(`${FILE}.tmp`, JSON.stringify(current));
    renameSync(`${FILE}.tmp`, FILE);
  } catch (err) {
    console.warn("[publish] persist failed:", err instanceof Error ? err.message : err);
  }
}

// A deploy/Ctrl-C inside the 2s debounce must not drop a just-published run.
let shutdownHooked = false;
function hookShutdownFlush(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
        flush();
      }
      process.exit(0);
    });
  }
}

function scheduleWrite(): void {
  hookShutdownFlush();
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 2000);
  writeTimer.unref?.(); // never keep the process alive just to flush
}

export function publishRun(run: SavedRun): PublishedRun {
  loadOnce();
  current = { run, publishedAt: new Date().toISOString() };
  scheduleWrite();
  return current;
}

export function getPublishedRun(): PublishedRun | null {
  loadOnce();
  return current;
}

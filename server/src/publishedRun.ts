import { readFileSync } from "node:fs";
import type { SavedRun } from "@sb/shared";
import { cacheFile } from "./util/paths";
import { persistedFile } from "./util/persist";

// THE published run — a single slot. The main page shows it to everyone; publishing a new
// run replaces it. Persisted like books/cache.ts (lazy load + debounced write) so a
// laptop-host restart keeps it; on ephemeral hosts (Render free) a deploy clears it and the
// organizer re-publishes from a saved JSON in one click.

interface PublishedRun {
  run: SavedRun;
  publishedAt: string;
}

const FILE = cacheFile("published-run.json");
let current: PublishedRun | null = null;
let loaded = false;
const file = persistedFile({ label: "publish", file: FILE, serialize: () => JSON.stringify(current) });

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

// A deploy/Ctrl-C inside the debounce must not drop a just-published run — `persistedFile`'s
// shared shutdown registry handles that for every store at once (see util/persist.ts).
export function publishRun(run: SavedRun): PublishedRun {
  loadOnce();
  current = { run, publishedAt: new Date().toISOString() };
  file.save();
  return current;
}

export function getPublishedRun(): PublishedRun | null {
  loadOnce();
  return current;
}

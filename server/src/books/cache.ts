import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Match } from "./match";

// Cache of resolved book matches, keyed by normalized "title|author". `null` means "searched,
// no match". Persisted to disk (lazy load + debounced write) so dev-server restarts and repeated
// runs don't re-hammer Open Library — repeated same-hour runs got us throttled. Bounded; cleared
// wholesale when full (fine at this scale — no per-entry TTL needed).
const cache = new Map<string, Match | null>();
const MAX_ENTRIES = 1000;

// v2: the pre-inversion-fix cache held wrong matches (title-inverted books accepted through
// the order-blind dice hatch) — a new filename invalidates all of them at once.
const FILE = join(homedir(), ".cache", "satisfying-books", "matches-v2.json");
let loaded = false;
let writeTimer: NodeJS.Timeout | null = null;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const entries = JSON.parse(readFileSync(FILE, "utf8")) as [string, Match | null][];
    for (const [k, v] of entries.slice(-MAX_ENTRIES)) cache.set(k, v);
  } catch {
    // no cache file yet (or unreadable) — start empty
  }
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      mkdirSync(join(homedir(), ".cache", "satisfying-books"), { recursive: true });
      writeFileSync(FILE, JSON.stringify([...cache.entries()]));
    } catch (err) {
      console.warn("[cache] persist failed:", err instanceof Error ? err.message : err);
    }
  }, 2000);
  writeTimer.unref?.(); // never keep the process alive just to flush a cache
}

export function getCached(key: string): { hit: boolean; value: Match | null } {
  loadOnce();
  return cache.has(key) ? { hit: true, value: cache.get(key) ?? null } : { hit: false, value: null };
}

export function setCached(key: string, value: Match | null): void {
  loadOnce();
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, value);
  scheduleWrite();
}

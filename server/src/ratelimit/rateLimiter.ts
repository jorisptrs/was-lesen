import { config } from "../config";

// Naive in-memory guards for a single-process deployment: a per-IP sliding-window rate limit
// and a global cap on concurrent runs. Both reset on restart — fine for a small group tool.

const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

/** Sliding-window rate limit per key (an IP, or a prefixed bucket like `share:<ip>` so cheap
 * endpoints can't starve the expensive run bucket). Records the hit when allowed. */
export function checkRateLimit(key: string, limit: number = config.RUN_RATE_LIMIT_PER_HOUR): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= limit) {
    hits.set(key, recent);
    const retryAfter = Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }

  recent.push(now);
  hits.set(key, recent);

  // Opportunistic cleanup so the map can't grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
    }
  }
  return { ok: true };
}

// Global concurrency cap on in-flight runs.
let active = 0;

export function acquireRunSlot(): boolean {
  if (active >= config.MAX_CONCURRENT_RUNS) return false;
  active++;
  return true;
}

export function releaseRunSlot(): void {
  active = Math.max(0, active - 1);
}

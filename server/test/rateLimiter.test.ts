import { describe, expect, it } from "vitest";
import { acquireRunSlot, checkRateLimit, releaseRunSlot } from "../src/ratelimit/rateLimiter";

describe("checkRateLimit", () => {
  it("allows up to the per-hour limit for an IP, then blocks with a retry-after", () => {
    const ip = "rl-test-A";
    let allowed = 0;
    for (let i = 0; i < 15; i++) if (checkRateLimit(ip).ok) allowed++;
    expect(allowed).toBe(10); // RUN_RATE_LIMIT_PER_HOUR default
    const blocked = checkRateLimit(ip);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("tracks IPs independently", () => {
    expect(checkRateLimit("rl-test-B").ok).toBe(true);
  });
});

describe("run slots", () => {
  it("caps concurrent runs and releases", () => {
    const acquired: boolean[] = [];
    for (let i = 0; i < 5; i++) acquired.push(acquireRunSlot());
    expect(acquired.filter(Boolean).length).toBe(3); // MAX_CONCURRENT_RUNS default
    releaseRunSlot();
    expect(acquireRunSlot()).toBe(true);
    // clean up slots we took
    releaseRunSlot();
    releaseRunSlot();
    releaseRunSlot();
  });
});

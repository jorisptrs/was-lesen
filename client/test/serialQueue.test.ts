import { describe, expect, it } from "vitest";
import { serialQueue } from "../src/lib/serialQueue";

// The two rules manual suggestions depend on: one at a time, and a reset that in-flight work
// obeys. Tested against the real module (no React, no network) rather than a copy of the loop.

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const started: string[] = [];
  const applied: string[] = [];
  let release: (() => void) | null = null;
  const q = serialQueue<string>({
    run: async (item, isCurrent) => {
      started.push(item);
      await new Promise<void>((res) => {
        release = res;
      });
      if (!isCurrent()) return; // exactly what the hook does after its await
      applied.push(item);
    },
  });
  return { q, started, applied, finish: () => release?.() };
}

describe("serialQueue", () => {
  it("runs one at a time — the second only starts when the first finishes", async () => {
    const { q, started, applied, finish } = harness();
    q.push("a");
    q.push("b");
    await tick();
    expect(started).toEqual(["a"]);
    expect(q.size()).toBe(2);

    finish();
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(applied).toEqual(["a"]);
    expect(q.size()).toBe(1);

    finish();
    await tick();
    expect(applied).toEqual(["a", "b"]);
    expect(q.size()).toBe(0);
  });

  it("reset drops the pending items AND makes in-flight work stand down", async () => {
    // Without this a late result calls loadRun and drops a stale map onto the run that just
    // started.
    const { q, started, applied, finish } = harness();
    q.push("a");
    q.push("b");
    await tick();

    q.reset();
    expect(q.size()).toBe(0);

    finish(); // "a" comes back after the reset
    await tick();
    expect(applied).toEqual([]); // its result was not applied
    expect(started).toEqual(["a"]); // and "b" never started
  });

  it("accepts new work after a reset", async () => {
    const { q, started, applied, finish } = harness();
    q.push("a");
    await tick();
    q.reset();
    finish();
    await tick();

    q.push("c");
    await tick();
    finish();
    await tick();
    expect(started).toEqual(["a", "c"]);
    expect(applied).toEqual(["c"]);
  });

  it("reports size and busy transitions to the caller", async () => {
    const sizes: number[] = [];
    const busy: boolean[] = [];
    let release: (() => void) | null = null;
    const q = serialQueue<string>({
      onSizeChange: (n) => sizes.push(n),
      onBusyChange: (b) => busy.push(b),
      run: () => new Promise<void>((res) => { release = res; }),
    });
    q.push("a");
    await tick();
    expect(busy).toEqual([true]);
    release?.();
    await tick();
    expect(busy).toEqual([true, false]);
    expect(sizes).toEqual([1, 0]);
  });

  it("keeps draining when one item throws", async () => {
    const done: string[] = [];
    const q = serialQueue<string>({
      run: async (item) => {
        // The hook catches its own errors; a throw that escapes must not wedge the queue.
        if (item === "bad") throw new Error("boom");
        done.push(item);
      },
    });
    q.push("bad");
    q.push("good");
    await tick();
    await tick();
    expect(done).toEqual(["good"]);
    expect(q.size()).toBe(0);
  });

  it("finds a queued item, so a duplicate can be refused before it costs anything", () => {
    const q = serialQueue<string>({ run: () => new Promise(() => {}) });
    q.push("Dune");
    expect(q.has((x) => x === "Dune")).toBe(true);
    expect(q.has((x) => x === "Piranesi")).toBe(false);
  });
});

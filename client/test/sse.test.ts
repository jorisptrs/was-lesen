import { describe, expect, it } from "vitest";
import { drainFrames } from "../src/lib/sse";

interface Ev {
  type: string;
  n?: number;
}

const frame = (e: Ev) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

describe("drainFrames", () => {
  it("parses several frames out of one chunk", () => {
    const { events, rest } = drainFrames<Ev>(frame({ type: "a", n: 1 }) + frame({ type: "b", n: 2 }));
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(rest).toBe("");
  });

  it("holds an incomplete frame back until its terminator arrives", () => {
    // The real failure mode: a chunk boundary lands mid-frame, which only happens on a slow
    // network — parsing the partial text would drop the event entirely.
    const whole = frame({ type: "score_progress", n: 7 });
    const cut = whole.length - 4;
    const first = drainFrames<Ev>(whole.slice(0, cut));
    expect(first.events).toEqual([]);
    const second = drainFrames<Ev>(first.rest + whole.slice(cut));
    expect(second.events).toEqual([{ type: "score_progress", n: 7 }]);
    expect(second.rest).toBe("");
  });

  it("ignores heartbeat comments", () => {
    const { events, rest } = drainFrames<Ev>(`: ping\n\n${frame({ type: "a" })}: ping\n\n`);
    expect(events).toEqual([{ type: "a" }]);
    expect(rest).toBe("");
  });

  it("skips a malformed frame without losing the ones around it", () => {
    const bad = "event: x\ndata: {not json\n\n";
    const { events } = drainFrames<Ev>(frame({ type: "a" }) + bad + frame({ type: "b" }));
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("keeps a trailing partial frame as the remainder", () => {
    const { events, rest } = drainFrames<Ev>(`${frame({ type: "a" })}event: b\ndata: {"type"`);
    expect(events.map((e) => e.type)).toEqual(["a"]);
    expect(rest).toBe('event: b\ndata: {"type"');
  });
});

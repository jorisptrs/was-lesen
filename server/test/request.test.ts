import { describe, expect, it } from "vitest";
import { isSsePath } from "../src/sse/channel";
import { normalizePace } from "../src/domain/request";

describe("normalizePace", () => {
  it("defaults to 180 pages / 2 weeks", () => {
    // The simple intake form doesn't ask about pace, so the fallback is what most runs use.
    expect(normalizePace(undefined)).toEqual({ pages: 180, weeks: 2 });
  });

  it("falls back per FIELD, so a half-filled pace still yields a usable one", () => {
    expect(normalizePace({ pages: 0, weeks: 3 })).toEqual({ pages: 180, weeks: 3 });
    expect(normalizePace({ pages: 240, weeks: -1 })).toEqual({ pages: 240, weeks: 2 });
  });

  it("rounds fractional input", () => {
    expect(normalizePace({ pages: 180.6, weeks: 2.4 })).toEqual({ pages: 181, weeks: 2 });
  });
});

describe("isSsePath", () => {
  it("excludes every streaming route from compression", () => {
    // A missing entry here is silent: the route still answers, it just stops streaming.
    expect(isSsePath("/api/run")).toBe(true);
    expect(isSsePath("/api/normalize")).toBe(true);
    expect(isSsePath("/api/suggest/rescore")).toBe(true);
  });

  it("tolerates the trailing slash Express also routes", () => {
    expect(isSsePath("/api/run/")).toBe(true);
  });

  it("leaves ordinary JSON routes compressed", () => {
    expect(isSsePath("/api/run/preview")).toBe(false);
    expect(isSsePath("/api/suggest/check")).toBe(false); // a plain lookup, not a stream
    expect(isSsePath("/api/current")).toBe(false);
    expect(isSsePath("/")).toBe(false);
  });
});

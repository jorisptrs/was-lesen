import { describe, expect, it } from "vitest";
import { sessionsForPages } from "../src/lib/sessions";

describe("sessionsForPages", () => {
  it("ceils pages / pace-pages", () => {
    expect(sessionsForPages(320, { pages: 160, weeks: 2 })).toBe(2);
    expect(sessionsForPages(400, { pages: 160, weeks: 2 })).toBe(3);
    expect(sessionsForPages(160, { pages: 160, weeks: 2 })).toBe(1);
  });

  it("returns null for unknown page count", () => {
    expect(sessionsForPages(null, { pages: 160, weeks: 2 })).toBeNull();
  });

  it("returns null for a non-positive pace", () => {
    expect(sessionsForPages(300, { pages: 0, weeks: 2 })).toBeNull();
  });
});

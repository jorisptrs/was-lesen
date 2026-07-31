import { describe, expect, it } from "vitest";
import { parseSavedRun } from "../src/lib/savedRun";

const valid = {
  app: "satisfying-books",
  version: 1,
  savedAt: "2026-07-08T00:00:00.000Z",
  input: { membersText: "Alice: x", constraints: "", pace: { pages: 160, weeks: 2 }, effort: "low" },
  members: [{ name: "Alice" }],
  scored: { books: [], clusters: [], coverage: [], selection: {} },
};

describe("parseSavedRun", () => {
  it("accepts a well-formed run", () => {
    const r = parseSavedRun(JSON.stringify(valid));
    expect(r.members).toEqual([{ name: "Alice" }]);
    expect(r.scored.books).toEqual([]);
  });

  it("rejects non-JSON", () => {
    expect(() => parseSavedRun("not json")).toThrow(/JSON/);
  });

  it("rejects a foreign JSON file", () => {
    expect(() => parseSavedRun(JSON.stringify({ hello: "world" }))).toThrow(/satisfying-books/);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseSavedRun(JSON.stringify({ ...valid, version: 2 }))).toThrow(/version/);
  });

  it("rejects a run missing its scored books", () => {
    expect(() => parseSavedRun(JSON.stringify({ ...valid, scored: {} }))).toThrow(/scored/);
  });

  it("migrates pre-summary books (oneLineSummary → summary)", () => {
    const old = {
      ...valid,
      scored: { ...valid.scored, books: [{ id: "a", title: "T", oneLineSummary: "About X." }] },
    };
    const r = parseSavedRun(JSON.stringify(old));
    expect(r.scored.books[0]!.summary).toBe("About X.");
  });

  it("leaves a modern summary untouched and defaults a missing one to empty", () => {
    const mixed = {
      ...valid,
      scored: { ...valid.scored, books: [{ id: "a", title: "A", summary: "New.\n\nReaders like it." }, { id: "b", title: "B" }] },
    };
    const r = parseSavedRun(JSON.stringify(mixed));
    expect(r.scored.books[0]!.summary).toBe("New.\n\nReaders like it.");
    expect(r.scored.books[1]!.summary).toBe("");
  });
});


describe("per-book validation", () => {
  it("rejects a run whose book lacks an id or title (would 500 the vote tally later)", () => {
    const bad = { ...valid, scored: { ...valid.scored, books: [{ summary: "no identity" }] } };
    expect(() => parseSavedRun(JSON.stringify(bad))).toThrow(/malformed book/);
  });
});

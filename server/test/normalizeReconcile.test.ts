import { describe, expect, it } from "vitest";
import type { NormalizeLine } from "../src/claude/schemas";
import {
  normalizeKeys,
  normalizeTotal,
  reconcileNormalize,
  renderNormalizeUser,
  resolveNormalizeInput,
} from "../src/domain/normalize";

const entry = (index: number, over: Partial<Extract<NormalizeLine, { type: "entry" }>> = {}): NormalizeLine => ({
  type: "entry",
  index,
  original: "x",
  kind: "book",
  title: `Title ${index}`,
  author: "",
  authorFromText: false,
  ...over,
});

describe("resolveNormalizeInput", () => {
  it("drops non-strings and blank entries, keeps the rest in order", () => {
    const input = resolveNormalizeInput({ entries: ["Sapiens", "", 7, "   ", "Dune"], paragraphs: ["hi"], rules: [] });
    expect(input.entries).toEqual(["Sapiens", "Dune"]);
    expect(input.paragraphs).toEqual(["hi"]);
  });

  it("treats a missing/garbage body as empty", () => {
    expect(normalizeTotal(resolveNormalizeInput(undefined))).toBe(0);
    expect(normalizeTotal(resolveNormalizeInput({ entries: "nope" }))).toBe(0);
  });

  it("caps oversized lists", () => {
    const input = resolveNormalizeInput({
      entries: Array.from({ length: 250 }, (_, i) => `b${i}`),
      paragraphs: Array.from({ length: 30 }, () => "p"),
    });
    expect([input.entries.length, input.paragraphs.length]).toEqual([200, 24]);
  });
});

describe("renderNormalizeUser", () => {
  const input = { entries: ["a", "b"], paragraphs: ["p1"], rules: ["r1"] };

  it("numbers each list independently", () => {
    expect(renderNormalizeUser(input)).toBe("Entries:\n1. a\n2. b\n\nParagraphs:\n1. p1\n\nRules:\n1. r1");
  });

  it("keeps ORIGINAL numbers when re-asking for a subset", () => {
    // The follow-up call merges into the same index space, so item 2 must stay "2".
    expect(renderNormalizeUser(input, new Set(["entry:2", "rule:1"]))).toBe("Entries:\n2. b\n\nRules:\n1. r1");
  });

  it("omits empty sections", () => {
    expect(renderNormalizeUser({ entries: ["a"], paragraphs: [], rules: [] })).toBe("Entries:\n1. a");
  });

  it("agrees with the expected-key list", () => {
    expect(normalizeKeys(input)).toEqual(["entry:1", "entry:2", "paragraph:1", "rule:1"]);
  });
});

describe("reconcileNormalize", () => {
  const input = { entries: ["kinds of mind", "just a note"], paragraphs: ["thanks! I like sci-fi"], rules: ["german ok"] };

  it("applies lines by index, not by position", () => {
    // Lines arrive across turns and out of order — index is the only alignment we trust.
    const { result, missed } = reconcileNormalize(input, [
      { type: "rule", index: 1, text: "German or English" },
      entry(2, { kind: "not_a_book", title: "" }),
      entry(1, { title: "Kinds of Minds", author: "Daniel Dennett", authorFromText: false }),
      { type: "paragraph", index: 1, text: "I like sci-fi" },
    ]);
    expect(missed).toBe(0);
    expect(result.entries[0]).toMatchObject({ title: "Kinds of Minds", kind: "book" });
    expect(result.entries[1]!.kind).toBe("not_a_book");
    expect(result.paragraphs).toEqual(["I like sci-fi"]);
    expect(result.rules).toEqual(["German or English"]);
  });

  it("leaves an entry with no line exactly as typed, and counts it", () => {
    const { result, missed } = reconcileNormalize(input, [entry(1, { title: "Kinds of Minds" })]);
    expect(missed).toBe(1);
    expect(result.entries[1]).toEqual({
      original: "just a note",
      kind: "book",
      title: "just a note",
      author: "",
      authorFromText: false,
    });
    // A dropped paragraph/rule line degrades to the member's own words, never to empty.
    expect(result.paragraphs).toEqual(["thanks! I like sci-fi"]);
    expect(result.rules).toEqual(["german ok"]);
  });

  it("ignores a line whose index has no item", () => {
    const { result } = reconcileNormalize({ entries: ["a"], paragraphs: [], rules: [] }, [entry(1), entry(9)]);
    expect(result.entries).toHaveLength(1);
  });

  it("takes the type into account, so a paragraph line can't fill an entry slot", () => {
    const { result, missed } = reconcileNormalize({ entries: ["a"], paragraphs: [], rules: [] }, [
      { type: "paragraph", index: 1, text: "wrong type" },
    ]);
    expect(missed).toBe(1);
    expect(result.entries[0]!.title).toBe("a");
  });
});

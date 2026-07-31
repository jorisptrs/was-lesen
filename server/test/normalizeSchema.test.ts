import { describe, expect, it } from "vitest";
import { FilterSchema, NormalizeSchema } from "../src/claude/schemas";

describe("NormalizeSchema", () => {
  it("accepts all three kinds plus cleaned paragraphs and rules", () => {
    const out = NormalizeSchema.parse({
      entries: [
        { original: "the dawn of everything", kind: "book", title: "The Dawn of Everything", author: "", authorFromText: false },
        { original: "don't have a list ready", kind: "not_a_book", title: "", author: "", authorFromText: false },
        { original: "as well as anything from Russian classics", kind: "rule", title: "", author: "", authorFromText: false },
      ],
      paragraphs: ["I read mostly fiction."],
      rules: ["German or English please"],
    });
    expect(out.entries.map((e) => e.kind)).toEqual(["book", "not_a_book", "rule"]);
    expect(out.rules).toEqual(["German or English please"]);
  });

  it("rejects an unknown kind (the removed 'unsure')", () => {
    expect(() =>
      NormalizeSchema.parse({
        entries: [{ original: "x", kind: "unsure", title: "", author: "", authorFromText: false }],
        paragraphs: [],
        rules: [],
      }),
    ).toThrow();
  });
});

describe("FilterSchema", () => {
  it("accepts an empty violations list and a populated one", () => {
    expect(FilterSchema.parse({ violations: [] }).violations).toEqual([]);
    const out = FilterSchema.parse({
      violations: [{ id: "c_1", rule: "no Russian classics", reason: "Gogol is a Russian classic" }],
    });
    expect(out.violations[0]!.id).toBe("c_1");
  });
});

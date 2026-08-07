import { describe, expect, it } from "vitest";
import { FilterLineSchema, NormalizeLineSchema, Stage3LineSchema } from "../src/claude/schemas";

describe("NormalizeLineSchema", () => {
  it("accepts all three entry kinds", () => {
    const kinds = ["book", "not_a_book", "rule"].map((kind, i) =>
      NormalizeLineSchema.parse({
        type: "entry",
        index: i + 1,
        original: "the dawn of everything",
        kind,
        title: "The Dawn of Everything",
        author: "",
        authorFromText: false,
      }),
    );
    expect(kinds.map((k) => (k.type === "entry" ? k.kind : null))).toEqual(["book", "not_a_book", "rule"]);
  });

  it("accepts paragraph and rule lines", () => {
    expect(NormalizeLineSchema.parse({ type: "paragraph", index: 1, text: "I read mostly fiction." })).toMatchObject({
      type: "paragraph",
      index: 1,
    });
    expect(NormalizeLineSchema.parse({ type: "rule", index: 2, text: "German or English please" })).toMatchObject({
      type: "rule",
      index: 2,
    });
  });

  it("rejects an unknown kind (the removed 'unsure')", () => {
    expect(() =>
      NormalizeLineSchema.parse({
        type: "entry",
        index: 1,
        original: "x",
        kind: "unsure",
        title: "",
        author: "",
        authorFromText: false,
      }),
    ).toThrow();
  });

  it("rejects an unknown line type", () => {
    expect(() => NormalizeLineSchema.parse({ type: "note", index: 1, text: "x" })).toThrow();
  });
});

describe("FilterLineSchema", () => {
  it("accepts a violation line", () => {
    const out = FilterLineSchema.parse({ id: "c_1", rule: "no Russian classics", reason: "Gogol is a Russian classic" });
    expect(out.id).toBe("c_1");
  });

  it("rejects a line missing the reason", () => {
    expect(() => FilterLineSchema.parse({ id: "c_1", rule: "no Russian classics" })).toThrow();
  });
});

describe("Stage3LineSchema", () => {
  const line = {
    id: "bk_1",
    complexity: "moderate",
    mode: "stretch",
    summary: "Para one.\n\nPara two.",
    discussability: 8,
    rationale: "Plenty to argue about.",
    expedition: false,
    perMember: [{ member: "Ana", fit: 9 }],
  };

  it("accepts a full scored book", () => {
    expect(Stage3LineSchema.parse(line).perMember[0]!.fit).toBe(9);
  });

  it("rejects an out-of-set complexity", () => {
    expect(() => Stage3LineSchema.parse({ ...line, complexity: "hard" })).toThrow();
  });

  it("rejects a missing per-member array", () => {
    const { perMember, ...withoutMembers } = line;
    expect(() => Stage3LineSchema.parse(withoutMembers)).toThrow();
  });

  it("ignores a clusterLabel if the model volunteers one", () => {
    // Stage 3 no longer asks for topics (M36) — map labels come from the clustering call. A
    // stray label must not travel onward and quietly become a map label again.
    expect(Stage3LineSchema.parse({ ...line, clusterLabel: "Deep History" })).not.toHaveProperty("clusterLabel");
  });
});

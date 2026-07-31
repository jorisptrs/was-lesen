import { describe, expect, it } from "vitest";
import type { ScoredInput } from "../src/pipeline/selection";
import { selectBooks } from "../src/pipeline/selection";

const book = (id: string, fits: Record<string, number>, over: Partial<ScoredInput> = {}): ScoredInput => ({
  id,
  title: id,
  author: "",
  provenance: "claude_own_pick",
  nominatedBy: null,
  status: "verified",
  year: 2000,
  pageCount: 300,
  pageCountSource: "openlibrary_median",
  coverUrl: null,
  olWorkKey: null,
  matchConfidence: 1,
  clusterLabel: "General",
  complexity: "moderate",
  mode: "comfort",
  summary: "",
  discussability: 6,
  rationale: "",
  expedition: false,
  perMember: Object.entries(fits).map(([member, fit]) => ({ member, fit })),
  ...over,
});

const many = (n: number, fits: Record<string, number>, over: Partial<ScoredInput> = {}) =>
  Array.from({ length: n }, (_, i) => book(`b${i}`, fits, over));

describe("selectBooks — scoring", () => {
  it("computes avgFit, servesMost, belowThreshold", () => {
    const solo = selectBooks([book("a", { Alice: 8 }, { discussability: 5 })], ["Alice"], true);
    expect(solo.books[0]!.avgFit).toBe(8);
    expect(solo.books[0]!.servesMost).toEqual(["Alice"]);
    expect(solo.books[0]!.belowThreshold).toBe(false);

    const two = selectBooks([book("a", { Alice: 8, Ben: 4 }, { discussability: 5 })], ["Alice", "Ben"], false);
    expect(two.books[0]!.avgFit).toBe(6);
    expect(two.books[0]!.servesMost).toEqual(["Alice"]);
    expect(two.books[0]!.belowThreshold).toBe(true); // quality 5.8 < 6.5
  });
});

describe("selectBooks — threshold, floor, ceiling", () => {
  it("caps at the ceiling when many books pass", () => {
    const res = selectBooks(many(30, { Alice: 8, Ben: 8 }, { discussability: 8 }), ["Alice", "Ben"], false);
    expect(res.selection.kept).toBe(25);
  });

  it("pads below threshold up to the available floor", () => {
    const res = selectBooks(many(8, { Alice: 2, Ben: 2 }, { discussability: 2 }), ["Alice", "Ben"], false);
    expect(res.selection.kept).toBe(8);
    expect(res.books.every((b) => b.belowThreshold)).toBe(true);
  });

  it("solo mode uncaps the display", () => {
    const res = selectBooks(many(30, { Alice: 9 }, { discussability: 8 }), ["Alice"], true);
    expect(res.selection.kept).toBe(30);
  });
});

describe("selectBooks — coverage override", () => {
  it("pulls in a quiet member's best books below the ceiling", () => {
    const alice = many(26, { Alice: 9, Ben: 6 }, { discussability: 8 }); // serve Alice, not Ben
    const ben = [
      book("ben0", { Alice: 2, Ben: 9 }, { discussability: 4 }),
      book("ben1", { Alice: 2, Ben: 9 }, { discussability: 4 }),
    ]; // serve Ben, below threshold
    const res = selectBooks([...alice, ...ben], ["Alice", "Ben"], false);

    expect(res.selection.quietMemberPulls).toHaveLength(2);
    expect(res.selection.quietMemberPulls.every((p) => p.member === "Ben")).toBe(true);
    expect(res.coverage.find((c) => c.member === "Ben")!.served).toBe(2);
    expect(res.books.filter((b) => b.pulledInFor === "Ben")).toHaveLength(2);
    expect(res.selection.kept).toBe(27); // 25 on merit + 2 pulled
  });

  it("reports a member no book can serve as unservable", () => {
    const res = selectBooks(many(20, { Alice: 9, Ben: 1 }, { discussability: 8 }), ["Alice", "Ben"], false);
    expect(res.selection.unservableMembers).toContain("Ben");
  });
});

describe("selectBooks — clusters", () => {
  it("groups selected books by cluster label", () => {
    const res = selectBooks(
      [
        book("a", { Alice: 9 }, { clusterLabel: "A", discussability: 8 }),
        book("b", { Alice: 9 }, { clusterLabel: "A", discussability: 8 }),
        book("c", { Alice: 9 }, { clusterLabel: "B", discussability: 8 }),
      ],
      ["Alice"],
      true,
    );
    const byLabel = Object.fromEntries(res.clusters.map((c) => [c.label, c.bookIds.length]));
    expect(byLabel).toEqual({ A: 2, B: 1 });
  });
});

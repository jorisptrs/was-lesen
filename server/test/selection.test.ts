import { describe, expect, it } from "vitest";
import type { ScoredInput } from "../src/pipeline/selection";
import { UNGROUPED_LABEL, selectBooks } from "../src/pipeline/selection";
import { fallbackLabels } from "../src/pipeline/clusterNames";

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
  it("computes avgFit and belowThreshold", () => {
    const solo = selectBooks([book("a", { Alice: 8 }, { discussability: 5 })], ["Alice"], true);
    expect(solo.books[0]!.avgFit).toBe(8);
    expect(solo.books[0]!.belowThreshold).toBe(false);

    const two = selectBooks([book("a", { Alice: 8, Ben: 4 }, { discussability: 5 })], ["Alice", "Ben"], false);
    expect(two.books[0]!.avgFit).toBe(6);
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

  it("falls back to one named group when nothing carries a label", () => {
    // Stage 3 no longer proposes topics (M36); `attachSemantics` assigns the real ones. If
    // embeddings are off or fail, the map must still render something with a readable label —
    // never an empty pill.
    const res = selectBooks([book("a", { Alice: 9 }), book("b", { Alice: 9 })], ["Alice"], true);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.label).toBe(UNGROUPED_LABEL);
    expect(res.books.every((b) => b.clusterLabel === UNGROUPED_LABEL)).toBe(true);
  });

  it("preserves a label that came in on an already-scored card (M38 re-selection)", () => {
    const res = selectBooks([book("a", { Alice: 9 }, { clusterLabel: "Systems Thinking" })], ["Alice"], true);
    expect(res.books[0]!.clusterLabel).toBe("Systems Thinking");
  });
});

describe("selectBooks — forced ids (a manual add)", () => {
  it("puts a book on the map that the threshold and the floor would both have dropped", () => {
    // The real shape: a full map of mediocre books, and one worse book typed in by hand. It
    // clears neither QUALITY_MIN nor the 15-book floor padding, so it used to vanish silently.
    const pool = [...many(20, { Alice: 7, Ben: 7 }, { discussability: 7 }), book("hand", { Alice: 2, Ben: 2 }, { discussability: 2 })];
    const without = selectBooks(pool, ["Alice", "Ben"], false);
    expect(without.books.some((b) => b.id === "hand")).toBe(false);

    const forced = selectBooks(pool, ["Alice", "Ben"], false, new Set(["hand"]));
    const added = forced.books.find((b) => b.id === "hand")!;
    expect(added).toBeDefined();
    expect(added.belowThreshold).toBe(true); // shown, but honestly marked
    expect(forced.books.at(-1)!.id).toBe("hand"); // ranked last, not smuggled up the order
    expect(forced.clusters.flatMap((c) => c.bookIds)).toContain("hand"); // reachable on the map
  });

  it("ranks a forced book on merit when it earns a higher place", () => {
    const pool = [...many(16, { Alice: 6, Ben: 6 }, { discussability: 6 }), book("hand", { Alice: 10, Ben: 9 }, { discussability: 9 })];
    const res = selectBooks(pool, ["Alice", "Ben"], false, new Set(["hand"]));
    expect(res.books[0]!.id).toBe("hand");
    expect(res.books[0]!.belowThreshold).toBe(false);
  });

  it("keeps the whole existing map when every id is forced (the suggest path)", () => {
    // Adding one book must not remove another. The suggest pool IS the map, so re-running the
    // threshold/floor logic over it was never a fair rerun — and a new book entering the padded
    // top-15 pushed the 15th-best off. The map only grows.
    const existing = many(17, { Alice: 5, Ben: 5 }, { discussability: 5 });
    const added = book("hand", { Alice: 9, Ben: 8 }, { discussability: 9 });
    const forced = new Set([...existing.map((b) => b.id), "hand"]);
    const res = selectBooks([...existing, added], ["Alice", "Ben"], false, forced);
    expect(res.books).toHaveLength(18);
    for (const b of existing) expect(res.books.some((x) => x.id === b.id)).toBe(true);
    expect(res.books[0]!.id).toBe("hand"); // still ranked on merit
  });

  it("a mismatched member name refills every book with the neutral fit (the bug forceIds can't fix)", () => {
    // Pins WHY the suggest path must read member names off the cards: pass the wrong roster and
    // the whole map's arithmetic silently changes.
    const pool = [book("a", { Alice: 9, Ben: 9 }, { discussability: 9 })];
    const right = selectBooks(pool, ["Alice", "Ben"], false);
    expect(right.books[0]!.avgFit).toBe(9);
    expect(right.selection.unservableMembers).toEqual([]);

    // Solo mode skips the coverage override, so the group path is what surfaces this.
    const drifted = selectBooks(pool, ["Alice", "Ben Smith"], false);
    expect(drifted.books[0]!.avgFit).toBe(7); // (9 + NEUTRAL_FIT 5) / 2 — a rank-changing lie
    expect(drifted.selection.unservableMembers).toEqual(["Ben Smith"]); // "no good pick found"
  });

  it("forces through in solo mode too, and never duplicates an already-selected book", () => {
    const pool = [book("good", { Alice: 9 }, { discussability: 9 }), book("hand", { Alice: 1 }, { discussability: 1 })];
    const solo = selectBooks(pool, ["Alice"], true, new Set(["hand"]));
    expect(solo.books.map((b) => b.id)).toEqual(["good", "hand"]);
    const already = selectBooks(pool, ["Alice"], true, new Set(["good"]));
    expect(already.books.filter((b) => b.id === "good")).toHaveLength(1);
  });
});

describe("fallbackLabels", () => {
  it("numbers the groups when the naming call fails", () => {
    expect(fallbackLabels(3)).toEqual(["Group 1", "Group 2", "Group 3"]);
  });

  it("says it plainly rather than calling a lone group 'Group 1'", () => {
    expect(fallbackLabels(1)).toEqual([UNGROUPED_LABEL]);
    expect(fallbackLabels(0)).toEqual([]);
  });
});

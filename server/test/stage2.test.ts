import { describe, expect, it } from "vitest";
import type { VerifiedBook } from "@sb/shared";
import { dedupeByWork } from "../src/pipeline/stage2";

const book = (over: Partial<VerifiedBook>): VerifiedBook => ({
  id: over.id ?? "x",
  title: "T",
  author: "A",
  provenance: "claude_own_pick",
  nominatedBy: null,
  status: "verified",
  year: 2000,
  pageCount: 300,
  pageCountSource: "openlibrary_median",
  coverUrl: "http://c/1.jpg",
  olWorkKey: null,
  matchConfidence: 0.9,
  ...over,
});

describe("dedupeByWork", () => {
  it("merges a member's raw-string nomination with Claude's clean pick of the same OL work", () => {
    const member = book({
      id: "m1",
      title: "David Graeber/David Wengrow: the dawn of everything.",
      author: "David Graeber/David Wengrow",
      provenance: "member_nomination",
      nominatedBy: "Karla",
      olWorkKey: "/works/OL123W",
      coverUrl: null,
    });
    const claude = book({ id: "c1", title: "The Dawn of Everything", author: "David Graeber", olWorkKey: "/works/OL123W" });
    const out = dedupeByWork([member, claude]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("The Dawn of Everything"); // OL-canonical title wins
    expect(out[0]!.provenance).toBe("member_nomination"); // the nomination badge survives
    expect(out[0]!.nominatedBy).toBe("Karla");
    expect(out[0]!.coverUrl).toBe("http://c/1.jpg"); // null filled from the duplicate
  });

  it("keeps member provenance when Claude's copy came first", () => {
    const claude = book({ id: "c1", olWorkKey: "/works/OL9W" });
    const member = book({ id: "m1", provenance: "member_nomination", nominatedBy: "Ana", olWorkKey: "/works/OL9W" });
    const out = dedupeByWork([claude, member]);
    expect(out).toHaveLength(1);
    expect(out[0]!.provenance).toBe("member_nomination");
    expect(out[0]!.nominatedBy).toBe("Ana");
  });

  it("leaves distinct works and distinct keyless books alone", () => {
    const out = dedupeByWork([
      book({ id: "1", title: "The Selfish Gene", olWorkKey: "/works/A" }),
      book({ id: "2", title: "The Extended Phenotype", olWorkKey: "/works/B" }),
      book({ id: "3", title: "The Righteous Mind", olWorkKey: null }),
      book({ id: "4", title: "The Ministry for the Future", olWorkKey: null }),
    ]);
    expect(out).toHaveLength(4);
  });

  it("merges the Graeber case by title containment when work keys differ", () => {
    const member = book({
      id: "m1",
      title: "David Graeber/David Wengrow: the dawn of everything.",
      author: "",
      provenance: "member_nomination",
      nominatedBy: "Karla",
      status: "unverified",
      olWorkKey: null,
      coverUrl: null,
    });
    const claude = book({ id: "c1", title: "The Dawn of Everything", author: "David Graeber", olWorkKey: "/works/OL1W" });
    const out = dedupeByWork([member, claude]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("The Dawn of Everything"); // verified card survives
    expect(out[0]!.provenance).toBe("member_nomination"); // badge preserved
  });

  it("merges subtitle variants of the same book", () => {
    const short = book({ id: "1", title: "Superintelligence", author: "Nick Bostrom", olWorkKey: "/works/X" });
    const long = book({ id: "2", title: "Superintelligence: Paths, Dangers, Strategies", author: "Nick Bostrom", olWorkKey: null });
    expect(dedupeByWork([short, long])).toHaveLength(1);
  });

  it("does NOT merge identical titles by different authors", () => {
    const a = book({ id: "1", title: "Invisible Cities Everywhere", author: "Alice Zed", olWorkKey: null });
    const b = book({ id: "2", title: "Invisible Cities Everywhere", author: "Bob Quark", olWorkKey: null });
    expect(dedupeByWork([a, b])).toHaveLength(2);
  });
});

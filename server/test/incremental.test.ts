import { describe, expect, it } from "vitest";
import type { Cluster, ScoredCard } from "@sb/shared";
import { alignPositions, carryLabels } from "../src/pipeline/incremental";
import { cardMemberNames } from "../src/pipeline/suggest";

const card = (id: string, avgFit: number, over: Partial<ScoredCard> = {}): ScoredCard =>
  ({ id, title: id, avgFit, discussability: 7, perMember: [], ...over }) as ScoredCard;

describe("cardMemberNames", () => {
  const withFits = (id: string, members: string[]) =>
    card(id, 6, { perMember: members.map((m) => ({ member: m, fit: 7 })) });

  it("reads the member set off the cards, not the (possibly drifted) roster", () => {
    // The bug this exists to stop: a roster that changed since the run (renamed card, member
    // skipped afterwards) makes `finalize` refill every existing book with NEUTRAL_FIT — ranks
    // reshuffle and the renamed member is "unservable" everywhere.
    const books = [withFits("a", ["Ana", "Ben"]), withFits("b", ["Ana", "Ben", "Cleo"])];
    const roster = [{ name: "Ana" }, { name: "Mira Lindqvist" }] as never;
    expect(cardMemberNames(books, roster)).toEqual(["Ana", "Ben", "Cleo"]);
  });

  it("falls back to the roster only when the cards carry no fits at all", () => {
    expect(cardMemberNames([card("a", 6)], [{ name: "Ana" }] as never)).toEqual(["Ana"]);
    expect(cardMemberNames([], [{ name: "Ana" }] as never)).toEqual(["Ana"]);
  });
});

describe("carryLabels", () => {
  const previous: Cluster[] = [
    { label: "Systems Thinking", bookIds: ["a", "b", "c"] },
    { label: "Nature Writing", bookIds: ["d", "e"] },
  ];

  it("carries each label to the group that kept most of its books", () => {
    const out = carryLabels([["d", "e"], ["a", "b", "c", "new"]], previous);
    expect(out.map((c) => c.label)).toEqual(["Systems Thinking", "Nature Writing"]);
    expect(out[0]!.bookIds).toContain("new");
  });

  it("preserves the PREVIOUS label order, because the client colors by it", () => {
    // Groups arrive in whatever order the clusterer produced; a reordered list would recolour
    // every book on a map the group is already reading.
    const out = carryLabels([["e", "d"], ["c", "b", "a"]], previous);
    expect(out.map((c) => c.label)).toEqual(["Systems Thinking", "Nature Writing"]);
  });

  it("never gives one label to two groups", () => {
    const out = carryLabels([["a", "b"], ["c"], ["d", "e"]], previous);
    expect(new Set(out.map((c) => c.label)).size).toBe(3);
    // The bigger overlap keeps the name; the splinter gets an honest generic one.
    expect(out.find((c) => c.bookIds.includes("a"))!.label).toBe("Systems Thinking");
    expect(out.find((c) => c.bookIds.includes("c"))!.label).toMatch(/^Group \d+$/);
  });

  it("names a genuinely new group generically and appends it last", () => {
    const out = carryLabels([["a", "b", "c"], ["d", "e"], ["new1", "new2"]], previous);
    expect(out.map((c) => c.label)).toEqual(["Systems Thinking", "Nature Writing", "Group 3"]);
  });

  it("handles a first-ever clustering with no previous labels", () => {
    expect(carryLabels([["a"], ["b"]], []).map((c) => c.label)).toEqual(["Group 1", "Group 2"]);
  });
});

describe("alignPositions", () => {
  const prev = new Map([
    ["a", { x: 0.1, y: 0.2 }],
    ["b", { x: 0.5, y: 0.5 }],
    ["c", { x: 0.9, y: 0.8 }],
    ["d", { x: 0.3, y: 0.9 }],
  ]);
  const round = (m: Map<string, { x: number; y: number }>) =>
    Object.fromEntries([...m].map(([k, p]) => [k, [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]]));

  it("un-mirrors a projection whose eigenvector signs flipped", () => {
    // project2d's eigenvectors are only defined up to sign: the same geometry can come back
    // mirrored, which reads as "the map was thrown away" for one added book.
    const mirrored = new Map([...prev].map(([k, p]) => [k, { x: 1 - p.x, y: 1 - p.y }]));
    expect(round(alignPositions(mirrored, prev))).toEqual(round(prev));
  });

  it("un-swaps axes when the top two eigenvalues trade places", () => {
    const swapped = new Map([...prev].map(([k, p]) => [k, { x: p.y, y: p.x }]));
    expect(round(alignPositions(swapped, prev))).toEqual(round(prev));
  });

  it("handles a swap AND a flip together", () => {
    const both = new Map([...prev].map(([k, p]) => [k, { x: 1 - p.y, y: p.x }]));
    expect(round(alignPositions(both, prev))).toEqual(round(prev));
  });

  it("carries a brand-new point along with the transform", () => {
    const mirrored = new Map([...prev].map(([k, p]) => [k, { x: 1 - p.x, y: 1 - p.y }]));
    mirrored.set("new", { x: 0.25, y: 0.4 });
    expect(round(alignPositions(mirrored, prev)).new).toEqual([0.75, 0.6]);
  });

  it("leaves an already-aligned projection alone", () => {
    expect(round(alignPositions(new Map(prev), prev))).toEqual(round(prev));
  });

  it("declines to guess from too few shared points", () => {
    const two = new Map([["a", { x: 0.9, y: 0.9 }], ["b", { x: 0.1, y: 0.1 }]]);
    expect(round(alignPositions(two, prev))).toEqual(round(two));
  });
});

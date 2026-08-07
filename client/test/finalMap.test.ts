import { describe, expect, it } from "vitest";
import type { Cluster, ScoredCard } from "@sb/shared";
import { rankByQuality, trayMapState } from "../src/lib/finalMap";

const card = (id: string, pos?: { x: number; y: number }, clusterLabel = "Systems"): ScoredCard =>
  ({ id, title: id, avgFit: 7, discussability: 7, clusterLabel, ...(pos ? { pos } : {}) }) as ScoredCard;

const clusters: Cluster[] = [
  { label: "Systems", bookIds: ["a", "b", "c"], centroid: { x: 0.3, y: 0.3 } },
  { label: "Nature", bookIds: ["d", "e"], centroid: { x: 0.8, y: 0.8 } },
];

describe("trayMapState", () => {
  it("keeps only the tray and stretches it back across the plane", () => {
    // Ten books out of twenty-five would otherwise huddle in whatever corner they occupied.
    const tray = [card("a", { x: 0.4, y: 0.5 }), card("b", { x: 0.5, y: 0.55 })];
    const state = trayMapState(tray, clusters);
    expect(state.books.map((b) => b.id)).toEqual(["a", "b"]);
    expect(state.books.map((b) => [b.pos!.x, b.pos!.y])).toEqual([
      [0.08, 0.08],
      [0.92, 0.92],
    ]);
  });

  it("drops clusters with nothing left and recomputes the survivors' centroids", () => {
    const tray = [card("a", { x: 0.2, y: 0.2 }), card("c", { x: 0.6, y: 0.6 })];
    const state = trayMapState(tray, clusters);
    expect(state.clusters.map((c) => c.label)).toEqual(["Systems"]);
    expect(state.clusters[0]!.bookIds).toEqual(["a", "c"]);
    expect(state.clusters[0]!.centroid).toEqual({ x: 0.5, y: 0.5 }); // midpoint of the rescaled pair
  });

  it("preserves cluster ORDER, so the final map doesn't recolour the books", () => {
    const tray = [card("d", { x: 0.8, y: 0.1 }, "Nature"), card("a", { x: 0.1, y: 0.8 })];
    expect(trayMapState(tray, clusters).clusters.map((c) => c.label)).toEqual(["Systems", "Nature"]);
  });

  it("still shows a trayed book the run has since evicted", () => {
    // Found by driving it: a suggestion can push a book off the map while the tray deliberately
    // keeps it. Grouping by the run's cluster list dropped exactly those books — the card
    // disappeared from the final map and took its rank number with it.
    const evicted = card("gone", { x: 0.5, y: 0.5 }, "Systems");
    const state = trayMapState([evicted, card("a", { x: 0.1, y: 0.1 })], [
      { label: "Systems", bookIds: ["a", "b"] }, // "gone" is no longer listed anywhere
    ]);
    expect(state.books.map((b) => b.id)).toEqual(["gone", "a"]);
    expect(state.clusters[0]!.bookIds).toEqual(["gone", "a"]);
  });

  it("puts a cluster the run no longer has last, without losing its books", () => {
    const state = trayMapState([card("x", { x: 0.2, y: 0.2 }, "Vanished Topic"), card("a", { x: 0.8, y: 0.8 })], clusters);
    expect(state.clusters.map((c) => c.label)).toEqual(["Systems", "Vanished Topic"]);
  });

  it("centres a single book instead of dividing by a zero range", () => {
    const state = trayMapState([card("a", { x: 0.42, y: 0.9 })], clusters);
    expect(state.books[0]!.pos).toEqual({ x: 0.5, y: 0.5 });
  });

  it("survives books with no position at all (a pre-embeddings saved run)", () => {
    const state = trayMapState([card("a"), card("b")], clusters);
    expect(state.books.every((b) => !b.pos)).toBe(true);
    expect(state.clusters[0]!.centroid).toEqual(clusters[0]!.centroid); // falls back to the old one
  });

  it("is empty for an empty tray", () => {
    const state = trayMapState([], clusters);
    expect(state.books).toEqual([]);
    expect(state.clusters).toEqual([]);
  });
});

describe("rankByQuality", () => {
  const scored = (id: string, avgFit: number, discussability = 7, pageCount = 300) =>
    ({ id, title: id, avgFit, discussability, pageCount }) as ScoredCard;

  it("ranks 1 = best by the shared quality blend", () => {
    const ranks = rankByQuality([scored("mid", 6), scored("best", 9), scored("worst", 2)]);
    expect([...ranks].sort((a, z) => a[1] - z[1]).map(([id]) => id)).toEqual(["best", "mid", "worst"]);
  });

  it("gives a shortlisted book the rank it earned on the WHOLE map", () => {
    // The final map shows the tray but keeps these numbers: "#3 of 18" says how the book placed
    // among everything considered, which renumbering the shortlist 1..N would throw away.
    const all = Array.from({ length: 18 }, (_, i) => scored(`b${i}`, 10 - i * 0.4));
    const ranks = rankByQuality(all);
    expect(ranks.get("b0")).toBe(1);
    expect(ranks.get("b2")).toBe(3);
    expect(ranks.get("b17")).toBe(18);
  });

  it("applies the length discount, so a long book can rank below a shorter equal", () => {
    const ranks = rankByQuality([scored("long", 7, 7, 900), scored("short", 7, 7, 150)]);
    expect(ranks.get("short")).toBe(1);
    expect(ranks.get("long")).toBe(2);
  });
});

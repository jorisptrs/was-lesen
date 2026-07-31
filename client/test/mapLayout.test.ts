import { describe, expect, it } from "vitest";
import { type ClusterInput, layoutMap } from "../src/lib/mapLayout";

const mk = (label: string, n: number, base = 8): ClusterInput => ({
  label,
  color: "#000",
  books: Array.from({ length: n }, (_, i) => ({ id: `${label}-${i}`, weight: base - i * 0.3 })),
});

// Deterministic pseudo-positions clustered around a center (the filled-plane input shape).
const mkPos = (label: string, n: number, cx: number, cy: number): ClusterInput => ({
  label,
  color: "#000",
  books: Array.from({ length: n }, (_, i) => ({
    id: `${label}-${i}`,
    weight: 8 - i * 0.3,
    pos: { x: cx + (((i * 37) % 10) - 5) / 60, y: cy + (((i * 53) % 10) - 5) / 60 },
  })),
});

describe("layoutMap", () => {
  it("keeps every book and places all coords within the reported bounds", () => {
    const layout = layoutMap([mk("History", 5), mk("Science", 4), mk("Fiction", 3)]);
    const books = layout.clusters.flatMap((c) => c.books);
    expect(books).toHaveLength(12);
    for (const b of books) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(layout.width);
      expect(b.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("packs blobs without overlapping each other", () => {
    const { clusters } = layoutMap([mk("History", 6), mk("Science", 5), mk("Economics", 4), mk("Fiction", 7)]);
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!;
        const b = clusters[j]!;
        expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(a.r + b.r - 0.001);
      }
    }
  });

  it("puts the best-fitting book at the blob centre and sizes covers by fit", () => {
    const [blob] = layoutMap([mk("History", 4, 10)]).clusters;
    const center = blob!.books[0]!;
    expect(Math.hypot(center.x - blob!.cx, center.y - blob!.cy)).toBeLessThan(1);
    expect(center.h).toBeGreaterThanOrEqual(blob!.books[blob!.books.length - 1]!.h);
  });

  it("is deterministic", () => {
    const input = [mk("History", 5), mk("Science", 4)];
    expect(JSON.stringify(layoutMap(input))).toBe(JSON.stringify(layoutMap(input)));
  });

  it("handles a single solo cluster", () => {
    const layout = layoutMap([mk("Philosophy", 18)]);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.width).toBeGreaterThan(0);
  });

  it("packs covers within a blob adjacent but never overlapping", () => {
    const covers = layoutMap([mk("History", 10, 9)]).clusters[0]!.books;
    for (let i = 0; i < covers.length; i++) {
      for (let j = i + 1; j < covers.length; j++) {
        const a = covers[i]!;
        const b = covers[j]!;
        const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe("layoutMap filled plane (per-book positions)", () => {
  const input = [mkPos("History", 6, 0.25, 0.3), mkPos("Science", 5, 0.75, 0.35), mkPos("Fiction", 5, 0.5, 0.75)];

  it("keeps every book, none overlapping, all within bounds", () => {
    const layout = layoutMap(input);
    const books = layout.clusters.flatMap((c) => c.books);
    expect(books).toHaveLength(16);
    for (const b of books) {
      expect(b.x - b.w / 2).toBeGreaterThanOrEqual(0);
      expect(b.y - b.h / 2).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w / 2).toBeLessThanOrEqual(layout.width);
      expect(b.y + b.h / 2).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < books.length; i++) {
      for (let j = i + 1; j < books.length; j++) {
        const a = books[i]!;
        const b = books[j]!;
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const overlapY = Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("preserves the rough arrangement (left cluster stays left of right cluster)", () => {
    const layout = layoutMap(input);
    const meanX = (label: string) => {
      const c = layout.clusters.find((cl) => cl.label === label)!;
      return c.books.reduce((s, b) => s + b.x, 0) / c.books.length;
    };
    expect(meanX("History")).toBeLessThan(meanX("Science"));
  });

  it("uses equal cover sizes (rank badges carry the quality signal)", () => {
    const books = layoutMap(input).clusters.flatMap((c) => c.books);
    const { w, h } = books[0]!;
    for (const b of books) {
      expect(b.w).toBe(w);
      expect(b.h).toBe(h);
    }
  });

  it("places labels at cluster centers, relaxed apart, and is deterministic", () => {
    const a = layoutMap(input);
    const b = layoutMap(input);
    expect(a).toEqual(b);
    for (const cl of a.clusters) {
      expect(cl.r).toBe(0);
      // Anchored within the cluster's own area (center-ish), not floated above it.
      const ys = cl.books.map((bk) => bk.y);
      expect(cl.cy).toBeGreaterThan(Math.min(...ys) - 60);
      expect(cl.cy).toBeLessThan(Math.max(...ys) + 60);
    }
    // No two labels merge: horizontally-close labels must be vertically separated.
    const labels = a.clusters;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const la = labels[i]!;
        const lb = labels[j]!;
        if (Math.abs(la.cx - lb.cx) < 90) expect(Math.abs(la.cy - lb.cy)).toBeGreaterThanOrEqual(28);
      }
    }
  });

  it("falls back to blobs when any book lacks a position", () => {
    const mixed = [mkPos("History", 3, 0.3, 0.3), mk("Science", 3)];
    const layout = layoutMap(mixed);
    expect(layout.clusters.some((c) => c.r > 0)).toBe(true); // blob layout gives real radii
  });
});

describe("layoutMap with embedding centroids", () => {
  const mkC = (label: string, n: number, x: number, y: number): ClusterInput => ({ ...mk(label, n), centroid: { x, y } });

  it("places blobs from centroids without overlaps", () => {
    const { clusters } = layoutMap([mkC("A", 5, 0.1, 0.1), mkC("B", 4, 0.9, 0.15), mkC("C", 6, 0.5, 0.9)]);
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!;
        const b = clusters[j]!;
        expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(a.r + b.r - 0.5);
      }
    }
  });

  it("preserves relative arrangement — a far centroid stays farthest", () => {
    // A and B are near each other; C is far. After layout, A–B should be closer than A–C.
    const byLabel = new Map(layoutMap([mkC("A", 4, 0.1, 0.1), mkC("B", 4, 0.2, 0.15), mkC("C", 4, 0.95, 0.95)]).clusters.map((c) => [c.label, c]));
    const A = byLabel.get("A")!;
    const B = byLabel.get("B")!;
    const C = byLabel.get("C")!;
    expect(Math.hypot(A.cx - B.cx, A.cy - B.cy)).toBeLessThan(Math.hypot(A.cx - C.cx, A.cy - C.cy));
  });

  it("is deterministic and falls back to the spiral if any centroid is missing", () => {
    const withCentroids = [mkC("A", 5, 0.2, 0.3), mkC("B", 4, 0.8, 0.6)];
    expect(JSON.stringify(layoutMap(withCentroids))).toBe(JSON.stringify(layoutMap(withCentroids)));
    // one missing → spiral path (still lays out, just not from centroids)
    const mixed = [mkC("A", 5, 0.2, 0.3), mk("B", 4)];
    expect(layoutMap(mixed).clusters).toHaveLength(2);
  });
});

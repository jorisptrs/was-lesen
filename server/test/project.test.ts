import { describe, expect, it } from "vitest";
import { clusterBooks, clusterCentroids, project2d } from "../src/pipeline/project";

describe("project2d", () => {
  it("preserves relative distances — similar items land closer than dissimilar ones", () => {
    const pts = [
      [1, 0, 0, 0], // A
      [0.95, 0.05, 0, 0], // B ≈ A
      [0, 0, 1, 0], // C
      [0, 0, 0.95, 0.05], // D ≈ C
    ];
    const p = project2d(pts);
    const d = (i: number, j: number) => Math.hypot(p[i]!.x - p[j]!.x, p[i]!.y - p[j]!.y);
    expect(d(0, 1)).toBeLessThan(d(0, 2)); // A–B (similar) closer than A–C (different)
    expect(d(2, 3)).toBeLessThan(d(1, 3)); // C–D (similar) closer than B–D (different)
  });

  it("is deterministic", () => {
    const pts = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    expect(JSON.stringify(project2d(pts))).toBe(JSON.stringify(project2d(pts)));
  });
});

describe("clusterCentroids", () => {
  const emb = new Map<string, number[]>([
    ["a1", [1, 0, 0, 0]],
    ["a2", [0.9, 0.1, 0, 0]],
    ["b1", [0, 1, 0, 0]],
    ["c1", [0, 0, 1, 0]],
    ["c2", [0, 0, 0.9, 0.1]],
  ]);
  const clusters = [
    { label: "A", bookIds: ["a1", "a2"] },
    { label: "B", bookIds: ["b1"] },
    { label: "C", bookIds: ["c1", "c2"] },
  ];

  it("returns a normalized [0.08, 0.92] centroid for every non-empty cluster", () => {
    const c = clusterCentroids(clusters, emb);
    expect([...c.keys()].sort()).toEqual(["A", "B", "C"]);
    for (const { x, y } of c.values()) {
      expect(x).toBeGreaterThanOrEqual(0.08 - 1e-9);
      expect(x).toBeLessThanOrEqual(0.92 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(0.08 - 1e-9);
      expect(y).toBeLessThanOrEqual(0.92 + 1e-9);
    }
  });

  it("centers a single cluster at (0.5, 0.5)", () => {
    expect(clusterCentroids([{ label: "Solo", bookIds: ["a1"] }], emb).get("Solo")).toEqual({ x: 0.5, y: 0.5 });
  });

  it("skips clusters with no embeddings and stays deterministic", () => {
    const withMissing = [...clusters, { label: "Z", bookIds: ["missing"] }];
    const c1 = clusterCentroids(withMissing, emb);
    expect(c1.has("Z")).toBe(false);
    expect(JSON.stringify([...clusterCentroids(withMissing, emb)])).toBe(JSON.stringify([...c1]));
  });
});

describe("clusterBooks", () => {
  /** n points around a unit direction with tiny deterministic jitter in the next axis. */
  const around = (axis: number, n: number, dims = 4): number[][] =>
    Array.from({ length: n }, (_, i) => {
      const v = new Array<number>(dims).fill(0);
      v[axis] = 1;
      v[(axis + 1) % dims] = 0.02 * (i + 1);
      return v;
    });

  it("finds two well-separated groups (below the 12-book floor threshold)", () => {
    const emb = new Map<string, number[]>();
    [...around(0, 3), ...around(2, 3)].forEach((v, i) => emb.set(`x${i}`, v));
    const groups = clusterBooks([...emb.keys()], emb);
    expect(groups.length).toBe(2);
    const sets = groups.map((g) => g.map((id) => Number(id.slice(1)) < 3).every(Boolean));
    expect(sets.filter(Boolean).length).toBe(1); // one group is exactly the first trio
  });

  it("enforces the floor of 4 clusters at ≥12 books, even when the knee says fewer", () => {
    const emb = new Map<string, number[]>();
    // Two dominant topics (7 + 7) — the knee alone would say 2.
    [...around(0, 7), ...around(2, 7)].forEach((v, i) => emb.set(`x${i}`, v));
    const groups = clusterBooks([...emb.keys()], emb);
    expect(groups.length).toBeGreaterThanOrEqual(4);
    expect(groups.length).toBeLessThanOrEqual(8);
    expect(groups.flat().sort()).toEqual([...emb.keys()].sort()); // no book lost or duplicated
  });

  it("is deterministic and appends embedding-less books to the largest cluster", () => {
    const emb = new Map<string, number[]>();
    [...around(0, 4), ...around(2, 2)].forEach((v, i) => emb.set(`x${i}`, v));
    const ids = [...emb.keys(), "orphan"];
    const a = clusterBooks(ids, emb);
    const b = clusterBooks(ids, emb);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const withOrphan = a.find((g) => g.includes("orphan"))!;
    expect(withOrphan.length).toBeGreaterThanOrEqual(4); // joined the biggest group
  });
});

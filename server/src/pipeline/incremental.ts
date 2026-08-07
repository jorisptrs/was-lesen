import type { Cluster, ScoredCard } from "@sb/shared";
import { UNGROUPED_LABEL } from "./selection";

// Pure helpers for re-placing a map after books are added. Everything here exists because the
// map has to stay RECOGNIZABLE: the group is looking at it on a projector, and an addition that
// renames every cluster, reshuffles the colors, or mirrors the whole plane reads as "the tool
// threw my map away" — even though the arithmetic underneath is correct.
//
// (Scale anchors used to live here too, propping up a single-book scoring call. That call is
// gone: the whole pool is rescored together, so the model sees the real distribution instead of
// being told about it.)

type Pos = { x: number; y: number };

/**
 * Carry existing cluster labels onto freshly computed groups, by book overlap.
 *
 * Two things depend on this. Names: re-running `nameClusters` on a one-book change would rename
 * clusters the group has been reading off a projector. Colors: the client picks them by label
 * ORDER (App.tsx), so a reordered cluster list recolors the whole map — hence surviving labels
 * keep their previous positions and genuinely new groups are appended at the end.
 */
export function carryLabels(groups: string[][], previous: Cluster[]): { label: string; bookIds: string[] }[] {
  const prevLabels = previous.map((c) => c.label);
  const prevOf = new Map<string, string>(); // bookId → previous label
  for (const c of previous) for (const id of c.bookIds) prevOf.set(id, c.label);

  // Every (group, previous label) overlap, strongest first — a greedy assignment that can't give
  // one label to two groups.
  const pairs: { gi: number; label: string; overlap: number }[] = [];
  groups.forEach((ids, gi) => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const label = prevOf.get(id);
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const [label, overlap] of counts) pairs.push({ gi, label, overlap });
  });
  // Ties broken by previous order, so the assignment is deterministic.
  pairs.sort((a, z) => z.overlap - a.overlap || prevLabels.indexOf(a.label) - prevLabels.indexOf(z.label) || a.gi - z.gi);

  const labelOf = new Map<number, string>();
  const takenLabels = new Set<string>();
  for (const p of pairs) {
    if (labelOf.has(p.gi) || takenLabels.has(p.label)) continue;
    labelOf.set(p.gi, p.label);
    takenLabels.add(p.label);
  }

  // A group that matched nothing is genuinely new. It gets a plainly generic placeholder rather
  // than a borrowed one — an honest "unnamed" beats a label that says something untrue about its
  // books — and the caller then asks the namer for a real one (see `isPlaceholderLabel`).
  let n = 1;
  const freshLabel = (): string => {
    let label = `Group ${prevLabels.length + n++}`;
    while (takenLabels.has(label)) label = `Group ${prevLabels.length + n++}`;
    takenLabels.add(label);
    return label;
  };

  const built = groups.map((bookIds, gi) => ({ label: labelOf.get(gi) ?? freshLabel(), bookIds }));
  // Order: surviving labels in their PREVIOUS order, then new groups. Colors follow this order.
  const rank = (label: string) => {
    const i = prevLabels.indexOf(label);
    return i < 0 ? prevLabels.length + built.findIndex((b) => b.label === label) : i;
  };
  return [...built].sort((a, z) => rank(a.label) - rank(z.label));
}

/** Did `carryLabels` (or the naming fallback) leave this group unnamed? */
export const isPlaceholderLabel = (label: string): boolean => /^Group \d+$/.test(label);

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

/** Pearson correlation; 0 when either side is constant (no evidence either way). */
function correlation(a: number[], b: number[]): number {
  if (a.length < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

// Positions are normalized into [0.08, 0.92], so mirroring an axis is min+max−v.
const MIRROR_SUM = 1;

/**
 * Re-orient freshly projected positions to match the previous map.
 *
 * `project2d`'s eigenvectors are only defined up to SIGN, and when the top two eigenvalues are
 * close the two axes can also trade places. Either one leaves the geometry mathematically
 * identical and the picture unrecognizable — the whole map mirrors or rotates a quarter turn
 * because one book was added. Compare the shared points against the previous layout, then flip
 * and/or swap. Points with no previous position ride along with the chosen transform.
 */
export function alignPositions<K>(next: Map<K, Pos>, previous: Map<K, Pos>): Map<K, Pos> {
  const shared = [...next.keys()].filter((k) => previous.has(k));
  if (shared.length < 3) return next; // too little evidence — leave it alone rather than guess

  const nx = shared.map((k) => next.get(k)!.x);
  const ny = shared.map((k) => next.get(k)!.y);
  const px = shared.map((k) => previous.get(k)!.x);
  const py = shared.map((k) => previous.get(k)!.y);

  const cxx = correlation(nx, px);
  const cyy = correlation(ny, py);
  const cxy = correlation(nx, py);
  const cyx = correlation(ny, px);
  const swap = Math.abs(cxy) + Math.abs(cyx) > Math.abs(cxx) + Math.abs(cyy);
  const flipX = (swap ? cyx : cxx) < 0;
  const flipY = (swap ? cxy : cyy) < 0;

  const out = new Map<K, Pos>();
  for (const [k, p] of next) {
    const x = swap ? p.y : p.x;
    const y = swap ? p.x : p.y;
    out.set(k, { x: flipX ? MIRROR_SUM - x : x, y: flipY ? MIRROR_SUM - y : y });
  }
  return out;
}

/** Previous per-book positions, read off the cards the client posted back. */
export function previousPositions(books: ScoredCard[]): Map<string, Pos> {
  const out = new Map<string, Pos>();
  for (const b of books) if (b.pos) out.set(b.id, b.pos);
  return out;
}

/** Previous cluster centroids, keyed by label. */
export function previousCentroids(clusters: Cluster[]): Map<string, Pos> {
  const out = new Map<string, Pos>();
  for (const c of clusters) if (c.centroid) out.set(c.label, c.centroid);
  return out;
}

/** A one-cluster map for the degraded path (no embeddings): everything under one honest label. */
export function singleCluster(books: ScoredCard[]): Cluster[] {
  if (books.length === 0) return [];
  for (const b of books) b.clusterLabel = UNGROUPED_LABEL;
  return [{ label: UNGROUPED_LABEL, bookIds: books.map((b) => b.id) }];
}

import { type Cluster, type ScoredCard, type ScoredState, qualityOf } from "@sb/shared";

// The final map: the tray alone, showing each book's rank ACROSS THE WHOLE MAP. Nothing is
// re-scored — everything in the tray was scored when it landed there (a suggestion scores at add
// time), so this is pure presentation and costs nothing.

const LO = 0.08;
const HI = 0.92; // the same padded band the server's projection normalizes into

/** Stretch one axis of a subset back across the plane: ten books keep the arrangement the full
 * map gave them, but spread over the whole canvas instead of huddling in one corner of it. */
function rescale(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (!Number.isFinite(range) || range < 1e-9) return () => 0.5;
  return (v) => LO + ((v - min) / range) * (HI - LO);
}

/**
 * A ScoredState containing only the tray books. Clusters are narrowed to their surviving
 * members (empty ones dropped) and their centroids recomputed from the rescaled positions, so a
 * label still sits over its own covers. Cluster ORDER is preserved — the client colors by label
 * order, and the final map must not recolor the books the group has been looking at.
 */
export function trayMapState(tray: ScoredCard[], clusters: Cluster[]): ScoredState {
  const withPos = tray.filter((b) => b.pos);
  const nx = rescale(withPos.map((b) => b.pos!.x));
  const ny = rescale(withPos.map((b) => b.pos!.y));
  const books = tray.map((b) => (b.pos ? { ...b, pos: { x: nx(b.pos.x), y: ny(b.pos.y) } } : { ...b }));
  const posById = new Map(books.filter((b) => b.pos).map((b) => [b.id, b.pos!]));

  // Group by each book's OWN clusterLabel rather than by narrowing the run's cluster list.
  // A trayed book can outlive the map it came from — an added suggestion evicts a book, but the
  // tray deliberately keeps the evicted card — and narrowing dropped exactly those books, so
  // they vanished from the final map and their rank number went missing with them.
  const grouped = new Map<string, string[]>();
  for (const b of books) {
    const label = b.clusterLabel || "";
    grouped.set(label, [...(grouped.get(label) ?? []), b.id]);
  }
  const order = clusters.map((c) => c.label);
  const rank = (label: string) => {
    const i = order.indexOf(label);
    return i < 0 ? order.length : i; // labels the run no longer has go last, in insertion order
  };
  const narrowed: Cluster[] = [...grouped.entries()]
    .sort(([a], [z]) => rank(a) - rank(z))
    .map(([label, bookIds]) => {
      const points = bookIds.map((id) => posById.get(id)).filter((p): p is { x: number; y: number } => !!p);
      const centroid = points.length
        ? {
            x: points.reduce((s, p) => s + p.x, 0) / points.length,
            y: points.reduce((s, p) => s + p.y, 0) / points.length,
          }
        : clusters.find((c) => c.label === label)?.centroid;
      return { label, bookIds, ...(centroid ? { centroid } : {}) };
    });

  return {
    books,
    clusters: narrowed,
    // Coverage and selection describe the RUN, not this view; carried through untouched so the
    // shape stays a valid ScoredState (the map itself renders neither).
    coverage: [],
    selection: { threshold: 0, target: 0, floor: 0, ceiling: 0, kept: books.length, quietMemberPulls: [], unservableMembers: [] },
  };
}

/**
 * Rank by the shared quality blend, 1 = best. The ONE definition of a rank badge, so the full
 * map, the final map and the tray can never disagree about a book's number.
 *
 * The final map deliberately shows these whole-map ranks rather than renumbering the shortlist
 * 1..N: "#3" carries how the book placed among everything considered, and renumbering throws
 * exactly that away — five books labelled 1–5 say nothing about how they beat the other thirteen.
 */
export function rankByQuality(books: ScoredCard[]): Map<string, number> {
  return new Map(
    [...books]
      .sort((a, z) => qualityOf(z.avgFit, z.discussability, z.pageCount) - qualityOf(a.avgFit, a.discussability, a.pageCount))
      .map((b, i) => [b.id, i + 1]),
  );
}

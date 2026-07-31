// Project cluster embeddings to 2D so the map can position blobs by semantic similarity.
// Pure + deterministic. Approach: mean-pool each cluster's book embeddings → one vector per
// cluster, then classical MDS via the dual-PCA (Gram-matrix) trick — top-2 eigenvectors of the
// centered n×n Gram matrix (n = #clusters, ~5-8). The Gram matrix is PSD, so power iteration
// converges to the largest POSITIVE eigenvalues (a plain cosine-distance MDS can produce negative
// eigenvalues and a meaningless axis). Since cluster vectors are L2-normalized, Euclidean-PCA here
// matches cosine-similarity MDS.

interface ClusterVec {
  label: string;
  vec: number[];
}

function l2(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function poolClusters(clusters: { label: string; bookIds: string[] }[], embById: Map<string, number[]>): ClusterVec[] {
  const out: ClusterVec[] = [];
  for (const cl of clusters) {
    const vecs = cl.bookIds.map((id) => embById.get(id)).filter((v): v is number[] => Array.isArray(v));
    if (vecs.length === 0) continue;
    const dim = vecs[0]!.length;
    const mean = new Array<number>(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) mean[i]! += v[i]!;
    for (let i = 0; i < dim; i++) mean[i]! /= vecs.length;
    out.push({ label: cl.label, vec: l2(mean) });
  }
  return out;
}

// Deterministic, non-constant start vector (a constant vector lies in the centered Gram matrix's
// null space, so it must not be used).
const seed = (n: number, off = 0): number[] => Array.from({ length: n }, (_, i) => Math.sin(i + 1 + off * 0.7));

const matVec = (M: number[][], v: number[]): number[] => M.map((row) => row.reduce((s, x, j) => s + x * v[j]!, 0));

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** Dominant eigenvector/eigenvalue of a symmetric PSD matrix via power iteration. */
function topEigen(M: number[][], start: number[]): [number[], number] {
  let v = unit(start);
  for (let it = 0; it < 128; it++) {
    const w = matVec(M, v);
    const nw = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
    if (nw < 1e-12) return [v, 0];
    v = w.map((x) => x / nw);
  }
  const Mv = matVec(M, v);
  const lambda = v.reduce((s, x, i) => s + x * Mv[i]!, 0); // Rayleigh quotient
  return [v, lambda];
}

/** Project row vectors to 2D via dual PCA (top-2 eigenvectors of the centered Gram matrix). */
export function project2d(vectors: number[][]): { x: number; y: number }[] {
  const n = vectors.length;
  if (n <= 1) return vectors.map(() => ({ x: 0, y: 0 }));
  const dim = vectors[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i]! += v[i]!;
  for (let i = 0; i < dim; i++) mean[i]! /= n;
  const Xc = vectors.map((v) => v.map((x, i) => x - mean[i]!));
  const G = Xc.map((a) => Xc.map((b) => a.reduce((s, x, i) => s + x * b[i]!, 0)));

  const [u1, l1] = topEigen(G, seed(n));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) G[i]![j]! -= l1 * u1[i]! * u1[j]!; // deflate
  const [u2, l2] = topEigen(G, seed(n, 1));

  const s1 = Math.sqrt(Math.max(0, l1));
  const s2 = Math.sqrt(Math.max(0, l2));
  return Array.from({ length: n }, (_, i) => ({ x: u1[i]! * s1, y: u2[i]! * s2 }));
}

const scaler = (vals: number[]): ((v: number) => number) => {
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min;
  if (range < 1e-9) return () => 0.5;
  return (v: number) => 0.08 + ((v - min) / range) * 0.84; // padded [0.08, 0.92]
};

function clusterVec(bookIds: string[], embById: Map<string, number[]>): number[] | null {
  const vecs = bookIds.map((id) => embById.get(id)).filter((v): v is number[] => Array.isArray(v));
  if (vecs.length === 0) return null;
  const dim = vecs[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i]! += v[i]!;
  return l2(mean.map((x) => x / vecs.length));
}
const cosine = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

/**
 * Cluster books DIRECTLY on their embeddings (hnbooks-style: geometry from meaning; Stage-3
 * labels only NAME the result). Ward agglomeration — merge cost (|A||B|/(|A|+|B|))·||μA−μB||²
 * penalizes growing a big cluster, so merges stay balanced (plain nearest-centroid merging
 * chains: one blob absorbs everything — seen live, 18/25 books in one "Philosophy"). The cut is
 * the Kneedle knee of the rising cost curve, bounded to [max(2, floor), min(8, n)] with a floor
 * of 4 once there are ≥12 books (a 2-blob map of 25 books is honest but useless). Deterministic.
 * Books without an embedding are appended to the largest cluster at the end.
 */
export function clusterBooks(bookIds: string[], embById: Map<string, number[]>): string[][] {
  const withVec = bookIds.filter((id) => embById.has(id));
  const orphans = bookIds.filter((id) => !embById.has(id));
  const n = withVec.length;
  if (n === 0) return orphans.length ? [orphans] : [];
  if (n <= 2) return [[...withVec, ...orphans]];

  const nodes = withVec.map((id) => ({ ids: [id], vec: embById.get(id)! }));
  const sqDist = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0);
  const snapshots: string[][][] = []; // snapshots[k] = clustering after k merges
  const costs: number[] = [];

  while (nodes.length > 1) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const cost = ((a.ids.length * b.ids.length) / (a.ids.length + b.ids.length)) * sqDist(a.vec, b.vec);
        if (cost < best) {
          best = cost;
          bi = i;
          bj = j;
        }
      }
    }
    const [keep, drop] = bi < bj ? [bi, bj] : [bj, bi];
    nodes[keep]!.ids.push(...nodes[drop]!.ids);
    nodes[keep]!.vec = clusterVec(nodes[keep]!.ids, embById) ?? nodes[keep]!.vec;
    nodes.splice(drop, 1);
    costs.push(best);
    snapshots.push(nodes.map((nd) => [...nd.ids]));
  }

  // Kneedle on the rising cost curve: the merge farthest BELOW the first→last chord is the last
  // cheap, within-topic merge; later merges join genuinely different topics. More robust than
  // "largest single gap", which one unusually tight pair can fool.
  let kneeMerges = 1;
  const last = costs.length - 1;
  const c0 = costs[0]!;
  const cLast = costs[last]!;
  let bestDist = -Infinity;
  for (let i = 0; i <= last; i++) {
    const chord = last === 0 ? c0 : c0 + (cLast - c0) * (i / last);
    const dist = chord - costs[i]!;
    if (dist > bestDist) {
      bestDist = dist;
      kneeMerges = i + 1;
    }
  }
  const floor = n >= 12 ? 4 : 2;
  const k = Math.max(floor, Math.min(6, n - kneeMerges));
  const clusters = snapshots[n - k - 1]!.map((ids) => [...ids]);

  if (orphans.length) {
    const largest = clusters.reduce((m, c) => (c.length > m.length ? c : m), clusters[0]!);
    largest.push(...orphans);
  }
  return clusters;
}

/** Book embeddings → normalized [0..1] 2D positions, keyed by book id — the same MDS the
 * centroids use, applied per book, so the map reads as one continuous plane (hnbooks-style)
 * instead of islands. */
export function bookPositions(bookIds: string[], embById: Map<string, number[]>): Map<string, { x: number; y: number }> {
  const withVec = bookIds.filter((id) => embById.has(id));
  const result = new Map<string, { x: number; y: number }>();
  if (withVec.length === 0) return result;
  if (withVec.length === 1) {
    result.set(withVec[0]!, { x: 0.5, y: 0.5 });
    return result;
  }
  const coords = project2d(withVec.map((id) => embById.get(id)!));
  const nx = scaler(coords.map((c) => c.x));
  const ny = scaler(coords.map((c) => c.y));
  withVec.forEach((id, i) => result.set(id, { x: nx(coords[i]!.x), y: ny(coords[i]!.y) }));
  return result;
}

/** Cluster embeddings → normalized [0..1] 2D centroids, keyed by cluster label. */
export function clusterCentroids(
  clusters: { label: string; bookIds: string[] }[],
  embById: Map<string, number[]>,
): Map<string, { x: number; y: number }> {
  const pooled = poolClusters(clusters, embById);
  const result = new Map<string, { x: number; y: number }>();
  if (pooled.length === 0) return result;
  if (pooled.length === 1) {
    result.set(pooled[0]!.label, { x: 0.5, y: 0.5 });
    return result;
  }
  const coords = project2d(pooled.map((p) => p.vec));
  const nx = scaler(coords.map((c) => c.x));
  const ny = scaler(coords.map((c) => c.y));
  pooled.forEach((c, i) => result.set(c.label, { x: nx(coords[i]!.x), y: ny(coords[i]!.y) }));
  return result;
}

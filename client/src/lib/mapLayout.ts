// Deterministic packed-cover map layout (no embeddings — an explicit non-goal; see NOTES).
// Each domain cluster becomes a phyllotaxis-packed blob of covers (best-fitting book in the
// centre, largest); blobs are packed along a domain-ordered spiral so related domains land near
// each other. Output is in abstract "world" units; the renderer measures its container and
// scales the whole world to fit. Pure and deterministic.

export interface LaidBook {
  id: string;
  x: number; // cover CENTRE, world units
  y: number;
  w: number;
  h: number;
}
export interface LaidCluster {
  label: string;
  color: string;
  cx: number; // blob centre
  cy: number;
  r: number; // blob radius
  books: LaidBook[];
}
export interface MapLayout {
  clusters: LaidCluster[];
  width: number;
  height: number;
}
export interface ClusterInput {
  label: string;
  color: string;
  books: { id: string; weight: number; pos?: { x: number; y: number } }[]; // weight = avgFit (1..10)
  /** Normalized 0..1 embedding position; when present on every cluster, drives blob placement. */
  centroid?: { x: number; y: number };
}

const COVER_MIN_H = 44;
const COVER_MAX_H = 78;
const ASPECT = 0.66;
const BLOB_GAP = 20; // clearance between blobs, world units
const COVER_GAP = 3; // clearance between covers within a blob (adjacent, never overlapping)

// Related domains sit next to each other in this order, so spiral-packing them in order puts
// e.g. History near Economics and Sci-Fi near Fantasy. Unknown domains sort to the end.
const DOMAIN_ORDER = [
  "philosophy", "religion", "history", "politics", "law", "economics", "business", "finance",
  "psychology", "sociology", "anthropology", "education", "biography", "memoir",
  "mathematics", "science", "nature", "medicine", "engineering", "technology", "programming", "computing",
  "art", "design", "music", "literature", "poetry", "fiction", "science fiction", "fantasy",
];
function domainRank(label: string): number {
  const l = label.toLowerCase().trim();
  const i = DOMAIN_ORDER.findIndex((d) => l.includes(d) || d.includes(l));
  return i < 0 ? DOMAIN_ORDER.length : i;
}

function coverH(weight: number): number {
  const t = Math.max(0, Math.min(1, (weight - 4) / 6)); // fit 4 → smallest, 10 → largest
  return Math.round(COVER_MIN_H + t * (COVER_MAX_H - COVER_MIN_H));
}
const blobWeight = (c: ClusterInput): number => Math.max(0, ...c.books.map((b) => b.weight));

/** Do the axis-aligned cover rects at (ax,ay,aw,ah) and `b` clear each other by COVER_GAP? */
function coverClear(ax: number, ay: number, aw: number, ah: number, b: LaidBook): boolean {
  return (
    ax + aw / 2 + COVER_GAP <= b.x - b.w / 2 ||
    ax - aw / 2 >= b.x + b.w / 2 + COVER_GAP ||
    ay + ah / 2 + COVER_GAP <= b.y - b.h / 2 ||
    ay - ah / 2 >= b.y + b.h / 2 + COVER_GAP
  );
}

/**
 * Pack a cluster's covers into a tight blob: biggest (best fit) in the centre, the rest placed on
 * an outward spiral at the first spot that doesn't overlap an already-placed cover — so covers sit
 * adjacent but never on top of each other (rectangle collision, unlike the old sunflower packing).
 */
function packBlob(cl: ClusterInput): LaidCluster {
  const sorted = [...cl.books].sort((a, b) => b.weight - a.weight);
  const maxH = Math.max(COVER_MIN_H, ...sorted.map((b) => coverH(b.weight)));
  const growth = maxH / 13; // spiral radius growth per step
  const books: LaidBook[] = [];

  for (const bk of sorted) {
    const h = coverH(bk.weight);
    const w = Math.round(h * ASPECT);
    if (books.length === 0) {
      books.push({ id: bk.id, x: 0, y: 0, w, h });
      continue;
    }
    let t = 0;
    for (let guard = 0; guard < 20000; guard++) {
      t += 0.3;
      const rad = growth * t;
      const x = Math.cos(t) * rad;
      const y = Math.sin(t) * rad;
      if (books.every((p) => coverClear(x, y, w, h, p))) {
        books.push({ id: bk.id, x, y, w, h });
        break;
      }
    }
  }

  let r = 0;
  for (const b of books) r = Math.max(r, Math.hypot(b.x, b.y) + Math.max(b.w, b.h) / 2);
  return { label: cl.label, color: cl.color, cx: 0, cy: 0, r: r + 6, books };
}

/** Greedy spiral packing: place each blob at the first spiral point that clears the placed ones. */
function packClusters(blobs: LaidCluster[]): void {
  const placed: LaidCluster[] = [];
  const maxR = Math.max(1, ...blobs.map((b) => b.r));
  const tightness = (maxR + BLOB_GAP) / (2 * Math.PI);
  for (const blob of blobs) {
    if (placed.length === 0) {
      placed.push(blob);
      continue;
    }
    let t = 0;
    for (let guard = 0; guard < 20000; guard++) {
      t += 0.45;
      const rad = tightness * t;
      const x = Math.cos(t) * rad;
      const y = Math.sin(t) * rad;
      if (placed.every((p) => Math.hypot(p.cx - x, p.cy - y) >= p.r + blob.r + BLOB_GAP)) {
        blob.cx = x;
        blob.cy = y;
        break;
      }
    }
    placed.push(blob);
  }
}

/** Place blobs from embedding centroids (0..1), then relax apart so none overlap. */
function placeByCentroids(blobs: LaidCluster[], centroids: { x: number; y: number }[]): void {
  // Scale the 0..1 centroid box to roughly the area the blobs need, so the relaxation only has
  // to fix local overlaps (a large span over-expands the world → tiny covers after fit-to-stage).
  const span = 2.2 * Math.sqrt(blobs.reduce((s, b) => s + b.r * b.r, 0));
  blobs.forEach((b, i) => {
    b.cx = centroids[i]!.x * span;
    b.cy = centroids[i]!.y * span;
  });
  // Iterative pairwise push-apart (like d3.forceCollide): only overlapping pairs move, so the
  // embedding arrangement is preserved where there's room. Deterministic.
  for (let iter = 0; iter < 140; iter++) {
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i]!;
        const b = blobs[j]!;
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          dx = i - j - 0.5; // deterministically separate coincident centers
          dy = (i + j) % 2 ? 1 : -1;
          d = Math.hypot(dx, dy);
        }
        const min = a.r + b.r + BLOB_GAP;
        if (d < min) {
          const push = (min - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          a.cx -= ux * push;
          a.cy -= uy * push;
          b.cx += ux * push;
          b.cy += uy * push;
        }
      }
    }
  }
}

const SCATTER_COVER_H = 58; // equal-size covers — rank badges carry the quality signal instead

/**
 * Filled-plane layout (the reference's look): every book at its own embedding position on one
 * continuous canvas, overlap-relaxed; cluster labels sit at each cluster's center (relaxed
 * apart so they never merge). Used when every book carries a `pos`; runs/saves without
 * positions fall back to the blob layout.
 */
function layoutScatter(clusters: ClusterInput[]): MapLayout {
  interface Laid extends LaidBook {
    cluster: number;
  }
  const laid: Laid[] = [];
  clusters.forEach((cl, ci) => {
    for (const bk of cl.books) {
      const h = SCATTER_COVER_H;
      laid.push({ id: bk.id, x: bk.pos!.x, y: bk.pos!.y, w: Math.round(h * ASPECT), h, cluster: ci });
    }
  });

  // Span the 0..1 positions over an area sized to the covers, so the plane reads airy but whole.
  const area = laid.reduce((s, b) => s + (b.w + COVER_GAP) * (b.h + COVER_GAP), 0);
  const span = Math.sqrt(area) * 2.4;
  for (const b of laid) {
    b.x *= span;
    b.y *= span * 0.72; // slightly landscape, like the stage it fits into
  }

  // Pairwise push-apart on circumscribed circles (guarantees the rects clear); deterministic.
  for (let iter = 0; iter < 200; iter++) {
    for (let i = 0; i < laid.length; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        const a = laid[i]!;
        const b = laid[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          dx = i - j - 0.5;
          dy = (i + j) % 2 ? 1 : -1;
          d = Math.hypot(dx, dy);
        }
        const min = Math.hypot(a.w, a.h) / 2 + Math.hypot(b.w, b.h) / 2 + COVER_GAP;
        if (d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
    }
  }

  const pad = 48;
  const minX = Math.min(...laid.map((b) => b.x - b.w / 2));
  const minY = Math.min(...laid.map((b) => b.y - b.h / 2));
  for (const b of laid) {
    b.x += pad - minX;
    b.y += pad + 18 - minY; // headroom in case a label lands near the top edge
  }

  // Labels sit AT each cluster's center (the reference's look), then get relaxed apart so two
  // labels never merge — mostly vertically, so a label stays over its own cluster's x-range.
  const labels = clusters.map((cl, ci) => {
    const books = laid.filter((b) => b.cluster === ci);
    return {
      x: books.reduce((s, b) => s + b.x, 0) / books.length,
      y: books.reduce((s, b) => s + b.y, 0) / books.length,
      w: cl.label.length * 7.6 + 22, // rough pill box for collision purposes
      h: 26,
    };
  });
  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i]!;
        const b = labels[j]!;
        const ox = (a.w + b.w) / 2 + 10 - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + 8 - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          const dir = a.y <= b.y ? 1 : -1;
          a.y -= (oy / 2) * dir;
          b.y += (oy / 2) * dir;
        }
      }
    }
  }

  const out: LaidCluster[] = clusters.map((cl, ci) => {
    const books = laid.filter((b) => b.cluster === ci).map(({ cluster: _c, ...bk }) => bk);
    const lb = labels[ci]!;
    // r = 0 → the renderer treats (cx, cy) as the label's anchor point.
    return { label: cl.label, color: cl.color, cx: lb.x, cy: lb.y + 12, r: 0, books };
  });
  const width = Math.max(...laid.map((b) => b.x + b.w / 2)) + pad;
  const height = Math.max(...laid.map((b) => b.y + b.h / 2)) + pad;
  return { clusters: out, width, height };
}

export function layoutMap(input: ClusterInput[]): MapLayout {
  const clusters = input.filter((c) => c.books.length > 0);
  if (clusters.length === 0) return { clusters: [], width: 0, height: 0 };

  // Filled plane when every book has an embedding position (current runs) …
  if (clusters.every((c) => c.books.every((b) => b.pos))) return layoutScatter(clusters);

  // … semantic blob placement when only cluster centroids exist; otherwise the domain spiral.
  const useEmbed = clusters.every((c) => c.centroid);
  const ordered = useEmbed
    ? clusters
    : [...clusters].sort((a, b) => domainRank(a.label) - domainRank(b.label) || blobWeight(b) - blobWeight(a));
  const blobs = ordered.map(packBlob);
  if (useEmbed) placeByCentroids(blobs, ordered.map((c) => c.centroid!));
  else packClusters(blobs);

  const pad = 36;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of blobs) {
    minX = Math.min(minX, b.cx - b.r);
    maxX = Math.max(maxX, b.cx + b.r);
    minY = Math.min(minY, b.cy - b.r);
    maxY = Math.max(maxY, b.cy + b.r);
  }
  const dx = pad - minX;
  const dy = pad - minY;
  for (const b of blobs) {
    b.cx += dx;
    b.cy += dy;
    for (const bk of b.books) {
      bk.x += b.cx;
      bk.y += b.cy;
    }
  }
  return { clusters: blobs, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

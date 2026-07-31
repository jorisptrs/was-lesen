import { normalizeTitle } from "../domain/bookref";
import type { OlDoc } from "./openLibrary";

export interface Match {
  doc: OlDoc;
  confidence: number;
  authorMatched: boolean;
}

/** Character-bigram Dice coefficient over two already-normalized strings. */
export function dice(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bg = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bg(x);
  const B = bg(y);
  let inter = 0;
  let total = 0;
  for (const [g, ca] of A) {
    total += ca;
    const cb = B.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  for (const cb of B.values()) total += cb;
  return total === 0 ? 0 : (2 * inter) / total;
}

/**
 * Normalized title variants to compare against. Handles the "Author: Title" artifact (and
 * ordinary "Title: Subtitle") by also comparing the parts on either side of a colon.
 */
export function titleVariants(title: string): string[] {
  const out = [normalizeTitle(title)];
  const i = title.indexOf(":");
  if (i > 0 && i < title.length - 1) {
    out.push(normalizeTitle(title.slice(0, i)), normalizeTitle(title.slice(i + 1)));
  }
  return out.filter(Boolean);
}

const ARTICLES = new Set(["a", "an", "the"]);
const contentTokens = (normalized: string): string[] =>
  normalized.split(" ").filter((w) => w && !ARTICLES.has(w));

/**
 * Same title in the same word ORDER (articles ignored; one near-equal token allowed for a
 * typo/plural). Bigram dice strips whitespace and is order-blind, so it scores the INVERSION
 * "A Brief History of Intelligence" vs "Intelligence: A Brief History" ~0.92 — two different
 * books. Word order is the signal dice can't see.
 */
export function sameTitleOrdered(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.length === 0 || ta.length !== tb.length) return false;
  let diffs = 0;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (x === y) continue;
    if (++diffs > 1) return false;
    if (dice(x, y) < 0.6) return false; // a typo/plural of the same word, not a different word
  }
  return true;
}

/** True if `author`'s full name or last name appears among the Open Library authors. */
export function authorMatches(author: string, olAuthors: string[]): boolean {
  const a = normalizeTitle(author);
  if (!a) return false;
  const last = a.split(" ").filter(Boolean).pop() ?? "";
  return olAuthors.some((ol) => {
    const n = normalizeTitle(ol);
    return n.includes(a) || (last.length > 2 && n.split(" ").includes(last));
  });
}

/**
 * Pick the best Open Library doc for a candidate, or null (→ hallucination / not found).
 *
 * Acceptance (tunable "dry-run dial"):
 *  - author matches and the title is a decent match, OR
 *  - no author given and the title is a very strong match IN ORDER, OR
 *  - author given but not matched, yet the title is the SAME title in the same word order and
 *    distinctive (≥3 words) — a real book whose author the model got wrong (we then correct
 *    the author from OL).
 * Without author agreement, dice alone is not enough: it is order-blind, and title INVERSIONS
 * ("A Brief History of Intelligence" → "Intelligence: A Brief History") are different books
 * that score ~0.9. A generic one/two-word title with a non-matching author is rejected.
 */
export function pickBestMatch(title: string, author: string | undefined, docs: OlDoc[]): Match | null {
  const variants = titleVariants(title);
  const words = normalizeTitle(title).split(" ").filter(Boolean).length;

  let best: Match | null = null;
  let bestRank = -1;
  for (const doc of docs) {
    if (!doc.title) continue;
    // Strip trailing edition qualifiers from the CATALOG title before comparing — the canonical
    // work is often listed as e.g. "Atlas Shrugged (Centennial Ed. HC)", which would score below
    // an exact-titled junk edition (a study guide, an audio release credited to its narrator).
    const strippedDoc = doc.title.replace(/\s*\([^)]*\)\s*$/, "");
    const dt = normalizeTitle(strippedDoc);
    const docVariants = titleVariants(strippedDoc);
    let sim = 0;
    for (const v of variants) sim = Math.max(sim, dice(v, dt));
    const ordered = variants.some((v) => docVariants.some((d) => sameTitleOrdered(v, d)));
    const authorMatched = author ? authorMatches(author, doc.author_name ?? []) : false;

    const accept =
      (authorMatched && sim >= 0.62) ||
      (!author && sim >= 0.9 && ordered) ||
      (!!author && !authorMatched && sim >= 0.85 && ordered && words >= 3);
    if (!accept) continue;

    const rank = sim + (authorMatched ? 0.2 : 0) + Math.min((doc.edition_count ?? 0) / 2000, 0.05);
    if (rank > bestRank) {
      bestRank = rank;
      best = { doc, confidence: Math.min(1, sim + (authorMatched ? 0.1 : 0)), authorMatched };
    }
  }
  return best;
}

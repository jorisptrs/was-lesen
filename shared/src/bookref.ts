import type { BookRef, ScoredCard } from "./types";

// Title identity, shared so the client's instant checks and the server's authoritative ones
// key books the same way. (The server layers variant matching on top for exclusions; this is
// the common floor.)

/** Normalise a title for fuzzy matching / dedup / exclusion (lowercase, strip accents & punctuation). */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A coarse dedup/exclusion key. Title-only; author is refined into matching at Stage 2. */
export function titleKey(ref: BookRef): string {
  return normalizeTitle(ref.title);
}

/**
 * The members a scored map was actually built for, read off the cards' own fit rows — the map's
 * contract, independent of whatever roster is in the input panel right now.
 *
 * Both sides need this and for the same reason: the panel's roster and the displayed map can be
 * from different runs (the boot-loaded published map is the common case). The server keys
 * re-selection off it so an edited roster can't silently rescore the map; the client compares
 * against it so the mismatch is visible instead of showing one run's names beside another's
 * books.
 */
export function scoredMemberNames(books: Pick<ScoredCard, "perMember">[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const b of books) {
    for (const p of b.perMember ?? []) {
      if (p.member && !seen.has(p.member)) {
        seen.add(p.member);
        names.push(p.member);
      }
    }
  }
  return names;
}

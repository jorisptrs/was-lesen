import pLimit from "p-limit";
import type { Candidate, Provenance, VerifiedBook } from "@sb/shared";
import { getCached, setCached } from "../books/cache";
import type { Match } from "../books/match";
import { authorMatches, dice, pickBestMatch } from "../books/match";
import { googleBooksEnabled, searchGoogleBooks } from "../books/googleBooks";
import { searchOpenLibrary } from "../books/openLibrary";
import { config } from "../config";
import { normalizeTitle } from "../domain/bookref";

export interface VerifyResult {
  status: "verified" | "unverified" | "dropped";
  reason?: string;
  book?: VerifiedBook;
}

export interface VerifyProgress {
  id: string;
  status: "verified" | "unverified" | "dropped";
  reason?: string;
  book?: VerifiedBook;
  progress: { resolved: number; total: number; kept: number; dropped: number };
}

const cacheKey = (c: { title: string; author: string }): string => `${normalizeTitle(c.title)}|${normalizeTitle(c.author)}`;

function coverOf(d: Match["doc"]): string | null {
  if (d.cover_i != null) return `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`;
  return d.gbCoverUrl ?? null;
}

// Open Library `subject` is a long, noisy list (bestseller tags, format flags, catalog cruft);
// GB `categories` are clean. Filter the junk, dedupe, keep a handful — topical tags for clustering.
const SUBJECT_JUNK =
  /accessible book|protected daisy|in library|large type|overdrive|bestseller|^nyt|reading level|lending|internet archive|ebook|audiobook|^general$|^fiction$|^nonfiction$|award|book club/i;
function cleanSubjects(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const s = raw.replace(/\s*\/\s*/g, " ").trim(); // GB "A / B" → "A B"
      if (!s || s.length > 40 || SUBJECT_JUNK.test(s)) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function enrich(c: Candidate, match: Match, keepOriginalAuthor: boolean, source: "ol" | "gb"): VerifiedBook {
  const d = match.doc;
  return {
    ...c,
    // Correct the model's author from the books API, EXCEPT when a member TYPED an author —
    // trust the human's spelling there (OL editions sometimes list a publisher). A title-only
    // member nomination (no typed author) takes the API's author.
    author: keepOriginalAuthor && c.author ? c.author : d.author_name?.[0] ?? c.author,
    status: "verified",
    year: d.first_publish_year ?? null,
    pageCount: d.number_of_pages_median ?? null,
    pageCountSource: d.number_of_pages_median == null ? "unknown" : source === "gb" ? "googlebooks" : "openlibrary_median",
    coverUrl: coverOf(d),
    olWorkKey: d.key ?? null,
    matchConfidence: match.confidence,
    subjects: cleanSubjects(d.subject),
  };
}

function unverified(c: Candidate): VerifiedBook {
  return {
    ...c,
    status: "unverified",
    year: null,
    pageCount: null,
    pageCountSource: "unknown",
    coverUrl: null,
    olWorkKey: null,
    matchConfidence: 0,
  };
}

export async function resolveMatch(c: { title: string; author: string }, signal: AbortSignal): Promise<Match | null> {
  const key = cacheKey(c);
  const cached = getCached(key);
  if (cached.hit) return cached.value;
  let match = pickBestMatch(c.title, c.author || undefined, await searchOpenLibrary(c.title, c.author, signal));
  // A wrong/uncertain author (member typo or a Stage-0 guess) pollutes the query and buries the
  // real book — retry on the title alone, still disambiguating results with the author.
  if (!match && c.author) {
    match = pickBestMatch(c.title, c.author || undefined, await searchOpenLibrary(c.title, "", signal));
  }
  setCached(key, match);
  return match;
}

/** Same as `resolveMatch` but against Google Books (fallback source). Cached under its own key. */
export async function resolveGbMatch(c: { title: string; author: string }, signal: AbortSignal): Promise<Match | null> {
  const key = `gb|${cacheKey(c)}`;
  const cached = getCached(key);
  if (cached.hit) return cached.value;
  let match = pickBestMatch(c.title, c.author || undefined, await searchGoogleBooks(c.title, c.author, signal));
  if (!match && c.author) {
    match = pickBestMatch(c.title, c.author || undefined, await searchGoogleBooks(c.title, "", signal));
  }
  setCached(key, match);
  return match;
}

/** Best-effort: fill a verified book's missing cover/pages/year from Google Books (recent
 * titles are often known to GB before Open Library has covers). Never throws. */
async function fillFromGoogle(book: VerifiedBook, c: Candidate, signal: AbortSignal): Promise<VerifiedBook> {
  if (!googleBooksEnabled() || (book.coverUrl && book.pageCount)) return book;
  try {
    const gb = await resolveGbMatch(c, signal);
    if (!gb) return book;
    const d = gb.doc;
    return {
      ...book,
      coverUrl: book.coverUrl ?? d.gbCoverUrl ?? null,
      pageCount: book.pageCount ?? d.number_of_pages_median ?? null,
      pageCountSource: book.pageCount != null ? book.pageCountSource : d.number_of_pages_median != null ? "googlebooks" : book.pageCountSource,
      year: book.year ?? d.first_publish_year ?? null,
      subjects: book.subjects?.length ? book.subjects : cleanSubjects(d.subject),
    };
  } catch {
    return book; // fill-in is a bonus, never a failure
  }
}

/**
 * Verify one candidate against Open Library.
 *  - match → verified (enriched, author corrected).
 *  - no match → drop a Claude pick (hallucination), but KEEP a member nomination as
 *    unverified (don't silently discard a human's suggestion).
 *  - our network error → keep as unverified (don't punish the book for our outage).
 */
export async function verifyCandidate(c: Candidate, signal: AbortSignal): Promise<VerifyResult> {
  // Human-typed entries (suggested OR liked) get the cautious treatment; only Claude's own
  // picks are dropped outright on no-match (a human's book is kept as unverified instead).
  const isMember = c.provenance !== "claude_own_pick";
  let match: Match | null;
  try {
    match = await resolveMatch(c, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return { status: "unverified", reason: "books_api_error", book: unverified(c) };
  }
  if (match) {
    // Be cautious ONLY when a member TYPED an author that the books API can't confirm (could be a
    // different book with the same title) — keep it unverified rather than attach a wrong edition.
    // A title-only nomination with a strong title match (pickBestMatch already gated it) is trusted.
    if (isMember && c.author && !match.authorMatched) {
      return { status: "unverified", reason: "unconfirmed", book: unverified(c) };
    }
    // Recent titles often lack an OL cover/page count — top up from Google Books.
    const book = await fillFromGoogle(enrich(c, match, isMember, "ol"), c, signal);
    return { status: "verified", book };
  }

  // Open Library found nothing — try Google Books before declaring the book a hallucination
  // (OL is often behind on 2024–25 releases). Skipped entirely without an API key.
  let gbMatch: Match | null = null;
  if (googleBooksEnabled()) {
    try {
      gbMatch = await resolveGbMatch(c, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      // OL said not-found and GB errored: fall through to the not_found handling below.
    }
  }
  if (gbMatch && (!isMember || !c.author || gbMatch.authorMatched)) {
    return { status: "verified", book: enrich(c, gbMatch, isMember, "gb") };
  }

  if (isMember) return { status: "unverified", reason: "not_found", book: unverified(c) };
  return { status: "dropped", reason: "not_found" };
}

/** Merge a duplicate into its surviving card: canonical (verified) fields win, and the
 * strongest member badge survives (suggested > liked > Claude pick — provenance matters on
 * the map). */
// Typed as a total Record so adding a provenance can't silently fall through to `undefined`.
const PROVENANCE_RANK: Record<Provenance, number> = {
  member_nomination: 2,
  organizer_add: 2, // typed into the room, same standing as a member's own suggestion
  member_loved: 1,
  claude_own_pick: 0,
};
function mergeDupe(seen: VerifiedBook, dup: VerifiedBook): void {
  const seenRank = PROVENANCE_RANK[seen.provenance];
  const dupRank = PROVENANCE_RANK[dup.provenance];
  if (seenRank > dupRank) {
    // The duplicate carries the API-canonical title/author — adopt it, keep the badge.
    seen.title = dup.title;
    seen.author = dup.author;
  } else if (dupRank > seenRank) {
    seen.provenance = dup.provenance;
    seen.nominatedBy = dup.nominatedBy;
  }
  seen.coverUrl ??= dup.coverUrl;
  seen.pageCount ??= dup.pageCount;
  seen.year ??= dup.year;
  seen.olWorkKey ??= dup.olWorkKey;
}

/**
 * Same book iff the normalized titles are near-identical (dice ≥ 0.9 — typos/punctuation) OR one
 * contains the other (subtitle variants "Superintelligence" ⊂ "Superintelligence: Paths, Dangers,
 * Strategies"; author-in-string "…: the dawn of everything" ⊃ "the dawn of everything") — the
 * containment side is guarded by a 12-char floor (so "persuasion" can't swallow "the art of
 * persuasion") AND author compatibility whenever both sides name one.
 */
function sameBook(a: VerifiedBook, b: VerifiedBook): boolean {
  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  const titlesAgree = dice(ta, tb) >= 0.9 || (shorter.length >= 12 && longer.includes(shorter));
  if (!titlesAgree) return false;
  if (!a.author || !b.author) return true;
  return authorMatches(a.author, [b.author]) || authorMatches(b.author, [a.author]);
}

/**
 * Merge duplicate books after verification. Two passes: (1) same Open Library work key —
 * a member's raw string and Claude's clean pick of the same book both survive candidate
 * title-dedup but usually share an olWorkKey; (2) near-identical canonical titles with
 * compatible authors — catches pairs that verified to different/missing works (seen live:
 * "David Graeber/David Wengrow: the dawn of everything." vs "The Dawn of Everything").
 */
export function dedupeByWork(books: VerifiedBook[]): VerifiedBook[] {
  const byKey = new Map<string, VerifiedBook>();
  const keyed: VerifiedBook[] = [];
  for (const b of books) {
    const seen = b.olWorkKey ? byKey.get(b.olWorkKey) : undefined;
    if (seen) {
      mergeDupe(seen, b);
      continue;
    }
    if (b.olWorkKey) byKey.set(b.olWorkKey, b);
    keyed.push(b);
  }

  const out: VerifiedBook[] = [];
  for (const b of keyed) {
    const seen = out.find((s) => sameBook(s, b));
    if (seen) {
      // Prefer the verified card as the survivor (its title/author are API-canonical).
      if (seen.status !== "verified" && b.status === "verified") {
        mergeDupe(b, seen);
        out[out.indexOf(seen)] = b;
      } else {
        mergeDupe(seen, b);
      }
      continue;
    }
    out.push(b);
  }
  return out;
}

/** Verify all candidates concurrently, streaming per-book progress. Returns the kept books. */
export async function verifyAll(
  candidates: Candidate[],
  onProgress: (p: VerifyProgress) => void,
  signal: AbortSignal,
): Promise<VerifiedBook[]> {
  const limit = pLimit(config.BOOKS_CONCURRENCY);
  const total = candidates.length;
  const kept: VerifiedBook[] = [];
  let resolved = 0;
  let dropped = 0;

  await Promise.all(
    candidates.map((c) =>
      limit(async () => {
        if (signal.aborted) return;
        let result: VerifyResult;
        try {
          result = await verifyCandidate(c, signal);
        } catch (err) {
          if (signal.aborted) return;
          result = { status: "unverified", reason: "error", book: unverified(c) };
        }
        resolved++;
        if (result.status === "dropped") dropped++;
        else if (result.book) kept.push(result.book);
        onProgress({
          id: c.id,
          status: result.status,
          reason: result.reason,
          book: result.book,
          progress: { resolved, total, kept: kept.length, dropped },
        });
      }),
    ),
  );

  return kept;
}

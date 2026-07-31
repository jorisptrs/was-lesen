import { config } from "../config";
import { normalizeTitle } from "../domain/bookref";
import { dice } from "./match";
import type { OlDoc } from "./openLibrary";
import { sleep } from "./openLibrary";

// Google Books fallback for what Open Library doesn't know — mostly recent (2024–25) releases
// that otherwise render as "verify"-badged placeholders. Results are mapped onto the SAME doc
// shape the Open Library matcher scores (`pickBestMatch`), so all match/disambiguation logic is
// shared. REQUIRES `GOOGLE_BOOKS_API_KEY` (a free Google Cloud key): verified live that
// anonymous callers now get a quota of ZERO (`quota_limit_value: "0"` on a keyless 429), so
// without a key this module opts out instantly instead of burning a doomed request per book.

interface GbVolume {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    pageCount?: number;
    imageLinks?: { thumbnail?: string };
    categories?: string[];
  };
}

/** Page counts are edition-level and often missing on the best-matched volume (observed
 * live: Bennett's "A Brief History of Intelligence" matched with cover but no pages). Borrow
 * the count from another returned edition of the same work — same philosophy as OL's
 * median-of-editions. */
export function borrowSiblingPages(docs: OlDoc[]): OlDoc[] {
  return docs.map((d) => {
    if (d.number_of_pages_median || !d.title) return d;
    const t = normalizeTitle(d.title);
    const sibling = docs.find(
      (o) => o !== d && o.number_of_pages_median && o.title && dice(normalizeTitle(o.title), t) >= 0.9,
    );
    return sibling ? { ...d, number_of_pages_median: sibling.number_of_pages_median } : d;
  });
}

/** Map a Google Books volume to the OlDoc shape the matcher consumes. */
export function gbToDoc(v: GbVolume): OlDoc {
  const info = v.volumeInfo ?? {};
  const year = info.publishedDate ? Number(info.publishedDate.slice(0, 4)) : NaN;
  return {
    title: info.title,
    author_name: info.authors,
    first_publish_year: Number.isFinite(year) ? year : undefined,
    number_of_pages_median: info.pageCount && info.pageCount > 0 ? info.pageCount : undefined,
    // https + strip the page-curl decoration for a clean cover.
    gbCoverUrl: info.imageLinks?.thumbnail?.replace(/^http:/, "https:").replace(/&edge=curl/, ""),
    subject: info.categories, // GB categories are clean topical tags ("Political Science")
  };
}

export const googleBooksEnabled = (): boolean => !!config.GOOGLE_BOOKS_API_KEY;

const GB_MAX_ATTEMPTS = 5; // Books API 503s ("backendFailed") intermittently — the SAME query can
// fail 3× then succeed; a few quick retries make it reliable. Verified live, 2026-07-16.

export async function searchGoogleBooks(title: string, author: string, signal: AbortSignal): Promise<OlDoc[]> {
  if (!googleBooksEnabled() || !title.trim()) return [];
  // A plain relevance query (like Open Library) — the `intitle:`/`inauthor:` field operators 503
  // more often. The matcher (pickBestMatch) scores + disambiguates the top results.
  const q = [title, author].filter(Boolean).join(" ").trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books&key=${config.GOOGLE_BOOKS_API_KEY}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < GB_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (res.ok) {
        const data = (await res.json()) as { items?: GbVolume[] };
        return Array.isArray(data.items) ? borrowSiblingPages(data.items.map(gbToDoc)) : [];
      }
      lastErr = new Error(`Google Books responded ${res.status}`);
      if ((res.status === 503 || res.status === 500) && attempt < GB_MAX_ATTEMPTS - 1) {
        await sleep(700, signal); // transient backend failure — retry quickly
      } else if (res.status === 429) {
        throw lastErr; // real rate limit — don't hammer
      } else if (res.status < 500) {
        throw lastErr;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Google Books request failed");
}

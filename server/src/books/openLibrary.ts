import { config } from "../config";

export interface OlDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  edition_count?: number;
  /** Median page count across all editions — the single number we use for `pageCount`. */
  number_of_pages_median?: number;
  /** Set on Google-Books-sourced docs (GB covers are URLs, not OL cover ids). */
  gbCoverUrl?: string;
  /** OL `subject` list (noisy) or GB `categories` (clean) — topical tags for clustering. */
  subject?: string[];
}

const FIELDS = "key,title,author_name,first_publish_year,cover_i,edition_count,number_of_pages_median,subject";

/**
 * Search Open Library with a relevance query of "title author" (not the strict `author`
 * filter — that would hide a real book whose author the model got wrong). Returns up to 5
 * candidate docs; the caller (match.ts) scores and disambiguates.
 */
export async function searchOpenLibrary(title: string, author: string, signal: AbortSignal): Promise<OlDoc[]> {
  const q = [title, author].filter(Boolean).join(" ").trim();
  if (!q) return [];
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=${FIELDS}&limit=10`;
  const data = (await fetchJson(url, signal)) as { docs?: OlDoc[] };
  return Array.isArray(data.docs) ? data.docs : [];
}

/** Abortable pause (rejects promptly if the run is cancelled mid-wait). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fetch JSON with a contact user-agent, an 8s timeout, and one retry on network/5xx. A 429/503
 * (throttled — happens after many same-hour runs) waits `min(Retry-After, 30s)` once before the
 * retry instead of failing; a still-throttled retry falls through to the caller's non-fatal
 * `books_api_error` path.
 */
async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.OPENLIBRARY_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`Open Library responded ${res.status}`);
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("retry-after")) || 10;
        if (attempt === 0) await sleep(Math.min(retryAfter, 30) * 1000, signal);
      } else if (res.status < 500) {
        throw lastErr;
      }
    } catch (err) {
      if (signal.aborted) throw err; // run cancelled — bail immediately
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Open Library request failed");
}
